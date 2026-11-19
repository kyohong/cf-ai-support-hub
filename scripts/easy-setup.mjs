#!/usr/bin/env node
// ponytail: Node 原生模块实现（readline/promises, child_process, node:fs），零第三方依赖，
// 跨平台（macOS / Windows / Linux）。复杂度上限：一个向导函数 + 一个 run() 封装。
import { createInterface } from 'node:readline/promises'
import { execSync, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url)) // scripts/
const PROJECT = dirname(ROOT)

const CYAN = (s) => `\x1b[36m${s}\x1b[0m`
const GREEN = (s) => `\x1b[32m${s}\x1b[0m`
const YELLOW = (s) => `\x1b[33m${s}\x1b[0m`
const RED = (s) => `\x1b[31m${s}\x1b[0m`
const BOLD = (s) => `\x1b[1m${s}\x1b[0m`

const rl = createInterface({ input: process.stdin, output: process.stdout })

async function ask(question, fallback = '') {
  const answer = (await rl.question(`${question}${fallback ? CYAN(`（直接回车 = ${fallback}）`) : ''}: `)).trim()
  return answer || fallback
}

/** 运行一个命令并实时透传输出；返回退出码。 */
function run(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', cwd: PROJECT })
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

/** 运行命令并捕获 stdout（不透传）。失败返回 null。 */
function capture(cmd, args) {
  try {
    return execSync(`${cmd} ${args.join(' ')}`, { cwd: PROJECT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

async function runInteractive(cmd, args) {
  // 登录类命令必须继承 stdin 才能交互；直接透传即可。
  return run(cmd, args)
}

// ———— 第 1 步：登录检测 ————
async function ensureLogin() {
  const whoami = capture('npx', ['-y', 'wrangler', 'whoami'])
  const loggedIn = whoami && !/not authenticated|You are not authenticated|Please.*login/i.test(whoami)
  if (loggedIn && /logged in with|Account ID|@/.test(whoami)) {
    const accountLine = whoami.split('\n').find((l) => /Account|账户/i.test(l))?.trim()
    console.log(GREEN(`✔ 已登录 Cloudflare ${accountLine ? `（${accountLine}）` : ''}`))
    return
  }
  console.log(YELLOW('检测到尚未登录 Cloudflare。现在会打开浏览器进行授权登录…'))
  const code = await runInteractive('npx', ['-y', 'wrangler', 'login'])
  if (code !== 0) {
    console.log(RED('✘ 登录未完成。请重新运行 npm run easy-setup。'))
    process.exit(1)
  }
  console.log(GREEN('✔ 登录成功'))
}

// ———— 第 2 步：R2 存储桶初始化 ————
function parseBucketName() {
  for (const file of ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml']) {
    const path = join(PROJECT, file)
    if (!existsSync(path)) {
      continue
    }
    const text = readFileSync(path, 'utf8')
    const m = text.match(/"bucket_name"\s*:\s*"([^"]+)"/) || text.match(/bucket_name\s*=\s*"([^"]+)"/)
    if (m) {
      return m[1]
    }
  }
  return null
}

async function ensureR2Bucket() {
  const bucket = parseBucketName()
  if (!bucket) {
    console.log(YELLOW('⚠ 配置里没有 r2_buckets.bucket_name，跳过存储桶初始化。'))
    return
  }
  const listed = capture('npx', ['-y', 'wrangler', 'r2', 'bucket', 'list']) ?? ''
  if (listed.includes(bucket)) {
    console.log(GREEN(`✔ R2 存储桶 ${bucket} 已存在`))
    return
  }
  console.log(`未找到存储桶 ${bucket}，尝试创建…`)
  for (let attempt = 1; attempt <= 3; attempt++) {
    const code = await run('npx', ['-y', 'wrangler', 'r2', 'bucket', 'create', bucket])
    if (code === 0) {
      console.log(GREEN(`✔ R2 存储桶 ${bucket} 创建成功`))
      return
    }
    console.log(RED(`✘ 创建失败（第 ${attempt} 次）。`))
    console.log(
      YELLOW(
        [
          '如果你的 Cloudflare 账号还没有开通 R2 服务：',
          '  1. 打开 https://dash.cloudflare.com → 左侧「R2 对象存储」',
          '  2. 点击「购买 R2 Plan」→ 选择 Free（免费，10GB 存储 + 每月 100 万次读）',
          '  3. 开通后回到这里，按回车重试。',
        ].join('\n'),
      ),
    )
    const answer = await ask('已完成 R2 开通并想重试，请按回车（输入 skip 可跳过）', '')
    if (answer.toLowerCase() === 'skip') {
      console.log(YELLOW(`已跳过 R2 初始化（后续可手动运行 npx wrangler r2 bucket create ${bucket}）。`))
      return
    }
  }
  console.log(RED('✘ R2 初始化多次失败，先继续后面的步骤；部署前请手动开通 R2。'))
}

// ———— 第 3 步：交互式配置向导 ————
async function putSecret(name, value) {
  const child = spawn('npx', ['-y', 'wrangler', 'secret', 'put', name], {
    cwd: PROJECT,
    stdio: ['pipe', 'inherit', 'inherit'],
    shell: process.platform === 'win32',
  })
  child.stdin.write(value)
  child.stdin.end()
  return new Promise((resolve) => child.on('exit', (code) => resolve(code === 0)))
}

async function configureSecrets() {
  console.log(CYAN('提示：以下配置全部可以直接回车跳过，使用默认的免费 Workers AI 方案。'))

  // 3.1 LLM：默认免费 Workers AI
  console.log(`\n${BOLD('① 大语言模型')}`)
  console.log('默认方案：Cloudflare Workers AI（每天 10,000 Neurons 免费额度，无需任何 Key）。')
  const custom = await ask('是否使用自定义 OpenAI 兼容接口？（y=自定义，直接回车=用免费默认）', '')
  if (custom.toLowerCase() === 'y') {
    const baseUrl = await ask('LLM_BASE_URL（例如 https://api.openai.com/v1）')
    const apiKey = await ask('LLM_API_KEY')
    const model = await ask('LLM_MODEL', 'gpt-4o-mini')
    if (baseUrl) {
      if (await putSecret('LLM_BASE_URL', baseUrl)) {
        console.log(GREEN('✔ LLM_BASE_URL 已写入'))
      }
    }
    if (apiKey) {
      if (await putSecret('LLM_API_KEY', apiKey)) {
        console.log(GREEN('✔ LLM_API_KEY 已写入'))
      }
    }
    if (model) {
      if (await putSecret('LLM_MODEL', model)) {
        console.log(GREEN('✔ LLM_MODEL 已写入'))
      }
    }
  } else {
    console.log(GREEN('✔ 使用默认免费 Workers AI（无需配置）'))
  }

  // 3.2 推送渠道（可选）
  console.log(`\n${BOLD('② 每日早报推送渠道（可选，直接回车跳过）')}`)
  const feishu = await ask('飞书机器人 Webhook URL', '')
  if (feishu) {
    if (await putSecret('FEISHU_WEBHOOK_URL', feishu)) {
      console.log(GREEN('✔ FEISHU_WEBHOOK_URL 已写入'))
    }
  }
  const tgToken = await ask('Telegram Bot Token', '')
  if (tgToken) {
    const tgChat = await ask('Telegram Chat ID')
    if (await putSecret('TELEGRAM_BOT_TOKEN', tgToken)) {
      console.log(GREEN('✔ TELEGRAM_BOT_TOKEN 已写入'))
    }
    if (tgChat) {
      if (await putSecret('TELEGRAM_CHAT_ID', tgChat)) {
        console.log(GREEN('✔ TELEGRAM_CHAT_ID 已写入'))
      }
    }
  }
  if (!feishu && !tgToken) {
    console.log(YELLOW('已跳过推送配置（之后也可以在网页的「设置 → 每日早报」里配置）。'))
  }
}

// ———— 第 4 步：构建与部署 ————
async function buildAndDeploy() {
  console.log(CYAN('\n正在构建前端…'))
  const pm = existsSync(join(PROJECT, 'pnpm-lock.yaml')) && commandExists('pnpm') ? 'pnpm' : 'npm'
  const buildCode = await run(pm, ['run', 'build'])
  if (buildCode !== 0) {
    console.log(RED('✘ 构建失败，中止部署。'))
    process.exit(1)
  }

  console.log(CYAN('\n正在部署到 Cloudflare Workers…'))
  const deploy = capture('npx', ['-y', 'wrangler', 'deploy'])
  if (deploy === null) {
    // capture 不透传交互输出，失败时退回透传模式再跑一次。
    const code = await run('npx', ['-y', 'wrangler', 'deploy'])
    if (code !== 0) {
      console.log(RED('✘ 部署失败，请把上面的报错复制出来排查。'))
      process.exit(1)
    }
    printFooter('https://personal-agent.<你的子域>.workers.dev（见上方输出）')
    return
  }
  const url = deploy.match(/https:\/\/[a-z0-9-]+\.workers\.dev/i)?.[0] ?? ''
  printFooter(url)
}

function commandExists(cmd) {
  try {
    execSync(cmd === 'pnpm' ? 'pnpm --version' : `${cmd} --version`, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function printFooter(url) {
  console.log(`\n${BOLD(GREEN('🎉 部署完成！'))}`)
  if (url) {
    console.log(`\n  ${BOLD('访问地址:')} ${CYAN(url)}`)
  }
  console.log(
    [
      '',
      BOLD('🔒 建议开启邮箱登录保护（Cloudflare Zero Trust Access，免费）：'),
      '  1. 打开 https://dash.cloudflare.com → Zero Trust → Access → Applications → Add an application',
      '  2. 选「Self-hosted」，域名填这个 Worker 的访问地址（*.workers.dev）',
      '  3. 策略里添加你的邮箱（登录方式选 One-time PIN，无需配置身份源）',
      '  4. 保存后，只有你的邮箱验证码可以打开这个 Agent。',
      '',
      '后续操作：',
      '  · 每日早报与推送渠道：打开网页 → 设置 → 每日早报 / 消息推送渠道',
      '  · 关联你自己的 GitHub 仓库：git remote add origin git@github.com:<你>/workers-personal-agent.git',
      '',
    ].join('\n'),
  )
}

async function main() {
  console.log(BOLD(CYAN('\n🚀 Workers Personal Agent 一键部署（零服务器成本）\n')))
  console.log('本向导将完成：登录检测 → R2 初始化 → 配置向导 → 构建部署。全程可直接回车使用默认免费方案。\n')
  await ensureLogin()
  await ensureR2Bucket()
  await configureSecrets()
  await buildAndDeploy()
  rl.close()
}

try {
  await main()
} catch (error) {
  console.error(RED(`发生错误: ${String(error)}`))
  rl.close()
  process.exit(1)
}
