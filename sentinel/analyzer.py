"""「一个狠人」(@henren778) Five-Layer Market Regime & Opportunity Engine."""

from __future__ import annotations

from typing import Any


def _clamp(val: float, lo: float = 0.0, hi: float = 100.0) -> int:
    return int(round(max(lo, min(hi, val))))


def analyze_market_snapshot(
    snapshot: dict[str, Any],
    prev_run: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Run the 5-pillar Henren analytical framework with Hysteresis anti-whipsaw buffers."""
    fred_m = snapshot.get("fred", {}).get("metrics", {})
    fred_d = snapshot.get("fred", {}).get("derived", {})
    quotes = snapshot.get("quotes", {})
    options = snapshot.get("options", {})
    ai_ledger = snapshot.get("ai_ledger", {})
    cal = snapshot.get("calendar", {})
    prev = prev_run or {}

    # -------------------------------------------------------------------------
    # 1. DOLLAR PLUMBING ("美元水管：钱没了还是管道尚稳？" + SOFR Hysteresis + MOVE 前置预警)
    # -------------------------------------------------------------------------
    sofr_info = fred_d.get("sofr_iorb_spread", {})
    sofr_sp = sofr_info.get("value_bps", 0.0)
    consec_sofr_gt0 = int(sofr_info.get("consecutive_days_above_zero", 1 if sofr_sp > 0 else 0))
    sofr_val = fred_m.get("SOFR", {}).get("value", 0.0)
    iorb_val = fred_m.get("IORB", {}).get("value", 0.0)
    rrp_bn = fred_m.get("RRPONTSYD", {}).get("value", 0.0)
    tga_bn = fred_m.get("WTREGEN", {}).get("value", 0.0)
    reserves_bn = fred_m.get("WRESBAL", {}).get("value", 3200.0)
    net_liq = fred_d.get("net_liquidity", {})
    net_liq_tn = net_liq.get("value_tn", 5.5)
    net_liq_chg_4w = net_liq.get("chg_4w_bn", 0.0)
    bdays_me = cal.get("bdays_to_month_end", 10)
    bdays_ye = cal.get("bdays_to_year_end", 30)

    move_q = quotes.get("^MOVE", {})
    move_val = move_q.get("price", 98.0)
    move_chg_20 = move_q.get("chg_20_abs", 0.0)
    move_pct_1y = move_q.get("pct_1y", 50.0)

    # SOFR - IORB Corridor Hysteresis:
    # Single-day minor breach (>0 bps, <8 bps) = Yellow "观察/临界试探中"; >=2 consecutive days = Red "水管吃紧确认"
    prev_sofr_state = prev.get("sofr_corridor_state")
    if sofr_sp >= 8.0 or (sofr_sp > 0.0 and consec_sofr_gt0 >= 2):
        sofr_corridor_state = "STRESS_CONFIRMED"
        sofr_hysteresis_note = (
            f"连续 {max(consec_sofr_gt0, 2)} 个交易日突破走廊上限（水管吃紧红灯确认）"
            if sofr_sp < 8.0
            else "单日大幅击穿走廊上限 ≥8bps（显性钱荒红灯告警）"
        )
    elif 0.0 < sofr_sp < 8.0 and consec_sofr_gt0 == 1:
        sofr_corridor_state = "BUFFER_OBSERVE"
        sofr_hysteresis_note = "临界试探中：单日轻微越界（仅 1 日 >0 bps），记观察/黄灯，连续 2 日越界再升级红灯"
    elif prev_sofr_state == "STRESS_CONFIRMED" and -0.5 <= sofr_sp <= 0.0:
        sofr_corridor_state = "BUFFER_OBSERVE"
        sofr_hysteresis_note = "临界试探中：刚回落至走廊上沿 0 bps 附近，待跌破 -0.5 bps 确认解除紧绷"
    else:
        sofr_corridor_state = "NORMAL_CORRIDOR"
        sofr_hysteresis_note = "位于 IORB 走廊上限之内（绿灯平稳）"

    plumbing_score = 15.0
    if sofr_sp > 12:
        plumbing_score += 40
    elif sofr_sp > 4:
        plumbing_score += 26 if sofr_corridor_state == "STRESS_CONFIRMED" else 14
    elif sofr_sp > 0:
        plumbing_score += 18 if sofr_corridor_state == "STRESS_CONFIRMED" else 8

    # MOVE Treasury Volatility leading plumbing stress check
    if move_val >= 120 or (move_pct_1y >= 85 and move_chg_20 >= 8.0):
        plumbing_score += 8

    # ON RRP buffer depletion
    if rrp_bn < 20:
        plumbing_score += 22
    elif rrp_bn < 150:
        plumbing_score += 14
    elif rrp_bn < 400:
        plumbing_score += 6

    # Bank reserves vs $3.0T LCLoR red line
    if reserves_bn < 2900:
        plumbing_score += 22
    elif reserves_bn < 3050:
        plumbing_score += 14
    elif reserves_bn < 3250:
        plumbing_score += 6

    # TGA cash hoarding (> $800B drains private reserves)
    if tga_bn > 850:
        plumbing_score += 10
    elif tga_bn > 700:
        plumbing_score += 5

    # Month-end / Year-end settlement proximity
    if bdays_me <= 5 or bdays_ye <= 8:
        plumbing_score += 8

    plumbing_score_int = _clamp(plumbing_score)
    plumbing_exploded = bool(sofr_sp >= 8.0 or (sofr_sp >= 5.0 and consec_sofr_gt0 >= 2) or reserves_bn < 2800)

    if plumbing_exploded:
        plumbing_status = "管道爆裂告警（钱荒显性化 · 红灯确认）"
        plumbing_level = "danger"
    elif sofr_corridor_state == "STRESS_CONFIRMED":
        plumbing_status = f"连续 {consec_sofr_gt0} 日破走廊 · 水管吃紧确认（红灯）"
        plumbing_level = "danger" if plumbing_score_int >= 72 else "warning"
    elif sofr_corridor_state == "BUFFER_OBSERVE":
        plumbing_status = "走廊临界试探中（单日毛刺观察 · 黄灯未升级）"
        plumbing_level = "warning"
    elif plumbing_score_int >= 60:
        plumbing_status = "缓冲垫归零 · 紧绷未炸（盯死月末/年末结算）"
        plumbing_level = "warning"
    else:
        plumbing_status = "回购管道平稳（流动性充裕）"
        plumbing_level = "ok"

    plumbing_findings = [
        f"SOFR ({sofr_val:.2f}%) 较 IORB ({iorb_val:.2f}%) 利差为 {sofr_sp:+.1f} bps（{sofr_hysteresis_note}）。",
        f"前置预警指标 MOVE 美债波动率报 {move_val:.1f}（20日变化 {move_chg_20:+.1f} 点，1年分位 {move_pct_1y:.0f}%）："
        "美债做市商资产负债表抽紧时 MOVE 常领先于隔夜回购利率异动，是「联储被迫修管道」的前置风向标。",
        f"隔夜逆回购 ON RRP 仅剩 ${rrp_bn:.2f}B（近乎彻底归零），银行准备金 ${reserves_bn/1000:.2f}T "
        + ("已跌破 $3.0T 稀缺警戒线，任何边际抽水都会直接冲击准备金。" if reserves_bn < 3000 else "尚在 $3.0T 红线之上。"),
        f"财政部账户 TGA 高达 ${tga_bn:.0f}B（近4周净流动性变化 {net_liq_chg_4w:+.0f}B，当前净流动性 ${net_liq_tn:.2f}T）；"
        f"距月末结算（{cal.get('month_end_settlement')}）{bdays_me} 个交易日，距年末 {bdays_ye} 个交易日。",
    ]

    # -------------------------------------------------------------------------
    # 2. CREDIT TIERING & COST OF MONEY ("不是钱没了，是钱贵了 · 最烂的债先炸")
    # -------------------------------------------------------------------------
    ccc_yield = fred_m.get("BAMLH0A3HYCEY", {}).get("value", 12.0)
    ccc_oas = fred_m.get("BAMLH0A3HYC", {}).get("value", 8.0)
    hy_oas = fred_m.get("BAMLH0A0HYM2", {}).get("value", 3.5)
    ig_oas = fred_m.get("BAMLC0A0CM", {}).get("value", 1.0)
    dgs10 = fred_m.get("DGS10", {}).get("value", 4.2)
    dgs2 = fred_m.get("DGS2", {}).get("value", 4.0)
    real_10y = fred_m.get("DFII10", {}).get("value", 2.0)
    breakeven_10y = fred_m.get("T10YIE", {}).get("value", 2.2)

    ccc_hy_ratio = round(ccc_oas / max(hy_oas, 0.1), 2)
    ccc_ig_ratio = round(ccc_oas / max(ig_oas, 0.1), 1)

    credit_score = 15.0
    if ccc_yield >= 17.0:
        credit_score += 36
    elif ccc_yield >= 14.5:
        credit_score += 25
    elif ccc_yield >= 12.5:
        credit_score += 12

    if ccc_hy_ratio >= 3.4:
        credit_score += 20
    elif ccc_hy_ratio >= 2.8:
        credit_score += 10

    if real_10y >= 2.5:
        credit_score += 18
    elif real_10y >= 2.0:
        credit_score += 10

    if dgs10 >= 4.7:
        credit_score += 12
    elif dgs10 >= 4.3:
        credit_score += 6

    credit_score_int = _clamp(credit_score)

    if not plumbing_exploded and ccc_yield >= 15.0:
        money_diagnosis = "不是钱没了，是钱贵了（边缘信用定向爆破）"
        credit_level = "danger"
    elif plumbing_exploded and hy_oas >= 4.5:
        money_diagnosis = "全面信用与流动性双重冻结"
        credit_level = "danger"
    elif credit_score_int >= 55:
        money_diagnosis = "高实际利率压制 · 信用利差走阔初期"
        credit_level = "warning"
    else:
        money_diagnosis = "资金成本温和 · 信用顺畅"
        credit_level = "ok"

    credit_findings = [
        f"CCC级及以下垃圾债有效收益率飙至 {ccc_yield:.2f}%（OAS {ccc_oas:.2f}%），而投资级利差仅 {ig_oas:.2f}%、整体高收益利差 {hy_oas:.2f}%。",
        f"信用撕裂比（CCC / HY OAS）高达 {ccc_hy_ratio:.2f}x（CCC / IG 达 {ccc_ig_ratio:.1f}x）：典型的「底层烂债先炸」，二线高杠杆算力债与垃圾债已处违约重定价区，而表层大盘尚未完全计价。",
        f"无风险资金依然昂贵：10Y美债 {dgs10:.2f}%、2Y美债 {dgs2:.2f}%，10Y TIPS 实际利率高达 {real_10y:.2f}%（通胀预期 {breakeven_10y:.2f}%）。",
        "联储反应函数判定：只要回购管道未全面爆裂、IG利差未失控，美联储「只认管道不认股价」，不会因高估值科技股回调而轻易转向降息。",
    ]

    # -------------------------------------------------------------------------
    # 3. VOLATILITY SCISSORS & OPTIONS GAMMA ("MOVE vs VXN · Zero-Gamma 滞回缓冲与防线")
    # -------------------------------------------------------------------------
    vxn_q = quotes.get("^VXN", {})
    vix_q = quotes.get("^VIX", {})
    ndx_q = quotes.get("^NDX", {})
    nvda_q = quotes.get("NVDA", {})

    move_pct = move_q.get("pct_1y", 50.0)
    vxn_val = vxn_q.get("price") or fred_m.get("VXNCLS", {}).get("value", 25.0)
    vxn_pct = vxn_q.get("pct_1y") or fred_m.get("VXNCLS", {}).get("pct_1y", 50.0)
    vix_val = vix_q.get("price", 20.0)
    vol_scissors = round(move_pct - vxn_pct, 1)

    zero_gamma_ndx = options.get("zero_gamma_ndx", 27000)
    put_wall = options.get("major_put_wall", {})
    near_put = options.get("near_put_support", {})
    call_wall = options.get("major_call_wall", {})
    psych_check = options.get("psych_25000_check", {})
    ndx_spot = ndx_q.get("price", 26215.0)

    # Zero-Gamma Hysteresis (±0.75% spatial buffer + 30m persistence + prior run state check)
    gh = options.get("gamma_hysteresis", {})
    lo_gamma_ndx = int(gh.get("lower_band_ndx") or round(zero_gamma_ndx * 0.9925))
    hi_gamma_ndx = int(gh.get("upper_band_ndx") or round(zero_gamma_ndx * 1.0075))
    held_30m_below = gh.get("held_30m_below", True)
    held_30m_above = gh.get("held_30m_above", True)
    prev_gamma_state = prev.get("gamma_state")

    if lo_gamma_ndx <= ndx_spot <= hi_gamma_ndx:
        gamma_state = "BUFFER_PROBING"
    elif ndx_spot < lo_gamma_ndx:
        if prev_gamma_state == "POSITIVE_CONFIRMED" and held_30m_below is False:
            gamma_state = "BUFFER_PROBING"
        else:
            gamma_state = gh.get("gamma_state") if gh.get("gamma_state") == "BUFFER_PROBING" else "NEGATIVE_CONFIRMED"
    else:
        if prev_gamma_state == "NEGATIVE_CONFIRMED" and held_30m_above is False:
            gamma_state = "BUFFER_PROBING"
        else:
            gamma_state = gh.get("gamma_state") if gh.get("gamma_state") == "BUFFER_PROBING" else "POSITIVE_CONFIRMED"

    gamma_in_buffer = bool(gamma_state == "BUFFER_PROBING")
    if gamma_state == "NEGATIVE_CONFIRMED":
        in_neg_gamma = True
    elif gamma_state == "POSITIVE_CONFIRMED":
        in_neg_gamma = False
    else:
        # Inside buffer: hold prior confirmed posture if available, else lean on raw net GEX
        if prev_gamma_state == "POSITIVE_CONFIRMED":
            in_neg_gamma = False
        elif prev_gamma_state == "NEGATIVE_CONFIRMED":
            in_neg_gamma = True
        else:
            in_neg_gamma = bool(options.get("in_negative_gamma", ndx_spot < zero_gamma_ndx))

    micro_score = 20.0
    if gamma_state == "NEGATIVE_CONFIRMED":
        micro_score += 32
    elif gamma_state == "BUFFER_PROBING":
        micro_score += 18  # Buffered transition score avoids ±32 cliff jumps
    if vxn_val >= 30:
        micro_score += 20
    elif vxn_val >= 24:
        micro_score += 10
    if vol_scissors >= 35:
        micro_score += 22
    elif abs(vol_scissors) <= 15 and move_pct >= 70 and vxn_pct >= 70:
        micro_score += 18
    if options.get("put_call_oi_ratio", 1.0) >= 1.25:
        micro_score += 10

    micro_score_int = _clamp(micro_score)

    # Detect "Bounce vs Reversal" ("反抽 vs 反转")
    is_dead_cat_bounce = bool(
        in_neg_gamma
        and not gamma_in_buffer
        and credit_score_int >= 60
        and (ndx_q.get("ret_5d_pct", 0) > 1.5 or nvda_q.get("ret_5d_pct", 0) > 8.0)
    )

    if gamma_in_buffer:
        micro_status = f"翻转线临界试探中（{lo_gamma_ndx:,}~{hi_gamma_ndx:,} 缓冲带 · 暂不翻多空）"
        micro_level = "warning"
    elif is_dead_cat_bounce:
        micro_status = "负Gamma确认 · 做市商对冲挤压型「反抽」（非反转）"
        micro_level = "danger"
    elif in_neg_gamma:
        micro_status = "负Gamma双向放大确认 · 紧盯下方Put Wall防线"
        micro_level = "warning"
    elif vol_scissors >= 35:
        micro_status = "债市巨震股市装睡（MOVE-VXN高剪刀差背离）"
        micro_level = "warning"
    else:
        micro_status = "正Gamma波动收敛确认（做市商高抛低吸护盘）"
        micro_level = "ok"

    pw_ndx = put_wall.get("ndx_equiv", 24650)
    pw_qqq = put_wall.get("qqq_strike", 600)
    pw_oi = put_wall.get("open_interest", 0)
    cw_ndx = call_wall.get("ndx_equiv", 28750)
    cw_qqq = call_wall.get("qqq_strike", 700)
    ratio_25k = psych_check.get("wall_to_25000_oi_ratio", 1.0)

    micro_findings = [
        (
            f"Gamma 状态（临界试探中）：纳指100现价 {ndx_spot:,.0f} 落入翻转线 ~{zero_gamma_ndx:,.0f} 的 ±0.75% / 30分钟滞回缓冲带（{lo_gamma_ndx:,}~{hi_gamma_ndx:,}），"
            "盘中尚未完成持续站稳确认，暂维持原有多空定调防假突破打脸。"
            if gamma_in_buffer
            else f"Gamma 状态：纳指100现价 {ndx_spot:,.0f} 位于 0–45 DTE 翻转线（~{zero_gamma_ndx:,.0f}，缓冲带 {lo_gamma_ndx:,}~{hi_gamma_ndx:,}）"
            + (
                "下方且已过缓冲确认，处于【负 Gamma 区间】—— 做市商被迫追涨杀跌，利好脉冲极易回吐、下跌波动机械放大。"
                if in_neg_gamma
                else "上方且已过缓冲确认，处于【正 Gamma 区间】，做市商高抛低吸抑制日内波动。"
            )
        ),
        f"真实期权防线 vs 整数幻觉：多头最厚看跌期权墙在 QQQ ${pw_qqq:.0f}（对应纳指 ~{pw_ndx:,} 点，未平仓 {pw_oi:,} 张），"
        f"筹码厚度约为纳指 25,000 整数位附近的 {ratio_25k:.1f} 倍；近端支撑在 QQQ ${near_put.get('qqq_strike', 635):.0f}（~{near_put.get('ndx_equiv', 26087):,}），上方最大阻力墙在 QQQ ${cw_qqq:.0f}（~{cw_ndx:,}）。",
        f"跨资产波动率：美债 MOVE {move_val:.1f}（20日 {move_chg_20:+.1f} 点，1年分位 {move_pct:.0f}%） vs 纳指 VXN {vxn_val:.1f}（1年分位 {vxn_pct:.0f}%），VIX {vix_val:.1f}，剪刀差 {vol_scissors:+.0f} 个百分位点。",
    ]

    # -------------------------------------------------------------------------
    # 4. AI CAPEX LEDGER & 5 PEAK SIGNALS ("AI算力账本审计与五大见顶信号")
    # -------------------------------------------------------------------------
    ai_sum = ai_ledger.get("summary", {})
    neg_fcf_n = ai_sum.get("negative_fcf_count", 0)
    total_ai_n = max(ai_sum.get("total_audited", 5), 1)
    ann_capex_bn = ai_sum.get("annualized_capex_bn", 0.0)
    q_fcf_bn = ai_sum.get("quarterly_fcf_bn", 0.0)
    agg_capex_ocf = ai_sum.get("agg_capex_to_ocf_pct", 0.0)

    ant_q = quotes.get("ANT", {})
    crwv_q = quotes.get("CRWV", {})
    avgo_q = quotes.get("AVGO", {})

    ant_broken_ipo = bool(ant_q and ant_q.get("vs_ipo_pct", 0.0) < 0.0)
    crwv_weak = bool(crwv_q and (crwv_q.get("drawdown_52w_pct", 0.0) < -25.0 or crwv_q.get("ret_1d_pct", 0.0) < -5.0))

    peak_signals = [
        {
            "name": "云巨头自由现金流转负",
            "triggered": bool(neg_fcf_n >= 2 or q_fcf_bn < 0),
            "detail": f"{neg_fcf_n}/{total_ai_n} 家云巨头单季 FCF 转负，五巨头合计单季 FCF ${q_fcf_bn:+.1f}B",
        },
        {
            "name": "万亿级算力账单吞噬经营现金流",
            "triggered": bool(agg_capex_ocf >= 85.0 or ann_capex_bn >= 750.0),
            "detail": f"五巨头年化 CapEx 高达 ${ann_capex_bn:.0f}B，占经营现金流比例达 {agg_capex_ocf:.1f}%",
        },
        {
            "name": "超级IPO山顶抽血与破发检验",
            "triggered": ant_broken_ipo,
            "detail": (
                f"Anthropic (ANT) 现价 ${ant_q.get('price', 0):.2f}，较 $83 发行价 {ant_q.get('vs_ipo_pct', 0):+.2f}%（已破发）"
                if ant_q else "超级IPO流动性抽血监控中"
            ),
        },
        {
            "name": "二线算力与高息债脆弱端领跌",
            "triggered": bool(crwv_weak and ccc_yield >= 15.0),
            "detail": (
                f"CoreWeave (CRWV) 现价 ${crwv_q.get('price', 0):.2f}（单日 {crwv_q.get('ret_1d_pct', 0):+.1f}%，距高点 {crwv_q.get('drawdown_52w_pct', 0):.1f}%）叠加 CCC 利率 {ccc_yield:.1f}%"
                if crwv_q else f"CCC级融资成本 {ccc_yield:.1f}%"
            ),
        },
        {
            "name": "核心芯片龙头反抽后动能分化",
            "triggered": bool(nvda_q.get("price", 0) < nvda_q.get("ma50", 0) or nvda_q.get("ret_1d_pct", 0) < -2.0),
            "detail": (
                f"NVDA ${nvda_q.get('price', 0):.2f}（单日 {nvda_q.get('ret_1d_pct', 0):+.1f}%，50日线 ${nvda_q.get('ma50', 0):.1f}）；AVGO ${avgo_q.get('price', 0):.2f}"
            ),
        },
    ]
    triggered_count = sum(1 for s in peak_signals if s["triggered"])
    ai_score_int = _clamp(triggered_count * 18 + (10 if agg_capex_ocf > 100 else 0))

    if triggered_count >= 4:
        ai_status = f"周期见顶信号齐亮（{triggered_count}/5 触发 · 反抽宜降杠杆排雷）"
        ai_level = "danger"
    elif triggered_count >= 2:
        ai_status = f"资本开支与现金流背离加剧（{triggered_count}/5 触发 · 精选现金流龙头）"
        ai_level = "warning"
    else:
        ai_status = f"算力投入回报健康（{triggered_count}/5 触发）"
        ai_level = "ok"

    # -------------------------------------------------------------------------
    # 5. GOLD DISCOUNT DETECTOR & CHINA SPILLOVER ("黄金打折期与中国外溢")
    # -------------------------------------------------------------------------
    gold_q = quotes.get("GC=F", {})
    copper_q = quotes.get("HG=F", {})
    cnh_q = quotes.get("USDCNH=X", {})
    fxi_q = quotes.get("FXI", {})
    kweb_q = quotes.get("KWEB", {})
    kospi_q = quotes.get("^KS11", {})

    gold_px = gold_q.get("price", 3550.0)
    gold_dd = gold_q.get("drawdown_52w_pct", -10.0)
    gold_ma200 = gold_q.get("ma200", 3100.0)
    gold_above_200 = gold_q.get("above_ma200", True)
    gold_rsi = gold_q.get("rsi14", 45.0) or 45.0

    is_gold_discount = bool(
        gold_dd <= -4.0
        and gold_dd >= -42.0
        and (plumbing_score_int >= 50 or credit_score_int >= 60)
    )

    gold_opp_score = 45.0
    if is_gold_discount:
        gold_opp_score += 28
    if gold_above_200:
        gold_opp_score += 8
    if gold_rsi < 30:
        gold_opp_score += 14
    elif gold_rsi < 45:
        gold_opp_score += 8
    if tga_bn > 800:
        gold_opp_score += 5
    gold_opp_score_int = _clamp(gold_opp_score)

    if is_gold_discount:
        gold_status = "康波钱荒洗金 · 黄金处于「打折期」（分批布局窗口）"
        gold_level = "opportunity"
    elif gold_dd > -3.0:
        gold_status = "黄金处于主升浪高位运行（持有为主，忌追高加杠杆）"
        gold_level = "ok"
    else:
        gold_status = "黄金中期盘整消化实际利率压力"
        gold_level = "warning"

    cnh_px = cnh_q.get("price") or fred_m.get("DEXCHUS", {}).get("value", 6.67)
    cu_au_ratio = round((copper_q.get("price", 4.2) / max(gold_px, 1.0)) * 1000.0, 3) if copper_q else 0.0

    gold_spillover_findings = [
        f"COMEX 黄金现价 ${gold_px:,.1f}，距52周高点（${gold_q.get('high_52w', 4000):,.0f}）回撤 {gold_dd:.1f}%，RSI(14)={gold_rsi:.1f}，200日均线 ${gold_ma200:,.0f}。",
        (
            "「打折期」机制触发：金价回撤主因是对冲基金在回购紧绷与高波动中被动砍仓换取美元流动性（「砍仓先砍最好卖的」），"
            "而非40万亿美债财政主导逻辑逆转；一旦月末/年末后 TGA 放水或联储被迫修补回购管道，黄金将先于美股修复。"
            if is_gold_discount else
            "金价当前未出现明显流动性错杀折价，维持底仓跟踪实际利率与 TGA 账户动向。"
        ),
        f"中国与亚太外溢参照：离岸人民币 USD/CNH 报 {cnh_px:.3f}，FXI 20日涨跌 {fxi_q.get('ret_20d_pct', 0):+.1f}%（KWEB {kweb_q.get('ret_20d_pct', 0):+.1f}%），"
        f"韩国 KOSPI 距高点 {kospi_q.get('drawdown_52w_pct', 0):.1f}%，铜金比(×1000)={cu_au_ratio:.3f} —— "
        "需警惕美国 AI 资本开支见顶对中国硬件出口链的外溢拖累，以及国内信用重定价下的「红利央票 vs 题材彩票」极端分化。",
    ]

    # -------------------------------------------------------------------------
    # MASTER REGIME SYNTHESIS WITH HYSTERESIS ANTI-WHIPSAW BUFFER
    # -------------------------------------------------------------------------
    overall_risk = _clamp(
        0.25 * plumbing_score_int
        + 0.25 * credit_score_int
        + 0.25 * micro_score_int
        + 0.25 * ai_score_int
    )

    prev_regime = prev.get("regime_code")
    regime_hysteresis_held = False

    if plumbing_exploded:
        regime_code = "RED_PLUMBING"
    elif is_dead_cat_bounce or (ai_score_int >= 70 and credit_score_int >= 65):
        regime_code = "DEFENSIVE_BOUNCE"
    elif overall_risk >= 55:
        if prev_regime == "DEFENSIVE_BOUNCE" and ai_score_int >= 66 and credit_score_int >= 62:
            regime_code = "DEFENSIVE_BOUNCE"
            regime_hysteresis_held = True
        elif prev_regime == "RISK_ON" and overall_risk <= 58:
            regime_code = "RISK_ON"
            regime_hysteresis_held = True
        else:
            regime_code = "CAUTIOUS_NEUTRAL"
    else:
        if prev_regime == "CAUTIOUS_NEUTRAL" and overall_risk >= 52:
            regime_code = "CAUTIOUS_NEUTRAL"
            regime_hysteresis_held = True
        else:
            regime_code = "RISK_ON"

    active_buffers: list[str] = []
    if gamma_in_buffer:
        active_buffers.append(f"Zero-Gamma 临界试探中 ({lo_gamma_ndx:,}~{hi_gamma_ndx:,})")
    if sofr_corridor_state == "BUFFER_OBSERVE":
        active_buffers.append("SOFR−IORB 单日毛刺观察中 (待2日确认)")
    if regime_hysteresis_held:
        active_buffers.append("综合定调处于滞回缓冲带")

    buffer_suffix = " · 【部分核心阈值临界试探中】" if active_buffers else ""

    if regime_code == "RED_PLUMBING":
        headline = f"红色警报：美元回购管道破损 · 现金与黄金静待联储救场{buffer_suffix}"
        summary_verdict = (
            "回购市场利差连续或大幅击穿走廊阈值，「钱贵」正在演变为显性「钱荒」。历史规律表明美联储将在管道受损时被迫介入注水，"
            "但在政策落地前高Beta股仍有流动性踩踏风险；一旦救市启动，黄金确定性显著高于高估值科技股。"
        )
    elif regime_code == "DEFENSIVE_BOUNCE":
        headline = f"防守反击期：「不是钱没了，是钱贵了」· 美股AI周期顶反抽减杠杆，黄金逢洗盘分批吸纳{buffer_suffix}"
        gamma_clause = (
            f"纳指现价 {ndx_spot:,.0f} 正在翻转线 ~{zero_gamma_ndx:,} 缓冲带（{lo_gamma_ndx:,}~{hi_gamma_ndx:,}）临界试探中，暂不盲目翻多；"
            if gamma_in_buffer
            else f"纳指在 ~{zero_gamma_ndx:,} 下方处于负 Gamma 放大区间，突发利好推升定性为「反抽」而非反转；"
        )
        sofr_clause = (
            f"SOFR-IORB {sofr_sp:+.1f}bps（单日轻微越界观察中，尚未连续确认）"
            if sofr_corridor_state == "BUFFER_OBSERVE"
            else f"SOFR-IORB {sofr_sp:+.1f}bps"
        )
        summary_verdict = (
            f"当前核心矛盾并非全面回购崩盘（{sofr_clause}，MOVE {move_val:.1f}），而是高利率下的边缘信用爆破（CCC级借钱成本 {ccc_yield:.1f}%）"
            f"叠加 AI 云巨头现金流转负（{neg_fcf_n}/{total_ai_n} 家 FCF 为负）。{gamma_clause}"
            f"下方真正期权厚防线在纳指 ~{pw_ndx:,}（QQQ ${pw_qqq:.0f}），紧盯 {cal.get('month_end_settlement')} 月末结算大考；黄金回调属于「钱荒洗金打折期」。"
        )
    elif regime_code == "CAUTIOUS_NEUTRAL":
        headline = f"震荡防御期：流动性缓冲垫变薄 · 严控杠杆与信用下沉风险{buffer_suffix}"
        summary_verdict = (
            "美元净流动性与期权微结构进入敏感区，资金成本偏高抑制估值扩张。建议降低二线题材与高负债标的敞口，保留短债现金干火药。"
        )
    else:
        headline = f"顺风进攻期：美元水管顺畅 + 正Gamma护航 · 顺势持有核心生产性资产{buffer_suffix}"
        summary_verdict = (
            "回购利差平稳、信用利差收敛且指数位于正 Gamma 区间，市场具备稳健上行基础，可顺势配置现金流健康的科技龙头。"
        )

    allocation_cards = [
        {
            "asset": "黄金 (GC=F / GLD)",
            "stance": "逢低分批吸纳（打折期）" if is_gold_discount else "核心底仓持有",
            "signal_tag": "首选配置" if is_gold_discount else "中性偏多",
            "rationale": (
                f"现价 ${gold_px:,.0f}（高点回撤 {gold_dd:.1f}%）。在 $40T 美债与高 TGA（${tga_bn:.0f}B）背景下，"
                "因机构补保证金引发的金价回撤属于「1976式钱荒洗盘」。不加杠杆、利用回调分批建仓；若月末/年末管道吃紧倒逼联储修管道，黄金将最先领涨。"
            ),
            "trigger": f"右侧确认信号：SOFR回落 + TGA余额开始下行，或金价放量站回50日线（${gold_q.get('ma50', 3700):,.0f}）",
        },
        {
            "asset": "美股宽基与纳指 (QQQ / ^NDX)",
            "stance": (
                "翻转线临界试探中 · 暂持原仓等确认"
                if gamma_in_buffer
                else ("反抽降杠杆 · 盯防线不追高" if in_neg_gamma else "正Gamma顺势持有")
            ),
            "signal_tag": "临界试探中" if gamma_in_buffer else ("谨慎防守" if in_neg_gamma else "顺势偏多"),
            "rationale": (
                f"现价 {ndx_spot:,.0f}（0–45DTE 翻转线 ~{zero_gamma_ndx:,}，滞回缓冲带 {lo_gamma_ndx:,}~{hi_gamma_ndx:,}）。联储只认管道不认股价，"
                f"在 10Y 实际利率 {real_10y:.2f}% 环境下，暴涨宜视为减仓/对冲窗口而非追涨信号。整数位 25,000 保护极薄，真正筹码防线看 ~{pw_ndx:,}（QQQ ${pw_qqq:.0f}）。"
            ),
            "trigger": f"转多确认：站稳缓冲带上沿 ~{hi_gamma_ndx:,} 满30分钟/收盘且 CCC 利差收敛；破位警戒：有效跌穿 ~{pw_ndx:,}",
        },
        {
            "asset": "AI 产业链内部结构 (NVDA / AVGO vs ANT / CRWV)",
            "stance": "去伪存真 · 规避高负债二线算力与高估值次新",
            "signal_tag": "结构排雷",
            "rationale": (
                f"五巨头年化 CapEx ${ann_capex_bn:.0f}B、{neg_fcf_n}家 FCF 转负，叠加 CCC 融资成本 {ccc_yield:.1f}%，"
                "依赖外部举债/卖方信贷的二线算力（如 CRWV）及抽血型高估值超级IPO（如破发的 ANT）处于风暴眼；即便配置也仅限资产负债表极强且无惧折旧的环节，严禁马丁格尔死扛。"
            ),
            "trigger": "观察云巨头下一季 CapEx 指引是否减速、以及二线算力高息债利差是否止血",
        },
        {
            "asset": "美元短债现金 vs 长端美债 (SHV/T-Bills vs TLT)",
            "stance": f"超配短端高息现金（~{fred_m.get('DGS3MO', {}).get('value', 4.5):.2f}%）· 长债紧盯MOVE回落",
            "signal_tag": "流动性压舱石",
            "rationale": (
                f"3个月美债提供约 {fred_m.get('DGS3MO', {}).get('value', 4.5):.2f}% 无久期风险收益，既能规避 10Y 美债（{dgs10:.2f}%）与 MOVE（{move_val:.1f}）波动，"
                "又能在月末、年末结算大考若砸出黄金坑时充当随时出击的「干火药」。"
            ),
            "trigger": "长债(TLT)右侧信号：MOVE指数回落至 85 以下且就业/通胀实质降温",
        },
    ]

    psych_round = psych_check.get("psych_round_ndx", 25000)

    # Pure Live Data -> Immediate Consequence -> Actionable Conclusion Chain (for Top Zone)
    live_consequences = [
        {
            "domain": "美股大盘与期权微结构",
            "freq_badge": "临界试探中 · 盘中实时" if gamma_in_buffer else "盘中实时",
            "level": "warning" if gamma_in_buffer else ("danger" if in_neg_gamma else "ok"),
            "in_buffer": gamma_in_buffer,
            "live_data": (
                f"纳指100 报 {ndx_spot:,.0f}（1日 {ndx_q.get('ret_1d_pct', 0):+.2f}%）"
                f" | 翻转线 ~{zero_gamma_ndx:,} (缓冲带 {lo_gamma_ndx:,}~{hi_gamma_ndx:,}) | 厚防线 ~{pw_ndx:,} (QQQ ${pw_qqq:.0f})"
            ),
            "consequence": (
                f"【临界试探中】现价处于 Zero-Gamma ±0.75% / 30分钟滞回缓冲区间（{lo_gamma_ndx:,}~{hi_gamma_ndx:,}），"
                "正负 Gamma 尚未完成有效切换确认，临界点附近做市商对冲流易反复拉锯。"
                if gamma_in_buffer
                else (
                    f"现价已跌破翻转线缓冲下沿（<{lo_gamma_ndx:,}），确认处于「负 Gamma 追涨杀跌」区间，"
                    f"消息脉冲极易回吐、下跌波动机械放大；整数关口 {psych_round:,} 筹码单薄难成有效支撑。"
                    if in_neg_gamma
                    else f"现价已站稳翻转线缓冲上沿（>{hi_gamma_ndx:,}），确认处于「正 Gamma 高抛低吸」护盘模式，日内回撤受抑。"
                )
            ),
            "conclusion": (
                f"【临界试探中 · 暂不翻仓】：等待站稳 ~{hi_gamma_ndx:,}（转多）或跌破 ~{lo_gamma_ndx:,}（确认负Gamma防守）满30分钟/收盘后再执行切换，防假突破打脸。"
                if gamma_in_buffer
                else (
                    f"定性「反抽非反转」：不追涨，趁急拉降杠杆；下方真正支撑看 ~{pw_ndx:,}（QQQ ${pw_qqq:.0f}），站稳 ~{hi_gamma_ndx:,} 前保持防守。"
                    if in_neg_gamma
                    else f"顺势偏多持有核心仓位，上方目标阻力墙 ~{cw_ndx:,}（QQQ ${cw_qqq:.0f}），跌破 ~{lo_gamma_ndx:,} 再转防守。"
                )
            ),
        },
        {
            "domain": "黄金实时买点判别",
            "freq_badge": "盘中实时",
            "level": "opportunity" if is_gold_discount else "ok",
            "in_buffer": False,
            "live_data": (
                f"COMEX 黄金 ${gold_px:,.1f}（1日 {gold_q.get('ret_1d_pct', 0):+.2f}%，高点回撤 {gold_dd:.1f}%）"
                f" | 日线 RSI(14)={gold_rsi:.1f} | 50日线 ${gold_q.get('ma50', 3700):,.0f}"
            ),
            "consequence": (
                f"在回购缓冲垫归零（RRP ${rrp_bn:.2f}B）与高波动压力下，机构被动卖出高流动性黄金补保证金，将金价砸入超卖折价区（RSI {gold_rsi:.0f}）。"
                if is_gold_discount
                else "金价与实际利率维持常规博弈，未出现流动性挤兑造成的显著错杀折价。"
            ),
            "conclusion": (
                f"处于「打折期」：严禁加杠杆抄底，宜用现金分批逢低吸纳；一旦月末后资金缓解或站回 ${gold_q.get('ma50', 3700):,.0f} 将率先领涨。"
                if is_gold_discount
                else "维持常规底仓持有，等待回调或实际利率下行再加仓。"
            ),
        },
        {
            "domain": "AI 产业链内部分化与排雷",
            "freq_badge": "盘中实时 + 日更利差",
            "level": "danger" if (ant_broken_ipo or crwv_weak) else "warning",
            "in_buffer": False,
            "live_data": (
                f"NVDA ${nvda_q.get('price', 0):.2f} ({nvda_q.get('ret_1d_pct', 0):+.1f}%) | "
                f"CoreWeave ${crwv_q.get('price', 0):.2f} ({crwv_q.get('ret_1d_pct', 0):+.1f}%) | "
                f"Anthropic ${ant_q.get('price', 0):.2f} (较IPO {ant_q.get('vs_ipo_pct', 0):+.1f}%) | CCC利率 {ccc_yield:.2f}%"
            ),
            "consequence": (
                f"高达 {ccc_yield:.1f}% 的垃圾债融资成本正按资产负债表质量从下往上爆破：依赖外部举债的二线算力（CRWV）与抽血型次新（ANT）率先失血下挫，龙头独木难支。"
            ),
            "conclusion": (
                "结构排雷：坚决规避高负债二线算力租赁与破发次新股，严禁马丁格尔补仓；仅保留现金流健康的极少数核心环节。"
            ),
        },
        {
            "domain": "美元回购水管与 MOVE 前置预警",
            "freq_badge": "临界试探中 · 日频" if sofr_corridor_state == "BUFFER_OBSERVE" else "FRED 日更 + MOVE",
            "level": "danger" if (plumbing_exploded or sofr_corridor_state == "STRESS_CONFIRMED") else "warning",
            "in_buffer": bool(sofr_corridor_state == "BUFFER_OBSERVE"),
            "live_data": (
                f"SOFR-IORB {sofr_sp:+.1f} bps (连破 {consec_sofr_gt0} 日) | MOVE {move_val:.1f} (20日 {move_chg_20:+.1f}, 分位 {move_pct_1y:.0f}%) | "
                f"RRP ${rrp_bn:.2f}B | 距月末结算 {bdays_me} 交易日"
            ),
            "consequence": (
                "【临界试探中】SOFR 单日轻微越过 IORB 走廊上限（仅连续 1 日 >0 bps），属结算前摩擦毛刺观察期（黄灯）；"
                f"同步关注前置指标 MOVE（{move_val:.1f}），只要未连续 2 日越界且 MOVE 未失控飙升，美联储仍按兵不动。"
                if sofr_corridor_state == "BUFFER_OBSERVE"
                else (
                    "SOFR 连续多日或大幅击穿走廊上限，隔夜回购管道实质吃紧（红灯确认），短期触发跨资产砍仓但也将倒逼美联储出手修管道！"
                    if (plumbing_exploded or sofr_corridor_state == "STRESS_CONFIRMED")
                    else f"逆回购已耗尽，隔夜利差尚在走廊内，前置预警指标 MOVE 报 {move_val:.1f}（1年分位 {move_pct_1y:.0f}%）；联储在管道真炸前不会因股市下跌而降息。"
                )
            ),
            "conclusion": (
                f"【临界试探中 · 黄灯观察】：暂不按全面钱荒清仓恐慌，超配 ~{fred_m.get('DGS3MO', {}).get('value', 4.4):.2f}% 短债现金（SHV），次日若连续第2天 >0bps 或 MOVE 跳升再升级防御。"
                if sofr_corridor_state == "BUFFER_OBSERVE"
                else f"超配 ~{fred_m.get('DGS3MO', {}).get('value', 4.4):.2f}% 短端美债现金（SHV/T-Bills）收息留足干火药；紧盯 MOVE 异动与 {cal.get('month_end_settlement')} 月末结算。"
            ),
        },
    ]

    return {
        "overall_risk_score": overall_risk,
        "regime_code": regime_code,
        "gamma_state": gamma_state,
        "sofr_corridor_state": sofr_corridor_state,
        "hysteresis": {
            "in_buffer": bool(active_buffers),
            "active_buffers": active_buffers,
            "regime_code": regime_code,
            "regime_hysteresis_held": regime_hysteresis_held,
            "gamma_state": gamma_state,
            "gamma_band_ndx": [lo_gamma_ndx, hi_gamma_ndx],
            "sofr_corridor_state": sofr_corridor_state,
            "sofr_days_above_zero": consec_sofr_gt0,
            "sofr_note": sofr_hysteresis_note,
        },
        "headline": headline,
        "summary_verdict": summary_verdict,
        "money_diagnosis": money_diagnosis,
        "is_dead_cat_bounce": is_dead_cat_bounce,
        "is_gold_discount": is_gold_discount,
        "live_consequences": live_consequences,
        "pillars": {
            "plumbing": {
                "title": "美元水管与结算节点",
                "score": plumbing_score_int,
                "status": plumbing_status,
                "level": plumbing_level,
                "in_buffer": bool(sofr_corridor_state == "BUFFER_OBSERVE"),
                "findings": plumbing_findings,
            },
            "credit": {
                "title": "资金成本与信用分层",
                "score": credit_score_int,
                "status": money_diagnosis,
                "level": credit_level,
                "in_buffer": False,
                "findings": credit_findings,
                "ccc_hy_ratio": ccc_hy_ratio,
                "ccc_ig_ratio": ccc_ig_ratio,
            },
            "microstructure": {
                "title": "波动率剪刀差与期权Gamma",
                "score": micro_score_int,
                "status": micro_status,
                "level": micro_level,
                "in_buffer": gamma_in_buffer,
                "findings": micro_findings,
                "vol_scissors": vol_scissors,
            },
            "ai_ledger": {
                "title": "AI算力账本与见顶审计",
                "score": ai_score_int,
                "status": ai_status,
                "level": ai_level,
                "in_buffer": False,
                "peak_signals": peak_signals,
                "triggered_count": triggered_count,
            },
            "gold_spillover": {
                "title": "黄金打折期与中国外溢",
                "score": gold_opp_score_int,
                "status": gold_status,
                "level": gold_level,
                "in_buffer": False,
                "findings": gold_spillover_findings,
                "cu_au_ratio": cu_au_ratio,
            },
        },
        "allocation_cards": allocation_cards,
    }
