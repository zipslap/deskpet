/**
 * The 3D cat: a voxel model hung on the skeleton from shared/cat3d/rig.ts, drawn with WebGL at low resolution and scaled up with
 * nearest-neighbour so it keeps a chunky pixel look. Lighting is a soft key light with a cast shadow, a cool rim light and a hemisphere fill.
 * The click-through mask is read back from the rendered pixels, so only the cat itself (not its shadow) catches the mouse.
 */
import {
  AmbientLight, BoxGeometry, BufferAttribute, BufferGeometry, CircleGeometry, DirectionalLight, Group, HemisphereLight, Mesh, MeshBasicMaterial,
  MeshStandardMaterial, OrthographicCamera, PCFShadowMap, PlaneGeometry, Scene, ShadowMaterial, WebGLRenderer
} from 'three'
import type { Heading, Mode } from '../shared/brain'
import { growMask } from '../shared/grab-mask'
import { buildArc, buildPart, buildZGlyph, COATS, faceFrontZ, HEAD_FRAME, paletteFor, TAIL_SEGMENT_LENGTH, TAIL_SEGMENTS, type CoatName, type PartName } from '../shared/cat3d/cat-model'
import { CatAnimator, LEGS, PX_PER_UNIT, type LegName, type PoseName } from '../shared/cat3d/rig'
import { meshFromGrid, type MeshData } from '../shared/cat3d/voxels'
import type { PetSpec } from '../shared/cat3d/pet-spec'
import { animationFor, WINDOW_SIZE } from '../shared/sprite'

/** How far the click area reaches past the drawn cat, in rendered pixels (5-6 CSS pixels). */
const GRAB_PX = 3

export interface Cat3DOptions {
  coat?: CoatName
  /** CSS pixels per rendered pixel. 2 = chunky (default), 1 = fine. */
  pixel?: number
}

export interface Cat3D {
  /** Restyle the pet from a pet spec (null = default). Only the standing figure supports it. */
  setSpec?(spec: PetSpec | null): void
  setState(mode: Mode, dir: 1 | -1, dragging: boolean, heading?: Heading): void
  /** Is the CSS-pixel point (relative to the canvas) over the cat? */
  hit(x: number, y: number): boolean
  dispose(): void
  /** Called if the GPU context is lost, so the page can fall back to the 2D sprite. */
  onLost: (() => void) | null
  /** Test/debug hooks. */
  debug: {
    /** Jump to a settled pose at time `t` (seconds), draw one frame and pause the loop. */
    freeze(pose: PoseName, dir: 1 | -1, t: number): void
    resume(): void
    frames(): number
    pose(): PoseName
    size(): number
    /** Current pose weights (sum to 1) and heading, for tests. */
    weights(): Record<PoseName, number>
    yaw(): number
    /** A CSS-pixel point inside the cat's click mask (nearest its centre of mass), or null if nothing is drawn. */
    bodyPoint(): [number, number] | null
    /** Pixel statistics of the last frame: fully opaque, shadow-only (translucent, not clickable) and clickable counts. */
    stats(): { opaque: number; shadow: number; clickable: number; shadowClickable: number }
    /** Switch to a pose live (like a state change from the app) and keep running. */
    live(pose: PoseName, dir: 1 | -1): void
    /** Cost of the last frames: milliseconds spent drawing (including waiting for the GPU to finish) and how many were drawn. */
    timing(): { avgMs: number; p95Ms: number; maxMs: number; frames: number }
    /** Simulate losing the GPU context (the page should fall back to the 2D sprite). */
    loseContext(): boolean
  }
}

const ELEVATION = (24 * Math.PI) / 180
/** World y that appears at the vertical centre of the view; chosen so the paws land just above the window's bottom edge. */
const TARGET_Y = 15.6

function geometryOf(m: MeshData): BufferGeometry {
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(m.positions, 3))
  g.setAttribute('normal', new BufferAttribute(m.normals, 3))
  g.setAttribute('color', new BufferAttribute(m.colors, 3))
  g.setIndex(new BufferAttribute(m.indices, 1))
  return g
}

export function createCat3D(canvas: HTMLCanvasElement, opts: Cat3DOptions = {}): Cat3D | null {
  const pixel = Math.max(1, Math.round(opts.pixel ?? 2))
  const size = Math.round(WINDOW_SIZE / pixel)
  let renderer: WebGLRenderer
  try {
    renderer = new WebGLRenderer({ canvas, alpha: true, antialias: false, premultipliedAlpha: true, powerPreference: 'low-power' })
  } catch {
    return null
  }
  const gl = renderer.getContext()
  if (!gl) return null
  renderer.setPixelRatio(1)
  renderer.setSize(size, size, false)
  renderer.setClearColor(0x000000, 0)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = PCFShadowMap

  const disposables: Array<{ dispose(): void }> = [renderer]
  const track = <T extends { dispose(): void }>(o: T): T => {
    disposables.push(o)
    return o
  }

  // ---------- scene ----------
  const scene = new Scene()
  const half = WINDOW_SIZE / PX_PER_UNIT / 2
  const camera = new OrthographicCamera(-half, half, half, -half, 1, 400)
  const dist = 150
  camera.position.set(0, TARGET_Y + Math.sin(ELEVATION) * dist, Math.cos(ELEVATION) * dist)
  camera.lookAt(0, TARGET_Y, 0)

  scene.add(new HemisphereLight(0xdbe7ff, 0x8a7a68, 1.5))
  scene.add(new AmbientLight(0xffffff, 0.35))
  const key = new DirectionalLight(0xfff3e0, 2.6)
  key.position.set(-22, 42, 30)
  key.castShadow = true
  key.shadow.mapSize.set(1024, 1024)
  const sc = key.shadow.camera
  sc.left = -24
  sc.right = 24
  sc.top = 24
  sc.bottom = -24
  sc.near = 5
  sc.far = 140
  key.shadow.bias = -0.0006
  key.shadow.normalBias = 0.05
  scene.add(key, key.target)
  const rim = new DirectionalLight(0xb4ccff, 2.4)
  rim.position.set(24, 20, -30)
  scene.add(rim)

  const coat = COATS[opts.coat ?? 'black']
  const palette = paletteFor(coat)
  const furMat = track(new MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0 }))
  const geoms = new Map<PartName, BufferGeometry>()
  const part = (name: PartName): Mesh => {
    let g = geoms.get(name)
    if (!g) {
      g = track(geometryOf(meshFromGrid(buildPart(name), palette, { jitter: 0.05 })))
      geoms.set(name, g)
    }
    const m = new Mesh(g, furMat)
    m.castShadow = true
    return m
  }

  // ---------- the cat ----------
  const root = new Group()
  scene.add(root)

  const torsoG = new Group()
  torsoG.add(part('torso'))
  root.add(torsoG)

  const headG = new Group()
  headG.rotation.order = 'YXZ'
  headG.add(part('head'))
  root.add(headG)
  const jawG = new Group()
  jawG.position.set(...(HEAD_FRAME.jaw as unknown as [number, number, number]))
  jawG.add(part('jaw'))
  headG.add(jawG)
  const earG: Record<'L' | 'R', Group> = { L: new Group(), R: new Group() }
  for (const side of ['L', 'R'] as const) {
    const g = earG[side]
    g.position.set(side === 'L' ? HEAD_FRAME.earX : -HEAD_FRAME.earX, HEAD_FRAME.earY, HEAD_FRAME.earZ)
    g.rotation.order = 'YXZ'
    g.add(part('ear'))
    headG.add(g)
  }
  const eyeMat = track(new MeshBasicMaterial({ color: coat.eye }))
  const pupilMat = track(new MeshBasicMaterial({ color: coat.pupil }))
  const eyeGeo = track(new BoxGeometry(1.9, 2.1, 1))
  const pupilGeo = track(new BoxGeometry(0.62, 1.9, 0.3))
  const lidGeo = track(new BoxGeometry(2, 0.4, 0.5))
  const headGrid = buildPart('head')
  const eyes: Array<{ g: Group; iris: Mesh; pupil: Mesh; lid: Mesh }> = []
  for (const side of [1, -1]) {
    const g = new Group()
    // sit the eye flush on the (blocky) face: its front plane just past the furthest-forward face voxel under it
    const front = faceFrontZ(headGrid, side * HEAD_FRAME.eyeX, HEAD_FRAME.eyeY, 1)
    g.position.set(side * HEAD_FRAME.eyeX, HEAD_FRAME.eyeY, front - 0.45)
    const iris = new Mesh(eyeGeo, eyeMat)
    const pupil = new Mesh(pupilGeo, pupilMat)
    pupil.position.z = 0.55
    const lid = new Mesh(lidGeo, pupilMat)
    lid.position.z = 0.3
    g.add(iris, pupil, lid)
    headG.add(g)
    eyes.push({ g, iris, pupil, lid })
  }

  const tailG = new Group()
  tailG.rotation.order = 'YXZ'
  root.add(tailG)
  const tailSegs: Group[] = []
  let parent: Group = tailG
  for (let i = 0; i < TAIL_SEGMENTS; i++) {
    const g = new Group()
    g.rotation.order = 'YXZ'
    if (i > 0) g.position.z = TAIL_SEGMENT_LENGTH
    g.add(part('tailSegment'))
    parent.add(g)
    tailSegs.push(g)
    parent = g
  }

  const legG = {} as Record<LegName, { upper: Group; lower: Group; paw: Group }>
  for (const leg of LEGS) {
    const front = leg[0] === 'F'
    const upper = new Group()
    upper.rotation.order = 'ZXY'
    upper.add(part(front ? 'frontUpper' : 'hindUpper'))
    const lower = new Group()
    lower.rotation.order = 'ZXY'
    lower.add(part(front ? 'frontLower' : 'hindLower'))
    const paw = new Group()
    paw.add(part('paw'))
    root.add(upper, lower, paw)
    legG[leg] = { upper, lower, paw }
  }

  // Ground: the cast shadow plus a soft blob so the cat always sits on something.
  const shadowPlane = new Mesh(track(new PlaneGeometry(90, 90)), track(new ShadowMaterial({ opacity: 0.3 })))
  shadowPlane.rotation.x = -Math.PI / 2
  shadowPlane.receiveShadow = true
  scene.add(shadowPlane)
  const blob = new Mesh(track(new CircleGeometry(1, 24)), track(new MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.16, depthWrite: false })))
  blob.rotation.x = -Math.PI / 2
  blob.position.y = 0.03
  root.add(blob)

  // ---------- decorations (fixed in the world, above the cat) ----------
  const decor = new Group()
  scene.add(decor)
  const dotMat = track(new MeshStandardMaterial({ color: 0x9dbbff, roughness: 0.55, emissive: 0x20315e }))
  const dotGeo = track(new BoxGeometry(1, 1, 1))
  const dots = [0, 1, 2].map((i) => {
    const m = new Mesh(dotGeo, dotMat)
    m.position.set(6.5 + i * 3.2, 28.5 + i * 2.8, 2)
    decor.add(m)
    return m
  })
    const glyphMaterial = (color: number): MeshStandardMaterial => {
    return track(new MeshStandardMaterial({ color, emissive: 0x1d3a66, roughness: 0.6, transparent: true, opacity: 0, depthWrite: false }))
  }
  const zGeo = track(geometryOf(meshFromGrid(buildZGlyph(), palette, { ao: false })))
  const zMeshes = [0, 1, 2].map(() => {
    const m = new Mesh(zGeo, glyphMaterial(0x8fb0ff))
    decor.add(m)
    return m
  })
  const arcRadii = [4, 6.8, 9.6]
  const arcMeshes = arcRadii.map((r) => {
    const g = track(geometryOf(meshFromGrid(buildArc(r, 0.85), palette, { ao: false })))
    const m = new Mesh(g, glyphMaterial(0x6fc0ff))
    m.position.set(9.5, 20.5, 3)
    decor.add(m)
    return m
  })

  // ---------- animation ----------
  const animator = new CatAnimator()
  let poseName: PoseName = 'idle'
  let dir: 1 | -1 = 1

  function applyPose(): void {
    const p = animator.pose()
    root.rotation.y = p.yaw

    torsoG.position.set(...p.torso.pos)
    torsoG.rotation.set(-p.torso.pitch, 0, p.torso.roll)
    torsoG.scale.set(1 + p.torso.breath * 0.5, 1 + p.torso.breath, 1 + p.torso.breath * 0.25)

    headG.position.set(...p.head.pos)
    headG.rotation.set(-p.head.pitch, p.head.yaw, p.head.roll)
    jawG.rotation.x = p.jaw
    for (const side of ['L', 'R'] as const) earG[side].rotation.set(p.ears[side].pitch, p.ears[side].yaw, p.ears[side].roll)

    const open = p.eyeOpen
    for (const e of eyes) {
      const shut = open < 0.14
      e.iris.visible = !shut
      e.pupil.visible = !shut
      e.lid.visible = shut
      e.g.scale.y = shut ? 1 : Math.max(0.2, open)
    }

    tailG.position.set(...p.tail.pos)
    tailG.rotation.set(-p.tail.basePitch, Math.PI + p.tail.baseYaw, 0)
    for (let i = 0; i < TAIL_SEGMENTS; i++) tailSegs[i]!.rotation.set(-p.tail.segs[i]!.pitch, p.tail.segs[i]!.yaw, 0)

    for (const leg of LEGS) {
      const L = p.legs[leg]
      const g = legG[leg]
      const showLeg = p.legScale > 0.03
      g.upper.visible = showLeg
      g.lower.visible = showLeg
      g.upper.scale.setScalar(Math.max(0.001, p.legScale))
      g.lower.scale.setScalar(Math.max(0.001, p.legScale))
      g.upper.position.set(...L.root)
      g.upper.rotation.set(-L.upperAngle, 0, L.roll)
      g.lower.position.set(...L.knee)
      g.lower.rotation.set(-L.lowerAngle, 0, L.roll)
      g.paw.position.set(...L.foot)
      g.paw.rotation.set(L.tilt, 0, 0)
    }

    blob.scale.set(6 + 2 * p.stretch, 7 + 6 * p.stretch, 1)
    blob.position.z = p.torso.pos[2] + 5.5 + 3 * p.stretch

    // decorations
    const t = animator.t
    decor.visible = p.decor.dots + p.decor.zzz + p.decor.waves > 0.01
    for (let i = 0; i < 3; i++) {
      const dot = dots[i]!
      dot.visible = p.decor.dots > 0.01
      const s = (0.9 + i * 0.35) * p.decor.dots * (0.65 + 0.35 * Math.sin(Math.PI * 2 * (t * 0.9 - i * 0.22)))
      dot.scale.setScalar(Math.max(0.001, s))
      dot.rotation.y = t * 0.8
    }
    for (let i = 0; i < 3; i++) {
      const z = zMeshes[i]!
      const u = (t / 3.4 + i / 3) % 1
      const mat = z.material as MeshStandardMaterial
      mat.opacity = Math.sin(Math.PI * u) * p.decor.zzz
      z.visible = mat.opacity > 0.02
      z.position.set(3.5 + 6 * u + i * 0.6, 12.5 + 12 * u, 3)
      z.scale.setScalar((0.45 + 0.5 * u) * 0.8)
    }
    for (let i = 0; i < 3; i++) {
      const a = arcMeshes[i]!
      const u = (t * 0.9 - i * 0.28) % 1
      const f = u < 0 ? u + 1 : u
      const mat = a.material as MeshStandardMaterial
      mat.opacity = p.decor.waves * Math.sin(Math.PI * f) * 0.9
      a.visible = mat.opacity > 0.02
      a.scale.setScalar(0.85 + 0.25 * f)
    }
  }

  // ---------- drawing, hit mask, frame policy ----------
  const pixels = new Uint8Array(size * size * 4)
  let mask = new Uint8Array(size * size)
  let frames = 0
  const recent = new Float32Array(120)
  function draw(): void {
    const t0 = performance.now()
    applyPose()
    renderer.render(scene, camera)
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    const next = new Uint8Array(size * size)
    for (let i = 0; i < size * size; i++) next[i] = pixels[i * 4 + 3]! >= 170 ? 1 : 0
    // grown by a few rendered pixels all round, so clicks near the edge (ears, tail, paws) still catch him
    mask = growMask(next, size, GRAB_PX)
    recent[frames % recent.length] = performance.now() - t0
    frames++
    if (frames % 10 === 0) canvas.dataset['frames'] = String(frames)
  }

  /**
   * Target frame interval. The pet window itself only moves 30 times a second, so drawing faster than that is wasted work
   * (and each frame waits for the GPU to hand the picture back for hit-testing): 30 fps while walking, carried or changing pose,
   * 20 fps for a cat that is just sitting, 4 fps for one that is asleep (resting at home: slow breathing, nearly free). The clock still steps every frame, so motion stays smooth in time.
   */
  function interval(): number {
    const w = animator.weights
    const settling = w[poseName] < 0.995 || Math.abs(animator.yawSpeed) > 0.02
    if (settling || poseName === 'walk' || poseName === 'carried') return 1000 / 30
    return poseName === 'sleeping' ? 1000 / 4 : 1000 / 20
  }

  let raf = 0
  let last = performance.now()
  let acc = 0
  let paused = false
  let disposed = false
  /** Asleep and settled: the picture is final, so the loop stops altogether (no timers, no drawing) until the pose changes. */
  let frozen = false
  function frame(now: number): void {
    if (disposed) return
    raf = requestAnimationFrame(frame)
    if (paused) return
    const dt = (now - last) / 1000
    acc += now - last
    last = now
    animator.step(dt, poseName, dir)
    if (acc < interval() - 1) return // keep stepping the clock every frame; only drawing is throttled
    acc = 0
    draw()
    if (poseName === 'sleeping' && animator.weights.sleeping >= 0.995 && Math.abs(animator.yawSpeed) < 0.02) {
      cancelAnimationFrame(raf)
      frozen = true
    }
  }
  const thaw = (): void => {
    if (!frozen || disposed) return
    frozen = false
    last = performance.now()
    acc = 0
    raf = requestAnimationFrame(frame)
  }
  raf = requestAnimationFrame(frame)

  const lost = (e: Event): void => {
    e.preventDefault()
    cat.onLost?.()
  }
  canvas.addEventListener('webglcontextlost', lost)

  const cat: Cat3D = {
    onLost: null,
    setState(mode, d, dragging) {
      dir = d
      poseName = dragging ? 'carried' : (animationFor(mode) as PoseName)
      canvas.dataset['pose'] = poseName
      thaw()
    },
    hit(x, y) {
      const px = Math.floor((x * size) / WINDOW_SIZE)
      const py = Math.floor((y * size) / WINDOW_SIZE)
      if (px < 0 || py < 0 || px >= size || py >= size) return false
      return mask[(size - 1 - py) * size + px] === 1
    },
    dispose() {
      disposed = true
      cancelAnimationFrame(raf)
      canvas.removeEventListener('webglcontextlost', lost)
      for (const d of disposables) d.dispose()
    },
    debug: {
      freeze(pose, d, t) {
        paused = true
        poseName = pose
        dir = d
        animator.settle(pose, d, t)
        draw()
      },
      resume() {
        paused = false
        last = performance.now()
        thaw()
      },
      frames: () => frames,
      pose: () => poseName,
      size: () => size,
      weights: () => ({ ...animator.weights }),
      yaw: () => animator.yaw,
      bodyPoint() {
        let n = 0
        let cx = 0
        let cy = 0
        for (let y = 0; y < size; y++)
          for (let x = 0; x < size; x++)
            if (mask[(size - 1 - y) * size + x]) {
              n++
              cx += x
              cy += y
            }
        if (!n) return null
        cx /= n
        cy /= n
        let best: [number, number] | null = null
        let bd = Infinity
        for (let y = 0; y < size; y++)
          for (let x = 0; x < size; x++)
            if (mask[(size - 1 - y) * size + x]) {
              const d = (x - cx) ** 2 + (y - cy) ** 2
              if (d < bd) {
                bd = d
                best = [x, y]
              }
            }
        return best ? [(best[0] + 0.5) * pixel, (best[1] + 0.5) * pixel] : null
      },
      stats() {
        let opaque = 0
        let shadow = 0
        let clickable = 0
        let shadowClickable = 0
        for (let i = 0; i < size * size; i++) {
          const a = pixels[i * 4 + 3]!
          const m = mask[i]!
          if (a >= 170) opaque++
          else if (a >= 20) {
            shadow++
            if (m) shadowClickable++ // only the one-pixel grab margin around the cat may count here
          }
          if (m) clickable++
        }
        return { opaque, shadow, clickable, shadowClickable }
      },
      live(pose, d) {
        poseName = pose
        dir = d
        paused = false
        last = performance.now()
        thaw()
      },
      timing() {
        const n = Math.min(frames, recent.length)
        const xs = Array.from(recent.subarray(0, n)).sort((a, b) => a - b)
        const avg = xs.reduce((a, b) => a + b, 0) / Math.max(1, n)
        return { avgMs: avg, p95Ms: xs[Math.floor(n * 0.95)] ?? 0, maxMs: xs[n - 1] ?? 0, frames }
      },
      loseContext() {
        const ext = gl.getExtension('WEBGL_lose_context')
        ext?.loseContext()
        return ext !== null
      }
    }
  }
  draw()
  return cat
}
