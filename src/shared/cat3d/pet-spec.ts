/**
 * A "pet spec": a small piece of data that restyles the standing voxel figure without any code. An AI (or a person) writes it as
 * JSON, `parsePetSpec` validates it strictly (bounded sizes, hex colours only, known parts only), and the renderer rebuilds the
 * figure from it live. Nothing in a spec can run code or reach outside the pet's own voxel parts.
 *
 *   { "name": "Mermaid",
 *     "palette": { "fur": "#3fb8a6", "furHi": "#7fe0cf" },          // recolour any of the 8 colour roles
 *     "parts": { "torso": { "shapes": [ { "kind": "ellipsoid", "center": [0,-3,0], "radii": [2,3,1.6], "color": "#2a9d8f" } ] } },
 *     "hide": ["leg"] }                                             // parts to hide
 *
 * Coordinates are voxels in the part's own frame (+y up, +z the way the pet faces, +x the pet's left). `replace: true` swaps the
 * part's shapes for yours; otherwise yours are added on top (and `carve: true` shapes remove voxels).
 */
import { COATS, hexToLinear, type Coat } from './cat-model'
import { FIGURE_SHAPES, FIG_LEG, type FigurePart } from './figure-model'
import type { Rgb, Shape } from './voxels'

/** The parts a spec can change. `tailTip` is an extra piece on the end of the tail (a fin, a tuft...). */
export const SPEC_PARTS = ['torso', 'head', 'ear', 'upperArm', 'foreArm', 'leg', 'tailSegment', 'tailTip', 'phone'] as const
export type SpecPart = (typeof SPEC_PARTS)[number]

export const COLOR_ROLES = ['fur', 'furHi', 'chest', 'pink', 'nose', 'mouth', 'eye', 'pupil'] as const
export type ColorRole = (typeof COLOR_ROLES)[number]
/** Roles that can colour a voxel (the eye and pupil are separate flat pieces drawn by the renderer). */
export const VOXEL_ROLES = ['fur', 'furHi', 'chest', 'pink', 'nose', 'mouth'] as const

export interface SpecShape {
  kind: 'ellipsoid' | 'box'
  center: [number, number, number]
  radii: [number, number, number]
  /** A colour role (fur, furHi, chest, pink, nose, mouth) or a "#rrggbb" colour. */
  color: string
  carve?: boolean
}
export interface PartEdit {
  replace: boolean
  shapes: SpecShape[]
}
export interface PetSpec {
  name: string
  palette: Partial<Record<ColorRole, string>>
  parts: Partial<Record<SpecPart, PartEdit>>
  hide: SpecPart[]
  /** Overall size multiplier. */
  scale: number
}

/** An ellipsoid thinner than this would fall between voxel centres and vanish, so compileSpec thickens it (boxes keep any size down to half a voxel). */
export const MIN_ELLIPSOID_RADIUS = 0.9
export const MIN_BOX_RADIUS = 0.5

export const LIMITS = { shapesPerPart: 48, totalShapes: 160, coord: 16, radiusMin: 0.25, radiusMax: 14, extraColors: 40, scaleMin: 0.6, scaleMax: 1.15, nameChars: 40 } as const

export const EMPTY_SPEC: PetSpec = { name: 'DeskPet cat', palette: {}, parts: {}, hide: [], scale: 1 }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const HEX = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/

/** "#abc" -> "#aabbcc", lower case; null if it is not a hex colour. */
export function normaliseHex(v: unknown): string | null {
  if (typeof v !== 'string' || !HEX.test(v)) return null
  const h = v.slice(1).toLowerCase()
  return '#' + (h.length === 3 ? [...h].map((c) => c + c).join('') : h)
}

const vec3 = (v: unknown, lo: number, hi: number): [number, number, number] | null => {
  if (!Array.isArray(v) || v.length !== 3) return null
  const out = v.map((n) => (typeof n === 'number' && Number.isFinite(n) && n >= lo && n <= hi ? n : NaN))
  return out.some(Number.isNaN) ? null : [out[0]!, out[1]!, out[2]!]
}

/** Validate untrusted JSON into a spec. On failure the message says what is wrong, so it can be handed back to the AI to fix. */
export function parsePetSpec(raw: unknown): { spec: PetSpec } | { error: string } {
  if (!isObj(raw)) return { error: 'The pet spec must be a JSON object.' }
  const spec: PetSpec = { name: 'Custom pet', palette: {}, parts: {}, hide: [], scale: 1 }
  if (raw['name'] !== undefined) {
    if (typeof raw['name'] !== 'string') return { error: '"name" must be a string.' }
    spec.name = raw['name'].replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, LIMITS.nameChars) || spec.name
  }
  if (raw['palette'] !== undefined) {
    if (!isObj(raw['palette'])) return { error: '"palette" must be an object like {"fur":"#3fb8a6"}.' }
    for (const [k, v] of Object.entries(raw['palette'])) {
      if (!(COLOR_ROLES as readonly string[]).includes(k)) return { error: `Unknown palette colour "${k}". Use: ${COLOR_ROLES.join(', ')}.` }
      const hex = normaliseHex(v)
      if (!hex) return { error: `Palette colour "${k}" must be a hex colour like "#3fb8a6".` }
      spec.palette[k as ColorRole] = hex
    }
  }
  if (raw['scale'] !== undefined) {
    const s = raw['scale']
    if (typeof s !== 'number' || !Number.isFinite(s) || s < LIMITS.scaleMin || s > LIMITS.scaleMax) return { error: `"scale" must be a number from ${LIMITS.scaleMin} to ${LIMITS.scaleMax}.` }
    spec.scale = s
  }
  if (raw['hide'] !== undefined) {
    if (!Array.isArray(raw['hide'])) return { error: '"hide" must be a list of part names.' }
    for (const p of raw['hide']) {
      if (typeof p !== 'string' || !(SPEC_PARTS as readonly string[]).includes(p)) return { error: `Cannot hide "${String(p).slice(0, 30)}". Parts: ${SPEC_PARTS.join(', ')}.` }
      if (!spec.hide.includes(p as SpecPart)) spec.hide.push(p as SpecPart)
    }
  }
  let total = 0
  const extra = new Set<string>()
  if (raw['parts'] !== undefined) {
    if (!isObj(raw['parts'])) return { error: '"parts" must be an object keyed by part name.' }
    for (const [name, edit] of Object.entries(raw['parts'])) {
      if (!(SPEC_PARTS as readonly string[]).includes(name)) return { error: `Unknown part "${name.slice(0, 30)}". Parts: ${SPEC_PARTS.join(', ')}.` }
      if (!isObj(edit)) return { error: `Part "${name}" must be an object with a "shapes" list.` }
      const list = edit['shapes']
      if (!Array.isArray(list)) return { error: `Part "${name}" needs a "shapes" list.` }
      if (list.length > LIMITS.shapesPerPart) return { error: `Part "${name}" has too many shapes (max ${LIMITS.shapesPerPart}).` }
      const shapes: SpecShape[] = []
      for (const [i, s] of list.entries()) {
        const at = `${name}.shapes[${i}]`
        if (!isObj(s)) return { error: `${at} must be an object.` }
        if (s['kind'] !== 'ellipsoid' && s['kind'] !== 'box') return { error: `${at}.kind must be "ellipsoid" or "box".` }
        const center = vec3(s['center'], -LIMITS.coord, LIMITS.coord)
        if (!center) return { error: `${at}.center must be [x, y, z] numbers between -${LIMITS.coord} and ${LIMITS.coord}.` }
        const radii = vec3(s['radii'], LIMITS.radiusMin, LIMITS.radiusMax)
        if (!radii) return { error: `${at}.radii must be [x, y, z] half-sizes between ${LIMITS.radiusMin} and ${LIMITS.radiusMax}.` }
        const carve = s['carve'] === true
        let color = 'fur'
        if (!carve || s['color'] !== undefined) {
          const c = s['color']
          if (typeof c === 'string' && (VOXEL_ROLES as readonly string[]).includes(c)) color = c
          else {
            const hex = normaliseHex(c)
            if (!hex) return { error: `${at}.color must be a role (${VOXEL_ROLES.join(', ')}) or a hex colour like "#3fb8a6".` }
            color = hex
            extra.add(hex)
          }
        }
        shapes.push({ kind: s['kind'], center, radii, color, ...(carve ? { carve: true } : {}) })
      }
      total += shapes.length
      spec.parts[name as SpecPart] = { replace: edit['replace'] === true, shapes }
    }
  }
  if (total > LIMITS.totalShapes) return { error: `Too many shapes in total (${total}; max ${LIMITS.totalShapes}).` }
  if (extra.size > LIMITS.extraColors) return { error: `Too many different custom colours (${extra.size}; max ${LIMITS.extraColors}). Reuse colours.` }
  return { spec }
}

/** What the renderer needs: the colours (as a `Coat`), a palette for the voxels, and the shapes of each part. */
export interface CompiledSpec {
  coat: Coat
  /** Linear colours; voxel colour index n (1-based) is palette[n - 1]. Roles first (1-6), then 7 = white glyph, then custom colours. */
  palette: Rgb[]
  shapes: Record<SpecPart, Shape[]>
  hidden: ReadonlySet<SpecPart>
  scale: number
}

const ROLE_INDEX: Record<(typeof VOXEL_ROLES)[number], number> = { fur: 1, furHi: 2, chest: 3, pink: 4, nose: 5, mouth: 6 }

export function compileSpec(spec: PetSpec | null): CompiledSpec {
  const s = spec ?? EMPTY_SPEC
  const coat: Coat = { ...COATS.black }
  for (const [k, v] of Object.entries(s.palette)) if (v) coat[k as ColorRole] = v
  const palette: Rgb[] = [coat.fur, coat.furHi, coat.chest, coat.pink, coat.nose, coat.mouth].map(hexToLinear)
  palette.push(hexToLinear('#ffffff')) // 7: glyph white
  const custom = new Map<string, number>()
  const indexOf = (c: string): number => {
    if (c in ROLE_INDEX) return ROLE_INDEX[c as keyof typeof ROLE_INDEX]
    let i = custom.get(c)
    if (!i) {
      i = palette.length + 1
      palette.push(hexToLinear(c))
      custom.set(c, i)
    }
    return i
  }
  const shapes = {} as Record<SpecPart, Shape[]>
  for (const part of SPEC_PARTS) {
    const base: Shape[] = part === 'tailTip' ? [] : [...FIGURE_SHAPES[part as FigurePart]]
    const edit = s.parts[part]
    if (!edit) {
      shapes[part] = base
      continue
    }
    const floor = (r: number, kind: SpecShape['kind']): number => Math.max(r, kind === 'ellipsoid' ? MIN_ELLIPSOID_RADIUS : MIN_BOX_RADIUS)
    const mine: Shape[] = edit.shapes.map((sh) => ({
      kind: sh.kind,
      center: sh.center,
      radii: [floor(sh.radii[0], sh.kind), floor(sh.radii[1], sh.kind), floor(sh.radii[2], sh.kind)] as const,
      color: indexOf(sh.color),
      ...(sh.carve ? { carve: true } : {})
    }))
    shapes[part] = edit.replace ? mine : [...base, ...mine]
  }
  return { coat, palette, shapes, hidden: new Set(s.hide), scale: s.scale }
}

// ---------- a quick offline recolour, for "make my cat green" without any AI ----------
export const COLOUR_HEX: Record<string, string> = {
  black: '#4b5068', grey: '#7d8693', gray: '#7d8693', white: '#e9e8e6', red: '#cc4343', orange: '#d8873a', yellow: '#e6c53a', green: '#4aa05a',
  teal: '#2fa59a', turquoise: '#33b7b0', blue: '#4f7bd8', navy: '#2f4a8a', purple: '#8a5cc8', violet: '#8a5cc8', pink: '#e58ea9', magenta: '#c4408f',
  brown: '#8a5a3a', gold: '#d8b03a', golden: '#d8b03a', silver: '#a9b2bd', cyan: '#3ab9d8', lime: '#8ccd3a', beige: '#d8c4a0', cream: '#efe4cc'
}
const lighten = (hex: string, t: number): string => {
  const n = Number.parseInt(hex.slice(1), 16)
  const mix = (c: number): number => Math.round(c + (255 - c) * t)
  return '#' + [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => mix(c).toString(16).padStart(2, '0')).join('')
}

/** "change my cat's skin to green" -> a palette-only spec; null when no colour name is found. Used when no AI is connected. */
export function quickRecolour(text: string, current: PetSpec | null): PetSpec | null {
  const words = text.toLowerCase().match(/[a-z]+/g) ?? []
  const found = words.filter((w) => w in COLOUR_HEX)
  const colour = found.at(-1)
  if (!colour) return null
  const fur = COLOUR_HEX[colour]!
  const base = current ?? EMPTY_SPEC
  return { ...base, palette: { ...base.palette, fur, furHi: lighten(fur, 0.28) }, name: `${colour[0]!.toUpperCase()}${colour.slice(1)} cat` }
}

// ---------- reference for the AI designer ----------
const round = (n: number): number => Math.round(n * 10) / 10
/** The default shapes of a part as spec JSON (colour roles instead of functions), so the AI can see what it is changing. */
export function describeDefaults(): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const part of SPEC_PARTS) {
    if (part === 'tailSegment' || part === 'tailTip') continue
    out[part] = (FIGURE_SHAPES[part as FigurePart] as readonly Shape[]).map((s) => ({
      kind: s.kind,
      center: s.center.map(round),
      radii: s.radii.map(round),
      color: typeof s.color === 'number' ? (['', 'fur', 'furHi', 'chest', 'pink', 'nose', 'mouth'][s.color] ?? 'fur') : 'fur (with a patterned patch of chest/pink)'
    }))
  }
  return out
}

export const FRAME_NOTES = {
  torso: `origin = the hips' centre; spans y -0.9 (bottom of the hips) to 6.3 (shoulders), x ±2.3, z ±2. The ground is y = -${FIG_LEG}.`,
  head: 'origin = the neck; the skull spans y 0.2 to 6.2, x ±3.5, z -2.8 to 3.2 (the face is on +z). Eyes, nose and mouth are drawn separately on the front of the face.',
  ear: 'one ear (it is used for both sides), origin at its base, pointing up to y 4. Ears sit at x ±2.1, y 4.9 on the head.',
  upperArm: 'one arm (used for both sides), origin = the shoulder, hanging down to y -2.9.',
  foreArm: 'one forearm and paw, origin = the elbow, hanging down to y -3.',
  leg: `one leg (used for both), origin = the hip joint, hanging down to y -${FIG_LEG}; the foot points to +z.`,
  tailSegment: 'one of 8 tail segments, each 1.5 long along +z (the direction the tail points away from the body); the same shapes are repeated along the tail.',
  tailTip: 'an extra piece at the very end of the tail (empty by default): +z points away from the body. Good for fins, tufts, flames.',
  phone: 'the little pink phone in the right paw (origin = its centre); replace it to give the pet a different prop.'
} as const
