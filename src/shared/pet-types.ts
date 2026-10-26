/** Shapes shared by the "change your pet" drawer (chat renderer), the main process and tests. */

export const MAX_PET_IMAGES = 4
/** Longest side of an image sent for a pet design, in pixels (the drawer scales pictures down to this before sending). */
export const PET_IMAGE_EDGE = 768
/** Largest base64 payload accepted for one image (about 1.1 MB of JPEG). */
export const MAX_PET_IMAGE_CHARS = 1_500_000
export const MAX_PET_TEXT_CHARS = 2000

export interface PetImage {
  mime: 'image/jpeg' | 'image/png'
  /** Base64 without the data: prefix. */
  data: string
}

export interface PetDesignRequest {
  text: string
  images: PetImage[]
}

export type PetAction = { kind: 'undo' } | { kind: 'reset' } | { kind: 'preset'; id: string }

export interface PetPresetInfo {
  id: string
  name: string
}

/** What the drawer shows. */
export interface PetUiState {
  /** A design request is running. */
  busy: boolean
  /** Name of the pet being drawn ("DeskPet cat" for the default). */
  name: string
  canUndo: boolean
  isDefault: boolean
  /** An AI is connected (otherwise only simple recolouring and the presets work). */
  hasAi: boolean
  /** The connected AI can look at pictures. */
  canSeeImages: boolean
  /** The pet window is showing the standing figure (the only view that can be restyled). */
  supported: boolean
  presets: PetPresetInfo[]
  /** The last result or problem, as one line. */
  message: string
  error: boolean
}

export const EMPTY_PET_UI: PetUiState = { busy: false, name: 'DeskPet cat', canUndo: false, isDefault: true, hasAi: false, canSeeImages: false, supported: true, presets: [], message: '', error: false }

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

export function parsePetDesignRequest(v: unknown): PetDesignRequest | null {
  if (typeof v !== 'object' || v === null) return null
  const { text, images } = v as Record<string, unknown>
  if (typeof text !== 'string' || !Array.isArray(images) || images.length > MAX_PET_IMAGES) return null
  const t = text.trim()
  if (t.length > MAX_PET_TEXT_CHARS || (t.length === 0 && images.length === 0)) return null
  const out: PetImage[] = []
  for (const im of images) {
    if (typeof im !== 'object' || im === null) return null
    const { mime, data } = im as Record<string, unknown>
    if ((mime !== 'image/jpeg' && mime !== 'image/png') || typeof data !== 'string' || data.length === 0 || data.length > MAX_PET_IMAGE_CHARS || !BASE64.test(data)) return null
    out.push({ mime, data })
  }
  return { text: t, images: out }
}

export function parsePetAction(v: unknown): PetAction | null {
  if (typeof v !== 'object' || v === null) return null
  const { kind, id } = v as Record<string, unknown>
  if (kind === 'undo' || kind === 'reset') return { kind }
  if (kind === 'preset' && typeof id === 'string' && /^[a-z0-9-]{1,30}$/.test(id)) return { kind, id }
  return null
}

export function parsePetUiState(v: unknown): PetUiState | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  const bools = ['busy', 'canUndo', 'isDefault', 'hasAi', 'canSeeImages', 'supported', 'error'] as const
  if (bools.some((k) => typeof o[k] !== 'boolean') || typeof o['name'] !== 'string' || typeof o['message'] !== 'string' || !Array.isArray(o['presets'])) return null
  const presets: PetPresetInfo[] = []
  for (const p of o['presets'].slice(0, 20)) {
    const q = p as Record<string, unknown> | null
    if (q && typeof q['id'] === 'string' && typeof q['name'] === 'string') presets.push({ id: q['id'].slice(0, 30), name: q['name'].slice(0, 40) })
  }
  return {
    busy: o['busy'] as boolean, name: (o['name'] as string).slice(0, 60), canUndo: o['canUndo'] as boolean, isDefault: o['isDefault'] as boolean, hasAi: o['hasAi'] as boolean,
    canSeeImages: o['canSeeImages'] as boolean, supported: o['supported'] as boolean, presets, message: (o['message'] as string).slice(0, 400), error: o['error'] as boolean
  }
}
