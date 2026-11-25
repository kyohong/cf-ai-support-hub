# Personal Agent

A personal agent on Cloudflare Workers, reachable from a web chat. A Durable Object holds one
conversation and runs a tool loop against an OpenAI-compatible API; long-term memory is markdown in
R2; `evals/` is a separate Python harness for measuring it.

**[ARCHITECTURE.md](ARCHITECTURE.md) is the map**: the platform limits and which of them were
measured, every ceiling this agent runs into and whether it fails loudly, the invariants that caused
outages when broken, the vault layout, and what a deploy cannot provision. Read it before changing
anything under `src/`. The reasoning per subsystem is in `docs/decisions/`, indexed there.

## Commands

```bash
pnpm test          # agent tests — Workers pool, excludes evals/
pnpm check         # tsc --noEmit for src/ and test/
pnpm check:web     # vue-tsc for web/ — a separate tsconfig, not covered by pnpm check
pnpm lint          # oxlint, --deny-warnings — reads .vue script blocks too
pnpm format        # oxfmt in place; format:check is the read-only form
pnpm build:web     # vite build web → ./public (gitignored; wrangler serves it)
pnpm dev           # wrangler dev — needs `cloudflared` once Access is on the account, see below
pnpm dev:web       # vite with hot reload, proxying /agents and /api to :8787
pnpm run deploy    # wrangler deploy — User runs this, not the agent; bare `pnpm deploy` is pnpm's builtin
```

`./public` is build output and gitignored. `wrangler.jsonc` names `pnpm build:web` as the custom
build, so `pnpm dev` and `pnpm run deploy` both produce it; run it by hand only outside wrangler.

**`pnpm dev` needs `cloudflared` and a terminal once Cloudflare Access is on the account**
(2026-08-23). The `ai` binding has no local simulator, so dev opens a remote proxy session against
the deployed Worker, which Access gates. `brew install cloudflared` once, and then wrangler sends
you to the Access login.

**It must be interactive.** Piping dev through `tee`
is enough to make it non-interactive, and it then fails with *"no Access Service Token credentials
were found and the current environment is non-interactive"*, which reads as a credentials problem
and is a TTY problem. `script -q /tmp/dev.log pnpm dev` keeps both. For a genuinely non-interactive
run, an Access **service token** in `CLOUDFLARE_ACCESS_CLIENT_ID` / `CLOUDFLARE_ACCESS_CLIENT_SECRET`
is the supported path.

`pnpm test` and `uv run pytest` (in `evals/`) are **two different suites and neither runs the
other's tests**. Running only one does not make the suite green.

**Lint and format decisions live in [docs/decisions/linting-and-formatting.md](docs/decisions/linting-and-formatting.md)**:
which rules are on, which were counted and refused, and why type-aware linting does *not* need the
TypeScript 7 upgrade that would break `vue-tsc`. `pnpm lint` runs type-aware rules with no extra
flag.

`evals/` is a Python project and none of the pnpm commands touch it. From that directory: `uv sync`,
then `uv run pytest`, `uv run ruff check`, `uv run ruff format`, `uv run pyright`; the scripts are
listed in [evals/README.md](evals/README.md). Anything under `evals/` may read files, the
environment and the network; anything under `src/` may not.

## Tests

The agent suite runs in `@cloudflare/vitest-pool-workers` with isolated storage. Two traps:

- **`fs` and `process` do not exist in the Workers pool.** That is why `evals/` has its own config.
- **An alarm scheduled by a test can fire after teardown**, producing
  `Isolated storage failed ... Application called abortAllDurableObjects()`. If a test causes code
  to `schedule()`, assert the schedule exists, cancel it, and invoke the callback directly rather
  than waiting for it.

Outbound HTTP is intercepted with `fetchMock`; `assertNoPendingInterceptors()` catches mocks that
stopped matching after a change. When a change alters call *counts*, for example an index
reconcile that now reads fewer files, the interceptor counts must be updated, not the assertion
removed.

The vault is **not** mocked over HTTP. Miniflare simulates R2 locally, so tests seed the real
binding through [test/helpers/vault.ts](test/helpers/vault.ts) and assert on what the bucket
holds. A file that is simply absent is the not-found case and needs no setup at all.

Bindings are pinned in `vitest.config.ts` (`LLM_BASE_URL`, `LOG_CONTENT: ''`) so the suite never
depends on the real values in `wrangler.jsonc`. `LOG_CONTENT` is why: the deployment opts in, so an
inherited binding turns content logging on under a test that asserts it is off.

Three more:

- **`SELF.fetch` cannot see a mutated `env`.** The pool hands the test a copy, so a test that needs
  a different binding (the Cloudflare provider branch, where `LLM_BASE_URL` is *absent* while the
  suite pins it) must call `worker.fetch(request, {...env, LLM_BASE_URL: undefined}, ctx)` directly.
- **The Cache API outlives a test's mocks**: one test's payload answers the next test's request.
  `/api/models` does not cache, because a cached catalogue also outlives a change of
  `LLM_BASE_URL`. Varying the URL per test was rejected: test scaffolding does not belong in a URL
  contract.
- **A fake standing in for the seam under test empties the test silently.** A scout test that hands
  the loop a `Map` for its archive never executes the code that builds the real one,
  `sqlTag(this.ctx.storage.sql)` inside a class declared under `new_sqlite_classes`, and its failure
  mode is quiet (`archive-failed`, findings still returned, the pruner mute for the run).
  `runInDurableObject` on the real namespace is what covers it. Note that a Durable Object doing I/O in `blockConcurrencyWhile` (the subrequest-plan lookup)
  throws under `disableNetConnect`, is caught, and logs `assumed: 50`; that is the expected shape,
  not a broken test.

`emit` is where a reply becomes visible, so a test that wants the text without asserting on the
thread spies on it and **calls through**; `test/unit/research-commands.test.ts` does. Replacing it
would take the history with it, and half those tests assert on what a run did as well as on what it
said.

**Every new guard gets a mutation check**: the test names what to break in the code and fails when
it is broken.

## Evals

`evals/lib/` holds pure functions with no I/O so they are unit-testable against literal fixtures;
the runners (`run_retrieval.py`, `turn_table.py`, and the `embed/`, `label/`, `gen/`, `models/`,
`ingest/` modules) do the I/O behind `if __name__ == '__main__'`, so importing one never fires a
paid call. Tests are colocated (`foo.py` next to `test_foo.py`), pyright runs strict, and every
function is annotated. Write-ups go in `evals/results/*.md`.

**`evals/data/` is gitignored and the corpus is never committed, shared, or quoted.** It contains
673 Claude Code exchanges from real work. What is tracked is the half of the harness that *scores* a
corpus; the step that builds one from local transcripts lives under `internal/`, outside the
repository, and `Chunk` lives in `evals/lib/corpus.py` so the tracked half stands alone.

## Docs

`docs/` holds only what is meant to be read outside this repo: the two write-ups, the walkthrough,
the screenshot, and `docs/decisions/`. Working material (plans, notes, anything not for a reader)
goes under `internal/`, which is gitignored as a whole; a note that lands in `docs/` is published.

**`docs/decisions/` holds the architecture's reasoning**:
every pointer in `ARCHITECTURE.md` lands there, so it is committed as a whole.

The two write-ups share a house style: a claim or question as the title, numbered sections, and a
section listing what was measured wrong before it was measured right.

`docs/manual-e2e.md` is the walkthrough for the seams no suite covers (the DOM, and the socket between the built client and a
live Worker), and without it the `scripts/stub-llm.mjs` and `--scenario` machinery beside it would
be committed with nothing saying what they are for. It opens with the three bugs found by hand that
no unit test could have failed.

## Style

Behaviour goes in a test with a descriptive name, a measurement in `ARCHITECTURE.md`,
a rejected alternative in `docs/decisions/`.

## Working with me here

- **Non-obvious decisions name the rejected alternative and why.** Not a menu of options with an
  obvious winner: the one that was seriously in play and lost, and what it lost on.
- **Separate verified from inferred.** Claims about production state, deployed code, or platform
  limits cite the command or doc that produced them. "Probably" is fine; a confident tone over an
  unchecked assumption is not.
- **When a measurement comes back empty, suspect the measurement first.** An empty result is
  evidence about the query until proven otherwise.
- **Re-check a document against the principles it states before handing it over.**

---

# 项目交接记忆（继承自 opencode，2026-11-25）

> 由 DeepSeek Harness 从 opencode 历史对话解析写入。详细版：`~/Desktop/opencode-backup/projects/cf-ai-support-hub.md`
> 注：本文件上半段是上游 `DomWane/workers-personal-agent` 的描述，**只覆盖"个人 Agent"那条线**；
> 下面这段补的是本仓库真正的主线——**客服中枢与持久记忆**，它们在上半段和 `ARCHITECTURE.md` 里都没有。

## 这个仓库到底是什么

一个 Worker 同时提供三样东西：

1. **个人 Agent**（上半段讲的那条）：WebSocket 聊天、DO 存会话、R2 存 markdown 长期记忆、深度调研、MCP、每日早报。
2. **多站点客服中枢**：`bots` 是 D1 里的一行，一段 `<script src=".../widget.js" data-bot-id="...">`
   就能给任意外站挂上 Shadow DOM 聊天气泡，每 bot 独立知识库 RAG、留资 webhook、访客对话记录。
3. **类 ChatGPT 持久记忆**（2026-11-22 这条 session 的主体）：每个访客/账号一份跨会话档案，
   自动抽取、去重、上限 50 条，后台与挂件里都能看/改/删。

## 血缘：这是 fork，且有两个下游/兄弟

```
DomWane/workers-personal-agent (MIT 上游)
        ↓
本地 workers-personal-agent（已删除，main=62079d7）
        ├──→ 本仓库 cf-ai-support-hub（开源线，2026-11-18 用孤儿分支脱敏重发布，main=c4627bf）
        └──→ omnibot-saas（商业线，同一棵树切 feat/commercial-saas，VPS + SQLite + 多租户）
```

- **本仓库是孤儿历史**：只有 2 个 commit（`c4627bf` 初始开源 + `fbc1f03` 持久记忆），上游历史被刻意脱敏切断。
- **与 omnibot-saas 是兄弟不是父子**，共享 `src/agent/*`、`src/connectors/*`、`src/tools/builtin-free-tools.ts`、
  `web/src/components/{BotHub,bothub/*}`、`web/public/widget.js`、`web/src/widget-client/*`、`evals/`。
- **`src/widget/{chat,db,router}.ts` 已经分叉**：本仓库 schema 用 `id`/`enabled`，omnibot 用 `bot_id`/`tenant_id`。
  **两边不能互拷表结构**，要移植就得适配这两处差异。
- 本仓库走 Cloudflare 免费层（D1 + R2 + Access + Workers AI），omnibot 走 VPS Docker（Node + better-sqlite3）。

## 记忆层实现（本仓库独有，改之前必读）

- DDL：`migrations/0001-user-memories.sql` → `user_memories(id, bot_id, owner_type('user'|'visitor'), owner_id,
  category, content, source_session_id, is_active, created_at, updated_at)` + 复合索引 `(bot_id, owner_type, owner_id, is_active)`；
  另有 `bots.memory_enabled INTEGER DEFAULT 1`。
- API：`src/widget/router.ts:193` 起 `/api/widget/memories`（GET list / POST add / PATCH /:id / DELETE /:id / DELETE /clear）；
  后台侧 `/api/memories`。
- **三条记忆读取路径各不相同**：`listMemories`（后台） / `listBotMemories`（挂件） / `renderMemoryBlock`（注入提示词）。
  改一处务必确认另外两处的语义，历史上就出过"后台看得见、挂件看不见"的偏差。
- 注入预算 **4000 字符**；抽取走 `ctx.waitUntil`（不阻塞响应）。
- 前台组件：`web/src/components/BotMemory.vue`（后台）、挂件侧在 `web/src/widget-client/`。

## 已知缺口（按优先级）

1. **`ARCHITECTURE.md` 对客服层/记忆层零覆盖**（2026-11-25 精确复核：`widget` / `user_memories` /
   `ensureWidgetSchema` / `listBotMemories` / `renderMemoryBlock` 均 **0 次命中**；337 行只讲个人 Agent 那条线）。
   新接手的人只能靠 README 了解 D1 多租户与记忆，而 D1 读写路径、注入预算、抽取管线恰恰最容易改坏。
   **建议补一节 "Customer-service hub (D1) + user memories"。**
2. **`/api/widget/memories` 没有限流**（chat 有 `countMessagesSince`，记忆接口没有），且 visitorId 未校验 UUID 格式。
3. **记忆只做过本地 `wrangler dev` + stub LLM 验证**，没在真实部署上跑过。
4. **本地起 `wrangler dev` 的坑**：`ai` binding 强制 remote proxy，需要 `cloudflared`（本机未装）。
   解法是把 `wrangler.jsonc` 的 `ai` binding 注释掉，用 `scripts/stub-llm.mjs` + `LLM_BASE_URL` 全本地跑。
   **部署前必须把 AI binding 恢复**（wrangler.jsonc 里留了注释提醒）。
5. `README.md` 里的 clone URL 还指向上游，应改成本仓库。

## 部署事实

- `wrangler.jsonc` 被 `.gitignore` 忽略（含账号级 id），模板是 `wrangler.example.jsonc`。
- 本仓库**未确认有线上实例**。`personal-agent.kyohong670.workers.dev` 目前 302 到 Cloudflare Access，
  但那是上一代（workers-personal-agent）的部署，不能证明本仓库已上线。
- 后台靠 Cloudflare Access（邮箱）保护，挂件 `/api/widget/*` 需在 Access 里配 Bypass。

## 注意：本仓库是 PUBLIC

GitHub 上 `kyohong/cf-ai-support-hub` 是 **public**（它本来就是开源线）。提交前确认不含密钥、账号 id、
真实访客数据。`wrangler.jsonc`、`.env`、`.dev.vars` 都已在 gitignore 里。
