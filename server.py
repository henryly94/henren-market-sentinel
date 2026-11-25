#!/usr/bin/env python3
"""Smart Web API, On-Visit Auto-Revalidator & Adaptive Background Scheduler."""

from __future__ import annotations

import asyncio
import logging
import os
import threading
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, PlainTextResponse
from fastapi.staticfiles import StaticFiles

from cli import execute_market_check
from sentinel.report_builder import build_markdown_report
from sentinel.scheduler import compute_smart_schedule_plan
from sentinel.storage import DATA_DIR, REPORTS_DIR, init_storage, list_run_history, load_latest_run

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("sentinel.server")

STATIC_DIR = Path(__file__).resolve().parent / "static"
REFRESH_LOCK = threading.Lock()
IS_REFRESHING = False


LAST_REFRESH_ERROR: str | None = None


def _parse_iso_utc(ts_str: str | None) -> datetime | None:
    if not ts_str:
        return None
    try:
        return datetime.strptime(ts_str, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _snapshot_age_seconds(data: dict[str, Any] | None) -> float:
    if not data:
        return 1e9
    ts = _parse_iso_utc(data.get("snapshot", {}).get("collected_at_utc"))
    if not ts:
        return 1e9
    return max(0.0, (datetime.now(timezone.utc) - ts).total_seconds())


def _safe_refresh(trigger_source: str = "manual") -> dict[str, Any]:
    global IS_REFRESHING, LAST_REFRESH_ERROR
    with REFRESH_LOCK:
        IS_REFRESHING = True
        try:
            res = execute_market_check(trigger_source=trigger_source)
            LAST_REFRESH_ERROR = None
            return res
        except Exception as exc:
            LAST_REFRESH_ERROR = str(exc)
            logger.warning("Upstream refresh failed (%s), falling back to cached snapshot: %s", trigger_source, exc)
            cached = load_latest_run()
            if cached is not None:
                cached["fallback_cached"] = True
                cached["fallback_reason"] = str(exc)
                return cached
            raise
        finally:
            IS_REFRESHING = False


def _trigger_background_refresh_if_idle(trigger_source: str) -> bool:
    """Spawn a non-blocking background refresh thread if not currently refreshing."""
    if IS_REFRESHING or REFRESH_LOCK.locked():
        return False
    t = threading.Thread(target=_safe_refresh, kwargs={"trigger_source": trigger_source}, daemon=True)
    t.start()
    return True


async def _smart_scheduler_loop() -> None:
    """Adaptive background loop checking every 30s against market sessions & critical windows."""
    while True:
        await asyncio.sleep(30)
        try:
            plan = compute_smart_schedule_plan()
            latest = load_latest_run()
            age = _snapshot_age_seconds(latest)
            if age >= plan["interval_seconds"] and not IS_REFRESHING:
                logger.info(
                    "智能调度触发自动抓取 [档位=%s, 数据年龄=%.0fs >= 阈值=%ds]...",
                    plan["mode_label"],
                    age,
                    plan["interval_seconds"],
                )
                await asyncio.to_thread(_safe_refresh, f"auto:{plan['mode_code'].lower()}")
        except Exception as exc:
            logger.warning("智能调度巡检异常: %s", exc)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_storage()
    if load_latest_run() is None:
        logger.info("首次启动未发现本地快照，执行初始真实市场数据采集...")
        await asyncio.to_thread(_safe_refresh, "startup")
    task = asyncio.create_task(_smart_scheduler_loop())
    try:
        yield
    finally:
        task.cancel()


app = FastAPI(title="狠人框架 · 全球市场风向与微结构智能巡检台", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["GET", "POST", "HEAD", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/api/status")
def api_status() -> dict[str, Any]:
    latest = load_latest_run()
    plan = compute_smart_schedule_plan()
    age = _snapshot_age_seconds(latest)
    snap = latest.get("snapshot", {}) if latest else {}
    return {
        "ok": True,
        "is_refreshing": IS_REFRESHING,
        "fallback_cached": bool(LAST_REFRESH_ERROR),
        "fallback_reason": LAST_REFRESH_ERROR,
        "run_id": latest.get("run_id") if latest else None,
        "collected_at_utc": snap.get("collected_at_utc"),
        "module_timestamps": snap.get("module_timestamps"),
        "age_seconds": round(age, 1) if age < 1e8 else None,
        "is_stale_for_visit": bool(age >= plan["visit_stale_seconds"]),
        "scheduler": plan,
    }


@app.post("/api/visit")
def api_visit() -> dict[str, Any]:
    """Called automatically when user opens/unlocks the dashboard on phone or desktop."""
    latest = load_latest_run()
    plan = compute_smart_schedule_plan()
    age = _snapshot_age_seconds(latest)
    triggered = False
    if age >= plan["visit_stale_seconds"]:
        triggered = _trigger_background_refresh_if_idle("on_visit")
    return {
        "triggered_refresh": triggered,
        "is_refreshing": IS_REFRESHING or triggered,
        "age_seconds": round(age, 1) if age < 1e8 else None,
        "visit_stale_threshold_seconds": plan["visit_stale_seconds"],
        "scheduler": plan,
    }


@app.get("/api/latest")
def api_latest() -> dict[str, Any]:
    data = load_latest_run()
    if data is None:
        raise HTTPException(status_code=404, detail="No snapshot available yet")
    plan = compute_smart_schedule_plan()
    data["scheduler"] = plan
    data["age_seconds"] = round(_snapshot_age_seconds(data), 1)
    data["is_refreshing"] = IS_REFRESHING
    data["fallback_cached"] = bool(LAST_REFRESH_ERROR)
    data["fallback_reason"] = LAST_REFRESH_ERROR
    return data


@app.get("/api/history")
def api_history() -> dict[str, Any]:
    return {"runs": list_run_history(limit=40)}


@app.post("/api/refresh")
async def api_refresh() -> dict[str, Any]:
    bundle = await asyncio.to_thread(_safe_refresh, "manual")
    bundle["scheduler"] = compute_smart_schedule_plan()
    bundle["age_seconds"] = round(_snapshot_age_seconds(bundle), 1)
    bundle["is_refreshing"] = False
    return bundle


@app.get("/api/report.md", response_class=PlainTextResponse)
def api_report_md() -> str:
    data = load_latest_run()
    if data is None:
        raise HTTPException(status_code=404, detail="No report available")
    return build_markdown_report(data)


app.mount("/data", StaticFiles(directory=str(DATA_DIR)), name="data")
app.mount("/reports", StaticFiles(directory=str(REPORTS_DIR)), name="reports")
app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.api_route("/", methods=["GET", "HEAD"])
def index_page() -> FileResponse:
    return FileResponse(str(STATIC_DIR / "index.html"))


@app.get("/{asset_path:path}")
def root_static_fallback(asset_path: str) -> FileResponse:
    """Serve relative PWA assets (styles.css, app.js, manifest.json, sw.js, icons/*) cleanly."""
    candidate = (STATIC_DIR / asset_path).resolve()
    if STATIC_DIR.resolve() in candidate.parents and candidate.is_file():
        return FileResponse(str(candidate))
    raise HTTPException(status_code=404, detail="Not found")


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("PORT", "8765"))
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
