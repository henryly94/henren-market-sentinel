/* Henren Market Sentinel — Real-Time Quote Stream, Hysteresis Engine, Scenario Sandbox & Freshness Guard */
(function () {
  "use strict";

  const STATE = {
    mode: "detecting",
    apiBase: (localStorage.getItem("sentinel_api_base") || "").replace(/\/+$/, ""),
    bundle: null,
    lastCollectedUtc: null,
    liveQuoteEtTime: null,
    liveQuoteFetchedAtMs: null,
    liveQuoteStreamFailed: false,
    backendFallbackCached: false,
    backendFallbackReason: "",
    activeScenario: "live",
  };

  // Zero-CORS real-time exchange quote mapping (Tencent Finance global feed)
  const LIVE_US_MAP = {
    v_usNDX: "^NDX",
    v_usQQQ: "QQQ",
    v_usINX: "^GSPC",
    v_usNVDA: "NVDA",
    v_usAVGO: "AVGO",
    v_usSMH: "SMH",
    v_usCRWV: "CRWV",
    v_usANT: "ANT",
    v_usVST: "VST",
    v_usTLT: "TLT",
    v_usHYG: "HYG",
    v_usSHV: "SHV",
    v_usFXI: "FXI",
    v_usKWEB: "KWEB",
  };

  const fmtNum = (v, digits = 2) =>
    v === null || v === undefined || Number.isNaN(Number(v))
      ? "--"
      : Number(v).toLocaleString("en-US", {
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        });

  const fmtSigned = (v, digits = 2, suffix = "") => {
    if (v === null || v === undefined || Number.isNaN(Number(v))) return "--";
    const n = Number(v);
    return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}${suffix}`;
  };

  const clsSigned = (v, invert = false) => {
    const n = Number(v || 0);
    if (Math.abs(n) < 1e-6) return "";
    if (!invert) return n > 0 ? "pos" : "neg";
    return n > 0 ? "neg" : "pos";
  };

  function formatLocalTime(isoUtc, includeDate = true) {
    if (!isoUtc) return "--";
    const d = new Date(isoUtc);
    if (Number.isNaN(d.getTime())) return isoUtc;
    return d.toLocaleString("zh-CN", {
      month: includeDate ? "2-digit" : undefined,
      day: includeDate ? "2-digit" : undefined,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }

  function getUsEasternClock() {
    const now = new Date();
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).formatToParts(now);

    const map = {};
    parts.forEach((p) => {
      map[p.type] = p.value;
    });
    const hr = Number(map.hour === "24" ? 0 : map.hour);
    const min = Number(map.minute || 0);
    const sec = Number(map.second || 0);
    const isWeekday = !["Sat", "Sun"].includes(map.weekday);
    const minsOfDay = hr * 60 + min;
    const isRegularOpen = isWeekday && minsOfDay >= 9 * 60 + 30 && minsOfDay < 16 * 60;
    const dateStr = `${map.year}-${map.month}-${map.day}`;
    return {
      dateStr,
      hr,
      min,
      sec,
      minsOfDay,
      isWeekday,
      isRegularOpen,
    };
  }

  function computeQuoteLagSeconds(snap) {
    const etClock = getUsEasternClock();
    if (STATE.liveQuoteEtTime && STATE.liveQuoteEtTime.length >= 16) {
      const qDate = STATE.liveQuoteEtTime.slice(0, 10);
      const qH = Number(STATE.liveQuoteEtTime.slice(11, 13)) || 0;
      const qM = Number(STATE.liveQuoteEtTime.slice(14, 16)) || 0;
      const qS = Number(STATE.liveQuoteEtTime.slice(17, 19)) || 0;
      if (qDate === etClock.dateStr) {
        const nowSec = etClock.hr * 3600 + etClock.min * 60 + etClock.sec;
        const qSec = qH * 3600 + qM * 60 + qS;
        return Math.max(0, nowSec - qSec);
      }
      // Different date while market is open => stale prior-session quote
      if (etClock.isRegularOpen && qDate < etClock.dateStr) {
        return 86400;
      }
      return 0;
    }

    const modTs = snap?.module_timestamps || {};
    const refIso = modTs.quotes_bar_utc || modTs.quotes_utc || snap?.collected_at_utc;
    if (!refIso) return 1e9;
    const ms = Date.parse(refIso);
    if (Number.isNaN(ms)) return 1e9;
    return Math.max(0, Math.floor((Date.now() - ms) / 1000));
  }

  function showToast(msg) {
    const el = document.getElementById("toast-msg");
    if (!el) return;
    el.textContent = msg;
    el.classList.add("visible");
    window.clearTimeout(el._timer);
    el._timer = window.setTimeout(() => el.classList.remove("visible"), 3400);
  }

  function setSyncBanner(active, text) {
    const banner = document.getElementById("sync-banner");
    const dot = document.getElementById("live-status-dot");
    if (text) document.getElementById("sync-banner-text").textContent = text;
    banner.classList.toggle("active", Boolean(active));
    dot.classList.toggle("syncing", Boolean(active));
  }

  function meterColor(level, isOpportunity) {
    if (isOpportunity) return "var(--accent-gold)";
    if (level === "danger") return "var(--signal-danger)";
    if (level === "warning") return "var(--signal-warn)";
    if (level === "opportunity") return "var(--accent-gold)";
    return "var(--signal-ok)";
  }

  function tagClsForLevel(level, inBuffer) {
    if (inBuffer) return "tag-probing";
    if (level === "danger") return "tag-danger";
    if (level === "warning") return "tag-warning";
    if (level === "opportunity") return "tag-opportunity";
    return "tag-ok";
  }

  function apiUrl(path) {
    if (STATE.apiBase) return `${STATE.apiBase}${path}`;
    return `.${path}`;
  }

  // ---------------------------------------------------------------------------
  // BROWSER-DIRECT REAL-TIME QUOTE STREAM (Zero CORS, ~150ms latency on mobile)
  // ---------------------------------------------------------------------------
  function applyQuoteTick(qObj, newPrice, ret1dPct, dateStr) {
    if (!qObj || !newPrice || newPrice <= 0) return;
    qObj.price = newPrice >= 10 ? Number(newPrice.toFixed(2)) : Number(newPrice.toFixed(4));
    if (!Number.isNaN(ret1dPct)) {
      qObj.ret_1d_pct = Number(ret1dPct.toFixed(2));
    }
    if (dateStr) qObj.date = dateStr;

    if (qObj.high_52w) {
      qObj.high_52w = Math.max(qObj.high_52w, qObj.price);
      qObj.drawdown_52w_pct = Number(((qObj.price / qObj.high_52w - 1) * 100).toFixed(2));
    }
    if (qObj.ipo_price) {
      qObj.vs_ipo_pct = Number(((qObj.price / qObj.ipo_price - 1) * 100).toFixed(2));
    }

    if (Array.isArray(qObj.history_60d) && qObj.history_60d.length >= 6) {
      const h = qObj.history_60d;
      const dStr = dateStr || h[h.length - 1].date;
      if (h[h.length - 1].date === dStr) {
        h[h.length - 1].close = qObj.price;
      } else if (dStr > h[h.length - 1].date) {
        h.push({ date: dStr, close: qObj.price });
        if (h.length > 60) h.shift();
      }
      const p5 = h[Math.max(0, h.length - 6)]?.close;
      const p20 = h[Math.max(0, h.length - 21)]?.close;
      if (p5) {
        qObj.ret_5d_pct = Number(((qObj.price / p5 - 1) * 100).toFixed(2));
        qObj.chg_5_abs = Number((qObj.price - p5).toFixed(2));
      }
      if (p20) {
        qObj.ret_20d_pct = Number(((qObj.price / p20 - 1) * 100).toFixed(2));
        qObj.chg_20_abs = Number((qObj.price - p20).toFixed(2));
      }
    }
  }

  function recomputeDynamicAnalysisFromLiveQuotes(bundle) {
    const snap = bundle.snapshot || {};
    const ana = bundle.analysis || {};
    const quotes = snap.quotes || {};
    const opt = snap.options || {};
    const fredM = (snap.fred || {}).metrics || {};
    const fredD = (snap.fred || {}).derived || {};
    const cal = snap.calendar || {};

    const ndxQ = quotes["^NDX"] || {};
    const qqqQ = quotes["QQQ"] || {};
    const goldQ = quotes["GC=F"] || {};
    const nvdaQ = quotes["NVDA"] || {};
    const crwvQ = quotes["CRWV"] || {};
    const antQ = quotes["ANT"] || {};
    const moveQ = quotes["^MOVE"] || {};

    const priorGammaState = ana.gamma_state || opt.gamma_hysteresis?.gamma_state || "NEGATIVE_CONFIRMED";

    if (ndxQ.price && qqqQ.price) {
      const ratio = ndxQ.price / qqqQ.price;
      opt.ndx_spot = ndxQ.price;
      opt.qqq_spot = qqqQ.price;
      opt.ndx_qqq_ratio = Number(ratio.toFixed(4));
      if (opt.zero_gamma_qqq) {
        opt.zero_gamma_ndx = Math.round(opt.zero_gamma_qqq * ratio);
      }
      if (opt.major_put_wall?.qqq_strike) {
        opt.major_put_wall.ndx_equiv = Math.round(opt.major_put_wall.qqq_strike * ratio);
        opt.major_put_wall.dist_pct = Number(((opt.major_put_wall.qqq_strike / qqqQ.price - 1) * 100).toFixed(2));
      }
      if (opt.near_put_support?.qqq_strike) {
        opt.near_put_support.ndx_equiv = Math.round(opt.near_put_support.qqq_strike * ratio);
      }
      if (opt.major_call_wall?.qqq_strike) {
        opt.major_call_wall.ndx_equiv = Math.round(opt.major_call_wall.qqq_strike * ratio);
      }
    }

    const ndxSpot = opt.ndx_spot || ndxQ.price || 25050;
    const zeroG = opt.zero_gamma_ndx || 27000;
    const bandPct = (opt.gamma_hysteresis?.band_pct || 0.75) / 100.0;
    const loGamma = Math.round(zeroG * (1 - bandPct));
    const hiGamma = Math.round(zeroG * (1 + bandPct));
    if (opt.gamma_hysteresis) {
      opt.gamma_hysteresis.lower_band_ndx = loGamma;
      opt.gamma_hysteresis.upper_band_ndx = hiGamma;
    }

    // Hysteresis anti-whipsaw evaluation on live ticks
    let gammaState = priorGammaState;
    if (ndxSpot >= loGamma && ndxSpot <= hiGamma) {
      gammaState = "BUFFER_PROBING";
    } else if (ndxSpot < loGamma) {
      // If previously confirmed positive, live tick alone enters BUFFER_PROBING until 30m backend confirms
      gammaState = priorGammaState === "POSITIVE_CONFIRMED" ? "BUFFER_PROBING" : "NEGATIVE_CONFIRMED";
    } else {
      gammaState = priorGammaState === "NEGATIVE_CONFIRMED" ? "BUFFER_PROBING" : "POSITIVE_CONFIRMED";
    }

    const gammaInBuffer = gammaState === "BUFFER_PROBING";
    const inNegG =
      gammaState === "NEGATIVE_CONFIRMED"
        ? true
        : gammaState === "POSITIVE_CONFIRMED"
        ? false
        : priorGammaState !== "POSITIVE_CONFIRMED";

    opt.in_negative_gamma = inNegG;
    ana.gamma_state = gammaState;

    const pwNdx = opt.major_put_wall?.ndx_equiv || 24650;
    const pwQqq = opt.major_put_wall?.qqq_strike || 600;
    const cwNdx = opt.major_call_wall?.ndx_equiv || 28750;
    const cwQqq = opt.major_call_wall?.qqq_strike || 700;
    const psychRound = opt.psych_25000_check?.psych_round_ndx || 25000;

    const sofrInfo = fredD.sofr_iorb_spread || {};
    const sofrSp = sofrInfo.value_bps ?? 0.0;
    const consecSofr = sofrInfo.consecutive_days_above_zero ?? (sofrSp > 0 ? 1 : 0);
    const sofrState =
      ana.sofr_corridor_state ||
      (sofrSp >= 8 || (sofrSp > 0 && consecSofr >= 2)
        ? "STRESS_CONFIRMED"
        : sofrSp > 0 && consecSofr === 1
        ? "BUFFER_OBSERVE"
        : "NORMAL_CORRIDOR");
    const sofrInBuffer = sofrState === "BUFFER_OBSERVE";

    const rrpBn = fredM.RRPONTSYD?.value ?? 0.3;
    const cccYield = fredM.BAMLH0A3HYCEY?.value ?? 18.48;
    const dgs3m = fredM.DGS3MO?.value ?? 4.37;
    const bdaysMe = cal.bdays_to_month_end ?? 3;
    const negFcfN = snap.ai_ledger?.summary?.negative_fcf_count ?? 4;

    const moveVal = moveQ.price ?? 99.0;
    const moveChg20 = moveQ.chg_20_abs ?? 0.0;
    const movePct1y = moveQ.pct_1y ?? 55.0;

    const goldPx = goldQ.price || 3475;
    const goldDd = goldQ.drawdown_52w_pct ?? -34;
    const goldRsi = goldQ.rsi14 ?? 20;
    const goldMa50 = goldQ.ma50 || 4065;
    const isGoldDiscount = Boolean(goldDd <= -4 && goldDd >= -45);
    ana.is_gold_discount = isGoldDiscount;

    const activeBuffers = [];
    if (gammaInBuffer) activeBuffers.push(`Zero-Gamma 临界试探中 (${fmtNum(loGamma, 0)}~${fmtNum(hiGamma, 0)})`);
    if (sofrInBuffer) activeBuffers.push("SOFR−IORB 单日毛刺观察中 (待2日确认)");
    if (ana.hysteresis?.regime_hysteresis_held) activeBuffers.push("综合定调处于滞回缓冲带");
    ana.hysteresis = Object.assign({}, ana.hysteresis || {}, {
      in_buffer: activeBuffers.length > 0,
      active_buffers: activeBuffers,
      gamma_state: gammaState,
      gamma_band_ndx: [loGamma, hiGamma],
      sofr_corridor_state: sofrState,
    });

    if (ana.pillars?.microstructure) {
      ana.pillars.microstructure.in_buffer = gammaInBuffer;
      if (gammaInBuffer) {
        ana.pillars.microstructure.status = `翻转线临界试探中（${fmtNum(loGamma, 0)}~${fmtNum(hiGamma, 0)} 缓冲带 · 暂不翻多空）`;
        ana.pillars.microstructure.level = "warning";
      }
    }

    const nearWallAlert =
      Math.abs(ndxSpot - pwNdx) <= 600
        ? `盘中纳指（${fmtNum(ndxSpot, 0)}）逼近下方最厚实盘期权防线 ~${fmtNum(pwNdx, 0)}（QQQ $${fmtNum(pwQqq, 0)}，仅差 ${Math.round(ndxSpot - pwNdx)} 点）！`
        : `下方真正期权厚防线在纳指 ~${fmtNum(pwNdx, 0)}（QQQ $${fmtNum(pwQqq, 0)}）。`;

    const gammaVerdictText = gammaInBuffer
      ? `纳指最新报 ${fmtNum(ndxSpot, 0)}，正处于 0–45DTE 翻转线缓冲带（${fmtNum(loGamma, 0)}~${fmtNum(hiGamma, 0)}）【临界试探中】，暂不盲目切换多空定调。`
      : `纳指最新报 ${fmtNum(ndxSpot, 0)}（1日 ${fmtSigned(ndxQ.ret_1d_pct, 2, "%")}，QQQ $${fmtNum(qqqQ.price, 2)}），位于 ~${fmtNum(zeroG, 0)} ${inNegG ? "下方负 Gamma 助跌区间" : "上方正 Gamma 护盘区间"}。`;

    ana.summary_verdict =
      `当前核心矛盾为高利率下的边缘信用爆破（CCC级借钱成本 ${fmtNum(cccYield, 1)}%，MOVE ${fmtNum(moveVal, 1)}）叠加 AI 云巨头现金流转负（${negFcfN}/5 家 FCF 为负）。` +
      gammaVerdictText +
      `${nearWallAlert}同时紧盯 ${cal.month_end_settlement || "月末"} 结算资金面大考；黄金回调仍属「钱荒洗金打折期」。`;

    ana.live_consequences = [
      {
        domain: "美股大盘与期权微结构",
        freq_badge: gammaInBuffer ? "临界试探中 · 秒级直连" : "盘中秒级直连",
        level: gammaInBuffer ? "warning" : inNegG ? "danger" : "ok",
        in_buffer: gammaInBuffer,
        live_data:
          `纳指100 报 ${fmtNum(ndxSpot, 0)}（1日 ${fmtSigned(ndxQ.ret_1d_pct, 2, "%")}）| QQQ $${fmtNum(qqqQ.price, 2)}` +
          ` | 0–45DTE翻转线 ~${fmtNum(zeroG, 0)} (缓冲 ${fmtNum(loGamma, 0)}~${fmtNum(hiGamma, 0)}) | 厚防线 ~${fmtNum(pwNdx, 0)}`,
        consequence: gammaInBuffer
          ? `【临界试探中】现价进入翻转线 ±0.75% / 30分钟滞回缓冲带（${fmtNum(loGamma, 0)}~${fmtNum(hiGamma, 0)}），盘中尚未完成站稳确认，临界点附近做市商对冲流易来回拉锯。`
          : inNegG
          ? `现价位于缓冲下沿（<${fmtNum(loGamma, 0)}）下方，确认处于「负 Gamma 顺势助跌」区间，做市商被动追涨杀跌放大波动；${fmtNum(psychRound, 0)} 整数位保护单薄，距 QQQ $${fmtNum(pwQqq, 0)} 厚防线 ${fmtNum(Math.abs(opt.major_put_wall?.dist_pct || 0), 2)}%。`
          : `现价站稳缓冲上沿（>${fmtNum(hiGamma, 0)}）上方，做市商处于正 Gamma 高抛低吸护盘模式。`,
        conclusion: gammaInBuffer
          ? `【临界试探中 · 暂不翻仓】：等待持续站稳 ~${fmtNum(hiGamma, 0)} 或跌破 ~${fmtNum(loGamma, 0)} 满30分钟/收盘后再切换多空动作，防假突破来回打脸。`
          : inNegG
          ? ndxSpot <= pwNdx + 120
            ? `正在测试 ~${fmtNum(pwNdx, 0)}（QQQ $${fmtNum(pwQqq, 0)}）最厚期权防线：观察此处做市商平仓能否止跌；一旦有效失守将触发二次去杠杆，切忌盲目接飞刀。`
            : `验证「反抽非反转」：负 Gamma 区下跌惯性未完，不抄半山腰；重点盯防 ~${fmtNum(pwNdx, 0)}（QQQ $${fmtNum(pwQqq, 0)}）最厚防线支撑得失。`
          : `顺势持有核心仓位，上方阻力墙 ~${fmtNum(cwNdx, 0)}（QQQ $${fmtNum(cwQqq, 0)}）。`,
      },
      {
        domain: "黄金实时买点判别",
        freq_badge: "盘中秒级直连",
        level: isGoldDiscount ? "opportunity" : "ok",
        in_buffer: false,
        live_data:
          `COMEX 黄金 $${fmtNum(goldPx, 1)}（1日 ${fmtSigned(goldQ.ret_1d_pct, 2, "%")}，高点回撤 ${fmtSigned(goldDd, 1, "%")}）` +
          ` | 日线 RSI=${fmtNum(goldRsi, 0)} | 50日线 $${fmtNum(goldMa50, 0)}`,
        consequence:
          `波动放大引发跨资产追加保证金（「砍仓先砍流动性最好的资产」），机构连带抛售黄金换取美元现金，使金价维持在超卖折价区。`,
        conclusion:
          `维持「钱荒洗金打折期」判断：严禁加杠杆，宜用冗余现金分批低吸；一旦去杠杆倒逼美联储松动管道或月末结算度过，黄金将率先反弹。`,
      },
      {
        domain: "AI 产业链内部分化与排雷",
        freq_badge: "盘中秒级 + 日更利差",
        level: "danger",
        in_buffer: false,
        live_data:
          `NVDA $${fmtNum(nvdaQ.price, 2)} (${fmtSigned(nvdaQ.ret_1d_pct, 1, "%")}) | ` +
          `CoreWeave $${fmtNum(crwvQ.price, 2)} (${fmtSigned(crwvQ.ret_1d_pct, 1, "%")}) | ` +
          `Anthropic $${fmtNum(antQ.price, 2)} (较$83发行价 ${fmtSigned(antQ.vs_ipo_pct, 1, "%")}) | CCC利率 ${fmtNum(cccYield, 2)}%`,
        consequence:
          `高达 ${fmtNum(cccYield, 1)}% 的垃圾债借钱成本叠加负 Gamma 抛压，令高负债二线算力（CRWV）与破发超级 IPO（ANT）持续领跌。`,
        conclusion:
          `继续排雷规避：坚决远离二线高负债算力租赁与破发次新股，严禁逆势马丁格尔加仓摊平。`,
      },
      {
        domain: "美元回购水管与 MOVE 前置预警",
        freq_badge: sofrInBuffer ? "临界试探中 · 日频" : "FRED 日更 + MOVE",
        level: sofrState === "STRESS_CONFIRMED" ? "danger" : "warning",
        in_buffer: sofrInBuffer,
        live_data:
          `SOFR-IORB ${fmtSigned(sofrSp, 1, " bps")} (连破${consecSofr}日) | MOVE ${fmtNum(moveVal, 1)} (20日 ${fmtSigned(moveChg20, 1)}, 分位 ${fmtNum(movePct1y, 0)}%) | ` +
          `TLT $${fmtNum(quotes["TLT"]?.price, 2)} (${fmtSigned(quotes["TLT"]?.ret_1d_pct, 2, "%")}) | 距月末 ${bdaysMe} 交易日`,
        consequence: sofrInBuffer
          ? `【临界试探中】SOFR 单日轻微越过走廊上限（仅 1 日 >0 bps，记黄灯观察），前置指标 MOVE 报 ${fmtNum(moveVal, 1)}；未满连续 2 日越界前美联储按兵不动。`
          : sofrState === "STRESS_CONFIRMED"
          ? `SOFR 连续或大幅击穿走廊上限（红灯确认），回购管道实质吃紧，短期触发砍仓但将倒逼联储修管道。`
          : `隔夜回购利差尚稳，前置预警指标 MOVE 报 ${fmtNum(moveVal, 1)}（分位 ${fmtNum(movePct1y, 0)}%）；只要管道未彻底爆裂，联储「只认管道不认股价」。`,
        conclusion: sofrInBuffer
          ? `【临界试探中 · 黄灯观察】：暂不按全面钱荒清仓恐慌，持有 ~${fmtNum(dgs3m, 2)}% 短债现金（SHV $${fmtNum(quotes["SHV"]?.price, 2)}），观察次日是否连续越界或 MOVE 跳升。`
          : `继续持有 ~${fmtNum(dgs3m, 2)}% 短端美债现金（SHV $${fmtNum(quotes["SHV"]?.price, 2)}）作为干火药，紧盯 MOVE 异动与 ${cal.month_end_settlement || "月末"} 结算大考。`,
      },
    ];
  }

  function fetchRealtimeBrowserQuotes(bundle) {
    return new Promise((resolve) => {
      if (!bundle?.snapshot?.quotes) {
        resolve(false);
        return;
      }
      const script = document.createElement("script");
      const symbols = [
        "usNDX", "usQQQ", "usINX", "usNVDA", "usAVGO", "usSMH",
        "usCRWV", "usANT", "usVST", "usTLT", "usHYG", "usSHV",
        "usFXI", "usKWEB", "hf_GC", "hf_HG",
      ].join(",");
      script.charset = "gbk";
      script.async = true;
      script.src = `https://qt.gtimg.cn/q=${symbols}&_=${Date.now()}`;

      let finished = false;
      const done = (ok) => {
        if (finished) return;
        finished = true;
        if (script.parentNode) script.parentNode.removeChild(script);
        resolve(ok);
      };

      const timer = window.setTimeout(() => {
        STATE.liveQuoteStreamFailed = true;
        done(false);
      }, 3500);

      script.onload = () => {
        window.clearTimeout(timer);
        try {
          const quotes = bundle.snapshot.quotes;
          let updatedAny = false;
          let newestEt = null;

          Object.entries(LIVE_US_MAP).forEach(([varName, sym]) => {
            const raw = window[varName];
            if (typeof raw !== "string" || !raw.includes("~")) return;
            const parts = raw.split("~");
            const px = parseFloat(parts[3]);
            const chgPct = parseFloat(parts[32]);
            const tsEt = parts[30] || "";
            const datePart = tsEt.slice(0, 10);
            if (px > 0 && quotes[sym]) {
              if (!quotes[sym].date || !datePart || datePart >= quotes[sym].date) {
                applyQuoteTick(quotes[sym], px, chgPct, datePart || quotes[sym].date);
                updatedAny = true;
                if (tsEt && (!newestEt || tsEt > newestEt)) newestEt = tsEt;
              }
            }
          });

          if (typeof window.v_hf_GC === "string" && quotes["GC=F"]) {
            const p = window.v_hf_GC.split(",");
            const gcPx = parseFloat(p[0]);
            const gcPct = parseFloat(p[1]);
            if (gcPx > 0) {
              applyQuoteTick(quotes["GC=F"], gcPx, gcPct, newestEt ? newestEt.slice(0, 10) : quotes["GC=F"].date);
              updatedAny = true;
            }
          }
          if (typeof window.v_hf_HG === "string" && quotes["HG=F"]) {
            const p = window.v_hf_HG.split(",");
            const hgRaw = parseFloat(p[0]);
            const hgPct = parseFloat(p[1]);
            if (hgRaw > 0) {
              const hgPx = hgRaw > 50 ? hgRaw / 100.0 : hgRaw;
              applyQuoteTick(quotes["HG=F"], hgPx, hgPct, newestEt ? newestEt.slice(0, 10) : quotes["HG=F"].date);
            }
          }

          if (updatedAny) {
            STATE.liveQuoteStreamFailed = false;
            STATE.liveQuoteFetchedAtMs = Date.now();
            if (newestEt) STATE.liveQuoteEtTime = newestEt;
            recomputeDynamicAnalysisFromLiveQuotes(bundle);
          } else {
            STATE.liveQuoteStreamFailed = true;
          }
          done(updatedAny);
        } catch (e) {
          console.warn("Realtime quote parse warning:", e);
          STATE.liveQuoteStreamFailed = true;
          done(false);
        }
      };

      script.onerror = () => {
        window.clearTimeout(timer);
        STATE.liveQuoteStreamFailed = true;
        done(false);
      };

      document.head.appendChild(script);
    });
  }

  // ---------------------------------------------------------------------------
  // P0.2: PER-MODULE FRESHNESS PILLS + TIMEOUT / DEGRADED SNAPSHOT ALERT
  // ---------------------------------------------------------------------------
  function renderTopMeta(bundle) {
    const snap = bundle.snapshot || {};
    const sched = bundle.scheduler || {};
    const modTs = snap.module_timestamps || {};
    STATE.lastCollectedUtc = snap.collected_at_utc || null;

    const quotesIso = modTs.quotes_bar_utc || modTs.quotes_utc || snap.collected_at_utc;
    const optionsIso = modTs.options_utc || snap.options?.updated_at_utc || snap.collected_at_utc;
    const fredIso = modTs.fred_utc || snap.fred?.updated_at_utc || snap.collected_at_utc;
    const fredObs = modTs.fred_obs_date || snap.fred?.latest_obs_date || "";

    const quotesText = STATE.liveQuoteEtTime
      ? `直连 ${STATE.liveQuoteEtTime.slice(5, 16)} ET`
      : formatLocalTime(quotesIso);
    document.getElementById("meta-ts-quotes").textContent = quotesText;
    document.getElementById("meta-ts-options").textContent = formatLocalTime(optionsIso);
    document.getElementById("meta-ts-fred").textContent = fredObs
      ? `${fredObs.slice(5)}观测 (${formatLocalTime(fredIso, false)})`
      : formatLocalTime(fredIso);

    const etClock = getUsEasternClock();
    const quoteLagSec = computeQuoteLagSeconds(snap);
    const isFallbackCached = Boolean(bundle.fallback_cached || STATE.backendFallbackCached);
    const isOpenMarketStale = Boolean(etClock.isRegularOpen && quoteLagSec > 300);
    const isOffHoursStaticOnly = Boolean(!etClock.isRegularOpen && STATE.mode === "static" && STATE.liveQuoteStreamFailed);

    const quotesPill = document.getElementById("mod-ts-quotes");
    const statusDot = document.getElementById("live-status-dot");
    const degBadge = document.getElementById("meta-degraded-badge");
    const degBanner = document.getElementById("degraded-alert-banner");
    const degTag = document.getElementById("degraded-banner-tag");
    const degText = document.getElementById("degraded-banner-text");

    quotesPill.classList.toggle("stale", isOpenMarketStale || isFallbackCached);
    statusDot.classList.toggle("stale", isOpenMarketStale || isFallbackCached);

    if (isFallbackCached || isOpenMarketStale) {
      degBadge.textContent = "⚠ 当前为缓存快照";
      degBadge.className = "degraded-badge";
      degBanner.className = "degraded-banner active";
      degTag.textContent = "当前为缓存快照";
      if (isFallbackCached) {
        const reason = bundle.fallback_reason || STATE.backendFallbackReason || "后端限流或冷启动";
        degText.textContent = `触发降级保护（${reason}），当前回退展示最近一次有效缓存快照，请勿将静态价当作实时成交价。`;
      } else {
        const lagMin = Math.max(5, Math.round(quoteLagSec / 60));
        degText.textContent = `美股开盘时段内盘中行情已延迟约 ${lagMin} 分钟（超过 5 分钟阈值），当前为缓存快照，请点击右侧重连或核对实盘报价。`;
      }
    } else if (isOffHoursStaticOnly) {
      degBadge.textContent = "当前为缓存快照";
      degBadge.className = "degraded-badge grey";
      degBanner.className = "degraded-banner active mode-grey";
      degTag.textContent = "当前为缓存快照";
      degText.textContent = "当前处于美股非开盘时段且实时行情流未连接，页面展示最近一次巡检缓存快照。";
    } else {
      degBadge.className = "degraded-badge hidden";
      degBanner.className = "degraded-banner";
    }

    const modeTxt = sched.mode_label
      ? `${sched.mode_label}`
      : STATE.mode === "api"
      ? "实时智能调度中"
      : "秒级行情直连 + 云端巡检";
    document.getElementById("meta-schedule-info").textContent = modeTxt;

    const reportLink = document.getElementById("btn-download-md");
    if (reportLink) {
      reportLink.href = STATE.mode === "api" ? apiUrl("/api/report.md") : "./reports/latest_market_brief.md";
    }
  }

  // ---------------------------------------------------------------------------
  // P2.5: SCENARIO PRESET LINKED CONSEQUENCES BUILDER
  // ---------------------------------------------------------------------------
  function buildScenarioConsequences(presetKey, bundle) {
    const snap = bundle.snapshot || {};
    const opt = snap.options || {};
    const quotes = snap.quotes || {};
    const fredM = (snap.fred || {}).metrics || {};
    const zeroG = opt.zero_gamma_ndx || 26800;
    const loGamma = opt.gamma_hysteresis?.lower_band_ndx || Math.round(zeroG * 0.9925);
    const pwNdx = opt.major_put_wall?.ndx_equiv || 24650;
    const pwQqq = opt.major_put_wall?.qqq_strike || 600;
    const ratio = opt.ndx_qqq_ratio || 41.08;
    const goldPx = quotes["GC=F"]?.price || 3500;
    const dgs3m = fredM.DGS3MO?.value ?? 4.35;

    if (presetKey === "break_zero_gamma") {
      const simNdx = Math.round(loGamma * 0.992);
      const simQqq = Math.round(simNdx / ratio);
      return {
        title: "跌破 Zero-Gamma 翻转缓冲带（确认转入负 Gamma）",
        simNdx,
        chains: [
          {
            domain: "推演：美股大盘跌穿 Zero-Gamma 缓冲带",
            freq_badge: "沙盘推演情景",
            level: "danger",
            live_data: `模拟 ^NDX ${fmtNum(simNdx, 0)} (QQQ ~$${simQqq}) < 缓冲下沿 ~${fmtNum(loGamma, 0)} | 下方最厚防线 ~${fmtNum(pwNdx, 0)}`,
            consequence:
              "指数有效击穿 ±0.75% 滞回缓冲下沿并站稳，做市商对冲机制正式由「高抛低吸护盘」切换为「顺势砸期货对冲看跌期权」，日内跌幅与反抽回吐均被机械放大。",
            conclusion:
              `立即从顺势进攻切换为防守：停止逢低加仓科技高 Beta，利用盘中脉冲反抽降低仓位/买入保护，耐心等待回踩最厚实盘 Put Wall ~${fmtNum(pwNdx, 0)}（QQQ $${fmtNum(pwQqq, 0)}）。`,
          },
          {
            domain: "推演：跨资产与现金应对",
            freq_badge: "沙盘联动结论",
            level: "warning",
            live_data: `短债现金收益率 ~${fmtNum(dgs3m, 2)}% | 观察 MOVE 是否同步突破 110`,
            consequence:
              "只要隔夜回购利差（SOFR−IORB）尚未连续突破走廊上限，美联储不会因负 Gamma 杀估值而口头救市。",
            conclusion:
              "保留 SHV/T-Bills 短债现金干火药，不抢半山腰反弹。",
          },
        ],
      };
    }

    if (presetKey === "break_put_wall") {
      const simNdx = Math.round(pwNdx * 0.986);
      const simQqq = Math.round(simNdx / ratio);
      return {
        title: `有效跌穿最厚 Put 防线 (~${fmtNum(pwNdx, 0)} / QQQ $${fmtNum(pwQqq, 0)})`,
        simNdx,
        chains: [
          {
            domain: "推演：核心期权防线失守（尾部去杠杆）",
            freq_badge: "沙盘推演情景",
            level: "danger",
            live_data: `模拟 ^NDX ${fmtNum(simNdx, 0)} (QQQ ~$${simQqq}) < 最厚 Put Wall ~${fmtNum(pwNdx, 0)}`,
            consequence:
              "下方最厚看跌期权保护墙被击穿，多头止损盘叠加做市商空头 Gamma 进一步加速追空，引发基金跨资产追加保证金（Margin Call）。",
            conclusion:
              "严禁左侧盲目接飞刀或马丁格尔补仓；立刻检查 SOFR−IORB 与 MOVE 是否同步爆表，等待恐慌盘出清信号。",
          },
          {
            domain: "推演：流动性踩踏后的黄金先手窗口",
            freq_badge: "沙盘联动结论",
            level: "opportunity",
            live_data: `黄金现价锚点 $${fmtNum(goldPx, 0)} | 紧盯联储 SRF / 回购注入信号`,
            consequence:
              "若股债双杀拖累美债做市商管道（MOVE > 125、SOFR 破走廊），美联储将被迫出手修管道注水。",
            conclusion:
              "准备好短债现金，在去杠杆连带错杀黄金时分批吸纳黄金（救市启动时黄金确定性远高于受损科技股）。",
          },
        ],
      };
    }

    if (presetKey === "repo_gold_discount") {
      const simNdx = Math.round(pwNdx * 0.995);
      const simGold = Math.round(goldPx * 0.95);
      return {
        title: "回购连续破走廊 + 康波钱荒洗金打折期",
        simNdx,
        chains: [
          {
            domain: "推演：美元回购水管连续越界（红灯确认）",
            freq_badge: "沙盘推演情景",
            level: "danger",
            live_data: `模拟 SOFR−IORB +12.0 bps (连续≥2日越界) | MOVE 128 pts | ON RRP 归零`,
            consequence:
              "「钱贵」升级为显性「钱荒」！月末/季末交易商资产负债表锁死，高杠杆基金遵循「先砍流动性最好资产」原则，被动抛售黄金与核心资产换取隔夜美元。",
            conclusion:
              "对高估值股票全面防守避险；同时密切跟踪纽约联储隔夜回购操作与财政部 TGA 账户余额拐点。",
          },
          {
            domain: "推演：黄金「1976式洗盘打折期」标准动作",
            freq_badge: "沙盘联动结论",
            level: "opportunity",
            live_data: `模拟黄金急跌至 ~$${fmtNum(simGold, 0)}（流动性错杀折价 · RSI < 30）`,
            consequence:
              "$40T 美债财政主导的长期逻辑未变，管道受损恰恰是倒逼美联储停止缩表/扩表注水的唯一开关，黄金将在修管道瞬间最先暴力修复。",
            conclusion:
              "绝对不加期货杠杆（防黎明前插针爆仓），动用 T-Bills 短债现金分 3 批逢低买入现货黄金 / GLD。",
          },
        ],
      };
    }

    if (presetKey === "ai_credit_crack") {
      const simNdx = Math.round(Math.min(opt.ndx_spot || 25200, loGamma * 0.985));
      return {
        title: "二线算力债领跌（「不是钱没了，是钱贵了」）",
        simNdx,
        chains: [
          {
            domain: "推演：底层垃圾债向二线 AI 算力定向爆破",
            freq_badge: "沙盘推演情景",
            level: "danger",
            live_data: `模拟 CCC 垃圾债收益率 18.8% | CoreWeave 单日 -12% | 超级 IPO 持续破发 | SOFR 走廊平稳`,
            consequence:
              "隔夜美元并不缺（SOFR 温和），但极高的真实资金成本正按资产负债表质量从下往上清剿：依赖高息举债买卡的二线算力租赁与抽血型次新股率先崩盘。",
            conclusion:
              "严格执行去伪存真与反马丁格尔纪律：清退一切高负债二线算力、题材次新及高收益债敞口，绝不死扛摊平。",
          },
          {
            domain: "推演：联储反应函数与大盘分化",
            freq_badge: "沙盘联动结论",
            level: "warning",
            live_data: `IG 投资级利差仍稳 | 10Y 实际利率 > 2.0%`,
            consequence:
              "由于回购管道与投资级大厂债券未崩，美联储「只认管道不认股价」，绝不会为拯救边缘高杠杆算力公司而降息。",
            conclusion:
              "即便保留美股仓位也仅限净现金充沛的核心寡头，同时配置短端国债收息等待信用利差见顶。",
          },
        ],
      };
    }

    return null;
  }

  function renderConsequenceCards(chains, isScenarioPreview) {
    document.getElementById("consequence-grid").innerHTML = (chains || [])
      .map(
        (item) => `
        <article class="consequence-card ${isScenarioPreview ? "is-scenario-preview" : ""} ${item.in_buffer ? "in-hysteresis-buffer" : ""}">
          <div class="consequence-head">
            <span class="consequence-domain">${item.domain}</span>
            <span class="tag ${tagClsForLevel(item.level, item.in_buffer)}">${item.freq_badge}</span>
          </div>
          <div class="chain-step">
            <span class="step-tag">${isScenarioPreview ? "推演输入" : "实时数据"}</span>
            <div class="step-data">${item.live_data}</div>
          </div>
          <div class="chain-step">
            <span class="step-tag">产生后果</span>
            <div class="step-body">${item.consequence}</div>
          </div>
          <div class="chain-step">
            <span class="step-tag conclusion-tag">当下结论</span>
            <div class="step-conclusion">${item.conclusion}</div>
          </div>
        </article>
      `
      )
      .join("");
  }

  function renderLiveTopAndConsequences(bundle) {
    const snap = bundle.snapshot || {};
    const ana = bundle.analysis || {};
    const pillars = ana.pillars || {};
    const fredM = (snap.fred || {}).metrics || {};
    const fredD = (snap.fred || {}).derived || {};
    const quotes = snap.quotes || {};
    const options = snap.options || {};
    const cal = snap.calendar || {};
    const hyst = ana.hysteresis || {};

    document.getElementById("verdict-headline").textContent = ana.headline || "--";
    document.getElementById("verdict-summary").textContent = ana.summary_verdict || "";

    const gammaState = ana.gamma_state || options.gamma_hysteresis?.gamma_state;
    const gammaTag =
      gammaState === "BUFFER_PROBING"
        ? { text: `Zero-Gamma 临界试探中 (~${fmtNum(options.zero_gamma_ndx, 0)})`, cls: "tag-probing" }
        : options.in_negative_gamma
        ? { text: `负Gamma确认 (< ${fmtNum(options.zero_gamma_ndx, 0)})`, cls: "tag-warning" }
        : { text: `正Gamma缓冲 (> ${fmtNum(options.zero_gamma_ndx, 0)})`, cls: "tag-ok" };

    const tags = [
      {
        text: `${ana.money_diagnosis || "--"}`,
        cls: pillars.credit?.level === "danger" ? "tag-danger" : "tag-warning",
      },
      gammaTag,
      {
        text: `厚防线 ~${fmtNum(options.major_put_wall?.ndx_equiv, 0)} (QQQ $${fmtNum(options.major_put_wall?.qqq_strike, 0)})`,
        cls: "tag",
      },
      {
        text: `距月末结算 ${cal.bdays_to_month_end ?? "--"} 交易日`,
        cls: (cal.bdays_to_month_end ?? 10) <= 5 ? "tag-warning" : "tag",
      },
      {
        text: ana.is_gold_discount ? "黄金: 打折期" : "黄金: 常规跟踪",
        cls: ana.is_gold_discount ? "tag-opportunity" : "tag",
      },
    ];
    if (ana.sofr_corridor_state === "BUFFER_OBSERVE") {
      tags.push({ text: "SOFR走廊: 单日毛刺临界观察", cls: "tag-probing" });
    } else if (hyst.regime_hysteresis_held) {
      tags.push({ text: "定调滞回缓冲保护中", cls: "tag-probing" });
    }

    document.getElementById("verdict-tags").innerHTML = tags
      .map((t) => `<span class="tag ${t.cls}">${t.text}</span>`)
      .join("");

    const riskScore = ana.overall_risk_score ?? 0;
    const scoreEl = document.getElementById("overall-risk-score");
    scoreEl.textContent = `${riskScore} / 100`;
    scoreEl.style.color =
      riskScore >= 68
        ? "var(--signal-danger)"
        : riskScore >= 50
        ? "var(--signal-warn)"
        : "var(--signal-ok)";

    const pillarOrder = [
      ["plumbing", false],
      ["credit", false],
      ["microstructure", false],
      ["ai_ledger", false],
      ["gold_spillover", true],
    ];
    document.getElementById("pillar-meters").innerHTML = pillarOrder
      .map(([key, isOpp]) => {
        const p = pillars[key] || {};
        const sc = p.score ?? 0;
        const col = p.in_buffer ? "var(--series-cyan)" : meterColor(p.level, isOpp);
        const bufBadge = p.in_buffer ? `<span class="tag tag-probing" style="padding:1px 5px; font-size:0.68rem;">临界试探中</span> ` : "";
        return `
          <div class="meter-item">
            <div class="meter-label-row">
              <span class="meter-title">${p.title || key}</span>
              <span class="meter-val">${bufBadge}${sc}/100 · ${p.status || ""}</span>
            </div>
            <div class="meter-track">
              <div class="meter-fill" style="width:${sc}%; background:${col};"></div>
            </div>
          </div>
        `;
      })
      .join("");

    const ndxQ = quotes["^NDX"] || {};
    const qqqQ = quotes["QQQ"] || {};
    const goldQ = quotes["GC=F"] || {};
    const nvdaQ = quotes["NVDA"] || {};
    const crwvQ = quotes["CRWV"] || {};
    const antQ = quotes["ANT"] || {};
    const moveQ = quotes["^MOVE"] || {};
    const vxnVal = quotes["^VXN"]?.price || fredM.VXNCLS?.value;
    const sofrInfo = fredD.sofr_iorb_spread || {};
    const sofrSp = sofrInfo.value_bps;
    const consecSofr = sofrInfo.consecutive_days_above_zero ?? 0;
    const rrpVal = fredM.RRPONTSYD?.value;
    const cccYld = fredM.BAMLH0A3HYCEY?.value;

    const kpis = [
      {
        label: "纳指100 / QQQ",
        freq: "秒级",
        freqCls: "freq-live",
        value: `${fmtNum(ndxQ.price, 0)}`,
        sub: `1日 ${fmtSigned(ndxQ.ret_1d_pct, 2, "%")} | QQQ $${fmtNum(qqqQ.price, 2)}`,
        cls: clsSigned(ndxQ.ret_1d_pct),
      },
      {
        label: "COMEX 黄金 (GC=F)",
        freq: "秒级",
        freqCls: "freq-live",
        value: `$${fmtNum(goldQ.price, 1)}`,
        sub: `1日 ${fmtSigned(goldQ.ret_1d_pct, 2, "%")} | RSI(14) ${fmtNum(goldQ.rsi14, 0)}`,
        cls: "gold-txt",
      },
      {
        label: "AI 脆弱端 (CRWV)",
        freq: "秒级",
        freqCls: "freq-live",
        value: `${fmtSigned(crwvQ.ret_1d_pct, 1, "%")}`,
        sub: `NVDA ${fmtSigned(nvdaQ.ret_1d_pct, 1, "%")} | ANT $${fmtNum(antQ.price, 1)}`,
        cls: clsSigned(crwvQ.ret_1d_pct),
      },
      {
        label: "美债 MOVE / 纳指 VXN",
        freq: "日频",
        freqCls: "freq-daily",
        value: `${fmtNum(moveQ.price, 1)} / ${fmtNum(vxnVal, 1)}`,
        sub: `MOVE 20日 ${fmtSigned(moveQ.chg_20_abs, 1)} · 分位 ${fmtNum(moveQ.pct_1y, 0)}%`,
        cls: (moveQ.pct_1y || 0) >= 80 ? "warn-txt" : "",
      },
      {
        label: "SOFR − IORB 利差",
        freq: ana.sofr_corridor_state === "BUFFER_OBSERVE" ? "观察黄灯" : "日更",
        freqCls: "freq-daily",
        value: `${fmtSigned(sofrSp, 1, " bps")}`,
        sub: `连破 ${consecSofr} 日 | RRP $${fmtNum(rrpVal, 2)}B`,
        cls: consecSofr >= 2 || sofrSp >= 8 ? "neg" : sofrSp > 0 ? "warn-txt" : "",
      },
      {
        label: "CCC 垃圾债借钱成本",
        freq: "日更",
        freqCls: "freq-daily",
        value: `${fmtNum(cccYld, 2)}%`,
        sub: `IG仅 ${fmtNum(fredM.BAMLC0A0CM?.value, 2)}% | 实际利率 ${fmtNum(fredM.DFII10?.value, 2)}%`,
        cls: cccYld >= 15 ? "neg" : "",
      },
    ];

    document.getElementById("core-kpi-strip").innerHTML = kpis
      .map(
        (k) => `
        <div class="kpi-box">
          <div class="kpi-head">
            <span class="kpi-label">${k.label}</span>
            <span class="freq-badge ${k.freqCls}">${k.freq}</span>
          </div>
          <div class="kpi-value ${k.cls}">${k.value}</div>
          <div class="kpi-sub">${k.sub}</div>
        </div>
      `
      )
      .join("");

    if (STATE.activeScenario !== "live") {
      const sc = buildScenarioConsequences(STATE.activeScenario, bundle);
      if (sc) {
        renderConsequenceCards(sc.chains, true);
        return;
      }
    }
    renderConsequenceCards(ana.live_consequences || [], false);
  }

  function updateGammaSandbox(ndxVal, opt, scenarioOverrideText) {
    const ratio = opt?.ndx_qqq_ratio || 41.082;
    const zeroG = opt?.zero_gamma_ndx || 27004;
    const loGamma = opt?.gamma_hysteresis?.lower_band_ndx || Math.round(zeroG * 0.9925);
    const hiGamma = opt?.gamma_hysteresis?.upper_band_ndx || Math.round(zeroG * 1.0075);
    const putWall = opt?.major_put_wall?.ndx_equiv || 24649;
    const putWallQ = opt?.major_put_wall?.qqq_strike || 600;
    const psychRound = opt?.psych_25000_check?.psych_round_ndx || 25000;
    const callWall = opt?.major_call_wall?.ndx_equiv || 28758;
    const ndx = Math.round(Number(ndxVal));
    const qqq = Math.round(ndx / ratio);

    document.getElementById("sandbox-readout").textContent =
      `模拟 ^NDX ${ndx.toLocaleString()} (QQQ ~$${qqq})`;

    const box = document.getElementById("sandbox-verdict-box");
    if (scenarioOverrideText) {
      box.innerHTML = scenarioOverrideText;
      return;
    }

    if (ndx > hiGamma) {
      box.innerHTML = `<strong class="pos">【站上翻转缓冲上沿 &gt; ${hiGamma.toLocaleString()} &rarr; 正 Gamma 确认】</strong>：突破 ±0.75% 缓冲带后做市商回归高抛低吸压制波动；若持续站稳 30 分钟且 CCC 利差回落，反抽升级为趋势修复，上方目标墙 ~${callWall.toLocaleString()}。`;
    } else if (ndx >= loGamma) {
      box.innerHTML = `<strong style="color:var(--series-cyan)">【位于 ${loGamma.toLocaleString()}~${hiGamma.toLocaleString()} 滞回缓冲带 &rarr; 临界试探中】</strong>：贴近 Zero-Gamma (~${zeroG.toLocaleString()}) 上下 0.75% 噪音区，正负 Gamma 未确认切换，结论：<strong>按兵不动防假突破来回打脸</strong>，等待站稳30分钟/收盘确认。`;
    } else if (ndx >= psychRound + 150) {
      box.innerHTML = `<strong class="warn-txt">【跌破缓冲下沿 &lt; ${loGamma.toLocaleString()} &rarr; 负 Gamma 放大确认】</strong>：做市商被迫追涨杀跌，突发利好拉升极易回吐（反抽非反转），结论：逢高降杠杆，不追高。`;
    } else if (ndx >= putWall - 80) {
      box.innerHTML = `<strong class="gold-txt">【逼近/测试 ${psychRound.toLocaleString()} 与 ~${putWall.toLocaleString()} (QQQ $${putWallQ}) 最厚防线】</strong>：整数关口筹码单薄易被穿透；真正实盘看跌防线在 ~${putWall.toLocaleString()}，做市商平仓对冲盘将在此触发技术支撑。`;
    } else {
      box.innerHTML = `<strong class="neg">【击穿 ~${putWall.toLocaleString()} 最厚防线 &rarr; 尾部加速去杠杆后果】</strong>：核心期权墙失守引发加速助跌；结论：紧盯 MOVE 与 SOFR−IORB 是否连续破走廊，若管道受损倒逼联储救市，黄金将先于美股暴力反弹。`;
    }
  }

  function applySandboxScenario(presetKey, scrollToConclusions = false) {
    if (!STATE.bundle) return;
    STATE.activeScenario = presetKey;
    const opt = STATE.bundle.snapshot?.options || {};
    const slider = document.getElementById("sandbox-slider");
    const chips = document.querySelectorAll("#sandbox-presets .preset-chip");
    chips.forEach((c) => c.classList.toggle("active", c.getAttribute("data-preset") === presetKey));

    const bar = document.getElementById("scenario-active-bar");
    const barLabel = document.getElementById("scenario-active-label");
    const zoneBadge = document.getElementById("consequence-zone-badge");

    if (presetKey === "live") {
      bar.classList.add("hidden");
      zoneBadge.textContent = "核心研判区";
      zoneBadge.className = "freq-badge freq-live";
      const liveNdx = Math.round(opt.ndx_spot || 25050);
      slider.value = String(liveNdx);
      updateGammaSandbox(liveNdx, opt);
      renderConsequenceCards(STATE.bundle.analysis?.live_consequences || [], false);
      return;
    }

    const sc = buildScenarioConsequences(presetKey, STATE.bundle);
    if (!sc) return;

    slider.value = String(sc.simNdx);
    const firstChain = sc.chains[0];
    const secondChain = sc.chains[1];
    updateGammaSandbox(
      sc.simNdx,
      opt,
      `<strong class="gold-txt">【预设情景：${sc.title}】</strong><br/>` +
        `• <strong>触发后果</strong>：${firstChain.consequence}<br/>` +
        `• <strong>应对动作</strong>：${firstChain.conclusion}` +
        (secondChain ? `<br/>• <strong>跨资产联动</strong>：${secondChain.conclusion}` : "")
    );

    bar.classList.remove("hidden");
    barLabel.textContent = `【沙盘情景推演预览中：${sc.title}】下方结论卡已联动展示该情景应对预案`;
    zoneBadge.textContent = "沙盘情景预览";
    zoneBadge.className = "freq-badge tag-opportunity";
    renderConsequenceCards(sc.chains, true);

    if (scrollToConclusions && window.innerWidth <= 768) {
      showToast(`已联动推演「${sc.title}」（可切回实时结论查看）`);
    }
  }

  function renderIntradayMarkets(bundle) {
    const snap = bundle.snapshot || {};
    const opt = snap.options || {};
    const quotes = snap.quotes || {};
    const fredM = (snap.fred || {}).metrics || {};

    const exps = opt.expirations_scanned || [];
    const cleanStats = opt.cleaning_stats || {};
    document.getElementById("options-exp-label").textContent = exps.length
      ? `${opt.dte_window || "0–45 DTE"} (${exps.length}个到期日: ${exps.slice(0, 2).join(", ")}..${exps[exps.length - 1]})`
      : "实时清洗期权链";

    const psychRound = opt.psych_25000_check?.psych_round_ndx || 25000;
    const profile = opt.strike_profile || [];
    const box = document.getElementById("chart-options-walls");
    if (profile.length >= 5) {
      const W = 620, H = 250, padL = 48, padR = 18, padT = 24, padB = 38;
      const plotW = W - padL - padR, plotH = H - padT - padB;
      const maxOI = Math.max(1, ...profile.map((p) => Math.max(p.put_oi, p.call_oi)));
      const stepW = plotW / profile.length;
      const barW = Math.max(3, stepW * 0.42);

      const minQ = profile[0].qqq_strike;
      const maxQ = profile[profile.length - 1].qqq_strike;
      const xForQ = (q) => padL + ((q - minQ) / Math.max(maxQ - minQ, 1)) * plotW;

      const xSpot = xForQ(opt.qqq_spot || 610);
      const zgQqq = opt.zero_gamma_qqq || 660;
      const xZeroG = xForQ(zgQqq);
      const xBandLo = Math.max(padL, xForQ(zgQqq * 0.9925));
      const xBandHi = Math.min(W - padR, xForQ(zgQqq * 1.0075));
      const xPsych = xForQ(psychRound / (opt.ndx_qqq_ratio || 41.08));

      box.innerHTML = `
        <svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="纳指100与QQQ清洗后期权筹码墙与Zero-Gamma缓冲带">
          <line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="rgba(255,255,255,0.18)" />
          ${
            xBandHi > xBandLo && xZeroG >= padL && xZeroG <= W - padR
              ? `<rect x="${xBandLo.toFixed(1)}" y="${padT}" width="${(xBandHi - xBandLo).toFixed(1)}" height="${plotH}" fill="hsla(199, 72%, 56%, 0.11)" />`
              : ""
          }
          ${profile
            .map((p, i) => {
              const cx = padL + (i + 0.5) * stepW;
              const hPut = (p.put_oi / maxOI) * plotH;
              const hCall = (p.call_oi / maxOI) * plotH;
              const showTick = i % 3 === 0;
              return `
                <rect x="${(cx - barW).toFixed(1)}" y="${(H - padB - hPut).toFixed(1)}" width="${barW.toFixed(1)}" height="${hPut.toFixed(1)}" fill="var(--signal-danger)" opacity="0.82">
                  <title>QQQ $${p.qqq_strike} (~NDX ${p.ndx_equiv}): Put OI ${p.put_oi.toLocaleString()}</title>
                </rect>
                <rect x="${cx.toFixed(1)}" y="${(H - padB - hCall).toFixed(1)}" width="${barW.toFixed(1)}" height="${hCall.toFixed(1)}" fill="var(--signal-ok)" opacity="0.78">
                  <title>QQQ $${p.qqq_strike} (~NDX ${p.ndx_equiv}): Call OI ${p.call_oi.toLocaleString()}</title>
                </rect>
                ${
                  showTick
                    ? `<text x="${cx.toFixed(1)}" y="${H - padB + 14}" text-anchor="middle" fill="var(--text-secondary)" font-size="9.5" font-family="var(--font-mono)">$${p.qqq_strike}</text>
                       <text x="${cx.toFixed(1)}" y="${H - padB + 25}" text-anchor="middle" fill="var(--text-muted)" font-size="8.5" font-family="var(--font-mono)">${(p.ndx_equiv / 1000).toFixed(1)}k</text>`
                    : ""
                }
              `;
            })
            .join("")}
          ${
            xPsych >= padL && xPsych <= W - padR
              ? `<line x1="${xPsych.toFixed(1)}" y1="${padT + 12}" x2="${xPsych.toFixed(1)}" y2="${H - padB}" stroke="rgba(255,255,255,0.35)" stroke-dasharray="2 3" />
                 <text x="${xPsych.toFixed(1)}" y="${padT + 10}" text-anchor="middle" fill="var(--text-muted)" font-size="8.5" font-family="var(--font-mono)">${(psychRound / 1000).toFixed(0)}k</text>`
              : ""
          }
          <line x1="${xSpot.toFixed(1)}" y1="${padT}" x2="${xSpot.toFixed(1)}" y2="${H - padB}" stroke="var(--accent-gold)" stroke-width="2.2" />
          <text x="${xSpot.toFixed(1)}" y="${padT - 6}" text-anchor="middle" fill="var(--accent-gold)" font-size="10" font-weight="600" font-family="var(--font-mono)">现价 ${fmtNum(opt.ndx_spot, 0)} ($${fmtNum(opt.qqq_spot, 1)})</text>
          ${
            xZeroG >= padL && xZeroG <= W - padR
              ? `<line x1="${xZeroG.toFixed(1)}" y1="${padT}" x2="${xZeroG.toFixed(1)}" y2="${H - padB}" stroke="var(--series-cyan)" stroke-width="1.8" stroke-dasharray="4 3" />
                 <text x="${Math.min(W - padR - 95, xZeroG + 4).toFixed(1)}" y="${padT + 10}" text-anchor="start" fill="var(--series-cyan)" font-size="9.5" font-family="var(--font-mono)">Zero-G ~${fmtNum(opt.zero_gamma_ndx, 0)}</text>`
              : ""
          }
        </svg>
      `;
    }

    const slider = document.getElementById("sandbox-slider");
    const spotVal = Math.round(opt.ndx_spot || 25050);
    slider.min = String(Math.round((opt.major_put_wall?.ndx_equiv || 24650) - 1100));
    slider.max = String(Math.round((opt.major_call_wall?.ndx_equiv || 28750) + 500));
    if (STATE.activeScenario === "live") {
      slider.value = String(spotVal);
      updateGammaSandbox(spotVal, opt);
    } else {
      applySandboxScenario(STATE.activeScenario, false);
    }
    slider.oninput = (e) => {
      if (STATE.activeScenario !== "live") {
        STATE.activeScenario = "live";
        document.querySelectorAll("#sandbox-presets .preset-chip").forEach((c) => {
          c.classList.toggle("active", c.getAttribute("data-preset") === "live");
        });
        document.getElementById("scenario-active-bar").classList.add("hidden");
        const zb = document.getElementById("consequence-zone-badge");
        zb.textContent = "核心研判区";
        zb.className = "freq-badge freq-live";
        renderConsequenceCards(bundle.analysis?.live_consequences || [], false);
      }
      updateGammaSandbox(e.target.value, opt);
    };

    // P0.1 Cleaning stats & dealer positioning assumption footnote
    const noteEl = document.getElementById("options-assumption-note");
    if (noteEl) {
      const statsPrefix = cleanStats.kept_contracts
        ? `【期权链清洗已启用：0–45 DTE 近月加权，扫描 ${cleanStats.raw_contracts} 张 → 保留有效合约 ${cleanStats.kept_contracts} 张，已剔除 OI<100(${cleanStats.dropped_low_oi}) / 零买价或点差>30%(${cleanStats.dropped_bad_quote}) / 异常IV(${cleanStats.dropped_bad_iv})】`
        : "【0–45 DTE 近月期权链清洗解算】";
      const caveat =
        opt.assumption_note ||
        "注：GEX 与 Zero-Gamma 基于公开未平仓量（OI）按默认做市商头寸方向假设（净多 Call / 净空 Put）估算，极端单边逼空或机构买方主导行情下真实翻转位可能存在漂移。";
      noteEl.textContent = `${statsPrefix} ${caveat}`;
    }

    const goldQ = quotes["GC=F"] || {};
    const hist = goldQ.history_60d || [];
    document.getElementById("gold-chart-subtitle").textContent =
      `黄金 $${fmtNum(goldQ.price, 1)} (${fmtSigned(goldQ.ret_1d_pct, 2, "%")}) · RSI(14)=${fmtNum(goldQ.rsi14, 0)}`;

    const goldBox = document.getElementById("chart-gold");
    if (hist.length >= 5) {
      const W = 560, H = 175, padL = 48, padR = 14, padT = 14, padB = 22;
      const plotW = W - padL - padR, plotH = H - padT - padB;
      const vals = hist.map((d) => d.close);
      const ma200 = goldQ.ma200 || vals[0];
      const minV = Math.min(ma200, ...vals) * 0.985;
      const maxV = Math.max(ma200, ...vals) * 1.015;
      const xAt = (i) => padL + (i / (hist.length - 1)) * plotW;
      const yAt = (v) => padT + (1 - (v - minV) / Math.max(maxV - minV, 1)) * plotH;

      const linePath = hist
        .map((d, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(d.close).toFixed(1)}`)
        .join(" ");
      const areaPath = `${linePath} L${xAt(hist.length - 1).toFixed(1)},${H - padB} L${padL},${H - padB} Z`;
      const yMa200 = yAt(ma200);

      goldBox.innerHTML = `
        <svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="黄金60日实时走势与200日均线">
          <defs>
            <linearGradient id="goldAreaGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="hsl(41, 70%, 57%)" stop-opacity="0.25" />
              <stop offset="100%" stop-color="hsl(41, 70%, 57%)" stop-opacity="0.0" />
            </linearGradient>
          </defs>
          ${[minV, (minV + maxV) / 2, maxV]
            .map((v) => {
              const y = yAt(v).toFixed(1);
              return `
                <line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="rgba(255,255,255,0.06)" />
                <text x="${padL - 6}" y="${Number(y) + 4}" text-anchor="end" fill="var(--text-muted)" font-size="9.5" font-family="var(--font-mono)">$${v.toFixed(0)}</text>
              `;
            })
            .join("")}
          <line x1="${padL}" y1="${yMa200.toFixed(1)}" x2="${W - padR}" y2="${yMa200.toFixed(1)}" stroke="var(--signal-ok)" stroke-dasharray="4 3" stroke-width="1.4" />
          <text x="${padL + 6}" y="${Math.max(12, yMa200 - 4).toFixed(1)}" fill="var(--signal-ok)" font-size="9" font-family="var(--font-mono)">200DMA $${fmtNum(ma200, 0)}</text>
          <path d="${areaPath}" fill="url(#goldAreaGrad)" />
          <path d="${linePath}" fill="none" stroke="var(--accent-gold)" stroke-width="2.1" />
          <text x="${padL}" y="${H - 4}" fill="var(--text-muted)" font-size="9.5" font-family="var(--font-mono)">${hist[0].date}</text>
          <text x="${W - padR}" y="${H - 4}" text-anchor="end" fill="var(--text-muted)" font-size="9.5" font-family="var(--font-mono)">${hist[hist.length - 1].date}</text>
        </svg>
      `;
    }

    const moveQ = quotes["^MOVE"] || {};
    const vxnVal = quotes["^VXN"]?.price || fredM.VXNCLS?.value;
    const vxnPct = quotes["^VXN"]?.pct_1y || fredM.VXNCLS?.pct_1y;
    const vixQ = quotes["^VIX"] || {};
    const gh = opt.gamma_hysteresis || {};
    const gStateLabel =
      (bundle.analysis?.gamma_state || gh.gamma_state) === "BUFFER_PROBING"
        ? "临界试探中"
        : opt.in_negative_gamma
        ? "负Gamma确认"
        : "正Gamma确认";

    const optRows = [
      ["纳指100 / QQQ 实时价", `${fmtNum(opt.ndx_spot, 0)}`, `QQQ $${fmtNum(opt.qqq_spot, 2)} (1日 ${fmtSigned(quotes["QQQ"]?.ret_1d_pct, 2, "%")})`],
      ["0–45DTE 翻转位 & 缓冲带", `~${fmtNum(opt.zero_gamma_ndx, 0)}`, `${fmtNum(gh.lower_band_ndx, 0)}~${fmtNum(gh.upper_band_ndx, 0)} (${gStateLabel})`],
      ["多头最厚防线 (Put Wall)", `~${fmtNum(opt.major_put_wall?.ndx_equiv, 0)}`, `QQQ $${fmtNum(opt.major_put_wall?.qqq_strike, 0)} (距现价 ${fmtSigned(opt.major_put_wall?.dist_pct, 2, "%")})`],
      [`${psychRound.toLocaleString()} 整数关口对比`, `~${psychRound.toLocaleString()}`, `厚防线筹码是此处的 ${fmtNum(opt.psych_25000_check?.wall_to_25000_oi_ratio, 1)} 倍`],
      ["上方最大看涨阻力墙", `~${fmtNum(opt.major_call_wall?.ndx_equiv, 0)}`, `QQQ $${fmtNum(opt.major_call_wall?.qqq_strike, 0)} (OI ${fmtNum(opt.major_call_wall?.open_interest, 0)})`],
      ["美债 MOVE vs 纳指 VXN", `${fmtNum(moveQ.price, 1)} / ${fmtNum(vxnVal, 1)}`, `分位 ${fmtNum(moveQ.pct_1y, 0)}% vs ${fmtNum(vxnPct, 0)}% (VIX ${fmtNum(vixQ.price, 1)})`],
    ];
    document.getElementById("options-summary-tbody").innerHTML = optRows
      .map(([k, v, sub]) => `<tr><td>${k}</td><td class="num">${v}</td><td class="num">${sub}</td></tr>`)
      .join("");

    const aiTickers = [
      ["NVDA", "核心算力芯片"],
      ["AVGO", "定制ASIC"],
      ["SMH", "半导体ETF"],
      ["ANT", "Anthropic"],
      ["CRWV", "CoreWeave (二线算力债)"],
      ["VST", "AI电力瓶颈"],
    ];
    document.getElementById("ai-equities-tbody").innerHTML = aiTickers
      .map(([sym, role]) => {
        const q = quotes[sym] || {};
        const extra = q.vs_ipo_pct !== undefined ? ` (IPO ${fmtSigned(q.vs_ipo_pct, 1, "%")})` : "";
        return `
          <tr>
            <td><strong>${sym}</strong> · <span style="color:var(--text-muted)">${role}${extra}</span></td>
            <td class="num">$${fmtNum(q.price, 2)}</td>
            <td class="num ${clsSigned(q.ret_1d_pct)}">${fmtSigned(q.ret_1d_pct, 2, "%")}</td>
            <td class="num ${clsSigned(q.ret_5d_pct)}">${fmtSigned(q.ret_5d_pct, 1, "%")}</td>
            <td class="num ${clsSigned(q.drawdown_52w_pct)}">${fmtSigned(q.drawdown_52w_pct, 1, "%")}</td>
          </tr>
        `;
      })
      .join("");

    const crossList = [
      ["^GSPC", "标普500指数"],
      ["QQQ", "纳指100 ETF (QQQ)"],
      ["GC=F", "COMEX 黄金期货"],
      ["HG=F", "COMEX 铜期货"],
      ["TLT", "20年+长端美债 ETF"],
      ["SHV", "短端美债现金 ETF"],
      ["HYG", "美国高收益债 ETF"],
      ["USDCNH=X", "离岸人民币 USD/CNH"],
      ["FXI", "中国大盘红利 (FXI)"],
      ["KWEB", "中概互联 (KWEB)"],
      ["^KS11", "韩国综指 KOSPI"],
    ];
    document.getElementById("spillover-tbody").innerHTML = crossList
      .map(([sym, label]) => {
        const q = quotes[sym] || {};
        const digits = (q.price || 0) < 15 ? 3 : 2;
        return `
          <tr>
            <td><strong>${label}</strong></td>
            <td class="num">${fmtNum(q.price, digits)}</td>
            <td class="num ${clsSigned(q.ret_5d_pct)}">${fmtSigned(q.ret_5d_pct, 2, "%")}</td>
            <td class="num ${clsSigned(q.ret_20d_pct)}">${fmtSigned(q.ret_20d_pct, 1, "%")}</td>
            <td class="num ${clsSigned(q.drawdown_52w_pct)}">${fmtSigned(q.drawdown_52w_pct, 1, "%")}</td>
          </tr>
        `;
      })
      .join("");
  }

  // ---------------------------------------------------------------------------
  // P1.4 + P1.3: DAILY PLUMBING WITH MOVE LEADING CARD & SOFR HYSTERESIS
  // ---------------------------------------------------------------------------
  function renderDailyPlumbing(bundle) {
    const snap = bundle.snapshot || {};
    const ana = bundle.analysis || {};
    const fredM = (snap.fred || {}).metrics || {};
    const fredD = (snap.fred || {}).derived || {};
    const quotes = snap.quotes || {};
    const moveQ = quotes["^MOVE"] || {};

    // Render MOVE Leading Plumbing Card
    const moveVal = moveQ.price;
    const moveChg20 =
      moveQ.chg_20_abs !== undefined
        ? moveQ.chg_20_abs
        : moveVal && moveQ.ret_20d_pct !== undefined
        ? moveVal - moveVal / (1 + moveQ.ret_20d_pct / 100)
        : null;
    const movePct1y = moveQ.pct_1y ?? 50;

    const moveBadge = document.getElementById("move-plumbing-badge");
    if (moveBadge) {
      if ((moveVal || 0) >= 115 || movePct1y >= 80) {
        moveBadge.textContent = "美债波动高压 · 紧盯管道摩擦";
        moveBadge.className = "tag tag-danger";
      } else if ((moveVal || 0) >= 98 || (moveChg20 || 0) >= 5) {
        moveBadge.textContent = "前置敏感区 · 留意拍卖与结算";
        moveBadge.className = "tag tag-warning";
      } else {
        moveBadge.textContent = "美债做市商波动平稳";
        moveBadge.className = "tag tag-ok";
      }
    }

    const moveStatsEl = document.getElementById("move-plumbing-stats");
    if (moveStatsEl) {
      moveStatsEl.innerHTML = `
        <div class="move-stat-item">
          <div class="move-stat-label">MOVE 最新读数</div>
          <div class="move-stat-val ${(moveVal || 0) >= 115 ? "neg" : ""}">${fmtNum(moveVal, 1)} <span style="font-size:0.72rem; color:var(--text-muted)">(${fmtSigned(moveQ.ret_1d_pct, 1, "%")})</span></div>
        </div>
        <div class="move-stat-item">
          <div class="move-stat-label">20日变化 (点 / %)</div>
          <div class="move-stat-val ${clsSigned(moveChg20, true)}">${fmtSigned(moveChg20, 1, " pts")} <span style="font-size:0.72rem;">(${fmtSigned(moveQ.ret_20d_pct, 1, "%")})</span></div>
        </div>
        <div class="move-stat-item">
          <div class="move-stat-label">1年历史分位</div>
          <div class="move-stat-val ${movePct1y >= 80 ? "warn-txt" : ""}">${fmtNum(movePct1y, 0)}% <span style="font-size:0.72rem; color:var(--text-muted)">(${fmtNum(moveQ.low_52w, 0)}–${fmtNum(moveQ.high_52w, 0)})</span></div>
        </div>
      `;
    }

    const moveSparkEl = document.getElementById("chart-move-sparkline");
    const moveHist = moveQ.history_60d || [];
    if (moveSparkEl && moveHist.length >= 5) {
      const W = 200, H = 52, pad = 5;
      const vals = moveHist.map((d) => d.close);
      const minV = Math.min(...vals) * 0.99;
      const maxV = Math.max(...vals) * 1.01;
      const xAt = (i) => pad + (i / (moveHist.length - 1)) * (W - pad * 2);
      const yAt = (v) => pad + (1 - (v - minV) / Math.max(maxV - minV, 0.5)) * (H - pad * 2);
      const pth = moveHist.map((d, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yAt(d.close).toFixed(1)}`).join(" ");
      moveSparkEl.innerHTML = `
        <svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="MOVE指数近60日火花线">
          <path d="${pth}" fill="none" stroke="var(--series-cyan)" stroke-width="1.8" />
          <circle cx="${xAt(moveHist.length - 1).toFixed(1)}" cy="${yAt(vals[vals.length - 1]).toFixed(1)}" r="2.8" fill="var(--accent-gold)" />
          <text x="${pad}" y="${H - 1}" fill="var(--text-muted)" font-size="8.5" font-family="var(--font-mono)">60d MOVE</text>
          <text x="${W - pad}" y="${H - 1}" text-anchor="end" fill="var(--text-secondary)" font-size="8.5" font-family="var(--font-mono)">${fmtNum(moveVal, 1)}</text>
        </svg>
      `;
    }

    const sofrObj = fredD.sofr_iorb_spread || {};
    const spHist = sofrObj.history || [];
    const consecDays = sofrObj.consecutive_days_above_zero ?? 0;
    const sofrSub = document.getElementById("sofr-corridor-subtitle");
    if (sofrSub) {
      if (ana.sofr_corridor_state === "BUFFER_OBSERVE") {
        sofrSub.textContent = "当前：单日轻微越界 (连破1日) · 处于滞回观察黄灯，连续2日 >0bps 才升级红灯";
      } else if (ana.sofr_corridor_state === "STRESS_CONFIRMED") {
        sofrSub.textContent = `当前：连续 ${Math.max(consecDays, 2)} 日或大幅突破走廊上限 · 红灯吃紧确认`;
      } else {
        sofrSub.textContent = `当前：${fmtSigned(sofrObj.value_bps, 1, " bps")} 位于走廊上限内（绿灯平稳）`;
      }
    }

    const spBox = document.getElementById("chart-sofr-spread");
    if (spHist.length >= 5) {
      const W = 540, H = 185, padL = 42, padR = 14, padT = 16, padB = 24;
      const plotW = W - padL - padR, plotH = H - padT - padB;
      const vals = spHist.map((d) => d.spread_bps);
      const minV = Math.min(-6, ...vals) - 1;
      const maxV = Math.max(8, ...vals) + 2;
      const yAt = (v) => padT + (1 - (v - minV) / (maxV - minV)) * plotH;
      const yZero = yAt(0);
      const barW = Math.max(2, plotW / spHist.length - 1.4);

      spBox.innerHTML = `
        <svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="SOFR减IORB利差柱状图（含2日滞回确认色标）">
          <line x1="${padL}" y1="${yZero.toFixed(1)}" x2="${W - padR}" y2="${yZero.toFixed(1)}" stroke="rgba(255,255,255,0.25)" stroke-dasharray="3 3" />
          <text x="${padL - 5}" y="${yZero.toFixed(1)}" text-anchor="end" dominant-baseline="middle" fill="var(--text-muted)" font-size="10" font-family="var(--font-mono)">0bp</text>
          <text x="${padL - 5}" y="${padT + 6}" text-anchor="end" fill="var(--signal-warn)" font-size="10" font-family="var(--font-mono)">+${maxV.toFixed(0)}bp</text>
          <text x="${padL - 5}" y="${H - padB}" text-anchor="end" fill="var(--text-muted)" font-size="10" font-family="var(--font-mono)">${minV.toFixed(0)}bp</text>
          ${spHist
            .map((d, i) => {
              const x = padL + (i / spHist.length) * plotW;
              const yVal = yAt(d.spread_bps);
              const top = Math.min(yZero, yVal);
              const h = Math.max(1.5, Math.abs(yVal - yZero));
              const prevGt0 = i > 0 && spHist[i - 1].spread_bps > 0;
              const col =
                d.spread_bps >= 8 || (d.spread_bps > 0 && prevGt0)
                  ? "var(--signal-danger)"
                  : d.spread_bps > 0
                  ? "var(--signal-warn)"
                  : "var(--series-cyan)";
              return `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${col}" opacity="0.88"><title>${d.date}: ${d.spread_bps} bps</title></rect>`;
            })
            .join("")}
          <text x="${padL}" y="${H - 5}" fill="var(--text-muted)" font-size="10" font-family="var(--font-mono)">${spHist[0].date}</text>
          <text x="${W - padR}" y="${H - 5}" text-anchor="end" fill="var(--text-muted)" font-size="10" font-family="var(--font-mono)">${spHist[spHist.length - 1].date}</text>
        </svg>
      `;
    }

    const moveRowHtml = `
      <tr>
        <td><strong>MOVE 美债波动率</strong> <span style="color:var(--text-muted)">(修管道前置预警)</span></td>
        <td class="num ${(moveVal || 0) >= 115 ? "neg" : "gold-txt"}">${fmtNum(moveVal, 1)} pts</td>
        <td class="num ${clsSigned(moveChg20, true)}">${fmtSigned(moveChg20, 1, " pts")}</td>
        <td class="num">${fmtNum(movePct1y, 0)}%</td>
      </tr>
    `;

    const creditRows = [
      ["BAMLH0A3HYCEY", "CCC级垃圾债有效收益率 (底层边缘债)"],
      ["BAMLH0A3HYC", "CCC级垃圾债利差 (OAS)"],
      ["BAMLH0A0HYM2", "高收益债整体利差 (HY OAS)"],
      ["BAMLC0A0CM", "投资级大厂债利差 (IG OAS)"],
      ["DFII10", "10Y TIPS 实际利率"],
      ["DGS10", "10年期美债名义收益率"],
      ["DGS3MO", "3个月短端美债收益率 (现金替代)"],
    ];
    document.getElementById("credit-tier-tbody").innerHTML =
      moveRowHtml +
      creditRows
        .map(([id, label]) => {
          const m = fredM[id] || {};
          const hiStress = (id === "BAMLH0A3HYCEY" && m.value >= 15) || m.pct_1y >= 85;
          return `
            <tr>
              <td>${label}</td>
              <td class="num ${hiStress ? "neg" : ""}">${fmtNum(m.value, 2)}${m.unit || "%"}</td>
              <td class="num ${clsSigned(m.chg_20, true)}">${fmtSigned(m.chg_20, 2, "%")}</td>
              <td class="num">${fmtNum(m.pct_1y, 0)}%</td>
            </tr>
          `;
        })
        .join("");
  }

  function renderSupplementaryBottom(bundle) {
    const snap = bundle.snapshot || {};
    const ana = bundle.analysis || {};
    const sched = bundle.scheduler || {};
    const fredM = (snap.fred || {}).metrics || {};
    const fredD = (snap.fred || {}).derived || {};
    const aiLedger = snap.ai_ledger || {};
    const aiPillar = ana.pillars?.ai_ledger || {};

    const comps = aiLedger.companies || [];
    const sum = aiLedger.summary || {};
    document.getElementById("ai-capex-summary-label").textContent =
      `年化算力开支 $${fmtNum(sum.annualized_capex_bn, 0)}B · 单季合计 FCF $${fmtSigned(sum.quarterly_fcf_bn, 1, "B")}`;

    const chartEl = document.getElementById("chart-ai-capex");
    if (comps.length > 0) {
      const W = 520, H = 175, padL = 44, padR = 14, padT = 16, padB = 24;
      const plotW = W - padL - padR, plotH = H - padT - padB;
      const maxV = Math.max(10, ...comps.map((c) => Math.max(c.ocf_bn, c.capex_bn))) * 1.12;
      const grpW = plotW / comps.length;
      const bW = Math.min(22, grpW * 0.28);

      chartEl.innerHTML = `
        <svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="云五巨头季报现金流与资本开支对比">
          <line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="rgba(255,255,255,0.18)" />
          ${[0, Math.round(maxV / 2), Math.round(maxV)]
            .map((v) => {
              const y = (H - padB - (v / maxV) * plotH).toFixed(1);
              return `
                <line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="rgba(255,255,255,0.06)" />
                <text x="${padL - 6}" y="${Number(y) + 4}" text-anchor="end" fill="var(--text-muted)" font-size="9.5" font-family="var(--font-mono)">$${v}B</text>
              `;
            })
            .join("")}
          ${comps
            .map((c, i) => {
              const cx = padL + (i + 0.5) * grpW;
              const hOcf = (c.ocf_bn / maxV) * plotH;
              const hCap = (c.capex_bn / maxV) * plotH;
              return `
                <rect x="${(cx - bW - 2).toFixed(1)}" y="${(H - padB - hOcf).toFixed(1)}" width="${bW}" height="${hOcf.toFixed(1)}" fill="var(--series-cyan)" rx="2"></rect>
                <rect x="${(cx + 2).toFixed(1)}" y="${(H - padB - hCap).toFixed(1)}" width="${bW}" height="${hCap.toFixed(1)}" fill="${c.fcf_negative ? "var(--signal-danger)" : "var(--signal-warn)"}" rx="2"></rect>
                <text x="${cx.toFixed(1)}" y="${H - 7}" text-anchor="middle" fill="var(--text-primary)" font-size="10.5" font-weight="600" font-family="var(--font-mono)">${c.symbol}</text>
              `;
            })
            .join("")}
        </svg>
      `;
    }

    document.getElementById("ai-ledger-tbody").innerHTML = comps
      .map(
        (c) => `
        <tr>
          <td><strong>${c.symbol}</strong></td>
          <td>${c.quarter_end.slice(2)}</td>
          <td class="num">$${fmtNum(c.ocf_bn, 1)}B</td>
          <td class="num">$${fmtNum(c.capex_bn, 1)}B</td>
          <td class="num ${c.fcf_negative ? "neg" : "pos"}">${fmtSigned(c.fcf_bn, 1, "B")}</td>
          <td class="num ${c.capex_to_ocf_pct > 100 ? "neg" : "warn-txt"}">${fmtNum(c.capex_to_ocf_pct, 0)}%</td>
        </tr>
      `
      )
      .join("");

    document.getElementById("ai-signals-list").innerHTML = (aiPillar.peak_signals || [])
      .map(
        (s) => `
        <div class="signal-row">
          <div>
            <div class="signal-name">${s.name}</div>
            <div class="signal-detail">${s.detail}</div>
          </div>
          <span class="tag ${s.triggered ? "tag-danger" : "tag-ok"}">${s.triggered ? "已触发" : "未触发"}</span>
        </div>
      `
      )
      .join("");

    const netLiq = fredD.net_liquidity || {};
    const series = netLiq.series || [];
    document.getElementById("net-liq-subtitle").textContent =
      `净流动性 $${fmtNum(netLiq.value_tn, 2)}T · 银行准备金 $${fmtNum((fredM.WRESBAL?.value || 0) / 1000, 2)}T · TGA $${fmtNum(fredM.WTREGEN?.value, 0)}B`;

    const liqBox = document.getElementById("chart-liquidity");
    if (series.length >= 4) {
      const W = 540, H = 175, padL = 46, padR = 44, padT = 14, padB = 22;
      const plotW = W - padL - padR, plotH = H - padT - padB;
      const nlVals = series.map((d) => d.net_liq_bn / 1000.0);
      const tgaVals = series.map((d) => d.tga_bn);
      const nlMin = Math.min(...nlVals) * 0.985, nlMax = Math.max(...nlVals) * 1.015;
      const tgaMin = 0, tgaMax = Math.max(...tgaVals, 1000) * 1.08;

      const xAt = (i) => padL + (i / (series.length - 1)) * plotW;
      const yNl = (v) => padT + (1 - (v - nlMin) / Math.max(nlMax - nlMin, 0.01)) * plotH;
      const yTga = (v) => padT + (1 - (v - tgaMin) / Math.max(tgaMax - tgaMin, 1)) * plotH;

      const nlPath = series
        .map((d, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yNl(d.net_liq_bn / 1000).toFixed(1)}`)
        .join(" ");
      const tgaPath = series
        .map((d, i) => `${i === 0 ? "M" : "L"}${xAt(i).toFixed(1)},${yTga(d.tga_bn).toFixed(1)}`)
        .join(" ");

      liqBox.innerHTML = `
        <svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="美元净流动性与TGA周报曲线">
          ${[nlMin, (nlMin + nlMax) / 2, nlMax]
            .map((v) => {
              const y = yNl(v).toFixed(1);
              return `
                <line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="rgba(255,255,255,0.06)" />
                <text x="${padL - 5}" y="${Number(y) + 4}" text-anchor="end" fill="var(--accent-gold)" font-size="9.5" font-family="var(--font-mono)">$${v.toFixed(2)}T</text>
              `;
            })
            .join("")}
          ${[0, Math.round(tgaMax / 2), Math.round(tgaMax)]
            .map((v) => {
              const y = yTga(v).toFixed(1);
              return `<text x="${W - padR + 5}" y="${Number(y) + 4}" text-anchor="start" fill="var(--series-cyan)" font-size="9.5" font-family="var(--font-mono)">$${v}B</text>`;
            })
            .join("")}
          <path d="${tgaPath}" fill="none" stroke="var(--series-cyan)" stroke-width="1.5" stroke-dasharray="3 2" opacity="0.85" />
          <path d="${nlPath}" fill="none" stroke="var(--accent-gold)" stroke-width="2.1" />
          <text x="${padL}" y="${H - 4}" fill="var(--text-muted)" font-size="9.5" font-family="var(--font-mono)">${series[0].date}</text>
          <text x="${W - padR}" y="${H - 4}" text-anchor="end" fill="var(--text-muted)" font-size="9.5" font-family="var(--font-mono)">${series[series.length - 1].date}</text>
        </svg>
      `;
    }

    document.getElementById("schedule-mode-subtitle").textContent = sched.mode_label
      ? `${sched.mode_label} (${sched.interval_minutes}m)`
      : "智能调度";

    document.getElementById("checkpoints-tbody").innerHTML = (sched.upcoming_checkpoints || [])
      .slice(0, 6)
      .map(
        (ev) => `
        <tr>
          <td><strong>${ev.title}</strong></td>
          <td class="num">${ev.time_et}</td>
          <td class="num gold-txt">${formatLocalTime(ev.time_utc)}</td>
        </tr>
      `
      )
      .join("");
  }

  // ---------------------------------------------------------------------------
  // P2.6: HISTORICAL RUN LOG WITH STATE-TRANSITION & RISK-JUMP HIGHLIGHTS
  // ---------------------------------------------------------------------------
  const REGIME_LABELS = {
    RED_PLUMBING: "红色警报",
    DEFENSIVE_BOUNCE: "防守反击期",
    CAUTIOUS_NEUTRAL: "震荡防御期",
    RISK_ON: "顺风进攻期",
  };

  function inferRegimePrefix(row) {
    if (row.regime_code && REGIME_LABELS[row.regime_code]) {
      return REGIME_LABELS[row.regime_code];
    }
    const hl = String(row.headline || "");
    return hl.includes("：") ? hl.split("：")[0].trim() : row.regime_code || hl.slice(0, 8);
  }

  function renderHistoryRows(runs) {
    const list = (runs || []).slice(0, 12);
    document.getElementById("history-tbody").innerHTML = list
      .map((r, idx) => {
        const older = idx + 1 < list.length ? list[idx + 1] : null;
        let tags = Array.isArray(r.transition_tags) ? [...r.transition_tags] : [];
        let delta = typeof r.risk_delta === "number" ? r.risk_delta : 0;

        if (!r.transition_tags && older) {
          delta = Number(r.overall_risk_score || 0) - Number(older.overall_risk_score || 0);
          const rk1 = inferRegimePrefix(r);
          const rk0 = inferRegimePrefix(older);
          if (rk1 && rk0 && rk1 !== rk0) tags.push(`定调切换 (${rk0}→${rk1})`);
          if (r.gamma_state && older.gamma_state && r.gamma_state !== older.gamma_state) {
            tags.push(`Gamma切换`);
          }
          if (Math.abs(delta) >= 6) {
            tags.push(`风险跳变 ${delta > 0 ? "+" : ""}${delta}`);
          }
        }

        const hasTrans = Boolean(r.has_transition || tags.length > 0);
        const badgesHtml = hasTrans
          ? `<div class="transition-cell">${tags
              .map((t) => {
                const cls = t.includes("风险跳变 +")
                  ? "jump-up"
                  : t.includes("风险跳变 -")
                  ? "jump-down"
                  : "";
                return `<span class="transition-badge ${cls}">⚡ ${t}</span>`;
              })
              .join("")}</div>`
          : `<span class="transition-steady">— 平稳延续</span>`;

        const deltaTxt =
          older || delta !== 0
            ? ` <span class="${delta >= 6 ? "neg" : delta <= -6 ? "pos" : ""}" style="font-size:0.72rem; color:${
                Math.abs(delta) < 6 ? "var(--text-muted)" : ""
              }">(${delta >= 0 ? "+" : ""}${delta})</span>`
            : "";

        return `
          <tr class="${hasTrans ? "row-transition" : ""}">
            <td class="num">#${r.id} <span style="color:var(--text-muted); font-size:0.72rem;">[${r.trigger_source || "auto"}]</span></td>
            <td style="font-family:var(--font-mono)">${formatLocalTime(r.collected_at_utc)}</td>
            <td>${badgesHtml}</td>
            <td class="num"><strong>${r.overall_risk_score}</strong>${deltaTxt}</td>
            <td class="num gold-txt">${r.gold_opp_score}</td>
            <td class="num">${fmtNum(r.ndx_spot, 0)} / $${fmtNum(r.gold_spot, 0)}</td>
          </tr>
        `;
      })
      .join("");
  }

  function renderAll(bundle) {
    STATE.bundle = bundle;
    renderTopMeta(bundle);
    renderLiveTopAndConsequences(bundle);
    renderIntradayMarkets(bundle);
    renderDailyPlumbing(bundle);
    renderSupplementaryBottom(bundle);
  }

  async function refreshRealtimeQuotesAndRender() {
    if (!STATE.bundle) return false;
    const ok = await fetchRealtimeBrowserQuotes(STATE.bundle);
    renderTopMeta(STATE.bundle);
    if (ok) {
      renderLiveTopAndConsequences(STATE.bundle);
      renderIntradayMarkets(STATE.bundle);
    }
    return ok;
  }

  async function loadHistory() {
    try {
      const url = STATE.mode === "api" ? apiUrl("/api/history") : `./data/history.json?_t=${Date.now()}`;
      const resp = await fetch(url, { cache: "no-store" });
      if (!resp.ok) return;
      const data = await resp.json();
      renderHistoryRows(data.runs || []);
    } catch (_) {}
  }

  async function waitUntilBackendRefreshCompletes(prevUtc) {
    setSyncBanner(true, "检测到数据已过保鲜阈值，后台正在实时拉取最新 FRED / 0–45DTE 期权链报价...");
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const stResp = await fetch(apiUrl("/api/status"), { cache: "no-store" });
        if (!stResp.ok) break;
        const st = await stResp.json();
        STATE.backendFallbackCached = Boolean(st.fallback_cached);
        STATE.backendFallbackReason = st.fallback_reason || "";
        if (!st.is_refreshing && st.collected_at_utc && st.collected_at_utc !== prevUtc) {
          const latResp = await fetch(apiUrl("/api/latest"), { cache: "no-store" });
          if (latResp.ok) {
            const fresh = await latResp.json();
            await fetchRealtimeBrowserQuotes(fresh);
            renderAll(fresh);
            await loadHistory();
            showToast("已自动静默更新至最新实盘数据");
          }
          break;
        }
        if (!st.is_refreshing && i >= 2) {
          if (STATE.bundle) renderTopMeta(STATE.bundle);
          break;
        }
      } catch (_) {
        break;
      }
    }
    setSyncBanner(false);
  }

  async function triggerOnVisitCheck() {
    await refreshRealtimeQuotesAndRender();
    if (STATE.mode === "api") {
      try {
        const prevUtc = STATE.lastCollectedUtc;
        const vResp = await fetch(apiUrl("/api/visit"), { method: "POST" });
        if (vResp.ok) {
          const v = await vResp.json();
          if (v.is_refreshing) await waitUntilBackendRefreshCompletes(prevUtc);
        }
      } catch (_) {}
    } else if (STATE.mode === "static") {
      try {
        const resp = await fetch(`./data/latest_snapshot.json?_t=${Date.now()}`, { cache: "no-store" });
        if (resp.ok) {
          const fresh = await resp.json();
          if (fresh?.snapshot?.collected_at_utc !== STATE.lastCollectedUtc) {
            await fetchRealtimeBrowserQuotes(fresh);
            renderAll(fresh);
            await loadHistory();
          }
        }
      } catch (_) {}
    }
  }

  async function detectAndLoadInitial() {
    let customApiFailed = false;
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3500);
      const resp = await fetch(apiUrl("/api/latest"), { cache: "no-store", signal: ctrl.signal });
      clearTimeout(timer);
      if (resp.ok && (resp.headers.get("content-type") || "").includes("application/json")) {
        STATE.mode = "api";
        const bundle = await resp.json();
        STATE.backendFallbackCached = Boolean(bundle.fallback_cached);
        STATE.backendFallbackReason = bundle.fallback_reason || "";
        await fetchRealtimeBrowserQuotes(bundle);
        renderAll(bundle);
        await loadHistory();
        document.getElementById("current-mode-badge").textContent =
          "实时 Python 后端 + 浏览器盘中秒级行情直连";
        triggerOnVisitCheck();
        return;
      }
      if (STATE.apiBase) customApiFailed = true;
    } catch (_) {
      if (STATE.apiBase) customApiFailed = true;
    }

    STATE.mode = "static";
    STATE.backendFallbackCached = customApiFailed;
    STATE.backendFallbackReason = customApiFailed ? "自定义实时后端连接超时，已降级回退静态快照" : "";
    document.getElementById("current-mode-badge").textContent =
      "盘中秒级行情直连 + GitHub 云端定期巡检";
    const resp = await fetch(`./data/latest_snapshot.json?_t=${Date.now()}`, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const bundle = await resp.json();
    await fetchRealtimeBrowserQuotes(bundle);
    renderAll(bundle);
    await loadHistory();
  }

  async function triggerManualRefresh() {
    const btn = document.getElementById("btn-refresh-live");
    const label = document.getElementById("btn-refresh-label");
    btn.disabled = true;
    btn.classList.add("is-loading");
    label.textContent = "拉取最新行情...";
    try {
      if (STATE.mode === "api") {
        const resp = await fetch(apiUrl("/api/refresh"), { method: "POST" });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const bundle = await resp.json();
        STATE.backendFallbackCached = Boolean(bundle.fallback_cached);
        STATE.backendFallbackReason = bundle.fallback_reason || "";
        await fetchRealtimeBrowserQuotes(bundle);
        renderAll(bundle);
        await loadHistory();
        showToast(
          bundle.fallback_cached
            ? "上游限流降级：已保留最近有效缓存快照"
            : "已完成全量 FRED / 清洗期权链与秒级行情重算"
        );
      } else {
        const resp = await fetch(`./data/latest_snapshot.json?_t=${Date.now()}`, { cache: "no-store" });
        if (resp.ok) {
          const bundle = await resp.json();
          await fetchRealtimeBrowserQuotes(bundle);
          renderAll(bundle);
          await loadHistory();
        } else {
          await refreshRealtimeQuotesAndRender();
        }
        showToast(`已刷新至最新盘中实盘价 (${STATE.liveQuoteEtTime ? STATE.liveQuoteEtTime.slice(11) + " ET" : "最新"})`);
      }
    } catch (err) {
      STATE.backendFallbackCached = true;
      STATE.backendFallbackReason = err.message || "网络或接口异常";
      if (STATE.bundle) renderTopMeta(STATE.bundle);
      showToast("刷新异常，当前维持缓存快照: " + err.message);
    } finally {
      btn.disabled = false;
      btn.classList.remove("is-loading");
      label.textContent = "实时刷新数据";
    }
  }

  function bindUiEvents() {
    document.getElementById("btn-refresh-live").addEventListener("click", triggerManualRefresh);
    const retryBtn = document.getElementById("btn-retry-degraded");
    if (retryBtn) retryBtn.addEventListener("click", triggerManualRefresh);

    // P2.5 Sandbox Preset Quick Buttons & Exit Scenario Button
    document.querySelectorAll("#sandbox-presets .preset-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        const preset = chip.getAttribute("data-preset") || "live";
        applySandboxScenario(preset, true);
      });
    });

    const exitScenarioBtn = document.getElementById("btn-exit-scenario");
    if (exitScenarioBtn) {
      exitScenarioBtn.addEventListener("click", () => applySandboxScenario("live", false));
    }

    const navLinks = document.querySelectorAll(".nav-link");
    navLinks.forEach((lnk) => {
      lnk.addEventListener("click", () => {
        navLinks.forEach((l) => l.classList.remove("active"));
        lnk.classList.add("active");
      });
    });

    const mobTabs = document.querySelectorAll(".mob-tab");
    mobTabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        const target = tab.getAttribute("data-target-tab") || "all";
        document.body.setAttribute("data-mobile-tab", target);
        mobTabs.forEach((t) => t.classList.remove("active"));
        tab.classList.add("active");
        window.scrollTo({ top: 0, behavior: "smooth" });
      });
    });

    const modal = document.getElementById("settings-modal");
    const inputApi = document.getElementById("input-api-base");
    document.getElementById("btn-open-settings").addEventListener("click", () => {
      inputApi.value = STATE.apiBase;
      modal.classList.add("open");
    });
    document.getElementById("btn-close-settings").addEventListener("click", () => modal.classList.remove("open"));
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.classList.remove("open");
    });
    document.getElementById("btn-save-settings").addEventListener("click", async () => {
      const val = inputApi.value.trim().replace(/\/+$/, "");
      STATE.apiBase = val;
      if (val) localStorage.setItem("sentinel_api_base", val);
      else localStorage.removeItem("sentinel_api_base");
      modal.classList.remove("open");
      try {
        await detectAndLoadInitial();
      } catch (err) {
        showToast("连接失败: " + err.message);
      }
    });

    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        triggerOnVisitCheck();
      }
    });

    // Auto-stream real-time exchange quotes & re-check 5-min market-open staleness every 20s
    window.setInterval(async () => {
      if (document.visibilityState === "visible") {
        await refreshRealtimeQuotesAndRender();
      }
    }, 20000);
  }

  async function init() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    }
    bindUiEvents();
    try {
      await detectAndLoadInitial();
    } catch (err) {
      showToast("初始数据加载失败: " + err.message);
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
