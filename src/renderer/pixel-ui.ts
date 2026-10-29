/**
 * Pixel-art buttons for the chat panel: round buttons whose circle is drawn in hard pixel steps (a clip-path, so it stays crisp
 * at any zoom), with little pixel icons instead of emoji. Icons are 9x9 bitmaps drawn into a canvas once and used as data URLs.
 */

/** 9x9 icons. '#' = ink, '+' = accent, anything else = clear. */
const ICONS = {
  data: ['.........', '.###.....', '.#..####.', '.#######.', '.#.....#.', '.#.....#.', '.#.....#.', '.#######.', '.........'],
  palette: ['..#####..', '.#######.', '##+###+##', '#########', '##+##....', '#####....', '.#####...', '..###....', '.........'],
  eye: ['.........', '..#####..', '.#.....#.', '#..###..#', '#..###..#', '.#.....#.', '..#####..', '.........', '.........'],
  speaker: ['....#....', '...##.#..', '.####..#.', '.#.##.#.#', '.#.##.#.#', '.####..#.', '...##.#..', '....#....', '.........'],
  muted: ['....#....', '...##....', '.####.#.#', '.#.##..#.', '.#.##.#.#', '.####....', '...##....', '....#....', '.........'],
  house: ['....#....', '...###...', '..#####..', '.#######.', '##.....##', '.#.###.#.', '.#.#+#.#.', '.#.#+#.#.', '.........'],
  minimise: ['.........', '.........', '.........', '.........', '.........', '.........', '.#######.', '.#######.', '.........'],
  restore: ['.........', '.#######.', '.#######.', '.#.....#.', '.#.....#.', '.#.....#.', '.#######.', '.........', '.........'],
  close: ['.........', '.##...##.', '..##.##..', '...###...', '....#....', '...###...', '..##.##..', '.##...##.', '.........'],
  plug: ['..#...#..', '..#...#..', '.#######.', '.#+++++#.', '.#######.', '..#####..', '....#....', '....#....', '....#....'],
  paw: ['.##...##.', '.##...##.', '#..###..#', '..#####..', '.#######.', '.#######.', '..##.##..', '.........', '.........'],
  camera: ['.........', '...###...', '.#######.', '.#.###.#.', '.#.#+#.#.', '.#.###.#.', '.#######.', '.........', '.........'],
  mic: ['...###...', '...#+#...', '...#+#...', '...###...', '.#.###.#.', '.#.....#.', '..#####..', '....#....', '..#####..'],
  stop: ['.........', '.........', '..#####..', '..#####..', '..#####..', '..#####..', '..#####..', '.........', '.........'],
  hand: ['..#.#....', '..#.#.#..', '#.#.#.#..', '#.#.#.#.#', '#######.#', '#.......#', '.#.....#.', '..#####..', '.........'],
  send: ['.........', '.##......', '.####....', '.######..', '.########', '.######..', '.####....', '.##......', '.........']
} as const
export type IconName = keyof typeof ICONS

const cache = new Map<string, string>()
/** A data URL of the icon at 1 pixel per art pixel (scale it up with `image-rendering: pixelated`). */
export function iconUrl(name: IconName, ink: string, accent = '#e8548a'): string {
  const key = `${name}|${ink}|${accent}`
  const hit = cache.get(key)
  if (hit) return hit
  const rows = ICONS[name]
  const c = document.createElement('canvas')
  c.width = 9
  c.height = 9
  const ctx = c.getContext('2d')
  if (!ctx) return ''
  rows.forEach((row, y) =>
    [...row].forEach((ch, x) => {
      if (ch !== '#' && ch !== '+') return
      ctx.fillStyle = ch === '#' ? ink : accent
      ctx.fillRect(x, y, 1, 1)
    })
  )
  const url = c.toDataURL('image/png')
  cache.set(key, url)
  return url
}

/** A circle on an n x n pixel grid as a stepped CSS polygon (percentages), inset by `inset` grid pixels. */
export function stepCircle(n: number, inset = 0): string {
  const r = n / 2 - inset
  const c = n / 2
  const spans: Array<[number, number, number]> = []
  for (let y = inset; y < n - inset; y++) {
    const dy = y + 0.5 - c
    const hw = Math.sqrt(Math.max(0, r * r - dy * dy))
    const x0 = Math.round(c - hw)
    const x1 = Math.round(c + hw)
    if (x1 > x0) spans.push([y, x0, x1])
  }
  const p = (v: number): string => `${((v / n) * 100).toFixed(3)}%`
  const right = spans.flatMap(([y, , x1]) => [`${p(x1)} ${p(y)}`, `${p(x1)} ${p(y + 1)}`])
  const left = [...spans].reverse().flatMap(([y, x0]) => [`${p(x0)} ${p(y + 1)}`, `${p(x0)} ${p(y)}`])
  return `polygon(${[...right, ...left].join(', ')})`
}

/** Publish the stepped-circle shapes as CSS variables (one art pixel = 2 CSS pixels: 13-pixel header buttons, 17-pixel composer buttons). */
export function installPixelShapes(): void {
  const root = document.documentElement.style
  root.setProperty('--disc-13', stepCircle(13))
  root.setProperty('--disc-13-in', stepCircle(13, 1))
  root.setProperty('--disc-17', stepCircle(17))
  root.setProperty('--disc-17-in', stepCircle(17, 1))
}

/** Give a button its pixel icon (dark ink normally, white on a coloured button). */
export function setIcon(btn: HTMLElement, name: IconName, light = false): void {
  btn.textContent = ''
  btn.dataset['icon'] = name
  btn.style.setProperty('--icon', `url("${iconUrl(name, light ? '#ffffff' : '#14305a')}")`)
}
