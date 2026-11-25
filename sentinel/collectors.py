"""Real-time and historical market data collectors (FRED + Yahoo Finance + Options + Ledgers)."""

from __future__ import annotations

import calendar
import io
import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd
import requests
import yfinance as yf
from scipy.stats import norm

logger = logging.getLogger(__name__)
ET_TZ = ZoneInfo("America/New_York")

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

    # Derived SOFR - IORB spread (in bps) + Hysteresis persistence counters
    if "SOFR" in raw_series and "IORB" in raw_series:
        sofr_s = raw_series["SOFR"].dropna().sort_index()
        iorb_aligned = (
            raw_series["IORB"]
            .reindex(sofr_s.index.union(raw_series["IORB"].index))
            .sort_index()
            .ffill()
            .reindex(sofr_s.index)
        )
        df_sp = pd.DataFrame({"sofr": sofr_s, "iorb": iorb_aligned}).dropna()
        df_sp["spread_bps"] = (df_sp["sofr"] - df_sp["iorb"]) * 100.0
        sp_vals = df_sp["spread_bps"].tolist()

        consec_above_zero = 0
        for v in reversed(sp_vals):
            if v > 0.0:
                consec_above_zero += 1
            else:
                break

        consec_above_5bps = 0
        for v in reversed(sp_vals):
            if v >= 5.0:
                consec_above_5bps += 1
            else:
                break

        prev_sp_bps = round(float(sp_vals[-2]), 2) if len(sp_vals) >= 2 else round(float(sp_vals[-1]), 2)
        derived["sofr_iorb_spread"] = {
            "value_bps": round(float(sp_vals[-1]), 2),
            "prev_value_bps": prev_sp_bps,
            "consecutive_days_above_zero": consec_above_zero,
            "consecutive_days_above_5bps": consec_above_5bps,
            "sofr": round(float(df_sp["sofr"].iloc[-1]), 3),
            "iorb": round(float(df_sp["iorb"].iloc[-1]), 3),
            "date": str(df_sp.index[-1].date()),
            "max_20d_bps": round(float(df_sp["spread_bps"].tail(20).max()), 2),
            "history": [
                {"date": str(dt.date()), "spread_bps": round(float(v), 2)}
                for dt, v in df_sp["spread_bps"].tail(60).items()
            ],
        }

    daily_dates = [
        metrics[k]["date"]
        for k in ("SOFR", "DGS10", "BAMLH0A3HYCEY")
        if k in metrics and metrics[k].get("date")
    ]
    latest_obs_date = max(daily_dates) if daily_dates else None
    updated_at_utc = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return {
        "metrics": metrics,
        "derived": derived,
        "updated_at_utc": updated_at_utc,
        "latest_obs_date": latest_obs_date,
    }


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
            raw_closes = hist["Close"].dropna() if not hist.empty and "Close" in hist else pd.Series(dtype=float)
            if not raw_closes.empty:
                norm_idx = pd.to_datetime([ts.tz_localize(None).normalize() if getattr(ts, "tzinfo", None) else pd.Timestamp(ts).normalize() for ts in raw_closes.index])
                closes = pd.Series(raw_closes.values, index=norm_idx)
                closes = closes[~closes.index.duplicated(keep="last")].sort_index()
            else:
                closes = pd.Series(dtype=float)

            last_bar_utc: str | None = None
            recent_30m_closes: list[float] = []

            # Always overlay latest 5-minute real-time intraday bar onto its trading date
            try:
                m5 = tk.history(period="2d", interval="5m", auto_adjust=False)
                if not m5.empty and "Close" in m5 and not m5["Close"].dropna().empty:
                    c5 = m5["Close"].dropna()
                    latest_ts = c5.index[-1]
                    if getattr(latest_ts, "tzinfo", None):
                        last_bar_utc = latest_ts.tz_convert("UTC").strftime("%Y-%m-%dT%H:%M:%SZ")
                        latest_day = latest_ts.tz_localize(None).normalize()
                    else:
                        last_bar_utc = pd.Timestamp(latest_ts, tz="UTC").strftime("%Y-%m-%dT%H:%M:%SZ")
                        latest_day = pd.Timestamp(latest_ts).normalize()
                    closes.loc[latest_day] = float(c5.iloc[-1])
                    closes = closes.sort_index()
                    if sym in ("QQQ", "^NDX"):
                        recent_30m_closes = [round(float(v), 2) for v in c5.tail(6).tolist()]
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
                "last_bar_utc": last_bar_utc,
                "ret_1d_pct": round((latest / prev_1 - 1.0) * 100.0, 2) if prev_1 else 0.0,
                "ret_5d_pct": round((latest / prev_5 - 1.0) * 100.0, 2) if prev_5 else 0.0,
                "ret_20d_pct": round((latest / prev_20 - 1.0) * 100.0, 2) if prev_20 else 0.0,
                "chg_5_abs": round(latest - prev_5, 2),
                "chg_20_abs": round(latest - prev_20, 2),
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
            if recent_30m_closes:
                item["recent_30m_closes"] = recent_30m_closes
            if "ipo_price" in meta:
                ipo_px = float(meta["ipo_price"])
                item["ipo_price"] = ipo_px
                item["vs_ipo_pct"] = round((latest / ipo_px - 1.0) * 100.0, 2)
            quotes[sym] = item
        except Exception as exc:
            logger.warning("Failed to fetch quote %s: %s", sym, exc)

    return quotes


def _bs_gamma(S: np.ndarray | float, K: np.ndarray, T: np.ndarray, r: float, sigma: np.ndarray) -> np.ndarray:
    """Vectorized Black-Scholes Gamma (inputs already scrubbed for invalid IV)."""
    sigma_safe = np.clip(sigma, 0.02, 3.0)
    T_safe = np.clip(T, 1.0 / 365.25, 5.0)
    sqrtT = np.sqrt(T_safe)
    d1 = (np.log(S / K) + (r + 0.5 * sigma_safe**2) * T_safe) / (sigma_safe * sqrtT)
    return norm.pdf(d1) / (S * sigma_safe * sqrtT)


def collect_options_microstructure(
    qqq_spot: float,
    ndx_spot: float,
    risk_free_rate: float = 0.045,
    qqq_recent_30m_closes: list[float] | None = None,
) -> dict[str, Any]:
    """Compute cleaned 0-45 DTE QQQ -> NDX Put/Call Walls, weighted Zero-Gamma, and Hysteresis state."""
    try:
        tk = yf.Ticker("QQQ")
        all_exps = list(tk.options)
        if not all_exps:
            return {"available": False}

        now_utc = datetime.now(timezone.utc)
        now_et = now_utc.astimezone(ET_TZ)
        today_et = now_et.date()
        post_close_0dte = (now_et.hour, now_et.minute) >= (16, 15)

        # Strictly restrict to near-month 0-45 DTE contracts (skip settled 0DTE after 16:15 ET)
        dte_candidates: list[tuple[str, int]] = []
        for exp in all_exps:
            try:
                exp_d = date.fromisoformat(exp)
            except ValueError:
                continue
            dte = (exp_d - today_et).days
            if dte < 0 or dte > 45:
                continue
            if dte == 0 and post_close_0dte:
                continue
            dte_candidates.append((exp, dte))

        if not dte_candidates:
            return {"available": False, "error": "No valid 0-45 DTE expirations"}

        # Prioritize nearest 6 expirations + structural OPEX / month-end within 0-45 DTE (max 10 chains)
        near_set = {e for e, _ in dte_candidates[:6]}
        struct_set = {
            e for e, _ in dte_candidates
            if e.endswith(("-15", "-16", "-17", "-18", "-19", "-20", "-21", "-29", "-30", "-31"))
        }
        chosen_set = near_set | struct_set
        selected_pairs = [(e, d) for e, d in dte_candidates if e in chosen_set][:10]
        selected_exps = [e for e, _ in selected_pairs]

        ratio = ndx_spot / qqq_spot if qqq_spot > 0 else 41.08
        rows: list[pd.DataFrame] = []

        raw_contracts = 0
        dropped_low_oi = 0
        dropped_bad_quote = 0
        dropped_bad_iv = 0
        used_weekend_fallback = False

        k_lo = qqq_spot * 0.84
        k_hi = qqq_spot * 1.14

        for exp, dte_days in selected_pairs:
            ch = tk.option_chain(exp)
            exp_dt = pd.Timestamp(exp, tz="UTC") + pd.Timedelta(hours=21)
            T = max((exp_dt - now_utc).total_seconds() / (365.25 * 86400.0), 1.0 / 365.25)
            # Near-month liquidity weighting: 0-21 DTE = 1.0, 22-35 DTE = 0.85, 36-45 DTE = 0.70
            dte_weight = 1.0 if dte_days <= 21 else (0.85 if dte_days <= 35 else 0.70)

            for opt_type, df in (("call", ch.calls), ("put", ch.puts)):
                if df is None or df.empty:
                    continue
                cols_needed = ["strike", "openInterest", "impliedVolatility"]
                for extra_col in ("bid", "ask", "lastPrice"):
                    if extra_col in df.columns:
                        cols_needed.append(extra_col)
                sub = df[cols_needed].copy()
                sub["strike"] = pd.to_numeric(sub["strike"], errors="coerce")
                sub = sub[(sub["strike"] >= k_lo) & (sub["strike"] <= k_hi)].copy()
                if sub.empty:
                    continue

                raw_contracts += len(sub)
                sub["openInterest"] = pd.to_numeric(sub["openInterest"], errors="coerce").fillna(0.0)
                sub["impliedVolatility"] = pd.to_numeric(sub["impliedVolatility"], errors="coerce").fillna(-1.0)
                sub["bid"] = pd.to_numeric(sub.get("bid", 0.0), errors="coerce").fillna(0.0)
                sub["ask"] = pd.to_numeric(sub.get("ask", 0.0), errors="coerce").fillna(0.0)
                sub["lastPrice"] = pd.to_numeric(sub.get("lastPrice", 0.0), errors="coerce").fillna(0.0)

                # Step 1: Dirty OI filter (drop OI < 100)
                mask_oi = sub["openInterest"] >= 100
                dropped_low_oi += int((~mask_oi).sum())
                sub = sub[mask_oi].copy()
                if sub.empty:
                    continue

                # Step 2: Dirty Bid/Ask spread filter (Bid > 0 and (Ask - Bid)/Mid <= 30%)
                live_bid_ratio = float((sub["bid"] > 0).mean())
                if live_bid_ratio >= 0.15:
                    mid = (sub["ask"] + sub["bid"]) / 2.0
                    rel_spread = np.where(mid > 0, (sub["ask"] - sub["bid"]) / mid, 999.0)
                    mask_quote = (sub["bid"] > 0) & (sub["ask"] >= sub["bid"]) & (rel_spread <= 0.30)
                else:
                    # Weekend / OPRA off-hours fallback when Yahoo zeroes all bids
                    used_weekend_fallback = True
                    mask_quote = sub["lastPrice"] >= 0.05

                dropped_bad_quote += int((~mask_quote).sum())
                sub = sub[mask_quote].copy()
                if sub.empty:
                    continue

                # Step 3: Abnormal IV filter (drop IV <= 0.5% or IV > 300%, NO synthetic IV fill)
                mask_iv = (sub["impliedVolatility"] > 0.005) & (sub["impliedVolatility"] <= 3.0)
                dropped_bad_iv += int((~mask_iv).sum())
                sub = sub[mask_iv].copy()
                if sub.empty:
                    continue

                sub["type"] = opt_type
                sub["T"] = T
                sub["dte"] = dte_days
                sub["dte_weight"] = dte_weight
                sub["exp"] = exp
                rows.append(sub)

        if not rows:
            return {"available": False, "error": "All option contracts filtered out"}

        opt = pd.concat(rows, ignore_index=True)
        kept_contracts = int(len(opt))

        # Gamma at current spot (Dealer default convention: +Call GEX, -Put GEX, $ per 1% spot move)
        gammas = _bs_gamma(
            qqq_spot,
            opt["strike"].to_numpy(),
            opt["T"].to_numpy(),
            risk_free_rate,
            opt["impliedVolatility"].to_numpy(),
        )
        sign = np.where(opt["type"] == "call", 1.0, -1.0)
        weights = opt["dte_weight"].to_numpy()
        opt["gex_m"] = sign * weights * gammas * opt["openInterest"] * 100.0 * (qqq_spot**2) * 0.01 / 1e6

        net_gex_m = float(opt["gex_m"].sum())

        # Solve weighted 0-45 DTE Zero-Gamma Flip across spot grid [0.90 * spot, 1.10 * spot]
        grid_qqq = np.linspace(qqq_spot * 0.90, qqq_spot * 1.10, 81)
        K_arr = opt["strike"].to_numpy()[None, :]
        T_arr = opt["T"].to_numpy()[None, :]
        iv_arr = opt["impliedVolatility"].to_numpy()[None, :]
        oi_arr = opt["openInterest"].to_numpy()[None, :]
        w_arr = weights[None, :]
        sign_arr = sign[None, :]
        S_arr = grid_qqq[:, None]

        grid_gammas = _bs_gamma(S_arr, K_arr, T_arr, risk_free_rate, iv_arr)
        grid_gex = np.sum(sign_arr * w_arr * grid_gammas * oi_arr * 100.0 * (S_arr**2) * 0.01 / 1e6, axis=1)

        zero_gamma_qqq: float | None = None
        for i in range(len(grid_qqq) - 1):
            if (grid_gex[i] <= 0 <= grid_gex[i + 1]) or (grid_gex[i] >= 0 >= grid_gex[i + 1]):
                denom = grid_gex[i + 1] - grid_gex[i]
                w = -grid_gex[i] / denom if abs(denom) > 1e-9 else 0.5
                zero_gamma_qqq = float(grid_qqq[i] + w * (grid_qqq[i + 1] - grid_qqq[i]))
                break
        if zero_gamma_qqq is None:
            idx_min = int(np.argmin(np.abs(grid_gex)))
            zero_gamma_qqq = float(grid_qqq[idx_min])

        zero_gamma_ndx = int(round(zero_gamma_qqq * ratio))

        # Hysteresis Band (±0.75% spatial deadband + 30-min 6x5m bar persistence check)
        band_pct = 0.0075
        lower_band_qqq = zero_gamma_qqq * (1.0 - band_pct)
        upper_band_qqq = zero_gamma_qqq * (1.0 + band_pct)
        lower_band_ndx = int(round(lower_band_qqq * ratio))
        upper_band_ndx = int(round(upper_band_qqq * ratio))
        dist_to_flip_pct = round((qqq_spot / zero_gamma_qqq - 1.0) * 100.0, 2)

        closes_30m = qqq_recent_30m_closes or []
        held_30m_below = bool(len(closes_30m) >= 6 and all(c < zero_gamma_qqq for c in closes_30m))
        held_30m_above = bool(len(closes_30m) >= 6 and all(c > zero_gamma_qqq for c in closes_30m))

        if lower_band_qqq <= qqq_spot <= upper_band_qqq:
            gamma_state = "BUFFER_PROBING"
        elif qqq_spot < lower_band_qqq:
            gamma_state = "NEGATIVE_CONFIRMED" if (held_30m_below or len(closes_30m) < 6) else "BUFFER_PROBING"
        else:
            gamma_state = "POSITIVE_CONFIRMED" if (held_30m_above or len(closes_30m) < 6) else "BUFFER_PROBING"

        # Aggregate OI & GEX by strike
        calls_by_k = opt[opt["type"] == "call"].groupby("strike")["openInterest"].sum()
        puts_by_k = opt[opt["type"] == "put"].groupby("strike")["openInterest"].sum()
        gex_by_k = opt.groupby("strike")["gex_m"].sum()

        otm_puts_main = puts_by_k[(puts_by_k.index <= qqq_spot * 0.998) & (puts_by_k.index >= qqq_spot * 0.92)].sort_values(ascending=False)
        all_below_puts = puts_by_k[(puts_by_k.index <= qqq_spot * 0.998) & (puts_by_k.index >= qqq_spot * 0.86)].sort_values(ascending=False)
        otm_calls = calls_by_k[calls_by_k.index >= qqq_spot * 1.005].sort_values(ascending=False)

        if not otm_puts_main.empty:
            major_put_wall_qqq = float(otm_puts_main.index[0])
            major_put_wall_oi = int(otm_puts_main.iloc[0])
        elif not all_below_puts.empty:
            major_put_wall_qqq = float(all_below_puts.index[0])
            major_put_wall_oi = int(all_below_puts.iloc[0])
        else:
            major_put_wall_qqq = round(qqq_spot * 0.95, 0)
            major_put_wall_oi = 0

        secondary_puts = puts_by_k[(puts_by_k.index < major_put_wall_qqq) & (puts_by_k.index >= qqq_spot * 0.86)].sort_values(ascending=False)
        near_put_support_qqq = float(secondary_puts.index[0]) if not secondary_puts.empty else round(major_put_wall_qqq * 0.97, 0)
        near_put_support_oi = int(secondary_puts.iloc[0]) if not secondary_puts.empty else 0

        major_call_wall_qqq = float(otm_calls.index[0]) if not otm_calls.empty else round(qqq_spot * 1.05, 0)
        major_call_wall_oi = int(otm_calls.iloc[0]) if not otm_calls.empty else 0

        nearest_1k = int(round(ndx_spot / 1000.0) * 1000)
        psych_round_ndx = nearest_1k if abs(ndx_spot - nearest_1k) <= 350 else int(np.floor(ndx_spot / 1000.0) * 1000)
        k_psych_qqq = round(psych_round_ndx / ratio)
        oi_near_psych = int(puts_by_k.get(float(k_psych_qqq), 0) + puts_by_k.get(float(k_psych_qqq + 1), 0))

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
        options_updated_utc = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

        return {
            "available": True,
            "updated_at_utc": options_updated_utc,
            "dte_window": "0–45 DTE 近月加权",
            "expirations_scanned": selected_exps,
            "cleaning_stats": {
                "raw_contracts": raw_contracts,
                "kept_contracts": kept_contracts,
                "dropped_low_oi": dropped_low_oi,
                "dropped_bad_quote": dropped_bad_quote,
                "dropped_bad_iv": dropped_bad_iv,
                "filter_mode": "weekend_lastprice_fallback" if used_weekend_fallback else "strict_bid_ask_30pct",
                "dte_max_days": 45,
            },
            "gamma_hysteresis": {
                "band_pct": round(band_pct * 100.0, 2),
                "lower_band_qqq": round(lower_band_qqq, 2),
                "upper_band_qqq": round(upper_band_qqq, 2),
                "lower_band_ndx": lower_band_ndx,
                "upper_band_ndx": upper_band_ndx,
                "dist_to_flip_pct": dist_to_flip_pct,
                "held_30m_below": held_30m_below,
                "held_30m_above": held_30m_above,
                "gamma_state": gamma_state,
            },
            "assumption_note": (
                "注：已过滤 OI<100、Bid=0、买卖点差>30% 及 IV异常(≤0%或>300%)脏合约，仅取 0–45 DTE 近月加权解算；"
                "GEX 基于公开未平仓量按行业默认头寸假设（做市商净多Call/净空Put）估算，极端单边行情下真实翻转位可能存在漂移。"
            ),
            "qqq_spot": round(qqq_spot, 2),
            "ndx_spot": round(ndx_spot, 2),
            "ndx_qqq_ratio": round(ratio, 4),
            "in_negative_gamma": bool(net_gex_m < 0 or ndx_spot < zero_gamma_ndx),
            "net_gex_m": round(net_gex_m, 2),
            "zero_gamma_qqq": round(zero_gamma_qqq, 2),
            "zero_gamma_ndx": zero_gamma_ndx,
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
                "psych_round_ndx": psych_round_ndx,
                "qqq_equiv_strike": k_psych_qqq,
                "put_oi_near_25000": oi_near_psych,
                "wall_to_25000_oi_ratio": round(major_put_wall_oi / max(oi_near_psych, 1), 1),
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
    quotes_fetched_utc = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    qqq_item = quotes.get("QQQ", {})
    ndx_item = quotes.get("^NDX", {})
    qqq_px = qqq_item.get("price", 638.0)
    ndx_px = ndx_item.get("price", 26215.0)
    rfr = fred["metrics"].get("DGS3MO", {}).get("value", 4.5) / 100.0

    options_micro = collect_options_microstructure(
        qqq_spot=qqq_px,
        ndx_spot=ndx_px,
        risk_free_rate=rfr,
        qqq_recent_30m_closes=qqq_item.get("recent_30m_closes"),
    )
    ai_ledger = collect_ai_capex_ledger()
    cal = compute_settlement_calendar()

    bar_candidates = [
        q.get("last_bar_utc")
        for k, q in quotes.items()
        if k in ("QQQ", "^NDX", "NVDA", "GC=F") and q.get("last_bar_utc")
    ]
    quotes_bar_utc = max(bar_candidates) if bar_candidates else quotes_fetched_utc
    collected_utc = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    elapsed = (datetime.now(timezone.utc) - started_at).total_seconds()

    return {
        "collected_at_utc": collected_utc,
        "elapsed_seconds": round(elapsed, 2),
        "module_timestamps": {
            "quotes_utc": quotes_fetched_utc,
            "quotes_bar_utc": quotes_bar_utc,
            "options_utc": options_micro.get("updated_at_utc") or collected_utc,
            "fred_utc": fred.get("updated_at_utc") or collected_utc,
            "fred_obs_date": fred.get("latest_obs_date"),
        },
        "calendar": cal,
        "fred": fred,
        "quotes": quotes,
        "options": options_micro,
        "ai_ledger": ai_ledger,
    }
