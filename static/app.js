/* Henren Market Sentinel — Real-Time Browser Quote Stream + Live-Top / Static-Bottom Engine */
(function () {
  "use strict";

  const STATE = {
    mode: "detecting",
    apiBase: (localStorage.getItem("sentinel_api_base") || "").replace(/\/+$/, ""),
    bundle: null,
    lastCollectedUtc: null,
    liveQuoteEtTime: null,
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

  function formatRelativeAge(isoUtc) {
    if (STATE.liveQuoteEtTime) {
      return `行情直连 ${STATE.liveQuoteEtTime.slice(5)} ET`;
    }
    if (!isoUtc) return "--";
    const d = new Date(isoUtc);
    if (Number.isNaN(d.getTime())) return "--";
    const diffSec = Math.max(0, Math.floor((Date.now() - d.getTime()) / 1000));
    if (diffSec < 60) return "刚刚更新";
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}分钟前`;
    if (diffSec < 86400) return `${(diffSec / 3600).toFixed(1)}小时前`;
    return `${Math.floor(diffSec / 86400)}天前`;
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

  function tagClsForLevel(level) {
    if (level === "danger") return "tag-danger";
    if (level === "warning") return "tag-warning";
    if (level === "opportunity") return "tag-opportunity";
    return "tag-ok";
  }

  function apiUrl(path) {
    if (STATE.apiBase) return `${STATE.apiBase}${path}`;
    return `.${path}`;
  }

  function updateFreshnessBadge() {
    document.getElementById("meta-freshness-rel").textContent = formatRelativeAge(STATE.lastCollectedUtc);
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

    // Update history_60d tail & multi-day returns cleanly
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
      if (p5) qObj.ret_5d_pct = Number(((qObj.price / p5 - 1) * 100).toFixed(2));
      if (p20) qObj.ret_20d_pct = Number(((qObj.price / p20 - 1) * 100).toFixed(2));
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

    if (ndxQ.price && qqqQ.price) {
      const ratio = ndxQ.price / qqqQ.price;
      opt.ndx_spot = ndxQ.price;
      opt.qqq_spot = qqqQ.price;
      opt.ndx_qqq_ratio = Number(ratio.toFixed(4));
      if (opt.zero_gamma_qqq) {
        opt.zero_gamma_ndx = Math.round(opt.zero_gamma_qqq * ratio);
      }
      opt.in_negative_gamma = Boolean(opt.ndx_spot < (opt.zero_gamma_ndx || 27000));
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
    const pwNdx = opt.major_put_wall?.ndx_equiv || 24650;
    const pwQqq = opt.major_put_wall?.qqq_strike || 600;
    const cwNdx = opt.major_call_wall?.ndx_equiv || 28750;
    const cwQqq = opt.major_call_wall?.qqq_strike || 700;
    const psychRound = opt.psych_25000_check?.psych_round_ndx || 25000;
    const inNegG = Boolean(opt.in_negative_gamma);

    const sofrSp = fredD.sofr_iorb_spread?.value_bps ?? 2.0;
    const rrpBn = fredM.RRPONTSYD?.value ?? 0.3;
    const cccYield = fredM.BAMLH0A3HYCEY?.value ?? 18.48;
    const dgs10 = fredM.DGS10?.value ?? 4.92;
    const dgs3m = fredM.DGS3MO?.value ?? 4.37;
    const bdaysMe = cal.bdays_to_month_end ?? 3;
    const negFcfN = snap.ai_ledger?.summary?.negative_fcf_count ?? 4;

    const goldPx = goldQ.price || 3475;
    const goldDd = goldQ.drawdown_52w_pct ?? -34;
    const goldRsi = goldQ.rsi14 ?? 20;
    const goldMa50 = goldQ.ma50 || 4065;
    const isGoldDiscount = Boolean(goldDd <= -4 && goldDd >= -45);
    ana.is_gold_discount = isGoldDiscount;

    // Update top summary verdict with real-time intraday coordinates
    const nearWallAlert = Math.abs(ndxSpot - pwNdx) <= 600
      ? `今日盘中大跌后纳指（${fmtNum(ndxSpot, 0)}）已逼近下方最厚实盘期权防线 ~${fmtNum(pwNdx, 0)}（QQQ $${fmtNum(pwQqq, 0)}，仅差 ${Math.round(ndxSpot - pwNdx)} 点）！`
      : `下方真正期权厚防线在纳指 ~${fmtNum(pwNdx, 0)}（QQQ $${fmtNum(pwQqq, 0)}）。`;

    ana.summary_verdict =
      `当前核心矛盾为高利率下的边缘信用爆破（CCC级借钱成本 ${fmtNum(cccYield, 1)}%）叠加 AI 云巨头现金流转负（${negFcfN}/5 家 FCF 为负）。` +
      `纳指最新报 ${fmtNum(ndxSpot, 0)}（1日 ${fmtSigned(ndxQ.ret_1d_pct, 2, "%")}，QQQ $${fmtNum(qqqQ.price, 2)}），位于 ~${fmtNum(zeroG, 0)} 下方负 Gamma 助跌区间。` +
      `${nearWallAlert}同时紧盯 ${cal.month_end_settlement || "月末"} 结算资金面大考；黄金回调仍属「钱荒洗金打折期」。`;

    ana.live_consequences = [
      {
        domain: "美股大盘与期权微结构",
        freq_badge: "盘中秒级直连",
        level: inNegG ? "danger" : "ok",
        live_data:
          `纳指100 报 ${fmtNum(ndxSpot, 0)}（1日 ${fmtSigned(ndxQ.ret_1d_pct, 2, "%")}）| QQQ $${fmtNum(qqqQ.price, 2)}（${fmtSigned(qqqQ.ret_1d_pct, 2, "%")}）` +
          ` | 翻转线 ~${fmtNum(zeroG, 0)} | 最厚 Put 防线 ~${fmtNum(pwNdx, 0)} (QQQ $${fmtNum(pwQqq, 0)})`,
        consequence: inNegG
          ? `现价低于翻转线 ${fmtNum(zeroG - ndxSpot, 0)} 点，处于典型「负 Gamma 顺势助跌」区间，做市商被动砸期货对冲看跌期权，导致前几日反抽迅速回吐；${fmtNum(psychRound, 0)} 整数位保护单薄，距 QQQ $${fmtNum(pwQqq, 0)} 厚防线仅剩 ${fmtNum(Math.abs(opt.major_put_wall?.dist_pct || 0), 2)}%。`
          : `现价站稳翻转线 ~${fmtNum(zeroG, 0)} 上方，做市商处于正 Gamma 高抛低吸护盘模式。`,
        conclusion: inNegG
          ? ndxSpot <= pwNdx + 120
            ? `正在测试 ~${fmtNum(pwNdx, 0)}（QQQ $${fmtNum(pwQqq, 0)}）最厚期权防线：观察此处做市商平仓能否止跌；一旦有效失守将触发二次去杠杆，切忌盲目接飞刀。`
            : `验证「反抽非反转」：负 Gamma 区下跌惯性未完，不抄半山腰；重点盯防 ~${fmtNum(pwNdx, 0)}（QQQ $${fmtNum(pwQqq, 0)}）最厚防线支撑得失。`
          : `顺势持有，上方阻力墙 ~${fmtNum(cwNdx, 0)}（QQQ $${fmtNum(cwQqq, 0)}）。`,
      },
      {
        domain: "黄金实时买点判别",
        freq_badge: "盘中秒级直连",
        level: isGoldDiscount ? "opportunity" : "ok",
        live_data:
          `COMEX 黄金 $${fmtNum(goldPx, 1)}（1日 ${fmtSigned(goldQ.ret_1d_pct, 2, "%")}，高点回撤 ${fmtSigned(goldDd, 1, "%")}）` +
          ` | 日线 RSI=${fmtNum(goldRsi, 0)} | 50日线 $${fmtNum(goldMa50, 0)}`,
        consequence:
          `科技股急跌引发跨资产追加保证金（「砍仓先砍流动性最好的资产」），对冲基金连带抛售黄金换取美元现金，把金价继续压在极端超卖折价区。`,
        conclusion:
          `维持「钱荒洗金打折期」判断：严禁加杠杆，宜用冗余现金分批低吸；一旦市场去杠杆倒逼美联储松动管道或月末结算度过，黄金将率先反弹。`,
      },
      {
        domain: "AI 产业链内部分化与排雷",
        freq_badge: "盘中秒级 + 日更利差",
        level: "danger",
        live_data:
          `NVDA $${fmtNum(nvdaQ.price, 2)} (${fmtSigned(nvdaQ.ret_1d_pct, 1, "%")}) | ` +
          `CoreWeave $${fmtNum(crwvQ.price, 2)} (${fmtSigned(crwvQ.ret_1d_pct, 1, "%")}) | ` +
          `Anthropic $${fmtNum(antQ.price, 2)} (较$83发行价 ${fmtSigned(antQ.vs_ipo_pct, 1, "%")}) | CCC利率 ${fmtNum(cccYield, 2)}%`,
        consequence:
          `高达 ${fmtNum(cccYield, 1)}% 的垃圾债借钱成本叠加负 Gamma 抛压，令高负债二线算力（CRWV）与破发超级 IPO（ANT）持续领跌，前期消息刺激反抽被迅速证伪。`,
        conclusion:
          `继续排雷规避：坚决远离二线高负债算力租赁与破发次新股，严禁逆势马丁格尔加仓摊平。`,
      },
      {
        domain: "美元回购水管与现金仓位",
        freq_badge: "FRED 日更 + 盘中长债",
        level: sofrSp >= 8 ? "danger" : "warning",
        live_data:
          `SOFR-IORB ${fmtSigned(sofrSp, 1, " bps")} | ON RRP $${fmtNum(rrpBn, 2)}B | ` +
          `TLT $${fmtNum(quotes["TLT"]?.price, 2)} (${fmtSigned(quotes["TLT"]?.ret_1d_pct, 2, "%")}) | 距月末结算 ${bdaysMe} 交易日`,
        consequence:
          `股市大跌触发部分避险资金流入长债（TLT ${fmtSigned(quotes["TLT"]?.ret_1d_pct, 1, "%")}），但只要隔夜回购管道未彻底爆裂，美联储「只认管道不认股价」，不会因科技股大跌而提前救市。`,
        conclusion:
          `继续持有 ~${fmtNum(dgs3m, 2)}% 短端美债现金（SHV $${fmtNum(quotes["SHV"]?.price, 2)}）作为干火药，静待 ${cal.month_end_settlement || "月末"} 回购结算大考落地。`,
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

      const timer = window.setTimeout(() => done(false), 3500);

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
            const tsEt = parts[30] || ""; // "YYYY-MM-DD HH:MM:SS"
            const datePart = tsEt.slice(0, 10);
            if (px > 0 && quotes[sym]) {
              if (!quotes[sym].date || !datePart || datePart >= quotes[sym].date) {
                applyQuoteTick(quotes[sym], px, chgPct, datePart || quotes[sym].date);
                updatedAny = true;
                if (tsEt && (!newestEt || tsEt > newestEt)) newestEt = tsEt;
              }
            }
          });

          // Gold & Copper futures (comma-separated)
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
            if (newestEt) STATE.liveQuoteEtTime = newestEt;
            recomputeDynamicAnalysisFromLiveQuotes(bundle);
          }
          done(updatedAny);
        } catch (e) {
          console.warn("Realtime quote parse warning:", e);
          done(false);
        }
      };

      script.onerror = () => {
        window.clearTimeout(timer);
        done(false);
      };

      document.head.appendChild(script);
    });
  }

  function renderTopMeta(bundle) {
    const snap = bundle.snapshot || {};
    const sched = bundle.scheduler || {};
    STATE.lastCollectedUtc = snap.collected_at_utc || null;

    updateFreshnessBadge();
    document.getElementById("meta-updated-at").textContent =
      `底层快照 ${formatLocalTime(snap.collected_at_utc)}`;

    const modeTxt = sched.mode_label
      ? `${sched.mode_label}`
      : STATE.mode === "api"
      ? "实时智能调度中"
      : "盘中秒级行情直连 + 云端巡检";
    document.getElementById("meta-schedule-info").textContent = modeTxt;

    const reportLink = document.getElementById("btn-download-md");
    if (reportLink) {
      reportLink.href = STATE.mode === "api" ? apiUrl("/api/report.md") : "./reports/latest_market_brief.md";
    }
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

    document.getElementById("verdict-headline").textContent = ana.headline || "--";
    document.getElementById("verdict-summary").textContent = ana.summary_verdict || "";

    const tags = [
      {
        text: `${ana.money_diagnosis || "--"}`,
        cls: pillars.credit?.level === "danger" ? "tag-danger" : "tag-warning",
      },
      {
        text: options.in_negative_gamma
          ? `负Gamma区 (< ${fmtNum(options.zero_gamma_ndx, 0)})`
          : "正Gamma缓冲",
        cls: options.in_negative_gamma ? "tag-warning" : "tag-ok",
      },
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
        const col = meterColor(p.level, isOpp);
        return `
          <div class="meter-item">
            <div class="meter-label-row">
              <span class="meter-title">${p.title || key}</span>
              <span class="meter-val">${sc}/100 · ${p.status || ""}</span>
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
    const sofrSp = fredD.sofr_iorb_spread?.value_bps;
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
        sub: `MOVE分位 ${fmtNum(moveQ.pct_1y, 0)}% | VIX ${fmtNum(quotes["^VIX"]?.price, 1)}`,
        cls: "",
      },
      {
        label: "SOFR − IORB 利差",
        freq: "日更",
        freqCls: "freq-daily",
        value: `${fmtSigned(sofrSp, 1, " bps")}`,
        sub: `SOFR ${fmtNum(fredM.SOFR?.value, 2)}% | RRP $${fmtNum(rrpVal, 2)}B`,
        cls: sofrSp > 0 ? "warn-txt" : "",
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

    const chains = ana.live_consequences || [];
    document.getElementById("consequence-grid").innerHTML = chains
      .map(
        (item) => `
        <article class="consequence-card">
          <div class="consequence-head">
            <span class="consequence-domain">${item.domain}</span>
            <span class="tag ${tagClsForLevel(item.level)}">${item.freq_badge}</span>
          </div>
          <div class="chain-step">
            <span class="step-tag">实时数据</span>
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

  function updateGammaSandbox(ndxVal, opt) {
    const ratio = opt?.ndx_qqq_ratio || 41.082;
    const zeroG = opt?.zero_gamma_ndx || 27004;
    const putWall = opt?.major_put_wall?.ndx_equiv || 24649;
    const putWallQ = opt?.major_put_wall?.qqq_strike || 600;
    const psychRound = opt?.psych_25000_check?.psych_round_ndx || 25000;
    const callWall = opt?.major_call_wall?.ndx_equiv || 28758;
    const ndx = Math.round(Number(ndxVal));
    const qqq = Math.round(ndx / ratio);

    document.getElementById("sandbox-readout").textContent =
      `模拟 ^NDX ${ndx.toLocaleString()} (QQQ ~$${qqq})`;

    const box = document.getElementById("sandbox-verdict-box");
    if (ndx >= zeroG) {
      box.innerHTML = `<strong class="pos">【站上翻转线 &ge; ${zeroG.toLocaleString()} &rarr; 正 Gamma 护盘后果】</strong>：做市商回归高抛低吸压制波动；若 CCC 垃圾债利差同步回落，反抽可升级为趋势修复，上方目标阻力墙 ~${callWall.toLocaleString()}。`;
    } else if (ndx >= psychRound + 150) {
      box.innerHTML = `<strong class="warn-txt">【位于翻转线 ~${zeroG.toLocaleString()} 下方 &rarr; 负 Gamma 放大后果】</strong>：做市商被迫追涨杀跌，突发利好拉升极易回吐（反抽非反转），结论：逢高降杠杆，不追高。`;
    } else if (ndx >= putWall - 80) {
      box.innerHTML = `<strong class="gold-txt">【逼近/测试 ${psychRound.toLocaleString()} 与 ~${putWall.toLocaleString()} (QQQ $${putWallQ}) 最厚防线】</strong>：整数关口筹码单薄易被穿透；真正实盘看跌防线在 ~${putWall.toLocaleString()}，做市商平仓对冲盘将在此触发技术支撑。`;
    } else {
      box.innerHTML = `<strong class="neg">【击穿 ~${putWall.toLocaleString()} 最厚防线 &rarr; 尾部加速去杠杆后果】</strong>：核心期权墙失守引发加速助跌；结论：紧盯 SOFR−IORB 是否破 +10bps，若管道受损倒逼联储救市，黄金将先于美股暴力反弹。`;
    }
  }

  function renderIntradayMarkets(bundle) {
    const snap = bundle.snapshot || {};
    const opt = snap.options || {};
    const quotes = snap.quotes || {};
    const fredM = (snap.fred || {}).metrics || {};

    const exps = opt.expirations_scanned || [];
    document.getElementById("options-exp-label").textContent = exps.length
      ? `聚合到期日 (${exps.length}个): ${exps.slice(0, 3).join(", ")} ... ${exps[exps.length - 1]}`
      : "实时期权链";

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
      const xZeroG = xForQ(opt.zero_gamma_qqq || 660);
      const xPsych = xForQ(psychRound / (opt.ndx_qqq_ratio || 41.08));

      box.innerHTML = `
        <svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="纳指100与QQQ期权未平仓筹码墙">
          <line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="rgba(255,255,255,0.18)" />
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
                 <text x="${xZeroG.toFixed(1)}" y="${padT + 10}" text-anchor="start" dx="4" fill="var(--series-cyan)" font-size="9.5" font-family="var(--font-mono)">Zero-Gamma ~${fmtNum(opt.zero_gamma_ndx, 0)}</text>`
              : ""
          }
        </svg>
      `;
    }

    const slider = document.getElementById("sandbox-slider");
    const spotVal = Math.round(opt.ndx_spot || 25050);
    slider.min = String(Math.round((opt.major_put_wall?.ndx_equiv || 24650) - 1100));
    slider.max = String(Math.round((opt.major_call_wall?.ndx_equiv || 28750) + 500));
    slider.value = String(spotVal);
    updateGammaSandbox(spotVal, opt);
    slider.oninput = (e) => updateGammaSandbox(e.target.value, opt);

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

    const optRows = [
      ["纳指100 / QQQ 实时价", `${fmtNum(opt.ndx_spot, 0)}`, `QQQ $${fmtNum(opt.qqq_spot, 2)} (1日 ${fmtSigned(quotes["QQQ"]?.ret_1d_pct, 2, "%")})`],
      ["正负 Gamma 翻转位", `~${fmtNum(opt.zero_gamma_ndx, 0)}`, `QQQ $${fmtNum(opt.zero_gamma_qqq, 1)} (${opt.in_negative_gamma ? "负Gamma" : "正Gamma"})`],
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
            <td class="num ${clsSigned(q.ret_1d_pct)}">1日 ${fmtSigned(q.ret_1d_pct, 2, "%")}</td>
            <td class="num ${clsSigned(q.ret_20d_pct)}">${fmtSigned(q.ret_20d_pct, 1, "%")}</td>
            <td class="num ${clsSigned(q.drawdown_52w_pct)}">${fmtSigned(q.drawdown_52w_pct, 1, "%")}</td>
          </tr>
        `;
      })
      .join("");
  }

  function renderDailyPlumbing(bundle) {
    const snap = bundle.snapshot || {};
    const fredM = (snap.fred || {}).metrics || {};
    const fredD = (snap.fred || {}).derived || {};

    const spHist = (fredD.sofr_iorb_spread || {}).history || [];
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
        <svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="SOFR减IORB利差柱状图">
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
              const col = d.spread_bps > 0 ? "var(--signal-warn)" : "var(--series-cyan)";
              return `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${col}" opacity="0.88"><title>${d.date}: ${d.spread_bps} bps</title></rect>`;
            })
            .join("")}
          <text x="${padL}" y="${H - 5}" fill="var(--text-muted)" font-size="10" font-family="var(--font-mono)">${spHist[0].date}</text>
          <text x="${W - padR}" y="${H - 5}" text-anchor="end" fill="var(--text-muted)" font-size="10" font-family="var(--font-mono)">${spHist[spHist.length - 1].date}</text>
        </svg>
      `;
    }

    const creditRows = [
      ["BAMLH0A3HYCEY", "CCC级垃圾债有效收益率 (底层边缘债)"],
      ["BAMLH0A3HYC", "CCC级垃圾债利差 (OAS)"],
      ["BAMLH0A0HYM2", "高收益债整体利差 (HY OAS)"],
      ["BAMLC0A0CM", "投资级大厂债利差 (IG OAS)"],
      ["DFII10", "10Y TIPS 实际利率"],
      ["DGS10", "10年期美债名义收益率"],
      ["DGS3MO", "3个月短端美债收益率 (现金替代)"],
    ];
    document.getElementById("credit-tier-tbody").innerHTML = creditRows
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

  function renderHistoryRows(runs) {
    document.getElementById("history-tbody").innerHTML = (runs || [])
      .slice(0, 10)
      .map(
        (r) => `
        <tr>
          <td class="num">#${r.id} <span style="color:var(--text-muted); font-size:0.72rem;">[${r.trigger_source || "auto"}]</span></td>
          <td style="font-family:var(--font-mono)">${formatLocalTime(r.collected_at_utc)}</td>
          <td class="num"><strong>${r.overall_risk_score}</strong></td>
          <td class="num gold-txt">${r.gold_opp_score}</td>
          <td class="num">${fmtNum(r.ndx_spot, 0)}</td>
          <td class="num">$${fmtNum(r.gold_spot, 0)}</td>
        </tr>
      `
      )
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
    if (ok) {
      renderTopMeta(STATE.bundle);
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
    setSyncBanner(true, "检测到数据已过保鲜阈值，后台正在实时拉取最新 FRED / 期权链报价...");
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const stResp = await fetch(apiUrl("/api/status"), { cache: "no-store" });
        if (!stResp.ok) break;
        const st = await stResp.json();
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
        if (!st.is_refreshing && i >= 2) break;
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
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3500);
      const resp = await fetch(apiUrl("/api/latest"), { cache: "no-store", signal: ctrl.signal });
      clearTimeout(timer);
      if (resp.ok && (resp.headers.get("content-type") || "").includes("application/json")) {
        STATE.mode = "api";
        const bundle = await resp.json();
        await fetchRealtimeBrowserQuotes(bundle);
        renderAll(bundle);
        await loadHistory();
        document.getElementById("current-mode-badge").textContent =
          "实时 Python 后端 + 浏览器盘中秒级行情直连";
        triggerOnVisitCheck();
        return;
      }
    } catch (_) {}

    STATE.mode = "static";
    document.getElementById("current-mode-badge").textContent =
      "盘中秒级行情直连 + GitHub 云端定期巡检";
    const resp = await fetch(`./data/latest_snapshot.json?_t=${Date.now()}`, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const bundle = await resp.json();
    await fetchRealtimeBrowserQuotes(bundle);
    renderAll(bundle);
    await loadHistory();
  }

  function bindUiEvents() {
    const btn = document.getElementById("btn-refresh-live");
    const label = document.getElementById("btn-refresh-label");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.classList.add("is-loading");
      label.textContent = "拉取最新行情...";
      try {
        if (STATE.mode === "api") {
          const resp = await fetch(apiUrl("/api/refresh"), { method: "POST" });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const bundle = await resp.json();
          await fetchRealtimeBrowserQuotes(bundle);
          renderAll(bundle);
          await loadHistory();
          showToast("已完成全量 FRED / 期权链与秒级行情重算");
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
        showToast("刷新失败: " + err.message);
      } finally {
        btn.disabled = false;
        btn.classList.remove("is-loading");
        label.textContent = "实时刷新数据";
      }
    });

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

    // Auto-stream real-time exchange quotes every 20s while page is visible
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
