import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/** The voices DeskPet knows how to download (assets/voices/catalog.json) and the ones actually installed on this Mac. */

export type VoiceFamily = 'kokoro' | 'vits'

export interface CatalogVoice {
  id: string
  family: VoiceFamily
  label: string
  /** "multi" for the multilingual Kokoro model, otherwise a locale like "en_GB". */
  lang: string
  langName: string
  asset: string
  mb: number
  /** Named speakers inside the model (Kokoro). Absent for single-speaker voices. */
  speakers?: string[]
  recommended: boolean
}

export interface InstalledVoice extends CatalogVoice {
  dir: string
}

export function loadCatalog(assetsDir: string): CatalogVoice[] {
  try {
    const j = JSON.parse(readFileSync(join(assetsDir, 'voices', 'catalog.json'), 'utf8')) as { voices?: unknown }
    return Array.isArray(j.voices) ? (j.voices as CatalogVoice[]).filter((v) => typeof v.id === 'string' && (v.family === 'kokoro' || v.family === 'vits')) : []
  } catch {
    return []
  }
}

/** A model folder is usable when it has the files the engine needs (the installer checks the same). */
export function isUsableModelDir(dir: string, family: VoiceFamily): boolean {
  let files: string[]
  try {
    files = readdirSync(dir)
  } catch {
    return false
  }
  if (!files.some((f) => f.endsWith('.onnx')) || !files.includes('tokens.txt')) return false
  return family === 'kokoro' ? files.includes('voices.bin') : true
}

export function installedVoices(catalog: CatalogVoice[], modelsDir: string): InstalledVoice[] {
  return catalog.filter((v) => existsSync(join(modelsDir, v.id)) && isUsableModelDir(join(modelsDir, v.id), v.family)).map((v) => ({ ...v, dir: join(modelsDir, v.id) }))
}

/** The Kokoro voice names are "af_heart"-style: language+gender prefix, then the name. */
export function speakerLabel(name: string): string {
  const m = /^([a-z])([fm])_(.+)$/.exec(name)
  if (!m) return name
  const lang: Record<string, string> = { a: 'US', b: 'UK', e: 'ES', f: 'FR', h: 'HI', i: 'IT', j: 'JP', p: 'PT', z: 'ZH' }
  const rest = m[3]!.replace(/_/g, ' ')
  return `${rest.charAt(0).toUpperCase()}${rest.slice(1)} (${lang[m[1]!] ?? m[1]}, ${m[2] === 'f' ? 'female' : 'male'})`
}
