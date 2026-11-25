"""Structured Markdown report generator for periodic market checks."""

from __future__ import annotations

from datetime import datetime
from pathlib import Path
from typing import Any

from .storage import REPORTS_DIR


def build_markdown_report(full_bundle: dict[str, Any]) -> str:
    snap = full_bundle["snapshot"]
    ana = full_bundle["analysis"]
    pillars = ana["pillars"]
    fred_m = snap.get("fred", {}).get("metrics", {})
    fred_d = snap.get("fred", {}).get("derived", {})
    quotes = snap.get("quotes", {})
    options = snap.get("options", {})
    ai_ledger = snap.get("ai_ledger", {})

    ts = snap.get("collected_at_utc", "")
    lines: list[str] = [
        f"# 狠人框架 · 全球市场风向与真实数据巡检报告",
        f"",
        f"- **数据抓取时间 (UTC)**：`{ts}`（耗时 `{snap.get('elapsed_seconds')}s`）",
        f"- **综合风险温度计**：**`{ana['overall_risk_score']} / 100`**",
        f"- **核心风向定调**：**{ana['headline']}**",
        f"",
        f"> {ana['summary_verdict']}",
        f"",
        f"---",
        f"",
        f"## 一、核心实时数据 → 触发后果 → 当下操作结论",
        f"",
    ]
    for item in ana.get("live_consequences", []):
        lines.extend([
            f"### {item['domain']}（`{item['freq_badge']}`）",
            f"- **实时数据**：`{item['live_data']}`",
            f"- **产生后果**：{item['consequence']}",
            f"- **当下结论**：**{item['conclusion']}**",
            f"",
        ])

    lines.extend([
        f"---",
        f"",
        f"## 二、五维实时评分与状态总览",
        f"",
        f"| 维度 | 量化分 (0-100) | 当前状态判定 | 核心锚定指标 |",
        f"| :--- | :---: | :--- | :--- |",
        f"| **1. 美元水管** | `{pillars['plumbing']['score']}` | {pillars['plumbing']['status']} | SOFR-IORB `{fred_d.get('sofr_iorb_spread', {}).get('value_bps', 0):+.1f} bps` · ON RRP `${fred_m.get('RRPONTSYD', {}).get('value', 0):.2f}B` · TGA `${fred_m.get('WTREGEN', {}).get('value', 0):.0f}B` |",
        f"| **2. 信用分层** | `{pillars['credit']['score']}` | {pillars['credit']['status']} | CCC收益率 `{fred_m.get('BAMLH0A3HYCEY', {}).get('value', 0):.2f}%` · 10Y实际利率 `{fred_m.get('DFII10', {}).get('value', 0):.2f}%` · 10Y美债 `{fred_m.get('DGS10', {}).get('value', 0):.2f}%` |",
        f"| **3. 期权微结构** | `{pillars['microstructure']['score']}` | {pillars['microstructure']['status']} | 翻转线 `~{options.get('zero_gamma_ndx', 0):,}` · 厚防线 `~{options.get('major_put_wall', {}).get('ndx_equiv', 0):,}` · MOVE `{quotes.get('^MOVE', {}).get('price', 0):.1f}` |",
        f"| **4. AI算力账本** | `{pillars['ai_ledger']['score']}` | {pillars['ai_ledger']['status']} | 年化CapEx `${ai_ledger.get('summary', {}).get('annualized_capex_bn', 0):.0f}B` · 单季合计FCF `${ai_ledger.get('summary', {}).get('quarterly_fcf_bn', 0):+.1f}B` |",
        f"| **5. 黄金机会度** | `{pillars['gold_spillover']['score']}` | {pillars['gold_spillover']['status']} | 黄金 `${quotes.get('GC=F', {}).get('price', 0):,.1f}`（高点回撤 `{quotes.get('GC=F', {}).get('drawdown_52w_pct', 0):.1f}%`）· USD/CNH `{quotes.get('USDCNH=X', {}).get('price', 0):.3f}` |",
        f"",
        f"---",
        f"",
        f"## 三、慢变量账本与分层补充细节",
        f"",
        f"### 1. 美元水管与结算日历",
    ]
    for f in pillars["plumbing"]["findings"]:
        lines.append(f"- {f}")

    lines.extend(["", "### 2. 资金价格与信用分层（「钱没了」vs「钱贵了」）"])
    for f in pillars["credit"]["findings"]:
        lines.append(f"- {f}")

    lines.extend(["", "### 3. 跨资产波动率与期权 Gamma 防线"])
    for f in pillars["microstructure"]["findings"]:
        lines.append(f"- {f}")

    lines.extend([
        "",
        "### 4. AI 云巨头现金流审计与五大见顶信号",
        "",
        "| 见顶信号项 | 触发状态 | 真实数据核验 |",
        "| :--- | :---: | :--- |",
    ])
    for sig in pillars["ai_ledger"]["peak_signals"]:
        badge = "已触发" if sig["triggered"] else "未触发"
        lines.append(f"| {sig['name']} | **{badge}** | {sig['detail']} |")

    if ai_ledger.get("companies"):
        lines.extend([
            "",
            "| 云巨头 | 最新财季 | 经营现金流 (OCF) | 资本开支 (CapEx) | 自由现金流 (FCF) | CapEx / OCF |",
            "| :--- | :---: | :---: | :---: | :---: | :---: |",
        ])
        for c in ai_ledger["companies"]:
            lines.append(
                f"| `{c['symbol']}` | {c['quarter_end']} | ${c['ocf_bn']:.2f}B | ${c['capex_bn']:.2f}B | "
                f"**${c['fcf_bn']:+.2f}B** | `{c['capex_to_ocf_pct']:.1f}%` |"
            )

    lines.extend(["", "### 5. 黄金「打折期」检验与中国外溢参照"])
    for f in pillars["gold_spillover"]["findings"]:
        lines.append(f"- {f}")

    lines.extend([
        "",
        "---",
        "",
        "## 三、大类资产风向与操作策略清单",
        "",
    ])
    for card in ana["allocation_cards"]:
        lines.extend([
            f"### {card['asset']} —— 【{card['stance']}】",
            f"- **核心逻辑**：{card['rationale']}",
            f"- **变盘/右侧触发器**：{card['trigger']}",
            "",
        ])

    lines.append("*免责声明：本系统基于公开真实市场数据与特定宏观微结构框架自动计算生成，仅供投研参考，不构成任何投资建议。*\n")
    return "\n".join(lines)


def write_reports(full_bundle: dict[str, Any]) -> Path:
    REPORTS_DIR.mkdir(parents=True, exist_ok=True)
    md = build_markdown_report(full_bundle)
    latest_path = REPORTS_DIR / "latest_market_brief.md"
    latest_path.write_text(md, encoding="utf-8")

    stamp = datetime.utcnow().strftime("%Y%m%d_%H%M")
    archive_path = REPORTS_DIR / f"brief_{stamp}.md"
    archive_path.write_text(md, encoding="utf-8")
    return latest_path
