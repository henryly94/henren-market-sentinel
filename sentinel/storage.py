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
                ndx_spot REAL,
                gold_spot REAL,
                sofr_iorb_bps REAL,
                ccc_yield REAL,
                payload_json TEXT NOT NULL
            )
            """
        )
        # Ensure trigger_source column exists if upgrading from earlier schema
        cols = {r[1] for r in conn.execute("PRAGMA table_info(runs)").fetchall()}
        if "trigger_source" not in cols:
            conn.execute("ALTER TABLE runs ADD COLUMN trigger_source TEXT DEFAULT 'auto'")
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
                ndx_spot, gold_spot, sofr_iorb_bps, ccc_yield, payload_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                quotes.get("^NDX", {}).get("price"),
                quotes.get("GC=F", {}).get("price"),
                fred_d.get("sofr_iorb_spread", {}).get("value_bps"),
                fred_m.get("BAMLH0A3HYCEY", {}).get("value"),
                json.dumps(full_bundle, ensure_ascii=False),
            ),
        )
        conn.commit()
        run_id = int(cur.lastrowid or 1)

    # Also update portable history.json (merges SQLite + any seeded portable runs, deduped by timestamp)
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
        "ndx_spot": quotes.get("^NDX", {}).get("price"),
        "gold_spot": quotes.get("GC=F", {}).get("price"),
        "sofr_iorb_bps": fred_d.get("sofr_iorb_spread", {}).get("value_bps"),
        "ccc_yield": fred_m.get("BAMLH0A3HYCEY", {}).get("value"),
    }

    deduped = [new_summary] + [
        r for r in existing_portable if r.get("collected_at_utc") != snap["collected_at_utc"]
    ]
    HISTORY_JSON.write_text(
        json.dumps({"runs": deduped[:60]}, ensure_ascii=False, indent=2),
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
                   ndx_spot, gold_spot, sofr_iorb_bps, ccc_yield
            FROM runs
            ORDER BY id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    db_runs = [dict(r) for r in rows]
    if db_runs:
        return db_runs
    if HISTORY_JSON.exists():
        try:
            return json.loads(HISTORY_JSON.read_text(encoding="utf-8")).get("runs", [])[:limit]
        except Exception:
            return []
    return []
