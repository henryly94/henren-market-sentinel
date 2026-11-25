#!/usr/bin/env python3
"""CLI entrypoint for Henren Market Sentinel (one-shot, smart daemon, or static PWA site builder)."""

from __future__ import annotations

import argparse
import logging
import shutil
import time
from pathlib import Path
from typing import Any

from sentinel.analyzer import analyze_market_snapshot
from sentinel.collectors import collect_all_market_data
from sentinel.report_builder import write_reports
from sentinel.scheduler import compute_smart_schedule_plan
from sentinel.storage import BASE_DIR, DATA_DIR, REPORTS_DIR, list_run_history, save_run, seed_history_from_json


def execute_market_check(trigger_source: str = "cli") -> dict[str, Any]:
    """Run full data collection, 5-layer regime analysis (with Hysteresis), smart schedule plan, and report output."""
    prior_runs = list_run_history(limit=1)
    prev_run = prior_runs[0] if prior_runs else None

    snapshot = collect_all_market_data()
    analysis = analyze_market_snapshot(snapshot, prev_run=prev_run)
    schedule_plan = compute_smart_schedule_plan()
    bundle: dict[str, Any] = {
        "snapshot": snapshot,
        "analysis": analysis,
        "scheduler": schedule_plan,
        "fallback_cached": False,
    }
    run_id = save_run(bundle, trigger_source=trigger_source)
    report_path = write_reports(bundle)
    bundle["run_id"] = run_id
    bundle["report_path"] = str(report_path)
    return bundle


def export_static_site(out_dir: Path) -> None:
    """Export a self-contained static PWA site (HTML/CSS/JS/Manifest/Data/Reports) for GitHub Pages."""
    static_src = BASE_DIR / "static"
    if out_dir.exists():
        shutil.rmtree(out_dir)
    shutil.copytree(static_src, out_dir)

    data_out = out_dir / "data"
    data_out.mkdir(parents=True, exist_ok=True)
    for fname in ("latest_snapshot.json", "history.json"):
        src = DATA_DIR / fname
        if src.exists():
            shutil.copy2(src, data_out / fname)

    rep_out = out_dir / "reports"
    rep_out.mkdir(parents=True, exist_ok=True)
    latest_md = REPORTS_DIR / "latest_market_brief.md"
    if latest_md.exists():
        shutil.copy2(latest_md, rep_out / "latest_market_brief.md")

    # Add .nojekyll so GitHub Pages serves all files cleanly
    (out_dir / ".nojekyll").write_text("", encoding="utf-8")


def main() -> None:
    parser = argparse.ArgumentParser(description="狠人框架 · 真实市场数据智能巡检与风向解读引擎")
    parser.add_argument("--watch", action="store_true", help="开启智能自适应周期与关键窗口守护巡检")
    parser.add_argument(
        "--trigger",
        type=str,
        default="cli",
        help="记录本次抓取触发来源（如 cli / smart_cron / github_actions / manual）",
    )
    parser.add_argument(
        "--seed-history",
        type=str,
        default="",
        help="导入已有的 history.json 历史巡检记录路径（用于云端 CI 延续历史）",
    )
    parser.add_argument(
        "--export-static-site",
        type=str,
        default="",
        help="输出完整静态 PWA 站点到指定目录（用于部署 GitHub Pages）",
    )
    args = parser.parse_args()

    logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")

    if args.seed_history:
        seed_history_from_json(Path(args.seed_history))

    while True:
        plan = compute_smart_schedule_plan()
        src = plan["mode_code"].lower() if args.watch else args.trigger
        logging.info("开始拉取真实市场数据 [触发源=%s | 当前档位=%s]...", src, plan["mode_label"])
        bundle = execute_market_check(trigger_source=src)
        ana = bundle["analysis"]
        snap = bundle["snapshot"]
        logging.info("巡检完成 (Run #%s, 耗时 %ss)", bundle["run_id"], snap["elapsed_seconds"])
        logging.info("综合风险分: %s/100 | 定调: %s", ana["overall_risk_score"], ana["headline"])

        if args.export_static_site:
            out_path = Path(args.export_static_site).resolve()
            export_static_site(out_path)
            logging.info("已导出静态移动端 PWA 站点至: %s", out_path)

        if not args.watch:
            break

        next_plan = compute_smart_schedule_plan()
        wait_mins = next_plan["interval_minutes"]
        logging.info(
            "智能调度器当前处于【%s】，下次自动抓取将在 %d 分钟后执行...",
            next_plan["mode_label"],
            wait_mins,
        )
        # Re-evaluate schedule every 60s so entering a critical window triggers promptly
        slept = 0
        while slept < wait_mins * 60:
            time.sleep(60)
            slept += 60
            live_plan = compute_smart_schedule_plan()
            if slept >= live_plan["interval_seconds"]:
                break


if __name__ == "__main__":
    main()
