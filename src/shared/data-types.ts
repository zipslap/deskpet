/** What the panel's data drawer shows: everything the pet keeps about you, and how to see or remove it. */
export interface MemoryRow {
  file: string
  name: string
  description: string
  type: string
  bytes: number
}

export interface DataSnapshot {
  /** Memory is being read / written by the pet (settings), and where it lives. */
  memoryRead: boolean
  memoryWrite: boolean
  memoryDir: string
  memory: MemoryRow[]
  /** The saved conversation. */
  messages: number
  summarizedMessages: number
  summary: string
  summarizeEnabled: boolean
}

export const EMPTY_DATA: DataSnapshot = { memoryRead: false, memoryWrite: false, memoryDir: '', memory: [], messages: 0, summarizedMessages: 0, summary: '', summarizeEnabled: false }

const str = (v: unknown, max: number): string | null => (typeof v === 'string' ? v.slice(0, max) : null)
const cnt = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < 1e9 ? v : null)

export function parseDataSnapshot(v: unknown): DataSnapshot | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  for (const k of ['memoryRead', 'memoryWrite', 'summarizeEnabled'] as const) if (typeof o[k] !== 'boolean') return null
  const [memoryDir, summary] = [str(o['memoryDir'], 400), str(o['summary'], 4000)]
  const [messages, summarizedMessages] = [cnt(o['messages']), cnt(o['summarizedMessages'])]
  if (memoryDir === null || summary === null || messages === null || summarizedMessages === null || !Array.isArray(o['memory'])) return null
  const memory: MemoryRow[] = []
  for (const r of o['memory'].slice(0, 200)) {
    if (typeof r !== 'object' || r === null) return null
    const { file, name, description, type, bytes } = r as Record<string, unknown>
    const [f, n, d, t, b] = [str(file, 130), str(name, 100), str(description, 200), str(type, 30), cnt(bytes)]
    if (f === null || n === null || d === null || t === null || b === null) return null
    memory.push({ file: f, name: n, description: d, type: t, bytes: b })
  }
  return { memoryRead: o['memoryRead'] as boolean, memoryWrite: o['memoryWrite'] as boolean, memoryDir, memory, messages, summarizedMessages, summary, summarizeEnabled: o['summarizeEnabled'] as boolean }
}

/** A file name sent from the panel: only a plain `*.md` name (the main process re-checks it against the real folder). */
export const parseMemoryFile = (v: unknown): string | null => (typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.md$/.test(v) && v !== 'MEMORY.md' ? v : null)
