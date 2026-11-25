"""Real-time and historical market data collectors (FRED + Yahoo Finance + Options + Ledgers)."""

from __future__ import annotations

import calendar
import io
import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any

import numpy as np
import pandas as pd
import requests
import yfinance as yf
from scipy.stats import norm

logger = logging.getLogger(__name__)

FRED_SERIES: dict[str, dict[str, str]] = {
    # Dollar Plumbing
    "SOFR": {"name": "SOFR 担保隔夜融资利率", "unit": "%", "group": "plumbing"},
    "IORB": {"name": "IORB 准备金利率走廊", "unit": "%", "group": "plumbing"},
    "EFFR": {"name": "EFFR 有效联邦基金利率", "unit": "%", "group": "plumbing"},
    "RRPONTSYD": {"name": "ON RRP 隔夜逆回购余额", "unit": "$B", "group": "plumbing"},
    "WTREGEN": {"name": "TGA 财政部一般账户", "unit": "$M", "group": "plumbing"},
    "WRESBAL": {"name": "银行准备金总额", "unit": "$M", "group": "plumbing"},
    "WALCL": {"name": "美联储总资产", "unit": "$M", "group": "plumbing"},
    # Credit & Rates
    "BAMLH0A3HYCEY": {"name": "CCC级垃圾债有效收益率", "unit": "%", "group": "credit"},
    "BAMLH0A3HYC": {"name": "CCC级垃圾债利差 (OAS)", "unit": "%", "group": "credit"},
    "BAMLH0A0HYM2": {"name": "美国高收益债利差 (HY OAS)", "unit": "%", "group": "credit"},
    "BAMLC0A0CM": {"name": "美国投资级债利差 (IG OAS)", "unit": "%", "group": "credit"},
    "DGS10": {"name": "10年期美债收益率", "unit": "%", "group": "rates"},
    "DGS2": {"name": "2年期美债收益率", "unit": "%", "group": "rates"},
    "DGS3MO": {"name": "3个月美债收益率", "unit": "%", "group": "rates"},
    "DFII10": {"name": "10年期TIPS实际利率", "unit": "%", "group": "rates"},
    "T10YIE": {"name": "10年期盈亏平衡通胀预期", "unit": "%", "group": "rates"},
    # Vol & FX fallbacks
    "VXNCLS": {"name": "CBOE 纳指波动率 VXN", "unit": "pts", "group": "vol"},
    "VIXCLS": {"name": "CBOE 标普波动率 VIX", "unit": "pts", "group": "vol"},
    "DEXCHUS": {"name": "美元兑人民币即期 (FRED)", "unit": "CNY", "group": "fx"},
}

MARKET_TICKERS: dict[str, dict[str, Any]] = {
    "^NDX": {"name": "纳斯达克100指数", "category": "index"},
    "QQQ": {"name": "纳指100 ETF (QQQ)", "category": "index"},
    "^GSPC": {"name": "标普500指数", "category": "index"},
    "^MOVE": {"name": "美债波动率 MOVE", "category": "vol"},
    "^VIX": {"name": "恐慌指数 VIX", "category": "vol"},
    "^VXN": {"name": "纳指波动率 VXN", "category": "vol"},
    "GC=F": {"name": "COMEX 黄金期货", "category": "macro"},
    "HG=F": {"name": "COMEX 铜期货", "category": "macro"},
    "TLT": {"name": "20年+长端美债 ETF", "category": "bond"},
    "SHV": {"name": "短端美债现金 ETF", "category": "bond"},
    "HYG": {"name": "高收益公司债 ETF", "category": "bond"},
    "NVDA": {"name": "NVIDIA (辉达)", "category": "ai_core"},
    "AVGO": {"name": "Broadcom (博通)", "category": "ai_core"},
    "SMH": {"name": "半导体 ETF (SMH)", "category": "ai_core"},
    "CRWV": {"name": "CoreWeave (二线算力)", "category": "ai_canary"},
    "ANT": {"name": "Anthropic (超级IPO)", "category": "ai_canary", "ipo_price": 83.0},
    "VST": {"name": "Vistra (AI电力瓶颈)", "category": "ai_power"},
    "USDCNH=X": {"name": "离岸人民币 USD/CNH", "category": "china"},
    "FXI": {"name": "中国大盘股 ETF (FXI)", "category": "china"},
    "KWEB": {"name": "中概互联 ETF (KWEB)", "category": "china"},
    "^KS11": {"name": "韩国综指 KOSPI", "category": "asia_canary"},
}

HYPERSCALERS: list[str] = ["MSFT", "AMZN", "GOOGL", "META", "ORCL"]


def _fetch_single_fred(series_id: str, session: requests.Session, lookback_days: int = 420) -> pd.Series:
    """Fetch a single FRED series via public CSV endpoint reusing TCP connection."""
    cosd = (pd.Timestamp.now().normalize() - pd.Timedelta(days=lookback_days)).strftime("%Y-%m-%d")
    url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}&cosd={cosd}"
    for attempt in range(2):
        try:
            resp = session.get(url, timeout=10)
            resp.raise_for_status()
            df = pd.read_csv(io.StringIO(resp.text))
            date_col = df.columns[0]
            val_col = df.columns[1]
            df[date_col] = pd.to_datetime(df[date_col], errors="coerce")
            df[val_col] = pd.to_numeric(df[val_col], errors="coerce")
            df = df.dropna(subset=[date_col, val_col]).sort_values(date_col)
            return pd.Series(df[val_col].values, index=df[date_col])
        except Exception:
            if attempt == 1:
                raise
    return pd.Series(dtype=float)


def collect_fred_data() -> dict[str, Any]:
    """Collect all FRED plumbing, credit, rate, and volatility series over a single keep-alive session."""
    session = requests.Session()
    raw_series: dict[str, pd.Series] = {}
    metrics: dict[str, Any] = {}

    for sid, meta in FRED_SERIES.items():
        try:
            s = _fetch_single_fred(sid, session=session)
            if s.empty:
                continue
            scale = 0.001 if meta["unit"] == "$M" else 1.0
            unit = "$B" if meta["unit"] == "$M" else meta["unit"]
            s = s * scale
            raw_series[sid] = s

            latest_val = float(s.iloc[-1])
            latest_date = str(s.index[-1].date())
            prev_1 = float(s.iloc[-2]) if len(s) >= 2 else latest_val
            prev_5 = float(s.iloc[-6]) if len(s) >= 6 else float(s.iloc[0])
            prev_20 = float(s.iloc[-21]) if len(s) >= 21 else float(s.iloc[0])

            window = s.tail(252)
            pct_1y = float((window <= latest_val).mean() * 100.0)

            metrics[sid] = {
                "id": sid,
                "name": meta["name"],
                "unit": unit,
                "group": meta["group"],
                "value": round(latest_val, 4),
                "date": latest_date,
                "chg_1": round(latest_val - prev_1, 4),
                "chg_5": round(latest_val - prev_5, 4),
                "chg_20": round(latest_val - prev_20, 4),
                "pct_1y": round(pct_1y, 1),
                "min_1y": round(float(window.min()), 4),
                "max_1y": round(float(window.max()), 4),
                "history": [
                    {"date": str(dt.date()), "value": round(float(v), 4)}
                    for dt, v in s.tail(90).items()
                ],
            }
        except Exception as exc:
            logger.warning("Failed to fetch FRED %s: %s", sid, exc)

    # Derived Plumbing Series: Net Dollar Liquidity = WALCL - WTREGEN - RRPONTSYD (in $B)
    derived: dict[str, Any] = {}
    if all(k in raw_series for k in ("WALCL", "WTREGEN", "RRPONTSYD")):
        df_liq = pd.DataFrame({
            "walcl": raw_series["WALCL"],
            "tga": raw_series["WTREGEN"],
            "rrp": raw_series["RRPONTSYD"],
        }).sort_index().ffill().dropna()
        df_liq["net_liq"] = df_liq["walcl"] - df_liq["tga"] - df_liq["rrp"]
        # Weekly sample for clean chart
        weekly = df_liq.resample("W-WED").last().dropna().tail(52)
        latest_nl = float(df_liq["net_liq"].iloc[-1])
        nl_4w_ago = float(weekly["net_liq"].iloc[-5]) if len(weekly) >= 5 else latest_nl
        nl_13w_ago = float(weekly["net_liq"].iloc[-14]) if len(weekly) >= 14 else latest_nl
        derived["net_liquidity"] = {
            "value_bn": round(latest_nl, 2),
            "value_tn": round(latest_nl / 1000.0, 3),
            "date": str(df_liq.index[-1].date()),
            "chg_4w_bn": round(latest_nl - nl_4w_ago, 2),
            "chg_13w_bn": round(latest_nl - nl_13w_ago, 2),
            "series": [
                {
                    "date": str(dt.date()),
                    "net_liq_bn": round(float(row["net_liq"]), 1),
                    "tga_bn": round(float(row["tga"]), 1),
                    "rrp_bn": round(float(row["rrp"]), 1),
                    "walcl_bn": round(float(row["walcl"]), 1),
                }
                for dt, row in weekly.iterrows()
            ],
        }

    # Derived SOFR - IORB spread (in bps)
    if "SOFR" in raw_series and "IORB" in raw_series:
        df_sp = pd.DataFrame({"sofr": raw_series["SOFR"], "iorb": raw_series["IORB"]}).sort_index().ffill().dropna()
        df_sp["spread_bps"] = (df_sp["sofr"] - df_sp["iorb"]) * 100.0
        derived["sofr_iorb_spread"] = {
            "value_bps": round(float(df_sp["spread_bps"].iloc[-1]), 2),
            "sofr": round(float(df_sp["sofr"].iloc[-1]), 3),
            "iorb": round(float(df_sp["iorb"].iloc[-1]), 3),
            "date": str(df_sp.index[-1].date()),
            "max_20d_bps": round(float(df_sp["spread_bps"].tail(20).max()), 2),
            "history": [
                {"date": str(dt.date()), "spread_bps": round(float(v), 2)}
                for dt, v in df_sp["spread_bps"].tail(60).items()
            ],
        }

    return {"metrics": metrics, "derived": derived}


def _compute_rsi(series: pd.Series, period: int = 14) -> float | None:
    if len(series) < period + 2:
        return None
    delta = series.diff()
    gain = delta.clip(lower=0).rolling(period).mean()
    loss = (-delta.clip(upper=0)).rolling(period).mean()
    rs = gain / loss.replace(0, np.nan)
    rsi = 100.0 - (100.0 / (1.0 + rs))
    val = rsi.iloc[-1]
    return round(float(val), 1) if pd.notna(val) else None


def collect_market_quotes() -> dict[str, Any]:
    """Collect 1-year daily + latest intraday quotes sequentially (avoiding SQLite locks)."""
    quotes: dict[str, Any] = {}
    for sym, meta in MARKET_TICKERS.items():
        try:
            tk = yf.Ticker(sym)
            hist = tk.history(period="1y", interval="1d", auto_adjust=False)
            closes = hist["Close"].dropna() if not hist.empty and "Close" in hist else pd.Series(dtype=float)

            # Check if latest trading day close was NaN in daily feed; supplement with 1h bar
            last_daily_dt = closes.index[-1].tz_localize(None).normalize() if not closes.empty else None
            try:
                h1 = tk.history(period="5d", interval="1h", auto_adjust=False)
                if not h1.empty and "Close" in h1 and not h1["Close"].dropna().empty:
                    c1 = h1["Close"].dropna()
                    latest_1h_ts = c1.index[-1]
                    latest_1h_day = latest_1h_ts.tz_localize(None).normalize()
                    latest_1h_px = float(c1.iloc[-1])
                    if last_daily_dt is None or latest_1h_day > last_daily_dt:
                        closes.loc[latest_1h_ts] = latest_1h_px
            except Exception:
                pass

            if closes.empty:
                continue

            latest = float(closes.iloc[-1])
            latest_dt = str(closes.index[-1].date())
            prev_1 = float(closes.iloc[-2]) if len(closes) >= 2 else latest
            prev_5 = float(closes.iloc[-6]) if len(closes) >= 6 else float(closes.iloc[0])
            prev_20 = float(closes.iloc[-21]) if len(closes) >= 21 else float(closes.iloc[0])

            high_52w = float(closes.max())
            low_52w = float(closes.min())
            pct_1y = float((closes <= latest).mean() * 100.0)
            ma50 = float(closes.tail(50).mean()) if len(closes) >= 50 else latest
            ma200 = float(closes.tail(200).mean()) if len(closes) >= 200 else latest

            item: dict[str, Any] = {
                "symbol": sym,
                "name": meta["name"],
                "category": meta["category"],
                "price": round(latest, 2 if latest >= 10 else 4),
                "date": latest_dt,
                "ret_1d_pct": round((latest / prev_1 - 1.0) * 100.0, 2) if prev_1 else 0.0,
                "ret_5d_pct": round((latest / prev_5 - 1.0) * 100.0, 2) if prev_5 else 0.0,
                "ret_20d_pct": round((latest / prev_20 - 1.0) * 100.0, 2) if prev_20 else 0.0,
                "drawdown_52w_pct": round((latest / high_52w - 1.0) * 100.0, 2) if high_52w else 0.0,
                "high_52w": round(high_52w, 2),
                "low_52w": round(low_52w, 2),
                "pct_1y": round(pct_1y, 1),
                "ma50": round(ma50, 2),
                "ma200": round(ma200, 2),
                "above_ma200": bool(latest >= ma200),
                "rsi14": _compute_rsi(closes),
                "history_60d": [
                    {"date": str(dt.date()), "close": round(float(v), 2 if v >= 10 else 4)}
                    for dt, v in closes.tail(60).items()
                ],
            }
            if "ipo_price" in meta:
                ipo_px = float(meta["ipo_price"])
                item["ipo_price"] = ipo_px
                item["vs_ipo_pct"] = round((latest / ipo_px - 1.0) * 100.0, 2)
            quotes[sym] = item
        except Exception as exc:
            logger.warning("Failed to fetch quote %s: %s", sym, exc)

    return quotes


def _bs_gamma(S: np.ndarray | float, K: np.ndarray, T: np.ndarray, r: float, sigma: np.ndarray) -> np.ndarray:
    """Vectorized Black-Scholes Gamma."""
    sigma_safe = np.clip(sigma, 0.05, 3.0)
    T_safe = np.clip(T, 1.0 / 365.25, 5.0)
    sqrtT = np.sqrt(T_safe)
    d1 = (np.log(S / K) + (r + 0.5 * sigma_safe**2) * T_safe) / (sigma_safe * sqrtT)
    return norm.pdf(d1) / (S * sigma_safe * sqrtT)


def collect_options_microstructure(qqq_spot: float, ndx_spot: float, risk_free_rate: float = 0.045) -> dict[str, Any]:
    """Compute live QQQ -> NDX mapped Put Walls, Call Walls, and Dealer Gamma Exposure (GEX)."""
    try:
        tk = yf.Ticker("QQQ")
        all_exps = list(tk.options)
        if not all_exps:
            return {"available": False}

        # Pick nearest 5 expirations + monthly OPEX (3rd Friday) & month/year-end within 45 days
        today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        cutoff_str = (datetime.now(timezone.utc) + timedelta(days=45)).strftime("%Y-%m-%d")
        near_exps = [e for e in all_exps if e >= today_str][:5]
        structural_exps = [
            e for e in all_exps
            if today_str <= e <= cutoff_str and (e.endswith("-18") or e.endswith("-19") or e.endswith("-30") or e.endswith("-31"))
        ]
        selected_exps = sorted(set(near_exps + structural_exps))[:8]

        now_utc = datetime.now(timezone.utc)
        ratio = ndx_spot / qqq_spot if qqq_spot > 0 else 41.08
        rows: list[pd.DataFrame] = []

        for exp in selected_exps:
            ch = tk.option_chain(exp)
            exp_dt = pd.Timestamp(exp, tz="UTC") + pd.Timedelta(hours=21)
            T = max((exp_dt - now_utc).total_seconds() / (365.25 * 86400.0), 1.0 / 365.25)
            for opt_type, df in (("call", ch.calls), ("put", ch.puts)):
                if df is None or df.empty:
                    continue
                sub = df[["strike", "openInterest", "impliedVolatility"]].copy()
                sub["openInterest"] = pd.to_numeric(sub["openInterest"], errors="coerce").fillna(0.0)
                sub["impliedVolatility"] = pd.to_numeric(sub["impliedVolatility"], errors="coerce").fillna(0.25)
                sub.loc[sub["impliedVolatility"] <= 0.01, "impliedVolatility"] = 0.25
                sub["type"] = opt_type
                sub["T"] = T
                sub["exp"] = exp
                rows.append(sub)

        if not rows:
            return {"available": False}

        opt = pd.concat(rows, ignore_index=True)
        opt = opt[(opt["openInterest"] > 0) & (opt["strike"] >= qqq_spot * 0.84) & (opt["strike"] <= qqq_spot * 1.14)].copy()

        # Gamma at current spot (Dealer convention: +Call GEX, -Put GEX, $ per 1% spot move)
        gammas = _bs_gamma(
            qqq_spot,
            opt["strike"].to_numpy(),
            opt["T"].to_numpy(),
            risk_free_rate,
            opt["impliedVolatility"].to_numpy(),
        )
        sign = np.where(opt["type"] == "call", 1.0, -1.0)
        # Dollar GEX per 1% move in QQQ ($M)
        opt["gex_m"] = sign * gammas * opt["openInterest"] * 100.0 * (qqq_spot**2) * 0.01 / 1e6

        net_gex_m = float(opt["gex_m"].sum())

        # Find Zero-Gamma Flip across spot grid [0.90 * spot, 1.10 * spot]
        grid_qqq = np.linspace(qqq_spot * 0.90, qqq_spot * 1.10, 81)
        K_arr = opt["strike"].to_numpy()[None, :]
        T_arr = opt["T"].to_numpy()[None, :]
        iv_arr = opt["impliedVolatility"].to_numpy()[None, :]
        oi_arr = opt["openInterest"].to_numpy()[None, :]
        sign_arr = sign[None, :]
        S_arr = grid_qqq[:, None]

        grid_gammas = _bs_gamma(S_arr, K_arr, T_arr, risk_free_rate, iv_arr)
        grid_gex = np.sum(sign_arr * grid_gammas * oi_arr * 100.0 * (S_arr**2) * 0.01 / 1e6, axis=1)

        zero_gamma_qqq: float | None = None
        for i in range(len(grid_qqq) - 1):
            if (grid_gex[i] <= 0 <= grid_gex[i + 1]) or (grid_gex[i] >= 0 >= grid_gex[i + 1]):
                denom = grid_gex[i + 1] - grid_gex[i]
                w = -grid_gex[i] / denom if abs(denom) > 1e-9 else 0.5
                zero_gamma_qqq = float(grid_qqq[i] + w * (grid_qqq[i + 1] - grid_qqq[i]))
                break
        if zero_gamma_qqq is None:
            # Nearest point to zero
            idx_min = int(np.argmin(np.abs(grid_gex)))
            zero_gamma_qqq = float(grid_qqq[idx_min])

        zero_gamma_ndx = round(zero_gamma_qqq * ratio, 0)

        # Aggregate OI & GEX by strike
        calls_by_k = opt[opt["type"] == "call"].groupby("strike")["openInterest"].sum()
        puts_by_k = opt[opt["type"] == "put"].groupby("strike")["openInterest"].sum()
        gex_by_k = opt.groupby("strike")["gex_m"].sum()

        # Put Walls below spot: immediate support (-5% to -0.3%) vs structural major wall (-11% to -2.5%)
        near_puts = puts_by_k[(puts_by_k.index <= qqq_spot * 0.997) & (puts_by_k.index >= qqq_spot * 0.95)].sort_values(ascending=False)
        deep_otm_puts = puts_by_k[(puts_by_k.index <= qqq_spot * 0.975) & (puts_by_k.index >= qqq_spot * 0.89)].sort_values(ascending=False)
        otm_calls = calls_by_k[calls_by_k.index >= qqq_spot * 1.005].sort_values(ascending=False)

        major_put_wall_qqq = float(deep_otm_puts.index[0]) if not deep_otm_puts.empty else float(near_puts.index[0])
        major_put_wall_oi = int(deep_otm_puts.iloc[0]) if not deep_otm_puts.empty else int(near_puts.iloc[0])
        near_put_support_qqq = float(near_puts.index[0]) if not near_puts.empty else qqq_spot * 0.98
        near_put_support_oi = int(near_puts.iloc[0]) if not near_puts.empty else 0

        major_call_wall_qqq = float(otm_calls.index[0]) if not otm_calls.empty else qqq_spot * 1.05
        major_call_wall_oi = int(otm_calls.iloc[0]) if not otm_calls.empty else 0

        # Compare NDX 25,000 (~QQQ 608-609) vs Major Put Wall (e.g. QQQ 600 -> NDX ~24,650)
        k_25000_qqq = round(25000.0 / ratio)
        oi_near_25000 = int(puts_by_k.get(float(k_25000_qqq), 0) + puts_by_k.get(float(k_25000_qqq + 1), 0))

        # Build clean strike profile in $5 QQQ increments (~205 NDX pts) for chart
        strike_min = int(np.floor(qqq_spot * 0.89 / 5.0) * 5)
        strike_max = int(np.ceil(qqq_spot * 1.11 / 5.0) * 5)
        profile: list[dict[str, Any]] = []
        for b in range(strike_min, strike_max + 5, 5):
            mask_c = (calls_by_k.index >= b - 2.5) & (calls_by_k.index < b + 2.5)
            mask_p = (puts_by_k.index >= b - 2.5) & (puts_by_k.index < b + 2.5)
            mask_g = (gex_by_k.index >= b - 2.5) & (gex_by_k.index < b + 2.5)
            profile.append({
                "qqq_strike": b,
                "ndx_equiv": int(round(b * ratio)),
                "call_oi": int(calls_by_k[mask_c].sum()),
                "put_oi": int(puts_by_k[mask_p].sum()),
                "net_gex_m": round(float(gex_by_k[mask_g].sum()), 2),
            })

        total_put_oi = int(puts_by_k.sum())
        total_call_oi = int(calls_by_k.sum())

        return {
            "available": True,
            "expirations_scanned": selected_exps,
            "qqq_spot": round(qqq_spot, 2),
            "ndx_spot": round(ndx_spot, 2),
            "ndx_qqq_ratio": round(ratio, 4),
            "in_negative_gamma": bool(net_gex_m < 0 or ndx_spot < zero_gamma_ndx),
            "net_gex_m": round(net_gex_m, 2),
            "zero_gamma_qqq": round(zero_gamma_qqq, 2),
            "zero_gamma_ndx": int(zero_gamma_ndx),
            "major_put_wall": {
                "qqq_strike": major_put_wall_qqq,
                "ndx_equiv": int(round(major_put_wall_qqq * ratio)),
                "open_interest": major_put_wall_oi,
                "dist_pct": round((major_put_wall_qqq / qqq_spot - 1.0) * 100.0, 2),
            },
            "near_put_support": {
                "qqq_strike": near_put_support_qqq,
                "ndx_equiv": int(round(near_put_support_qqq * ratio)),
                "open_interest": near_put_support_oi,
                "dist_pct": round((near_put_support_qqq / qqq_spot - 1.0) * 100.0, 2),
            },
            "major_call_wall": {
                "qqq_strike": major_call_wall_qqq,
                "ndx_equiv": int(round(major_call_wall_qqq * ratio)),
                "open_interest": major_call_wall_oi,
                "dist_pct": round((major_call_wall_qqq / qqq_spot - 1.0) * 100.0, 2),
            },
            "psych_25000_check": {
                "qqq_equiv_strike": k_25000_qqq,
                "put_oi_near_25000": oi_near_25000,
                "wall_to_25000_oi_ratio": round(major_put_wall_oi / max(oi_near_25000, 1), 1),
            },
            "put_call_oi_ratio": round(total_put_oi / max(total_call_oi, 1), 2),
            "strike_profile": profile,
            "gex_curve": [
                {"qqq": round(float(s), 1), "ndx": int(round(float(s) * ratio)), "gex_m": round(float(g), 2)}
                for s, g in zip(grid_qqq[::2], grid_gex[::2])
            ],
        }
    except Exception as exc:
        logger.warning("Failed options microstructure calculation: %s", exc)
        return {"available": False, "error": str(exc)}


def collect_ai_capex_ledger() -> dict[str, Any]:
    """Audit Big-5 Hyperscaler quarterly CapEx vs Operating Cash Flow & Free Cash Flow."""
    companies: list[dict[str, Any]] = []
    total_ocf_b = 0.0
    total_capex_b = 0.0
    total_fcf_b = 0.0
    neg_fcf_count = 0

    for sym in HYPERSCALERS:
        try:
            tk = yf.Ticker(sym)
            cf = tk.quarterly_cashflow
            if cf is None or cf.empty:
                continue
            col = cf.columns[0]
            prev_col = cf.columns[1] if len(cf.columns) >= 2 else None

            ocf = float(cf.loc["Operating Cash Flow", col]) / 1e9 if "Operating Cash Flow" in cf.index else 0.0
            capex = abs(float(cf.loc["Capital Expenditure", col])) / 1e9 if "Capital Expenditure" in cf.index else 0.0
            fcf = float(cf.loc["Free Cash Flow", col]) / 1e9 if "Free Cash Flow" in cf.index else (ocf - capex)
            debt_issued = (
                float(cf.loc["Issuance Of Debt", col]) / 1e9
                if "Issuance Of Debt" in cf.index and pd.notna(cf.loc["Issuance Of Debt", col])
                else 0.0
            )

            prev_capex = (
                abs(float(cf.loc["Capital Expenditure", prev_col])) / 1e9
                if prev_col is not None and "Capital Expenditure" in cf.index and pd.notna(cf.loc["Capital Expenditure", prev_col])
                else capex
            )
            capex_ocf_pct = (capex / ocf * 100.0) if ocf > 0 else 999.0

            if fcf < 0:
                neg_fcf_count += 1
            total_ocf_b += ocf
            total_capex_b += capex
            total_fcf_b += fcf

            companies.append({
                "symbol": sym,
                "quarter_end": str(col.date()),
                "ocf_bn": round(ocf, 2),
                "capex_bn": round(capex, 2),
                "fcf_bn": round(fcf, 2),
                "debt_issued_bn": round(debt_issued, 2),
                "capex_to_ocf_pct": round(capex_ocf_pct, 1),
                "capex_qoq_pct": round((capex / prev_capex - 1.0) * 100.0, 1) if prev_capex > 0 else 0.0,
                "fcf_negative": bool(fcf < 0),
            })
        except Exception as exc:
            logger.warning("Failed cashflow audit for %s: %s", sym, exc)

    annualized_capex_b = total_capex_b * 4.0
    agg_capex_ocf_pct = (total_capex_b / total_ocf_b * 100.0) if total_ocf_b > 0 else 0.0

    return {
        "companies": companies,
        "summary": {
            "quarterly_ocf_bn": round(total_ocf_b, 2),
            "quarterly_capex_bn": round(total_capex_b, 2),
            "annualized_capex_bn": round(annualized_capex_b, 1),
            "quarterly_fcf_bn": round(total_fcf_b, 2),
            "agg_capex_to_ocf_pct": round(agg_capex_ocf_pct, 1),
            "negative_fcf_count": neg_fcf_count,
            "total_audited": len(companies),
        },
    }


def compute_settlement_calendar(ref_date: date | None = None) -> dict[str, Any]:
    """Compute business days to Month-End, Quarter-End, and Year-End repo balance-sheet bottlenecks."""
    today = ref_date or datetime.now(timezone.utc).date()
    last_day_month = date(today.year, today.month, calendar.monthrange(today.year, today.month)[1])
    # Adjust if weekend to last weekday
    me_bday = last_day_month
    while me_bday.weekday() >= 5:
        me_bday -= timedelta(days=1)

    q_end_month = ((today.month - 1) // 3 + 1) * 3
    last_day_q = date(today.year, q_end_month, calendar.monthrange(today.year, q_end_month)[1])
    qe_bday = last_day_q
    while qe_bday.weekday() >= 5:
        qe_bday -= timedelta(days=1)

    ye_bday = date(today.year, 12, 31)
    while ye_bday.weekday() >= 5:
        ye_bday -= timedelta(days=1)

    def _bdays_between(d1: date, d2: date) -> int:
        if d2 <= d1:
            return 0
        return int(np.busday_count(d1.isoformat(), d2.isoformat()))

    bdays_me = _bdays_between(today, me_bday)
    bdays_qe = _bdays_between(today, qe_bday)
    bdays_ye = _bdays_between(today, ye_bday)

    return {
        "today": today.isoformat(),
        "month_end_settlement": me_bday.isoformat(),
        "bdays_to_month_end": bdays_me,
        "quarter_end_settlement": qe_bday.isoformat(),
        "bdays_to_quarter_end": bdays_qe,
        "year_end_settlement": ye_bday.isoformat(),
        "bdays_to_year_end": bdays_ye,
        "in_settlement_window": bool(bdays_me <= 5 or bdays_qe <= 7),
    }


def collect_all_market_data() -> dict[str, Any]:
    """Master collection pipeline pulling FRED, Market Quotes, Options Walls, and AI CapEx Ledgers."""
    started_at = datetime.now(timezone.utc)
    fred = collect_fred_data()
    quotes = collect_market_quotes()

    qqq_px = quotes.get("QQQ", {}).get("price", 638.0)
    ndx_px = quotes.get("^NDX", {}).get("price", 26215.0)
    rfr = fred["metrics"].get("DGS3MO", {}).get("value", 4.5) / 100.0

    options_micro = collect_options_microstructure(qqq_spot=qqq_px, ndx_spot=ndx_px, risk_free_rate=rfr)
    ai_ledger = collect_ai_capex_ledger()
    cal = compute_settlement_calendar()

    elapsed = (datetime.now(timezone.utc) - started_at).total_seconds()
    return {
        "collected_at_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "elapsed_seconds": round(elapsed, 2),
        "calendar": cal,
        "fred": fred,
        "quotes": quotes,
        "options": options_micro,
        "ai_ledger": ai_ledger,
    }
