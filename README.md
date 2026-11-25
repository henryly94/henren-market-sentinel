# 狠人框架 · 全球市场风向与微结构智能巡检台 (`henren-market-sentinel`)

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/henryly94/henren-market-sentinel)

基于 YouTube 频道 **「一个狠人」（`@henren778`）** 近两个月核心市场视频提炼的 **五层投研框架** 构建的真实市场数据智能巡检、量化打分与手机端 PWA 综合看板。

- **手机端 / 桌面端云端访问地址（GitHub Pages 24/7 在线）**：
  **https://henryly94.github.io/henren-market-sentinel/**
  *(在 iPhone Safari 或 Android Chrome 打开后，点击「分享 → 添加到主屏幕」即可安装为独立全屏 App)*

---

## 一、三位一体智能抓取机制（周期 + 关键节点 + 主动访问）

系统通过 `sentinel/scheduler.py`、`server.py` 与 `.github/workflows/market-sentinel.yml` 协同实现三种触发逻辑：

1. **常规周期巡检 (Periodic Baseline)**
   - 美股常规交易时段（`09:30–16:15 ET`）每 `45` 分钟、盘前盘后每 `60` 分钟、亚欧盘夜间（跟踪黄金/离岸汇率）每 `2–3` 小时、周末每 `6` 小时自动抓取。
2. **关键市场窗口自动加密 (Critical Market Windows)**
   - **美元水管放榜狙击**：美东 `08:05 ET`（SOFR 隔夜回购利率公布）、`13:20 ET`（ON RRP 逆回购结果公布）、`17:15 ET`（FRED 每日 `CCC` 垃圾债利差与 `TIPS` 实际利率更新）及每周四 `16:35 ET`（美联储 H.4.1 资产负债表发布）。
   - **负 Gamma 脉冲窗口**：美股开盘（`09:30–10:15 ET`）与尾盘 MOC / 0DTE 结算（`15:30–16:10 ET`）做市商集中对冲时段自动提速至 `10` 分钟级。
   - **结算大考与宏观大日子**：每月最后 `5` 个交易日（如 `11/30`、`12/31` 回购缩表大考）、月度四巫日期权交割周及 `FOMC` 议息窗口自动切入高频警戒模式。
3. **主动访问新鲜度校验 (On-Visit Stale-While-Revalidate)**
   - 每次从手机或电脑打开/唤醒页面时，前端先毫秒级渲染本地最新快照（零白屏等待），同时自动调用 `POST /api/visit`（或绕过缓存同步云端最新 JSON）。若数据年龄超过当前时段保鲜阈值（关键窗口 `3` 分钟 / 盘中 `5–7` 分钟），后台立即静默拉取最新 FRED + 期权链数据并无感刷新界面。

---

## 二、五层核心监测模块

1. **美元水管与结算节点**：`SOFR - IORB` 走廊利差、`ON RRP` 余额、`TGA` 账户、银行准备金与 52 周美元净流动性 (`WALCL - TGA - RRP`)。
2. **资金成本与信用分层**：`CCC` 级垃圾债有效收益率、`CCC / HY / IG` 信用撕裂比、`10Y TIPS` 实际利率，自动判别「钱没了」vs「不是钱没了，是钱贵了」。
3. **期权 Gamma 微结构与纳指防线**：聚合近期、月末与四巫日 `QQQ` 期权链计算做市商 Net GEX、正负 Gamma 翻转位与下方最厚 Put Wall，内置交互式点位推演沙盘。
4. **AI 算力账本审计**：自动核算 `MSFT / AMZN / GOOGL / META / ORCL` 最新季报 `OCF vs CapEx vs FCF`，监控 `NVDA / AVGO / CRWV / ANT ($83 IPO)` 分层表现。
5. **黄金「打折期」与中国/亚太外溢**：识别对冲基金补保证金引发的「康波钱荒洗金」窗口，同步跟踪 `USD/CNH`、`FXI / KWEB`、`^KS11` 与铜金比。

---

## 三、部署与运行方式

### 方式 A：零成本即刻手机访问（GitHub Pages + GitHub Actions，已内置启用）
- 仓库推送后，`.github/workflows/market-sentinel.yml` 会按上述关键时间点自动抓取真实数据并发布至 `https://henryly94.github.io/henren-market-sentinel/`。
- 你也可以随时在手机 **GitHub App → Actions → Market Sentinel → Run workflow** 手动触发一次云端重算。

### 方式 B：一键升级 24/7 实时 Python 后端（支持打开网页 7 秒实时重算）
- 点击顶部 **Deploy to Render** 按钮（或将本仓库接入 Railway / Zeabur / Fly.io），平台会自动读取 `render.yaml` 与 `Dockerfile` 启动常驻 `server.py`。
- 部署完成后，你既可以直接在手机访问该云端 URL，也可以在 GitHub Pages 看板右上角「云端 / 手机设置」中填入该后端地址。

### 方式 C：自有云服务器 / NAS Docker 一键自托管
```bash
git clone https://github.com/henryly94/henren-market-sentinel.git
cd henren-market-sentinel
docker compose up -d --build
```
