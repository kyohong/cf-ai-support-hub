export const LOG_SCHEMA_VERSION = 1

export type LogSource = 'web' | 'dev' | 'reflection' | 'reindex' | 'research' | 'schedule'

/** 逐层展开 err.cause：OpenAI SDK 的 APIConnectionError 会把 DNS/URL 级真实原因藏在 cause 里，
 *  单层 message 只会说 "Connection error."，无法定位。 */
export function describeError(err: unknown, maxDepth = 3): string {
  const parts: string[] = []
  let current: unknown = err
  for (let depth = 0; current !== undefined && current !== null && depth < maxDepth; depth++) {
    if (current instanceof Error) {
      parts.push(current.message)
      current = current.cause
    } else if (typeof current === 'string') {
      parts.push(current)
      current = undefined
    } else {
      parts.push(JSON.stringify(current))
      current = undefined
    }
  }
  return parts.join(' -> ') || String(err)
}

export function errorFields(err: unknown): { name: string; message: string } {
  if (err instanceof Error) {
    return { name: err.name, message: err.message.slice(0, 300) }
  }
  return { name: typeof err, message: String(err).slice(0, 300) }
}

export interface LogContent {
  sample?: string
  args?: string
  resultHead?: string
}

export interface TurnLog {
  readonly turnId: string | null
  event(fields: Record<string, unknown>, content?: LogContent): void
  error(fields: Record<string, unknown>, content?: LogContent): void
}

export function contentEnabled(env: { LOG_CONTENT?: string }): boolean {
  return env.LOG_CONTENT === 'true' || env.LOG_CONTENT === '1'
}

export interface LogOptions {
  turnId?: string | null
  content?: boolean
}

export function createLog(source: LogSource, opts: LogOptions = {}): TurnLog {
  const turnId = opts.turnId === null ? null : (opts.turnId ?? crypto.randomUUID().slice(0, 8))
  let seq = 0
  const emit = (level: 'info' | 'error', fields: Record<string, unknown>, content?: LogContent): void => {
    console.log(
      JSON.stringify({
        v: LOG_SCHEMA_VERSION,
        ts: Date.now(),
        level,
        source,
        ...(turnId === null ? {} : { turnId }),
        seq: seq++,
        ...fields,
        ...(opts.content && content ? { content } : { content: undefined }),
      }),
    )
  }
  return {
    turnId,
    event: (fields, content) => emit('info', fields, content),
    error: (fields, content) => emit('error', fields, content),
  }
}

export const ORPHAN_LOG: TurnLog = createLog('schedule', { turnId: null })
