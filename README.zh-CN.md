# 个人云端管家 + 多站点客服中心

[English](./README.md) · 简体中文

一个**永久 $0** 的 AI 平台，完全跑在 Cloudflare 免费层上：既有带长期记忆与深度调研的个人 Agent，
也有用一行 `<script>` 就能嵌入任意网站的多租户客服中心。

本项目基于 [Dominik Klesal 的 `workers-personal-agent`](https://github.com/DomWane/workers-personal-agent)
（MIT 协议）扩展而来，新增了商业客服层与零 Key 系统级工具链。

---

## ✨ 核心亮点

- **$0 免费层** —— Workers + Durable Objects（SQLite）+ D1 + R2 + Workers AI，无需服务器、无需向量数据库、没有月账单。
- **单 D1 多租户** —— 每个子客服只是同一张 D1 表里的一行，用 `bot_id` 严格逻辑隔离；几十个站点共用一个库，突破 D1 每账号 10 个数据库的限制。
- **Shadow DOM 挂件** —— 一行 `<script data-bot-id="...">` 即可给 Shopify、WordPress 或手写 HTML 站点挂上有主题色的聊天气泡，零 CSS 冲突。
- **轻量知识库 RAG** —— FAQ/手册条目按访客消息打分（≤15 条全量注入，否则关键词 Top 5），拼成 `[Company Knowledge Base]` 注入系统提示词。
- **一键学习** —— 后台每条访客提问旁都有「转为知识条目」按钮，点击即把问题预填进知识库表单。
- **自动线索捕获** —— 模型唯一的写工具是 `capture_customer_lead`；联系方式落入 `bot_leads`，并推送到飞书 / Telegram / 任意 JSON Webhook。
- **零 Key 工具链** —— Jina Reader 网页读取、多级容灾免 Key 搜索（DuckDuckGo → Wikipedia → HackerNews）、Frankfurter 实时汇率、Piston Python 沙箱、QuickChart 图表、Open-Meteo 天气、IANA 时区与二维码；填入可选 Tavily/Brave Key 后搜索质量自动升级。
- **模型热插拔** —— 默认免费 Workers AI（完全不需要 Key），也可切换任意 OpenAI 兼容接口（流式 + 工具调用）。
- **人格与工具控制** —— 可在线编辑 SOUL 人格；意图门控确保一句「你好」不会触发联网搜索或记忆写入。
- **全端响应式界面** —— Bento 看板、可折叠状态卡、移动端抽屉、明暗主题、完整中英双语。
- **R2 长期记忆** —— Markdown 记忆库、自动压缩、Agent 自己沉淀的技能、夜间自动整理。

## 🧱 架构

```
浏览器 ── WebSocket ── Durable Object（PersonalAgent）── Workers AI / OpenAI 兼容接口
   │                       │        │
   │                       │        └── R2 记忆库（记忆、技能、会话、设置）
   │                       └── Alarms（早报、提醒、夜间复盘）
   │
公开挂件 ── /api/widget/* ── D1（bots、知识库、访客对话、线索）
```

`/api/widget/*` 是唯一的公开面：它不用登录态，而是按每个子客服配置的域名白名单鉴权，
并且只挂载安全子集的工具（留资、读网页、汇率、时区、二维码）。

## 🚀 保姆级快速开始（约 5 分钟）

```bash
# 1. 克隆
git clone https://github.com/<you>/workers-personal-agent.git
cd workers-personal-agent

# 2. 本地配置（wrangler.jsonc 已被 gitignore）
cp wrangler.example.jsonc wrangler.jsonc
npm install

# 3. 登录
npx wrangler login

# 4. 创建两个存储资源，并把 id 填回 wrangler.jsonc
npx wrangler d1 create personal-agent-db     # 把 database_id 粘贴进 d1_databases
npx wrangler r2 bucket create personal-agent-vault

# 5. 一键配置并部署
npm run easy-setup
```

`npm run easy-setup` 会自动检测登录、创建 R2 桶、可选写入 LLM / Webhook Secrets、构建前端并部署。
想手动来也可以：

```bash
npm run build
npx wrangler deploy
```

数据表会在首次请求时自动创建，没有额外的迁移命令。

### 可选 Secrets

| Secret | 用途 |
| --- | --- |
| `LLM_API_KEY` | 仅在使用自定义 OpenAI 兼容接口（`LLM_BASE_URL` var）时需要 |
| `FEISHU_WEBHOOK_URL` / `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | 早报与线索推送 |
| `TAVILY_API_KEY` / `BRAVE_API_KEY` | 搜索增强（也可直接在界面里填） |

以上全部可选：默认路径通过 `AI` 绑定调用 Workers AI，**零 Key 即可运行**。

## 🔒 Cloudflare Zero Trust（Access）避坑指南

主控后台必须私密，挂件必须在**同一个域名**上公开。两步都要做：

1. **保护主站**：Zero Trust → Access → Applications → Add → Self-hosted → 填入你的 Worker 域名 →
   建一条 `allow` 你的邮箱的策略（One-time PIN 无需任何身份源）。
2. **为挂件路径放行**：在同一个 Application 里新增一条动作为 **Bypass** 的策略，Include 规则：
   - `Path` **starts with** `/api/widget/`
   - `Path` **is** `/widget.js`

只做第 1 步不做第 2 步，访客会拿到 302 跳登录页，嵌入的聊天永远加载不出来。验证：

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://your-agent.your-subdomain.workers.dev/widget.js
# 期望 200（而不是 302）
```

## 💬 嵌入客服挂件

1. 打开后台 → 🤖 **客服中心** → **新建子客服**。
2. 填写名称、域名白名单（`https://example.com,https://www.example.com`）、SOUL 人设、
   每日消息上限与可选的线索 Webhook。
3. 添加几条 FAQ（也可批量粘贴，条目之间空一行）。
4. 在「基础与接入」底部复制嵌入代码：

```html
<script src="https://your-agent.your-subdomain.workers.dev/widget.js" data-bot-id="bot_example" defer></script>
```

可选覆盖：`data-title`、`data-greeting`、`data-color`、`data-api`。

## 🧰 内置免费工具

| 工具 | 数据源 | 说明 |
| --- | --- | --- |
| `read_webpage` | r.jina.ai | 任意公开网页转干净 Markdown，带 SSRF 过滤 |
| `web_search` | Tavily → Brave → DuckDuckGo → Wikipedia → HackerNews | 永不抛异常；默认零 Key |
| `get_exchange_rate` | frankfurter.app（欧洲央行） | 实时汇率换算 |
| `run_python_calc` | Piston | Python 3.10 精确计算；**绝不暴露给公网** |
| `generate_chart` | QuickChart | Chart.js JSON → Markdown 图片 |
| `fetch_tech_news` | HackerNews | 每日早报的科技头条 |
| `get_weather` | Open-Meteo | 实时天气 + 未来 3 天 |
| `get_world_time` | V8 `Intl` | 任意 IANA 时区的精确时间 |
| `generate_qr_code` | qrserver.com | 联系二维码 |

## 🛠 开发命令

```bash
npm run dev          # Worker + 前端（wrangler dev）
npm run dev:web      # Vite 热更新，代理 /agents 与 /api
npm run test         # Agent 测试套件（Workers pool）
npm run check        # tsc（src/ + test/）
npm run check:web    # vue-tsc（web/）
npm run lint         # oxlint，警告即失败
npm run build        # 前端打包到 ./public
```

## 🙏 开源致谢

本项目 fork 自 **[workers-personal-agent](https://github.com/DomWane/workers-personal-agent)**，
作者 **Dominik Klesal**。上游提供了整个个人 Agent 引擎：Durable Object 对话循环、R2 Markdown
长期记忆、上下文压缩、扇出并发深度调研以及 MCP 桥接。感谢其严谨的架构设计与 MIT 协议，让本次扩展成为可能。

本 fork 的新增部分：D1 多租户客服中心、Shadow DOM 挂件、线索捕获与 Webhook 推送、零 Key 工具链、
意图门控、加固版 Workers AI 适配层以及双语界面。

## 📄 许可证

MIT —— 详见 [LICENSE](./LICENSE)。原始版权 © 2026 Dominik Klesal；fork 新增部分 © 2026 Kyohong。
