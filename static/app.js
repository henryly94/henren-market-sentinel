/* Henren Market Sentinel — Mobile-First PWA, On-Visit Revalidator & Interactive Charts */
(function () {
  "use strict";

  const STATE = {
    mode: "detecting", // "api" | "static"
    apiBase: (localStorage.getItem("sentinel_api_base") || "").replace(/\/+$/, ""),
    bundle: null,
    pollTimer: null,
    lastCollectedUtc: null,
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

  function apiUrl(path) {
    if (STATE.apiBase) return `${STATE.apiBase}${path}`;
    return `.${path}`;
  }

  function updateFreshnessBadge() {
    if (!STATE.lastCollectedUtc) return;
    document.getElementById("meta-freshness-rel").textContent = formatRelativeAge(STATE.lastCollectedUtc);
  }

  function renderTopMeta(bundle) {
    const snap = bundle.snapshot || {};
    const sched = bundle.scheduler || {};
    STATE.lastCollectedUtc = snap.collected_at_utc || null;

    updateFreshnessBadge();
    document.getElementById("meta-updated-at").textContent =
      `快照 ${formatLocalTime(snap.collected_at_utc)}`;

    const modeTxt = sched.mode_label
      ? `${sched.mode_label} (每${sched.interval_minutes || 60}m)`
      : STATE.mode === "api"
      ? "实时智能调度中"
      : "GitHub云端定时巡检";
    document.getElementById("meta-schedule-info").textContent = modeTxt;

    const reportLink = document.getElementById("btn-download-md");
    if (reportLink) {
      reportLink.href = STATE.mode === "api" ? apiUrl("/api/report.md") : "./reports/latest_market_brief.md";
    }
  }

  function renderHeroAndPlaybook(bundle) {
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
        text: `纳指厚防线 ~${fmtNum(options.major_put_wall?.ndx_equiv, 0)} (QQQ $${fmtNum(options.major_put_wall?.qqq_strike, 0)})`,
        cls: "tag",
      },
      {
        text: `距月末结算(${cal.month_end_settlement || "--"}) ${cal.bdays_to_month_end ?? "--"} 交易日`,
        cls: (cal.bdays_to_month_end ?? 10) <= 5 ? "tag-warning" : "tag",
      },
      {
        text: ana.is_gold_discount ? "黄金: 钱荒洗金打折期" : "黄金: 常规跟踪",
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

    const sofrSp = fredD.sofr_iorb_spread?.value_bps;
    const rrpVal = fredM.RRPONTSYD?.value;
    const cccYld = fredM.BAMLH0A3HYCEY?.value;
    const ndxQ = quotes["^NDX"] || {};
    const goldQ = quotes["GC=F"] || {};
    const aiSum = (snap.ai_ledger || {}).summary || {};

    const kpis = [
      {
        label: "SOFR − IORB 走廊利差",
        value: `${fmtSigned(sofrSp, 1, " bps")}`,
        sub: `SOFR ${fmtNum(fredM.SOFR?.value, 2)}% | RRP $${fmtNum(rrpVal, 2)}B`,
        cls: sofrSp > 0 ? "warn-txt" : "",
      },
      {
        label: "CCC级垃圾债借钱成本",
        value: `${fmtNum(cccYld, 2)}%`,
        sub: `OAS ${fmtNum(fredM.BAMLH0A3HYC?.value, 2)}% | IG ${fmtNum(fredM.BAMLC0A0CM?.value, 2)}%`,
        cls: cccYld >= 15 ? "neg" : "",
      },
      {
        label: "10Y 美债 / 实际利率",
        value: `${fmtNum(fredM.DGS10?.value, 2)}%`,
        sub: `TIPS实际 ${fmtNum(fredM.DFII10?.value, 2)}%`,
        cls: "",
      },
      {
        label: "纳指100 (^NDX)",
        value: fmtNum(ndxQ.price, 0),
        sub: `1日 ${fmtSigned(ndxQ.ret_1d_pct, 2, "%")} | 防线 ~${fmtNum(options.major_put_wall?.ndx_equiv, 0)}`,
        cls: clsSigned(ndxQ.ret_1d_pct),
      },
      {
        label: "云五巨头年化算力账单",
        value: `$${fmtNum(aiSum.annualized_capex_bn, 0)}B`,
        sub: `${aiSum.negative_fcf_count || 0}/5 家FCF转负 (${fmtSigned(aiSum.quarterly_fcf_bn, 1, "B")})`,
        cls: aiSum.quarterly_fcf_bn < 0 ? "neg" : "",
      },
      {
        label: "COMEX 黄金 (GC=F)",
        value: `$${fmtNum(goldQ.price, 1)}`,
        sub: `RSI(14) ${fmtNum(goldQ.rsi14, 0)} | TGA $${fmtNum(fredM.WTREGEN?.value, 0)}B`,
        cls: "gold-txt",
      },
    ];

    document.getElementById("core-kpi-strip").innerHTML = kpis
      .map(
        (k) => `
        <div class="kpi-box">
          <div class="kpi-label">${k.label}</div>
          <div class="kpi-value ${k.cls}">${k.value}</div>
          <div class="kpi-sub">${k.sub}</div>
        </div>
      `
      )
      .join("");

    document.getElementById("playbook-grid").innerHTML = (ana.allocation_cards || [])
      .map(
        (c) => `
        <article class="playbook-item">
          <div class="playbook-top">
            <span class="playbook-asset">${c.asset}</span>
            <span class="tag tag-opportunity">${c.signal_tag}</span>
          </div>
          <div class="playbook-stance">${c.stance}</div>
          <p class="playbook-rationale">${c.rationale}</p>
          <div class="playbook-trigger">${c.trigger}</div>
        </article>
      `
      )
      .join("");
  }

  function renderLiquidityAndCredit(bundle) {
    const snap = bundle.snapshot || {};
    const ana = bundle.analysis || {};
    const fredM = (snap.fred || {}).metrics || {};
    const fredD = (snap.fred || {}).derived || {};
    const netLiq = fredD.net_liquidity || {};
    const series = netLiq.series || [];

    document.getElementById("net-liq-subtitle").textContent =
      `净流动性 $${fmtNum(netLiq.value_tn, 2)}T (近4周 ${fmtSigned(netLiq.chg_4w_bn, 0, "B")}) · 准备金 $${fmtNum((fredM.WRESBAL?.value || 0) / 1000, 2)}T`;

    const liqBox = document.getElementById("chart-liquidity");
    if (series.length >= 4) {
      const W = 600, H = 215, padL = 48, padR = 46, padT = 16, padB = 26;
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
        <svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="美元净流动性与TGA曲线">
          ${[nlMin, (nlMin + nlMax) / 2, nlMax]
            .map((v) => {
              const y = yNl(v).toFixed(1);
              return `
                <line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="rgba(255,255,255,0.06)" />
                <text x="${padL - 6}" y="${Number(y) + 4}" text-anchor="end" fill="var(--accent-gold)" font-size="10" font-family="var(--font-mono)">$${v.toFixed(2)}T</text>
              `;
            })
            .join("")}
          ${[0, Math.round(tgaMax / 2), Math.round(tgaMax)]
            .map((v) => {
              const y = yTga(v).toFixed(1);
              return `<text x="${W - padR + 6}" y="${Number(y) + 4}" text-anchor="start" fill="var(--series-cyan)" font-size="10" font-family="var(--font-mono)">$${v}B</text>`;
            })
            .join("")}
          <path d="${tgaPath}" fill="none" stroke="var(--series-cyan)" stroke-width="1.6" stroke-dasharray="3 2" opacity="0.85" />
          <path d="${nlPath}" fill="none" stroke="var(--accent-gold)" stroke-width="2.3" />
          <text x="${padL}" y="${H - 6}" fill="var(--text-muted)" font-size="10" font-family="var(--font-mono)">${series[0].date}</text>
          <text x="${W - padR}" y="${H - 6}" text-anchor="end" fill="var(--text-muted)" font-size="10" font-family="var(--font-mono)">${series[series.length - 1].date}</text>
        </svg>
      `;
    }

    const spHist = (fredD.sofr_iorb_spread || {}).history || [];
    const spBox = document.getElementById("chart-sofr-spread");
    if (spHist.length >= 5) {
      const W = 520, H = 150, padL = 40, padR = 14, padT = 14, padB = 22;
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
          <text x="${padL}" y="${H - 4}" fill="var(--text-muted)" font-size="10" font-family="var(--font-mono)">${spHist[0].date}</text>
          <text x="${W - padR}" y="${H - 4}" text-anchor="end" fill="var(--text-muted)" font-size="10" font-family="var(--font-mono)">${spHist[spHist.length - 1].date}</text>
        </svg>
      `;
    }

    const creditRows = [
      ["BAMLH0A3HYCEY", "CCC级垃圾债收益率 (最烂的债)"],
      ["BAMLH0A3HYC", "CCC级垃圾债利差 (OAS)"],
      ["BAMLH0A0HYM2", "高收益债整体利差 (HY OAS)"],
      ["BAMLC0A0CM", "投资级大厂债利差 (IG OAS)"],
      ["DFII10", "10Y TIPS 实际利率"],
      ["DGS10", "10年期美债名义收益率"],
      ["DGS2", "2年期美债名义收益率"],
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

    document.getElementById("plumbing-findings").innerHTML =
      (ana.pillars?.plumbing?.findings || []).map((f) => `<li>${f}</li>`).join("");
    document.getElementById("credit-findings").innerHTML =
      (ana.pillars?.credit?.findings || []).map((f) => `<li>${f}</li>`).join("");
  }

  function updateGammaSandbox(ndxVal, opt) {
    const ratio = opt?.ndx_qqq_ratio || 41.082;
    const zeroG = opt?.zero_gamma_ndx || 27004;
    const putWall = opt?.major_put_wall?.ndx_equiv || 24649;
    const putWallQ = opt?.major_put_wall?.qqq_strike || 600;
    const callWall = opt?.major_call_wall?.ndx_equiv || 28758;
    const ndx = Math.round(Number(ndxVal));
    const qqq = Math.round(ndx / ratio);

    document.getElementById("sandbox-readout").textContent =
      `模拟 ^NDX ${ndx.toLocaleString()} (QQQ ~$${qqq})`;

    const box = document.getElementById("sandbox-verdict-box");
    if (ndx >= zeroG) {
      box.innerHTML = `<strong class="pos">【正 Gamma 缓冲区间 (&ge; ${zeroG.toLocaleString()})】</strong>：重新站上正负 Gamma 翻转线，做市商对冲回归「高抛低吸」压制波动率；若同时伴随 CCC 垃圾债利差拐头收敛，反抽才具备升级为趋势反转的条件，上方阻力墙看 ~${callWall.toLocaleString()}。`;
    } else if (ndx >= 25150) {
      box.innerHTML = `<strong class="warn-txt">【负 Gamma 放大区间 · 反抽非反转】</strong>：位于翻转线 ~${zeroG.toLocaleString()} 下方，做市商被迫「追涨杀跌」。在资金依然昂贵（CCC ~18%）背景下，突发利好推升的暴涨属于空头+做市商对冲挤压反抽，宜逢高降杠杆而非追高。`;
    } else if (ndx >= putWall - 80) {
      box.innerHTML = `<strong class="gold-txt">【25,000 整数位失守 &rarr; 测试 ~${putWall.toLocaleString()} (QQQ $${putWallQ}) 最厚防线】</strong>：25,000 心理关口缺乏期权筹码保护易被击穿；真正多头最厚实盘 Put Wall 在 ~${putWall.toLocaleString()}，做市商平仓看跌对冲盘将在此处形成强支撑反抽。`;
    } else {
      box.innerHTML = `<strong class="neg">【跌穿 ~${putWall.toLocaleString()} 最厚防线 · 二次去杠杆告警】</strong>：QQQ $${putWallQ} 核心防线失守将触发深度负 Gamma 机械助跌。此时紧盯 <strong>SOFR−IORB 是否飙破 +10bps</strong>——若管道被砸坏倒逼美联储修水管，黄金将率先暴力反弹。`;
    }
  }

  function renderOptionsAndVol(bundle) {
    const snap = bundle.snapshot || {};
    const ana = bundle.analysis || {};
    const opt = snap.options || {};
    const quotes = snap.quotes || {};
    const fredM = (snap.fred || {}).metrics || {};

    const exps = opt.expirations_scanned || [];
    document.getElementById("options-exp-label").textContent = exps.length
      ? `聚合到期日 (${exps.length}个): ${exps.slice(0, 3).join(", ")} ... ${exps[exps.length - 1]}`
      : "实时期权链";

    const profile = opt.strike_profile || [];
    const box = document.getElementById("chart-options-walls");
    if (profile.length >= 5) {
      const W = 620, H = 260, padL = 48, padR = 18, padT = 24, padB = 40;
      const plotW = W - padL - padR, plotH = H - padT - padB;
      const maxOI = Math.max(1, ...profile.map((p) => Math.max(p.put_oi, p.call_oi)));
      const stepW = plotW / profile.length;
      const barW = Math.max(3, stepW * 0.42);

      const minQ = profile[0].qqq_strike;
      const maxQ = profile[profile.length - 1].qqq_strike;
      const xForQ = (q) => padL + ((q - minQ) / Math.max(maxQ - minQ, 1)) * plotW;

      const xSpot = xForQ(opt.qqq_spot || 638);
      const xZeroG = xForQ(opt.zero_gamma_qqq || 660);
      const x25k = xForQ(25000 / (opt.ndx_qqq_ratio || 41.08));

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
                       <text x="${cx.toFixed(1)}" y="${H - padB + 26}" text-anchor="middle" fill="var(--text-muted)" font-size="8.5" font-family="var(--font-mono)">${(p.ndx_equiv / 1000).toFixed(1)}k</text>`
                    : ""
                }
              `;
            })
            .join("")}
          ${
            x25k >= padL && x25k <= W - padR
              ? `<line x1="${x25k.toFixed(1)}" y1="${padT + 12}" x2="${x25k.toFixed(1)}" y2="${H - padB}" stroke="rgba(255,255,255,0.35)" stroke-dasharray="2 3" />
                 <text x="${x25k.toFixed(1)}" y="${padT + 8}" text-anchor="middle" fill="var(--text-muted)" font-size="9" font-family="var(--font-mono)">25k整数(薄)</text>`
              : ""
          }
          <line x1="${xSpot.toFixed(1)}" y1="${padT}" x2="${xSpot.toFixed(1)}" y2="${H - padB}" stroke="var(--accent-gold)" stroke-width="2" />
          <text x="${xSpot.toFixed(1)}" y="${padT - 6}" text-anchor="middle" fill="var(--accent-gold)" font-size="10" font-weight="600" font-family="var(--font-mono)">现价 ${fmtNum(opt.ndx_spot, 0)}</text>
          ${
            xZeroG >= padL && xZeroG <= W - padR
              ? `<line x1="${xZeroG.toFixed(1)}" y1="${padT}" x2="${xZeroG.toFixed(1)}" y2="${H - padB}" stroke="var(--series-cyan)" stroke-width="1.8" stroke-dasharray="4 3" />
                 <text x="${xZeroG.toFixed(1)}" y="${padT + 10}" text-anchor="start" dx="4" fill="var(--series-cyan)" font-size="9.5" font-family="var(--font-mono)">Zero-Gamma ~${fmtNum(opt.zero_gamma_ndx, 0)}</text>`
              : ""
          }
        </svg>
      `;
    }

    // Initialize interactive sandbox slider with live spot
    const slider = document.getElementById("sandbox-slider");
    const spotVal = Math.round(opt.ndx_spot || 26214);
    slider.min = String(Math.round((opt.major_put_wall?.ndx_equiv || 24650) - 1100));
    slider.max = String(Math.round((opt.major_call_wall?.ndx_equiv || 28750) + 500));
    slider.value = String(spotVal);
    updateGammaSandbox(spotVal, opt);
    slider.oninput = (e) => updateGammaSandbox(e.target.value, opt);

    const moveQ = quotes["^MOVE"] || {};
    const vxnVal = quotes["^VXN"]?.price || fredM.VXNCLS?.value;
    const vxnPct = quotes["^VXN"]?.pct_1y || fredM.VXNCLS?.pct_1y;
    const vixQ = quotes["^VIX"] || {};

    const optRows = [
      ["纳指100 现价 (^NDX)", fmtNum(opt.ndx_spot, 0), `QQQ $${fmtNum(opt.qqq_spot, 2)}`],
      [
        "正负 Gamma 翻转位",
        `~${fmtNum(opt.zero_gamma_ndx, 0)}`,
        `QQQ $${fmtNum(opt.zero_gamma_qqq, 1)} (${opt.in_negative_gamma ? "负Gamma" : "正Gamma"})`,
      ],
      [
        "近端第一看跌支撑",
        `~${fmtNum(opt.near_put_support?.ndx_equiv, 0)}`,
        `QQQ $${fmtNum(opt.near_put_support?.qqq_strike, 0)} (OI ${fmtNum(opt.near_put_support?.open_interest, 0)})`,
      ],
      [
        "多头最厚期权防线 (Put Wall)",
        `~${fmtNum(opt.major_put_wall?.ndx_equiv, 0)}`,
        `QQQ $${fmtNum(opt.major_put_wall?.qqq_strike, 0)} (OI ${fmtNum(opt.major_put_wall?.open_interest, 0)})`,
      ],
      [
        "上方最大看涨阻力墙 (Call Wall)",
        `~${fmtNum(opt.major_call_wall?.ndx_equiv, 0)}`,
        `QQQ $${fmtNum(opt.major_call_wall?.qqq_strike, 0)} (OI ${fmtNum(opt.major_call_wall?.open_interest, 0)})`,
      ],
      ["Put / Call 未平仓比", fmtNum(opt.put_call_oi_ratio, 2), "大于1.2代表保护拥挤"],
      ["美债波动率 MOVE", fmtNum(moveQ.price, 1), `1年分位 ${fmtNum(moveQ.pct_1y, 0)}%`],
      ["纳指 VXN / 标普 VIX", `${fmtNum(vxnVal, 1)} / ${fmtNum(vixQ.price, 1)}`, `VXN 分位 ${fmtNum(vxnPct, 0)}%`],
    ];

    document.getElementById("options-summary-tbody").innerHTML = optRows
      .map(([k, v, sub]) => `<tr><td>${k}</td><td class="num">${v}</td><td class="num">${sub}</td></tr>`)
      .join("");

    document.getElementById("micro-findings").innerHTML =
      (ana.pillars?.microstructure?.findings || []).map((f) => `<li>${f}</li>`).join("");
  }

  function renderAiAudit(bundle) {
    const snap = bundle.snapshot || {};
    const ana = bundle.analysis || {};
    const aiPillar = ana.pillars?.ai_ledger || {};
    const aiLedger = snap.ai_ledger || {};
    const quotes = snap.quotes || {};

    const signals = aiPillar.peak_signals || [];
    document.getElementById("ai-triggered-badge").textContent =
      `已触发 ${aiPillar.triggered_count || 0} / ${signals.length || 5} 项见顶信号`;

    document.getElementById("ai-signals-list").innerHTML = signals
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

    const aiTickers = [
      ["NVDA", "核心算力芯片"],
      ["AVGO", "定制ASIC"],
      ["SMH", "半导体ETF"],
      ["ANT", "Anthropic"],
      ["CRWV", "CoreWeave"],
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
            <td class="num ${clsSigned(q.ret_1d_pct)}">${fmtSigned(q.ret_1d_pct, 1, "%")}</td>
            <td class="num ${clsSigned(q.ret_5d_pct)}">${fmtSigned(q.ret_5d_pct, 1, "%")}</td>
            <td class="num ${clsSigned(q.drawdown_52w_pct)}">${fmtSigned(q.drawdown_52w_pct, 1, "%")}</td>
          </tr>
        `;
      })
      .join("");

    const comps = aiLedger.companies || [];
    const sum = aiLedger.summary || {};
    document.getElementById("ai-capex-summary-label").textContent =
      `年化 CapEx $${fmtNum(sum.annualized_capex_bn, 0)}B · 单季合计 FCF $${fmtSigned(sum.quarterly_fcf_bn, 1, "B")}`;

    const chartEl = document.getElementById("chart-ai-capex");
    if (comps.length > 0) {
      const W = 540, H = 190, padL = 44, padR = 14, padT = 16, padB = 26;
      const plotW = W - padL - padR, plotH = H - padT - padB;
      const maxV = Math.max(10, ...comps.map((c) => Math.max(c.ocf_bn, c.capex_bn))) * 1.12;
      const grpW = plotW / comps.length;
      const bW = Math.min(24, grpW * 0.3);

      chartEl.innerHTML = `
        <svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="云五巨头经营现金流与资本开支对比">
          <line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="rgba(255,255,255,0.18)" />
          ${[0, Math.round(maxV / 2), Math.round(maxV)]
            .map((v) => {
              const y = (H - padB - (v / maxV) * plotH).toFixed(1);
              return `
                <line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="rgba(255,255,255,0.06)" />
                <text x="${padL - 6}" y="${Number(y) + 4}" text-anchor="end" fill="var(--text-muted)" font-size="10" font-family="var(--font-mono)">$${v}B</text>
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
                <text x="${cx.toFixed(1)}" y="${H - 8}" text-anchor="middle" fill="var(--text-primary)" font-size="11" font-weight="600" font-family="var(--font-mono)">${c.symbol}</text>
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
  }

  function renderGoldAndSchedule(bundle) {
    const snap = bundle.snapshot || {};
    const ana = bundle.analysis || {};
    const sched = bundle.scheduler || {};
    const quotes = snap.quotes || {};
    const goldQ = quotes["GC=F"] || {};
    const hist = goldQ.history_60d || [];

    document.getElementById("gold-chart-subtitle").textContent =
      `现价 $${fmtNum(goldQ.price, 1)} · RSI(14)=${fmtNum(goldQ.rsi14, 0)} · 200日线 $${fmtNum(goldQ.ma200, 0)}`;

    const goldBox = document.getElementById("chart-gold");
    if (hist.length >= 5) {
      const W = 580, H = 200, padL = 50, padR = 16, padT = 16, padB = 24;
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
        <svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="黄金60日走势与200日均线">
          <defs>
            <linearGradient id="goldAreaGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stop-color="hsl(41, 70%, 57%)" stop-opacity="0.26" />
              <stop offset="100%" stop-color="hsl(41, 70%, 57%)" stop-opacity="0.0" />
            </linearGradient>
          </defs>
          ${[minV, (minV + maxV) / 2, maxV]
            .map((v) => {
              const y = yAt(v).toFixed(1);
              return `
                <line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="rgba(255,255,255,0.06)" />
                <text x="${padL - 6}" y="${Number(y) + 4}" text-anchor="end" fill="var(--text-muted)" font-size="10" font-family="var(--font-mono)">$${v.toFixed(0)}</text>
              `;
            })
            .join("")}
          <line x1="${padL}" y1="${yMa200.toFixed(1)}" x2="${W - padR}" y2="${yMa200.toFixed(1)}" stroke="var(--signal-ok)" stroke-dasharray="4 3" stroke-width="1.4" />
          <text x="${padL + 6}" y="${Math.max(12, yMa200 - 5).toFixed(1)}" fill="var(--signal-ok)" font-size="9.5" font-family="var(--font-mono)">200DMA $${fmtNum(ma200, 0)}</text>
          <path d="${areaPath}" fill="url(#goldAreaGrad)" />
          <path d="${linePath}" fill="none" stroke="var(--accent-gold)" stroke-width="2.2" />
          <text x="${padL}" y="${H - 5}" fill="var(--text-muted)" font-size="10" font-family="var(--font-mono)">${hist[0].date}</text>
          <text x="${W - padR}" y="${H - 5}" text-anchor="end" fill="var(--text-muted)" font-size="10" font-family="var(--font-mono)">${hist[hist.length - 1].date}</text>
        </svg>
      `;
    }

    document.getElementById("gold-findings").innerHTML =
      (ana.pillars?.gold_spillover?.findings || []).map((f) => `<li>${f}</li>`).join("");

    const crossList = [
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
            <td class="num ${clsSigned(q.ret_5d_pct)}">${fmtSigned(q.ret_5d_pct, 1, "%")}</td>
            <td class="num ${clsSigned(q.ret_20d_pct)}">${fmtSigned(q.ret_20d_pct, 1, "%")}</td>
            <td class="num ${clsSigned(q.drawdown_52w_pct)}">${fmtSigned(q.drawdown_52w_pct, 1, "%")}</td>
          </tr>
        `;
      })
      .join("");

    // Smart Schedule & Checkpoints
    document.getElementById("schedule-mode-subtitle").textContent = sched.mode_label
      ? `当前档位：${sched.mode_label}（自动周期 ${sched.interval_minutes}m · 打开页面超 ${Math.round((sched.visit_stale_seconds || 300) / 60)}m 自动静默重抓）`
      : "周期巡检 + 关键时间点加密 + 主动访问新鲜度校验";

    const cps = sched.upcoming_checkpoints || [];
    document.getElementById("checkpoints-tbody").innerHTML = cps
      .map(
        (ev) => `
        <tr>
          <td>
            <div style="font-weight:600; color:var(--text-primary);">${ev.title}</div>
            <div style="font-size:0.76rem; color:var(--text-muted);">${ev.purpose}</div>
          </td>
          <td class="num">${ev.time_et}</td>
          <td class="num gold-txt">${formatLocalTime(ev.time_utc)}</td>
        </tr>
      `
      )
      .join("");
  }

  function renderHistoryRows(runs) {
    document.getElementById("history-tbody").innerHTML = (runs || [])
      .slice(0, 15)
      .map(
        (r) => `
        <tr>
          <td class="num">#${r.id} <span style="color:var(--text-muted); font-size:0.73rem;">[${r.trigger_source || "auto"}]</span></td>
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
    renderHeroAndPlaybook(bundle);
    renderLiquidityAndCredit(bundle);
    renderOptionsAndVol(bundle);
    renderAiAudit(bundle);
    renderGoldAndSchedule(bundle);
  }

  async function loadHistory() {
    try {
      const url =
        STATE.mode === "api"
          ? apiUrl("/api/history")
          : `./data/history.json?_t=${Date.now()}`;
      const resp = await fetch(url, { cache: "no-store" });
      if (!resp.ok) return;
      const data = await resp.json();
      renderHistoryRows(data.runs || []);
    } catch (err) {
      console.warn("History load skipped:", err);
    }
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
    if (STATE.mode === "api") {
      try {
        const prevUtc = STATE.lastCollectedUtc;
        const vResp = await fetch(apiUrl("/api/visit"), { method: "POST" });
        if (vResp.ok) {
          const v = await vResp.json();
          if (v.is_refreshing) {
            await waitUntilBackendRefreshCompletes(prevUtc);
          }
        }
      } catch (_) {}
    } else if (STATE.mode === "static") {
      // Re-pull latest static JSON bypassing CDN/browser cache when unlocking phone
      try {
        const resp = await fetch(`./data/latest_snapshot.json?_t=${Date.now()}`, { cache: "no-store" });
        if (resp.ok) {
          const fresh = await resp.json();
          if (fresh?.snapshot?.collected_at_utc !== STATE.lastCollectedUtc) {
            renderAll(fresh);
            await loadHistory();
            showToast("已同步云端最新巡检快照");
          }
        }
      } catch (_) {}
    }
  }

  async function detectAndLoadInitial() {
    // 1. Try API mode first (either custom apiBase or same-origin /api/latest)
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 3500);
      const resp = await fetch(apiUrl("/api/latest"), { cache: "no-store", signal: ctrl.signal });
      clearTimeout(timer);
      if (resp.ok) {
        const contentType = resp.headers.get("content-type") || "";
        if (contentType.includes("application/json")) {
          STATE.mode = "api";
          const bundle = await resp.json();
          renderAll(bundle);
          await loadHistory();
          document.getElementById("current-mode-badge").textContent =
            "实时 Python 后端引擎 (支持访问即刻重算 + 智能调度)";
          // Trigger non-blocking on-visit freshness revalidation
          triggerOnVisitCheck();
          return;
        }
      }
    } catch (_) {
      // Fall through to static cloud mode
    }

    // 2. Fallback to Static GitHub Pages PWA mode (./data/latest_snapshot.json)
    STATE.mode = "static";
    document.getElementById("current-mode-badge").textContent =
      "GitHub Pages 云端模式 (由 GitHub Actions 按周期与关键节点自动更新)";
    const resp = await fetch(`./data/latest_snapshot.json?_t=${Date.now()}`, { cache: "no-store" });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const bundle = await resp.json();
    renderAll(bundle);
    await loadHistory();
  }

  function bindUiEvents() {
    // Refresh button
    const btn = document.getElementById("btn-refresh-live");
    const label = document.getElementById("btn-refresh-label");
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      btn.classList.add("is-loading");
      label.textContent = STATE.mode === "api" ? "拉取实盘中..." : "同步云端中...";
      try {
        if (STATE.mode === "api") {
          const resp = await fetch(apiUrl("/api/refresh"), { method: "POST" });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const bundle = await resp.json();
          renderAll(bundle);
          await loadHistory();
          showToast("已完成全量实盘数据重算");
        } else {
          const resp = await fetch(`./data/latest_snapshot.json?_t=${Date.now()}`, { cache: "no-store" });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const bundle = await resp.json();
          renderAll(bundle);
          await loadHistory();
          showToast("已拉取云端最新巡检快照（如需秒级实时重算可在设置中绑定Python后端）");
        }
      } catch (err) {
        showToast("刷新失败: " + err.message);
      } finally {
        btn.disabled = false;
        btn.classList.remove("is-loading");
        label.textContent = "实时刷新数据";
      }
    });

    // Desktop nav active highlight
    const navLinks = document.querySelectorAll(".nav-link");
    navLinks.forEach((lnk) => {
      lnk.addEventListener("click", () => {
        navLinks.forEach((l) => l.classList.remove("active"));
        lnk.classList.add("active");
      });
    });

    // Mobile bottom tab bar switching
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

    // Settings modal
    const modal = document.getElementById("settings-modal");
    const inputApi = document.getElementById("input-api-base");
    document.getElementById("btn-open-settings").addEventListener("click", () => {
      inputApi.value = STATE.apiBase;
      modal.classList.add("open");
    });
    document.getElementById("btn-close-settings").addEventListener("click", () => {
      modal.classList.remove("open");
    });
    modal.addEventListener("click", (e) => {
      if (e.target === modal) modal.classList.remove("open");
    });
    document.getElementById("btn-save-settings").addEventListener("click", async () => {
      const val = inputApi.value.trim().replace(/\/+$/, "");
      STATE.apiBase = val;
      if (val) {
        localStorage.setItem("sentinel_api_base", val);
      } else {
        localStorage.removeItem("sentinel_api_base");
      }
      modal.classList.remove("open");
      showToast("正在重新探测数据源...");
      try {
        await detectAndLoadInitial();
      } catch (err) {
        showToast("连接失败: " + err.message);
      }
    });

    // Auto-revalidate when user unlocks phone or switches back to tab
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        updateFreshnessBadge();
        triggerOnVisitCheck();
      }
    });

    // Keep relative timestamp fresh & poll lightweight backend status every 45s
    window.setInterval(async () => {
      updateFreshnessBadge();
      if (STATE.mode === "api" && document.visibilityState === "visible") {
        try {
          const r = await fetch(apiUrl("/api/status"), { cache: "no-store" });
          if (r.ok) {
            const st = await r.json();
            if (st.collected_at_utc && st.collected_at_utc !== STATE.lastCollectedUtc && !st.is_refreshing) {
              const lat = await fetch(apiUrl("/api/latest"), { cache: "no-store" });
              if (lat.ok) {
                renderAll(await lat.json());
                await loadHistory();
              }
            }
          }
        } catch (_) {}
      }
    }, 45000);
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
