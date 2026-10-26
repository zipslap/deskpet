import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The pet keeps a small file-based memory in a folder you can read and edit (by default inside the app's data folder; point
 * `memory.dir` at any folder, for instance one that other tools also use): `MEMORY.md` is an index,
 * every other `*.md` is one memory with frontmatter. The pet reads all of it into the system prompt and can add or
 * update a memory when the model emits a <remember> block (see `RememberFilter`). Nothing else in the folder is touched.
 */

export const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const
export type MemoryType = (typeof MEMORY_TYPES)[number]

export interface MemoryEntry {
  type: MemoryType
  /** kebab-case slug; the file is `<type>_<name>.md`. */
  name: string
  description: string
  body: string
}

const NAME = /^[a-z0-9][a-z0-9-]{0,59}$/
const MAX_BODY = 4000
const MAX_DESCRIPTION = 200
const MAX_FILE_BYTES = 32 * 1024

/** Everything the model should know from memory, as one block of text ('' if there is none). Bounded by `maxChars`. */
export function readMemory(dir: string, maxChars = 60_000): string {
  let names: string[]
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.md'))
  } catch {
    return ''
  }
  const parts: string[] = []
  let used = 0
  // The index first (it is the table of contents), then each memory; whatever does not fit is dropped whole.
  for (const n of ['MEMORY.md', ...names.filter((x) => x !== 'MEMORY.md').sort()]) {
    if (!names.includes(n)) continue
    let text: string
    try {
      const p = join(dir, n)
      if (statSync(p).size > MAX_FILE_BYTES) continue
      text = readFileSync(p, 'utf8').trim()
    } catch {
      continue
    }
    if (!text) continue
    const block = `### ${n}\n${text}`
    if (used + block.length > maxChars) continue
    parts.push(block)
    used += block.length
  }
  return parts.join('\n\n')
}

export function validateEntry(e: unknown): MemoryEntry | null {
  if (typeof e !== 'object' || e === null) return null
  const { type, name, description, body } = e as Record<string, unknown>
  if (typeof type !== 'string' || !(MEMORY_TYPES as readonly string[]).includes(type)) return null
  if (typeof name !== 'string' || !NAME.test(name)) return null
  if (typeof description !== 'string' || typeof body !== 'string') return null
  const d = description.replace(/\s+/g, ' ').trim()
  const b = body.trim()
  if (!d || d.length > MAX_DESCRIPTION || !b || b.length > MAX_BODY) return null
  return { type: type as MemoryType, name, description: d, body: b }
}

export const memoryFileName = (e: Pick<MemoryEntry, 'type' | 'name'>): string => `${e.type}_${e.name}.md`

const atomicWrite = (path: string, text: string): void => {
  const tmp = `${path}.pet-tmp`
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}

const titleOf = (name: string): string => {
  const t = name.replace(/-/g, ' ')
  return t.charAt(0).toUpperCase() + t.slice(1)
}

/** Creates or replaces the memory file and keeps its one-line pointer in MEMORY.md. Returns the file name written. */
export function saveMemory(dir: string, entry: MemoryEntry): string {
  mkdirSync(dir, { recursive: true })
  const file = memoryFileName(entry)
  const text =
    `---\nname: ${entry.name}\ndescription: ${entry.description}\nmetadata:\n  type: ${entry.type}\n---\n\n${entry.body}\n`
  atomicWrite(join(dir, file), text)

  const indexPath = join(dir, 'MEMORY.md')
  const line = `- [${titleOf(entry.name)}](${file}) — ${entry.description}`
  const lines = existsSync(indexPath) ? readFileSync(indexPath, 'utf8').split('\n') : []
  const at = lines.findIndex((l) => l.includes(`](${file})`))
  if (at >= 0) lines[at] = line
  else {
    while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    lines.push(line)
  }
  atomicWrite(indexPath, lines.join('\n') + '\n')
  return file
}

// ---------------------------------------------------------------- <remember> blocks in a streamed reply

const OPEN = '<remember'
const CLOSE = '</remember>'

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of s.matchAll(/([a-z]+)="([^"]*)"/g)) out[m[1]!] = m[2]!
  return out
}

/**
 * Removes <remember type=".." name=".." description="..">body</remember> blocks from a streamed reply so they are
 * never shown or spoken, and reports each complete, valid block. Text is held back only while it could still be the
 * start of a block, so ordinary replies stream through without delay.
 */
export class RememberFilter {
  private buf = ''
  private inside = false

  constructor(private readonly onEntry: (e: MemoryEntry | null) => void) {}

  /** Feed a chunk; returns the text that is safe to show. */
  push(chunk: string): string {
    this.buf += chunk
    let out = ''
    for (;;) {
      if (!this.inside) {
        const at = this.buf.indexOf(OPEN)
        if (at >= 0) {
          out += this.buf.slice(0, at)
          this.buf = this.buf.slice(at)
          this.inside = true
          continue
        }
        // keep a trailing fragment that could be the beginning of "<remember"
        let keep = 0
        for (let n = Math.min(OPEN.length - 1, this.buf.length); n > 0; n--) {
          if (OPEN.startsWith(this.buf.slice(this.buf.length - n))) {
            keep = n
            break
          }
        }
        out += this.buf.slice(0, this.buf.length - keep)
        this.buf = this.buf.slice(this.buf.length - keep)
        return out
      }
      const end = this.buf.indexOf(CLOSE)
      if (end < 0) {
        if (this.buf.length > MAX_BODY + 1000) {
          this.buf = '' // runaway block: drop it rather than hold the reply back forever
          this.inside = false
          this.onEntry(null)
        }
        return out
      }
      const block = this.buf.slice(0, end)
      this.buf = this.buf.slice(end + CLOSE.length)
      this.inside = false
      const gt = block.indexOf('>')
      const attrs = gt > 0 ? parseAttrs(block.slice(OPEN.length, gt)) : {}
      this.onEntry(validateEntry({ ...attrs, body: gt > 0 ? block.slice(gt + 1) : '' }))
      this.buf = this.buf.replace(/^\n+/, '')
    }
  }

  /** The reply ended: release anything held back (an unfinished block is dropped, never shown). */
  flush(): string {
    const rest = this.inside ? '' : this.buf
    if (this.inside) this.onEntry(null)
    this.buf = ''
    this.inside = false
    return rest
  }
}

// ---------------------------------------------------------------- listing, viewing and removing (the panel's data drawer)

export interface MemoryItem {
  file: string
  name: string
  description: string
  type: string
  bytes: number
}

const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.md$/
/** A file name the drawer may touch: a plain `*.md` name, never the index, never a path. */
export const isMemoryFileName = (f: unknown): f is string => typeof f === 'string' && FILE.test(f) && f !== 'MEMORY.md' && !f.includes('..')

export function listMemoryFiles(dir: string): MemoryItem[] {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: MemoryItem[] = []
  for (const file of names.filter(isMemoryFileName).sort()) {
    try {
      const p = join(dir, file)
      const st = statSync(p)
      if (!st.isFile() || st.size > MAX_FILE_BYTES) continue
      const text = readFileSync(p, 'utf8')
      const fm = /^---\n([\s\S]*?)\n---/.exec(text)?.[1] ?? ''
      const field = (k: string): string => new RegExp(`^\\s*${k}:\\s*(.+)$`, 'm').exec(fm)?.[1]?.trim().slice(0, 200) ?? ''
      out.push({ file, name: field('name') || file.replace(/\.md$/, ''), description: field('description'), type: field('type') || 'memory', bytes: st.size })
    } catch {
      /* unreadable: leave it out of the list */
    }
  }
  return out
}

/** The text of one memory file, bounded. Null if it is not a memory file in this folder. */
export function readMemoryFile(dir: string, file: unknown, maxChars = 8000): string | null {
  if (!isMemoryFileName(file)) return null
  try {
    return readFileSync(join(dir, file), 'utf8').slice(0, maxChars)
  } catch {
    return null
  }
}

/** Drop the index line that points at `file` (the file itself is removed by the caller, to the Trash). */
export function removeFromIndex(dir: string, file: string): void {
  const indexPath = join(dir, 'MEMORY.md')
  if (!existsSync(indexPath)) return
  const lines = readFileSync(indexPath, 'utf8').split('\n')
  const kept = lines.filter((l) => !l.includes(`](${file})`))
  if (kept.length !== lines.length) atomicWrite(indexPath, kept.join('\n'))
}
