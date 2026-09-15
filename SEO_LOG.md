## 2026-09-15 — Rummage 摸金模式

- 新模式 📦 Rummage：封仓储位出价（只给走廊线索，不给物品清单）→ 逐件掏宝 → 偶发 picker 报价（先报价后揭市场价，Sell/Keep）→ 以 P&L 对出价结算
- 不改 daily 5 件猜价 / 排行榜 / Close Call / Battle Royale；纯前端，Worker 无改动
- 日更 rummage 种子 `rummage-YYYY-MM-DD`，localStorage 可中途续挖

## 2026-09-07 — 行为埋点上线（Worker D1 + track）

- PR: https://github.com/Jeromelll/priceguessinggame/pull/1 → merged `c491e7a`
- D1 `pgp-db`: 建表 `events` / `events_rejected`（schema.sql remote execute）
- Worker `pgp-edge` Version ID: `d970c6e2-0d91-46ec-8abf-66f09e9a06e2`（含 `POST /api/evt` + server `page_view`）
- Pages: `https://7dc6ad8d.priceguessinggame.pages.dev`（app.js `track` 挂点）
- 白名单: `page_view` / `game_start` / `game_complete` / `round_abandon` / `share`（无 `score_submit`）
- 冒烟: POST 合法事件→events；未知 `not_a_real_event`→events_rejected `not_in_whitelist`；HTML GET→page_view
- 无 GA4

# SEO_LOG — priceguessinggame.com

> 惯例照 image-to-base64：目标词、决策依据、迭代记录留档。

## 立项依据（2026-09-04）

- **三轮验证闭环**（存档 `~/webcafe/marketing/daily-auction/`）：
  - QA1（哥飞 SEO Agent）：6 词 5 个 KD<40，price guessing game KD 4.6 内容真空；竞品 costcodle/guesstheprice 体验分 6-11/100 → 蓝海早期，"条件可行"
  - QA2：EMD 域名实测可注册；对标 guesstheprice.net（DR26 月访 2.1 万，靠非品牌词吃量）验证小站可行；playauctiongame -48% 为品类稳定性警示
  - QA3（Keyword Planner 官方）：guess the price / guess the prize 官方 5,000 档、YoY +900%、Low 竞争、organic share 0 → 判据过关，开
- **域名**：priceguessinggame.com，2026-09-04 Cloudflare Registrar API 注册，$10.46/年，auto_renew 开

## 目标词矩阵

| 词 | 官方月搜档 | 角色 |
|---|---|---|
| guess the price | 5,000（+900% YoY） | 主战词，首页 H1/Title/正文覆盖 |
| guess the prize | 5,000（+900% YoY） | 首页正文自然带出 |
| price guessing game | 待补查 | EMD 域名本体，Title 首位 |
| guess the price game | 500 | H2/FAQ 覆盖 |
| auction game | 500（CPC $0.83–4.15） | 首页"auction"语义 + 后续独立内页候选 |
| bid game / bidding games online | 500/50（CPC 高位 $17.19） | 变现锚点参考 |

## 页面策略（MVP v1）

- 单页：游戏本体 + How to Play + FAQ（JSON-LD FAQPage + WebApplication）
- 每日题目确定性（日期种子），`?d=YYYY-MM-DD` 存档模式预留
- 纯静态零依赖零外部请求（LCP 最优），系统字体栈，无 JS 框架
- 待办候选：多语言（哥飞防老第 6 步）、auction game 独立内页、每日新主题内容页对冲品类下行（QA2 待办 3）、AdSense（新域名先养原创再申）
