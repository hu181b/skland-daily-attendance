import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createNotifier } from 'statocysts'

export function toArray<T>(value: T | T[]): T[] {
  return Array.isArray(value) ? value : [value]
}

export interface CreateMessageCollectorOptions {
  notificationUrls?: string | string[]
  onError?: () => void
}

export interface CollectOptions {
  output?: boolean // Whether to output to console (default: false)
  isError?: boolean // Whether this is an error message (default: false)
}

export interface MessageCollector {
  // Console only (不收集到通知)
  log: (message: string) => void
  error: (message: string) => void

  // Notification only (不输出到控制台)
  notify: (message: string) => void
  notifyError: (message: string) => void

  // Console + Notification (同时输出和收集)
  info: (message: string) => void
  infoError: (message: string) => void

  // Utility
  push: () => Promise<void>
  hasError: () => boolean

  /** @deprecated Use notify(), info(), or notifyError() instead */
  collect: (message: string, options?: CollectOptions) => void
}

interface NotifyState {
  date: string
  success: boolean
  failures: string[]
}

function todayInShanghai(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

async function loadState(path: string): Promise<NotifyState | null> {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (parsed && typeof parsed === 'object')
      return parsed as NotifyState
  }
  catch {
    // 首次运行或状态文件损坏，按未推送处理
  }
  return null
}

async function saveState(path: string, state: NotifyState): Promise<void> {
  const index = path.lastIndexOf('/')
  if (index > 0)
    await mkdir(path.slice(0, index), { recursive: true })
  await writeFile(path, JSON.stringify(state))
}

/** 给每条角色结果加上与原神签到一致的状态标记 */
function decorate(line: string): string {
  if (line.includes('签到成功'))
    return `✅ ${line}`
  if (line.includes('今天已经签到过了') || line.includes('跳过签到') || line.includes('没有角色'))
    return `➖ ${line}`
  if (line.includes('失败') || line.includes('错误'))
    return `❌ ${line}`
  return line
}

/** 把内部消息整理成原神签到那种紧凑格式 */
function buildBodyLines(messages: string[]): string[] {
  const lines: string[] = []
  for (const message of messages) {
    for (const rawLine of message.split('\n')) {
      const line = rawLine.trim()
      if (!line)
        continue
      // 旧的自带标题行由新标题取代
      if (line.startsWith('##'))
        continue
      if (/^=+\s*执行摘要\s*=+$/.test(line)) {
        lines.push('—— 执行摘要 ——')
        continue
      }
      const account = line.match(/^-+\s*账号\s*(\d+)\s*\/\s*(\d+)\s*-+$/)
      if (account) {
        lines.push(`【账号${account[1]}】`)
        continue
      }
      if (line === '开始处理...')
        continue
      lines.push(decorate(line))
    }
  }
  return lines
}

export function createMessageCollector(options: CreateMessageCollectorOptions): MessageCollector {
  const messages: string[] = []
  let hasError = false

  const log = (message: string) => {
    console.log(message)
  }

  const error = (message: string) => {
    console.error(message)
    hasError = true
  }

  // Notification only methods
  const notify = (message: string) => {
    messages.push(message)
  }

  const notifyError = (message: string) => {
    messages.push(message)
    hasError = true
  }

  // Combined methods (Console + Notification)
  const info = (message: string) => {
    console.log(message)
    messages.push(message)
  }

  const infoError = (message: string) => {
    console.error(message)
    messages.push(message)
    hasError = true
  }

  /** @deprecated Use notify(), info(), or notifyError() instead */
  const collect = (message: string, opts: CollectOptions = {}) => {
    const { output = false, isError = false } = opts

    // Add to notification messages
    messages.push(message)

    // Output to console if requested
    if (output) {
      console[isError ? 'error' : 'log'](message)
    }

    // Mark as error if needed
    if (isError) {
      hasError = true
    }
  }

  const push = async () => {
    const urls = options.notificationUrls ? toArray(options.notificationUrls) : []

    if (urls.length > 0) {
      const status = hasError ? '❌' : (messages.some(m => m.includes('签到成功')) ? '✅' : '➖')
      const date = todayInShanghai()
      const title = `${status} 森空岛签到结果`
      const content = [`签到日期：${date}（北京时间）`, '', ...buildBodyLines(messages)].join('\n')
      const digest = createHash('sha256').update(content).digest('hex')

      // 一天跑多次时，同一类结果只推送一次
      const statePath = process.env.NOTIFY_STATE_PATH || '.notify-state/notification.json'
      const state = await loadState(statePath)
      const sameDay = state?.date === date
      const pushed = sameDay === true
        && (status === '❌'
          ? (state?.failures || []).includes(digest)
          : state?.success === true)

      if (pushed) {
        console.log('今日同类通知已发送，跳过重复推送；签到检查仍正常执行')
      }
      else {
        const notifier = createNotifier(urls)
        try {
          await notifier.send({ title, body: content })
          const next: NotifyState = sameDay && state ? state : { date, success: false, failures: [] }
          if (!Array.isArray(next.failures))
            next.failures = []
          if (status === '❌')
            next.failures.push(digest)
          else
            next.success = true
          await saveState(statePath, next)
        }
        catch (sendError) {
          // Don't let notification failures crash the attendance task
          console.error('[notify] send failed:', sendError)
          hasError = true
        }
      }
    }

    // Exit with error if any error occurred
    if (hasError && options.onError) {
      options.onError()
    }
  }

  return { log, error, notify, notifyError, info, infoError, collect, push, hasError: () => hasError } as const
}
