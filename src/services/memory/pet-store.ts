import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parsePetSpec, type PetSpec } from '../../shared/cat3d/pet-spec'

/** The pet's custom look, kept in `pet.json` next to settings.json: the current spec and a short undo history. */

const MAX_HISTORY = 10

export class PetStore {
  private spec: PetSpec | null = null
  private history: Array<PetSpec | null> = []

  constructor(private readonly path: string) {
    this.load()
  }

  get current(): PetSpec | null {
    return this.spec
  }
  get canUndo(): boolean {
    return this.history.length > 0
  }

  /** Make `spec` the pet's look (null = back to the default cat); the old look can be restored with undo(). */
  set(spec: PetSpec | null): void {
    this.history.push(this.spec)
    if (this.history.length > MAX_HISTORY) this.history.shift()
    this.spec = spec
    this.save()
  }

  /** Go back one look. Returns false when there is nothing to go back to. */
  undo(): boolean {
    if (this.history.length === 0) return false
    this.spec = this.history.pop() ?? null
    this.save()
    return true
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as { current?: unknown; history?: unknown }
      const parse = (v: unknown): PetSpec | null => {
        if (v === null || v === undefined) return null
        const r = parsePetSpec(v)
        return 'spec' in r ? r.spec : null
      }
      this.spec = parse(raw.current)
      this.history = Array.isArray(raw.history) ? raw.history.slice(-MAX_HISTORY).map(parse) : []
    } catch {
      /* no custom pet yet, or an unreadable file: start from the default */
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.tmp`
    writeFileSync(tmp, JSON.stringify({ current: this.spec, history: this.history }, null, 2) + '\n')
    renameSync(tmp, this.path)
    try {
      chmodSync(this.path, 0o600)
    } catch {
      /* not supported on every file system */
    }
  }
}

export interface PetPreset {
  id: string
  spec: PetSpec
}

/** The ready-made pets in assets/pets/*.json (invalid files are skipped). */
export function loadPresets(assetsDir: string): PetPreset[] {
  const dir = join(assetsDir, 'pets')
  if (!existsSync(dir)) return []
  const out: PetPreset[] = []
  for (const f of readdirSync(dir).sort()) {
    if (!/^[a-z0-9-]{1,30}\.json$/.test(f)) continue
    try {
      const r = parsePetSpec(JSON.parse(readFileSync(join(dir, f), 'utf8')))
      if ('spec' in r) out.push({ id: f.slice(0, -5), spec: r.spec })
    } catch {
      /* skip */
    }
  }
  return out
}
