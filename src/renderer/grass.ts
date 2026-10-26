import { FRAMES, renderGrass } from '../shared/grass-art'

/**
 * Draw the patch: all FRAMES pictures stacked in one canvas, stepped through on the compositor (like the cat's sprite sheet),
 * so the blades on every edge sway. `px` is CSS pixels per art pixel.
 */
export function drawGrass(sheet: HTMLCanvasElement, wArt: number, hArt: number, px: number): void {
  const art = renderGrass(wArt, hArt)
  sheet.width = wArt
  sheet.height = hArt * FRAMES
  sheet.style.width = `${wArt * px}px`
  sheet.style.height = `${hArt * FRAMES * px}px`
  const ctx = sheet.getContext('2d')
  art.frames.forEach((frame, i) => ctx?.putImageData(new ImageData(frame, wArt, hArt), 0, i * hArt))
  document.documentElement.style.setProperty('--sway-end', `${-hArt * FRAMES * px}px`)
}
