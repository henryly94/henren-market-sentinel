"""Smart event-aware & market-session-aware adaptive scheduler for Henren Market Sentinel."""

from __future__ import annotations

import calendar
from datetime import date, datetime, time, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

import numpy as np

ET_TZ = ZoneInfo("America/New_York")

# Known FOMC rate decision dates (2026 Q4 - 2027)
FOMC_DATES: set[str] = {
    "2026-10-28",
    "2026-12-09",
    "2026-12-16",
    "2027-01-27",
    "2027-03-17",
    "2027-05-05",
    "2027-06-16",
    "2027-07-28",
    "2027-09-22",
    "2027-11-03",
    "2027-12-15",
}


def _third_friday(year: int, month: int) -> date:
    """Return the 3rd Friday (monthly OPEX / Quad Witching) of a given month."""
    cal = calendar.monthcalendar(year, month)
    fridays = [week[calendar.FRIDAY] for week in cal if week[calendar.FRIDAY] != 0]
    return date(year, month, fridays[2])


def _last_business_day(year: int, month: int) -> date:
    d = date(year, month, calendar.monthrange(year, month)[1])
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def _bdays_until(d1: date, d2: date) -> int:
    if d2 <= d1:
        return 0
    return int(np.busday_count(d1.isoformat(), d2.isoformat()))


def compute_smart_schedule_plan(now_utc: datetime | None = None) -> dict[str, Any]:
    """
    Evaluate current timestamp against:
      1. Periodic baseline (regular market hours vs overnight vs weekend)
      2. Plumbing official fixings (08:05 ET SOFR, 13:20 ET ON RRP, 17:15 ET FRED CCC/TIPS, Thu 16:35 ET Fed H.4.1)
      3. Options Negative-Gamma windows (09:30-10:15 ET open, 15:30-16:10 ET close, OPEX/Quad Witching week)
      4. Month-end / Quarter-end / Year-end repo settlement alert window (last 5 trading days) & FOMC days
      5. On-visit staleness threshold (how old data can be before a user visit triggers instant background refresh)
    """
    now_u = now_utc or datetime.now(timezone.utc)
    now_et = now_u.astimezone(ET_TZ)
    today_et = now_et.date()
    t_et = now_et.time()
    is_weekday = today_et.weekday() < 5

    # Calendar proximity checks
    me_date = _last_business_day(today_et.year, today_et.month)
    q_month = ((today_et.month - 1) // 3 + 1) * 3
    qe_date = _last_business_day(today_et.year, q_month)
    ye_date = _last_business_day(today_et.year, 12)
    opex_date = _third_friday(today_et.year, today_et.month)

    bdays_me = _bdays_until(today_et, me_date)
    bdays_qe = _bdays_until(today_et, qe_date)
    bdays_ye = _bdays_until(today_et, ye_date)

    in_settlement_danger = bool(bdays_me <= 5 or bdays_qe <= 6)
    is_opex_week = bool(0 <= (opex_date - today_et).days <= 4)
    is_fomc_day = today_et.isoformat() in FOMC_DATES

    # Determine active regime mode & intervals
    active_window_tags: list[str] = []
    if in_settlement_danger:
        active_window_tags.append(f"月末/季末结算前{bdays_me}交易日警戒")
    if is_opex_week:
        active_window_tags.append("月度期权交割/四巫日周")
    if is_fomc_day:
        active_window_tags.append("FOMC议息决议日")

    if not is_weekday:
        mode_code = "WEEKEND_WATCH"
        mode_label = "周末休市巡检模式"
        mode_reason = "美股与回购市场休市，低频跟踪周末地缘与加密/离岸动态"
        interval_minutes = 360
        visit_stale_seconds = 3600
    else:
        # Check exact intraday critical windows (ET)
        in_sofr_fixing = time(8, 2) <= t_et <= time(8, 25)
        in_open_gamma = time(9, 28) <= t_et <= time(10, 15)
        in_rrp_fixing = time(13, 15) <= t_et <= time(13, 35)
        in_fomc_window = is_fomc_day and (time(13, 55) <= t_et <= time(15, 35))
        in_close_gamma = time(15, 25) <= t_et <= time(16, 12)
        in_fred_close = time(16, 35) <= t_et <= time(17, 30)
        in_h41_release = (today_et.weekday() == 3) and (time(16, 30) <= t_et <= time(17, 10))
        in_regular_rth = time(9, 30) <= t_et <= time(16, 15)
        in_us_extended = time(7, 30) <= t_et <= time(18, 0)

        if in_fomc_window:
            mode_code = "CRITICAL_FOMC"
            mode_label = "FOMC 决议与发布会高频盯盘"
            mode_reason = "美联储利率决议窗口，实时监测 SOFR 远期、美债 MOVE 与纳指负 Gamma 脉冲"
            interval_minutes = 8
            visit_stale_seconds = 180
        elif in_open_gamma or in_close_gamma:
            mode_code = "CRITICAL_GAMMA_WINDOW"
            mode_label = "美股开/收盘负 Gamma 脉冲窗口"
            mode_reason = "做市商集中对冲调仓时段（09:30-10:15 / 15:30-16:10 ET），双向波动放大"
            interval_minutes = 10
            visit_stale_seconds = 180
        elif in_sofr_fixing or in_rrp_fixing or in_fred_close or in_h41_release:
            mode_code = "PLUMBING_FIXING"
            mode_label = "美元水管官方数据放榜窗口"
            mode_reason = "纽约联储 SOFR (08:05) / ON RRP (13:20) / FRED 信用利差与 H.4.1 资产负债表更新时段"
            interval_minutes = 12
            visit_stale_seconds = 240
        elif in_regular_rth and (in_settlement_danger or is_opex_week):
            mode_code = "SETTLEMENT_HIGH_ALERT"
            mode_label = "结算大考 / 期权交割周加密巡检"
            mode_reason = f"距月末回购结算仅 {bdays_me} 个交易日，一级交易商缩表窗口期盘中加密监控"
            interval_minutes = 20
            visit_stale_seconds = 300
        elif in_regular_rth:
            mode_code = "REGULAR_MARKET_HOURS"
            mode_label = "美股盘中常规巡检"
            mode_reason = "美股常规交易时段，持续跟踪期权筹码墙与跨资产涨跌"
            interval_minutes = 45
            visit_stale_seconds = 420
        elif in_us_extended:
            mode_code = "EXTENDED_HOURS"
            mode_label = "美股盘前/盘后观察期"
            mode_reason = "跟踪盘前宏观数据冲击与盘后科技巨头财报反应"
            interval_minutes = 60
            visit_stale_seconds = 600
        else:
            mode_code = "OVERNIGHT_ASIA_EUROPE"
            mode_label = "亚欧盘夜间巡检（黄金/离岸汇率）"
            mode_reason = "跟踪 COMEX 黄金夜盘、离岸人民币 USD/CNH 与中韩股市外溢表现"
            interval_minutes = 120 if in_settlement_danger else 180
            visit_stale_seconds = 900

    # Build upcoming daily/structural critical checkpoints in UTC + ET
    upcoming_checkpoints = _build_upcoming_checkpoints(now_et, me_date, ye_date, opex_date)

    return {
        "evaluated_at_utc": now_u.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "evaluated_at_et": now_et.strftime("%Y-%m-%d %H:%M ET"),
        "mode_code": mode_code,
        "mode_label": mode_label,
        "mode_reason": mode_reason,
        "interval_minutes": interval_minutes,
        "interval_seconds": interval_minutes * 60,
        "visit_stale_seconds": visit_stale_seconds,
        "in_settlement_danger": in_settlement_danger,
        "is_opex_week": is_opex_week,
        "active_window_tags": active_window_tags,
        "upcoming_checkpoints": upcoming_checkpoints,
    }


def _next_weekday_occurrence(now_et: datetime, hour: int, minute: int) -> datetime:
    candidate = now_et.replace(hour=hour, minute=minute, second=0, microsecond=0)
    if candidate <= now_et:
        candidate += timedelta(days=1)
    while candidate.weekday() >= 5:
        candidate += timedelta(days=1)
    return candidate


def _build_upcoming_checkpoints(
    now_et: datetime, me_date: date, ye_date: date, opex_date: date
) -> list[dict[str, Any]]:
    daily_slots = [
        (8, 5, "纽约联储 SOFR 隔夜回购利率放榜", "检验 SOFR-IORB 是否倒挂突破走廊"),
        (9, 30, "美股开盘负 Gamma 对冲脉冲窗口", "观察做市商开盘追涨杀跌方向与期权墙得失"),
        (13, 20, "纽约联储 ON RRP 逆回购操作结果", "监测隔夜逆回购缓冲垫抽水/回流"),
        (15, 30, "美股尾盘 MOC 与 0DTE 结算窗口", "全天衍生品杠杆集中再平衡高危时段"),
        (17, 15, "FRED 每日信用利差与实际利率更新", "核查 CCC级垃圾债收益率(~18%)与 10Y TIPS"),
    ]
    events: list[dict[str, Any]] = []
    for h, m, title, purpose in daily_slots:
        dt_et = _next_weekday_occurrence(now_et, h, m)
        dt_utc = dt_et.astimezone(timezone.utc)
        mins_away = int(round((dt_utc - now_et.astimezone(timezone.utc)).total_seconds() / 60.0))
        events.append({
            "title": title,
            "purpose": purpose,
            "time_et": dt_et.strftime("%m-%d %H:%M ET"),
            "time_utc": dt_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "minutes_away": mins_away,
            "kind": "intraday",
        })

    events.sort(key=lambda x: x["minutes_away"])

    # Append structural calendar milestones
    structural = [
        (me_date, "月末一级交易商回购结算大考", "「11月30日见真章」：检验无RRP缓冲下回购利率是否跳升"),
        (opex_date if opex_date >= now_et.date() else _third_friday(
            now_et.year + (1 if now_et.month == 12 else 0),
            1 if now_et.month == 12 else now_et.month + 1
        ), "月度期权/四巫日大规模交割 (OPEX)", "大量 Put/Call 未平仓到期脱钩，正负 Gamma 翻转重设"),
        (ye_date, "年末银行监管缩表终极大考", "「12月31日见真章」：全年流动性管道最紧节点"),
    ]
    for d, title, purpose in structural:
        dt_et = datetime(d.year, d.month, d.day, 16, 0, tzinfo=ET_TZ)
        dt_utc = dt_et.astimezone(timezone.utc)
        events.append({
            "title": title,
            "purpose": purpose,
            "time_et": f"{d.isoformat()} (结算日)",
            "time_utc": dt_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "minutes_away": max(0, int(round((dt_utc - now_et.astimezone(timezone.utc)).total_seconds() / 60.0))),
            "kind": "structural",
        })

    return events
