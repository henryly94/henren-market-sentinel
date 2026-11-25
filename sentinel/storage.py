"""Persistence layer for market snapshots and historical regime tracking (SQLite + Portable JSON)."""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / "data"
REPORTS_DIR = BASE_DIR / "reports"
LATEST_JSON = DATA_DIR / "latest_snapshot.json"
HISTORY_JSON = DATA_DIR / "history.json"
DB_PATH = DATA_DIR / "history.db"


REGIME_LABELS: dict[str, str] = {
    "RED_PLUMBING": "红色警报",
    "DEFENSIVE_BOUNCE": "防守反击期",
    "CAUTIOUS_NEUTRAL": "震荡防御期",
    "RISK_ON": "顺风进攻期",
}


def _infer_regime_key(run_row: dict[str, Any]) -> str:
    rc = str(run_row.get("regime_code") or "")
    if rc in REGIME_LABELS:
        return REGIME_LABELS[rc]
    hl = str(run_row.get("headline") or "")
    if "：" in hl:
        return hl.split("：", 1)[0].strip()
    return rc or hl[:8]


def _annotate_transitions(runs: list[dict[str, Any]], risk_jump_threshold: int = 6) -> list[dict[str, Any]]:
    """Annotate descending run list (newest first) with regime flips, Gamma flips, and risk-score jumps."""
    out: list[dict[str, Any]] = []
    for idx, r in enumerate(runs):
        item = dict(r)
        tags: list[str] = []
        risk_delta = 0
        if idx + 1 < len(runs):
            older = runs[idx + 1]
            curr_rk = _infer_regime_key(item)
            prev_rk = _infer_regime_key(older)
            if curr_rk and prev_rk and curr_rk != prev_rk:
                tags.append(f"定调切换 ({prev_rk}→{curr_rk})")

            curr_g = item.get("gamma_state")
            prev_g = older.get("gamma_state")
            if curr_g and prev_g and curr_g != prev_g:
                g_map = {
                    "NEGATIVE_CONFIRMED": "负G",
                    "BUFFER_PROBING": "临界试探",
                    "POSITIVE_CONFIRMED": "正G",
                }
                tags.append(f"Gamma切换 ({g_map.get(prev_g, prev_g)}→{g_map.get(curr_g, curr_g)})")

            curr_s = item.get("sofr_corridor_state")
            prev_s = older.get("sofr_corridor_state")
            if curr_s and prev_s and curr_s != prev_s:
                s_map = {
                    "NORMAL_CORRIDOR": "走廊平稳",
                    "BUFFER_OBSERVE": "毛刺观察",
                    "STRESS_CONFIRMED": "吃紧确认",
                }
                tags.append(f"水管切换 ({s_map.get(prev_s, prev_s)}→{s_map.get(curr_s, curr_s)})")

            curr_sc = int(item.get("overall_risk_score") or 0)
            prev_sc = int(older.get("overall_risk_score") or 0)
            risk_delta = curr_sc - prev_sc
            if abs(risk_delta) >= risk_jump_threshold:
                tags.append(f"风险跳变 {risk_delta:+d}")

        item["risk_delta"] = risk_delta
        item["transition_tags"] = tags
        item["has_transition"] = bool(tags)
        out.append(item)
    return out


def init_storage() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    with sqlite3.connect(DB_PATH) as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS runs (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                collected_at_utc TEXT NOT NULL,
                trigger_source TEXT DEFAULT 'auto',
                overall_risk_score INTEGER NOT NULL,
                plumbing_score INTEGER NOT NULL,
                credit_score INTEGER NOT NULL,
                micro_score INTEGER NOT NULL,
                ai_score INTEGER NOT NULL,
                gold_opp_score INTEGER NOT NULL,
                headline TEXT NOT NULL,
                regime_code TEXT,
                gamma_state TEXT,
                sofr_corridor_state TEXT,
                ndx_spot REAL,
                gold_spot REAL,
                move_spot REAL,
                sofr_iorb_bps REAL,
                ccc_yield REAL,
                payload_json TEXT NOT NULL
            )
            """
        )
        cols = {r[1] for r in conn.execute("PRAGMA table_info(runs)").fetchall()}
        migrations = [
            ("trigger_source", "ALTER TABLE runs ADD COLUMN trigger_source TEXT DEFAULT 'auto'"),
            ("regime_code", "ALTER TABLE runs ADD COLUMN regime_code TEXT"),
            ("gamma_state", "ALTER TABLE runs ADD COLUMN gamma_state TEXT"),
            ("sofr_corridor_state", "ALTER TABLE runs ADD COLUMN sofr_corridor_state TEXT"),
            ("move_spot", "ALTER TABLE runs ADD COLUMN move_spot REAL"),
        ]
        for col_name, ddl in migrations:
            if col_name not in cols:
                conn.execute(ddl)
        conn.commit()


def seed_history_from_json(seed_file: Path) -> None:
    """Import prior portable history.json runs if local history.json does not exist yet."""
    if not seed_file.exists():
        return
    init_storage()
    try:
        prior = json.loads(seed_file.read_text(encoding="utf-8"))
        if isinstance(prior, dict) and isinstance(prior.get("runs"), list):
            HISTORY_JSON.write_text(json.dumps(prior, ensure_ascii=False, indent=2), encoding="utf-8")
    except Exception:
        pass


def save_run(full_bundle: dict[str, Any], trigger_source: str = "auto") -> int:
    """Save full snapshot + analysis bundle to latest_snapshot.json, history.json, and SQLite."""
    init_storage()
    full_bundle["trigger_source"] = trigger_source

    snap = full_bundle["snapshot"]
    ana = full_bundle["analysis"]
    pillars = ana["pillars"]
    quotes = snap.get("quotes", {})
    fred_m = snap.get("fred", {}).get("metrics", {})
    fred_d = snap.get("fred", {}).get("derived", {})

    with sqlite3.connect(DB_PATH) as conn:
        cur = conn.execute(
            """
            INSERT INTO runs (
                collected_at_utc, trigger_source, overall_risk_score, plumbing_score, credit_score,
                micro_score, ai_score, gold_opp_score, headline,
                regime_code, gamma_state, sofr_corridor_state,
                ndx_spot, gold_spot, move_spot, sofr_iorb_bps, ccc_yield, payload_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                snap["collected_at_utc"],
                trigger_source,
                ana["overall_risk_score"],
                pillars["plumbing"]["score"],
                pillars["credit"]["score"],
                pillars["microstructure"]["score"],
                pillars["ai_ledger"]["score"],
                pillars["gold_spillover"]["score"],
                ana["headline"],
                ana.get("regime_code"),
                ana.get("gamma_state"),
                ana.get("sofr_corridor_state"),
                quotes.get("^NDX", {}).get("price"),
                quotes.get("GC=F", {}).get("price"),
                quotes.get("^MOVE", {}).get("price"),
                fred_d.get("sofr_iorb_spread", {}).get("value_bps"),
                fred_m.get("BAMLH0A3HYCEY", {}).get("value"),
                json.dumps(full_bundle, ensure_ascii=False),
            ),
        )
        conn.commit()
        run_id = int(cur.lastrowid or 1)

    existing_portable: list[dict[str, Any]] = []
    if HISTORY_JSON.exists():
        try:
            existing_portable = json.loads(HISTORY_JSON.read_text(encoding="utf-8")).get("runs", [])
        except Exception:
            existing_portable = []

    new_summary = {
        "id": (existing_portable[0]["id"] + 1) if existing_portable else run_id,
        "collected_at_utc": snap["collected_at_utc"],
        "trigger_source": trigger_source,
        "overall_risk_score": ana["overall_risk_score"],
        "plumbing_score": pillars["plumbing"]["score"],
        "credit_score": pillars["credit"]["score"],
        "micro_score": pillars["microstructure"]["score"],
        "ai_score": pillars["ai_ledger"]["score"],
        "gold_opp_score": pillars["gold_spillover"]["score"],
        "headline": ana["headline"],
        "regime_code": ana.get("regime_code"),
        "gamma_state": ana.get("gamma_state"),
        "sofr_corridor_state": ana.get("sofr_corridor_state"),
        "ndx_spot": quotes.get("^NDX", {}).get("price"),
        "gold_spot": quotes.get("GC=F", {}).get("price"),
        "move_spot": quotes.get("^MOVE", {}).get("price"),
        "sofr_iorb_bps": fred_d.get("sofr_iorb_spread", {}).get("value_bps"),
        "ccc_yield": fred_m.get("BAMLH0A3HYCEY", {}).get("value"),
    }

    deduped = [new_summary] + [
        r for r in existing_portable if r.get("collected_at_utc") != snap["collected_at_utc"]
    ]
    annotated_portable = _annotate_transitions(deduped[:60])
    HISTORY_JSON.write_text(
        json.dumps({"runs": annotated_portable}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    full_bundle["run_id"] = new_summary["id"]
    LATEST_JSON.write_text(json.dumps(full_bundle, ensure_ascii=False, indent=2), encoding="utf-8")
    return new_summary["id"]


def load_latest_run() -> dict[str, Any] | None:
    if LATEST_JSON.exists():
        return json.loads(LATEST_JSON.read_text(encoding="utf-8"))
    return None


def list_run_history(limit: int = 40) -> list[dict[str, Any]]:
    init_storage()
    with sqlite3.connect(DB_PATH) as conn:
        conn.row_factory = sqlite3.Row
        rows = conn.execute(
            """
            SELECT id, collected_at_utc, trigger_source, overall_risk_score, plumbing_score, credit_score,
                   micro_score, ai_score, gold_opp_score, headline,
                   regime_code, gamma_state, sofr_corridor_state,
                   ndx_spot, gold_spot, move_spot, sofr_iorb_bps, ccc_yield
            FROM runs
            ORDER BY id DESC
            LIMIT ?
            """,
            (limit + 1,),
        ).fetchall()
    db_runs = [dict(r) for r in rows]
    if db_runs:
        return _annotate_transitions(db_runs)[:limit]
    if HISTORY_JSON.exists():
        try:
            raw_runs = json.loads(HISTORY_JSON.read_text(encoding="utf-8")).get("runs", [])[: limit + 1]
            return _annotate_transitions(raw_runs)[:limit]
        except Exception:
            return []
    return []
