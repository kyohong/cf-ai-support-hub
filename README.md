# Personal Cloud Agent + Multi-Bot Customer Service Hub

English · [简体中文](./README.zh-CN.md)

A **$0-forever** AI platform that runs entirely on Cloudflare's free tier: a personal agent with
long-term memory and deep research, plus a multi-tenant customer-service hub that embeds into any
website with one `<script>` tag.

Built on top of [Dominik Klesal's `workers-personal-agent`](https://github.com/DomWane/workers-personal-agent)
(MIT), extended with a commercial support layer and a keyless system-level toolchain.

---

## ✨ Highlights

- **$0 free tier** — Workers + Durable Objects (SQLite) + D1 + R2 + Workers AI. No servers, no
  vector database, no monthly bill.
- **Single-D1 multi-tenant hub** — every support bot is a row in one D1 database, isolated by
  `bot_id`. Dozens of sites share one database instead of burning through the 10-database limit.
- **Shadow DOM widget** — one `<script data-bot-id="...">` embeds a themed chat bubble on Shopify,
  WordPress or any hand-written HTML with zero CSS conflicts.
- **Lightweight RAG per bot** — FAQ/manual entries are scored against the visitor's message
  (`≤15` entries load in full, otherwise top-5 keyword match) and injected as a
  `[Company Knowledge Base]` block.
- **One-click teach** — every visitor question in the dashboard has a "Turn into FAQ" button that
  pre-fills a knowledge entry.
- **Automatic lead capture** — the model's only write tool is `capture_customer_lead`; captured
  contacts land in `bot_leads` and are pushed to Feishu / Telegram / any JSON webhook.
- **Zero-key system toolbox** — Jina Reader, multi-tier keyless search (DuckDuckGo → Wikipedia →
  HackerNews), Frankfurter FX rates, Piston Python sandbox, QuickChart images, Open-Meteo weather,
  IANA timezones and QR codes. Search quality upgrades automatically when you add optional
  Tavily/Brave keys.
- **Hot-swappable LLM** — free Workers AI by default (no API key at all), or any OpenAI-compatible
  endpoint with streaming + tool calling.
- **Persona + tooling controls** — edit a SOUL prompt, and an intent gate keeps "hi" from firing
  web searches or memory writes.
- **Fully responsive UI** — Bento dashboard, collapsible stats, mobile drawers, light/dark themes,
  complete Chinese/English interface.
- **R2 long-term memory** — markdown vault with compaction, skills the agent writes for itself, and
  nightly reconciliation.

## 🧱 Architecture

```
Browser ── WebSocket ── Durable Object (PersonalAgent) ── Workers AI / OpenAI-compatible API
   │                          │        │
   │                          │        └── R2 vault (memory, skills, threads, settings)
   │                          └── Alarms (briefings, reminders, nightly reflection)
   │
Public widget ── /api/widget/* ── D1 (bots, knowledge, conversations, leads)
```

`/api/widget/*` is the only public surface: it authenticates callers by per-bot origin allow-list
instead of a login session, and mounts exactly the safe subset of tools (lead capture, page reader,
FX, world time, QR).

## 🚀 Quick start (about 5 minutes)

```bash
# 1. Clone
git clone https://github.com/<you>/workers-personal-agent.git
cd workers-personal-agent

# 2. Local config (wrangler.jsonc is gitignored)
cp wrangler.example.jsonc wrangler.jsonc
npm install

# 3. Log in
npx wrangler login

# 4. Create the two storage resources, then paste the ids into wrangler.jsonc
npx wrangler d1 create personal-agent-db     # copy database_id into d1_databases
npx wrangler r2 bucket create personal-agent-vault

# 5. One-command setup + deploy
npm run easy-setup
```

`npm run easy-setup` checks login, creates the R2 bucket, optionally stores LLM / webhook secrets,
builds the client and deploys. Prefer doing it by hand?

```bash
npm run build
npx wrangler deploy
```

Tables are created automatically on the first request — there is no migration step.

### Optional secrets

| Secret | Purpose |
| --- | --- |
| `LLM_API_KEY` | Only for a custom OpenAI-compatible endpoint (`LLM_BASE_URL` var) |
| `FEISHU_WEBHOOK_URL` / `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` | Briefing and lead notifications |
| `TAVILY_API_KEY` / `BRAVE_API_KEY` | Search upgrades (also settable in the UI) |

Everything above is optional: the default build runs on Workers AI through the `AI` binding with
**no keys at all**.

## 🔒 Cloudflare Zero Trust (Access) — read this before sharing the URL

The dashboard must be private; the widget must be public **on the same hostname**. Do both:

1. **Protect the app**: Zero Trust → Access → Applications → Add → Self-hosted → your Worker
   hostname → policy `allow` your email (One-time PIN needs no identity provider).
2. **Bypass the widget paths**: in the same application add a policy with action **Bypass** and
   include rules:
   - `Path` **starts with** `/api/widget/`
   - `Path` **is** `/widget.js`

Without step 2 visitors get a 302 to the Access login page and the embedded chat never loads.
Verify:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://your-agent.your-subdomain.workers.dev/widget.js
# expect 200 (not 302)
```

## 💬 Embedding the widget

1. Open the dashboard → 🤖 **Customer Service Hub** → **New bot**.
2. Fill in name, allowed origins (`https://example.com,https://www.example.com`), SOUL persona,
   daily message cap and optional lead webhook.
3. Add a few FAQ entries (or paste them in bulk, one blank line per entry).
4. Copy the snippet from **Basics & embed**:

```html
<script src="https://your-agent.your-subdomain.workers.dev/widget.js" data-bot-id="bot_example" defer></script>
```

Optional overrides: `data-title`, `data-greeting`, `data-color`, `data-api`.

## 🧰 Built-in free tools

| Tool | Source | Notes |
| --- | --- | --- |
| `read_webpage` | r.jina.ai | Any public page as clean Markdown, SSRF-filtered |
| `web_search` | Tavily → Brave → DuckDuckGo → Wikipedia → HackerNews | Never throws; keyless by default |
| `get_exchange_rate` | frankfurter.app (ECB) | Live FX conversion |
| `run_python_calc` | Piston | Python 3.10 for exact math; **never exposed publicly** |
| `generate_chart` | QuickChart | Chart.js JSON → Markdown image |
| `fetch_tech_news` | HackerNews | Top AI/tech headlines for the daily briefing |
| `get_weather` | Open-Meteo | Current weather + 3-day forecast |
| `get_world_time` | V8 `Intl` | Accurate IANA timezone times |
| `generate_qr_code` | qrserver.com | Contact QR codes |

## 🛠 Development

```bash
npm run dev          # Worker + client (wrangler dev)
npm run dev:web      # Vite hot reload, proxying /agents and /api
npm run test         # agent test suite (Workers pool)
npm run check        # tsc for src/ + test/
npm run check:web    # vue-tsc for web/
npm run lint         # oxlint, warnings denied
npm run build        # client bundle into ./public
```

## 🙏 Upstream credits

This project is a fork of **[workers-personal-agent](https://github.com/DomWane/workers-personal-agent)**
by **Dominik Klesal**, which provides the personal-agent engine: Durable Object conversation loop,
R2 markdown memory, compaction, deep-research fan-out and the MCP bridge. Huge thanks for the
careful architecture and the MIT license that made this extension possible.

Additions in this fork: the D1 multi-tenant customer-service hub, the Shadow DOM widget, lead
capture and webhook delivery, the zero-key toolchain, intent gating, the hardened Workers AI
adapter and the bilingual UI.

## 📄 License

MIT — see [LICENSE](./LICENSE). Original copyright © 2026 Dominik Klesal; fork additions
© 2026 Kyohong.
