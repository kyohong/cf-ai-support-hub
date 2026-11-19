import { AgentClient } from 'agents/client'
import { LANDING } from './useThreads'

const HANDSHAKE_MS = 5_000
const CALL_MS = 90_000

let client: AgentClient<unknown, unknown> | null = null
let open = false
let ready: Promise<void> = Promise.resolve()

function ensure(): void {
  if (client) {
    return
  }
  const c = new AgentClient<unknown, unknown>({
    agent: 'personal-agent',
    name: LANDING,
    host: location.host,
    onStateUpdate: () => {},
  })
  client = c
  ready = new Promise<void>((resolve) => {
    c.addEventListener('open', () => {
      open = true
      resolve()
    })
    c.addEventListener('close', () => (open = false))
  })
}

/** RPC to the landing Durable Object, where dashboard numbers, briefing schedules and push settings
 *  live. One shared socket for the whole tab: the dashboard, the memory wall and the settings panel
 *  all read from the same instance. */
export async function landingRpc<T>(method: string, args: unknown[] = []): Promise<T> {
  ensure()
  await Promise.race([ready, new Promise((resolve) => setTimeout(resolve, HANDSHAKE_MS))])
  if (!open || !client) {
    throw new Error('未连接到 Agent')
  }
  return Promise.race([
    client.call(method, args) as Promise<T>,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error('请求超时')), CALL_MS)),
  ])
}
