/**
 * The standing figure (the "figure" view): the black voxel cat, with a person's posture and expressions. He stands and walks on
 * his hind legs, uses his front legs as arms (one holds a little pink phone), and his eyes have lids, so he can look half-asleep,
 * interested, wide-eyed or shut. Voxel parts, lit like the 3D cat, drawn at low resolution and scaled up without smoothing.
 *
 * Animation is procedural: every mode has a target for each joint, the joints ease towards it, and a clock adds the motion
 * (walk cycle, breathing, talking mouth, gestures). Same contract as the four-legged cat (createCat3D), so main.ts can use either.
 */
import {
  AmbientLight, BoxGeometry, BufferAttribute, BufferGeometry, CircleGeometry, DirectionalLight, Group, HemisphereLight, Mesh, MeshBasicMaterial,
  MeshStandardMaterial, Object3D, OrthographicCamera, Scene, SphereGeometry, WebGLRenderer, type Material
} from 'three'
import type { Heading, Mode } from '../shared/brain'
import { growMask } from '../shared/grab-mask'
import { WALK_SPEED } from '../shared/brain'
import { faceFrontZ } from '../shared/cat3d/cat-model'
import { buildFigurePart, FIG_FRAME, FIG_LEG, FIG_TAIL_LENGTH, FIG_TAIL_SEGMENTS } from '../shared/cat3d/figure-model'
import { compileSpec, type CompiledSpec, type PetSpec, type SpecPart } from '../shared/cat3d/pet-spec'
import { meshFromGrid, type MeshData } from '../shared/cat3d/voxels'
import { animationFor, WINDOW_SIZE } from '../shared/sprite'
import type { Cat3D } from './cat3d'

/** How far the click area reaches past the drawn cat, in rendered pixels (5-6 CSS pixels). */
const GRAB_PX = 4

export interface Figure3DOptions {
  /** CSS pixels per rendered pixel (2 = chunky, the default). The figure is drawn a little finer than that so his face survives. */
  pixel?: number
}

type Pose = 'idle' | 'walk' | 'curious' | 'thinking' | 'speaking' | 'listening' | 'sleeping' | 'carried' | 'eating'
const POSES: readonly Pose[] = ['idle', 'walk', 'curious', 'thinking', 'speaking', 'listening', 'sleeping', 'carried', 'eating']

/** Everything a pose sets. Angles in radians. */
interface Joints {
  hipY: number // height of the hips above the ground
  lean: number // torso pitch (+ = forward)
  headTilt: number // roll (+ = towards his left)
  headNod: number // pitch (+ = looking down)
  lArmZ: number // left (+x) arm out to the side
  lArmX: number // left arm forward (-) / back (+)
  lElbow: number // left forearm bend (- = bend forward/up)
  rArmZ: number // right (-x) arm out to the side (- = out)
  rArmX: number
  rElbow: number
  lLeg: number // leg swing (- = forward)
  rLeg: number
  eye: number // eyelids: 0 shut, 0.6 half-lidded (his relaxed look), 1 wide open
  ears: number // ear perk (+ = up and forward), - = flattened
  tail: number // tail swing
}

const LEG = FIG_LEG
const BASE: Joints = { hipY: LEG, lean: 0, headTilt: 0, headNod: 0, lArmZ: 0.12, lArmX: 0, lElbow: -0.25, rArmZ: -0.12, rArmX: 0, rElbow: -0.25, lLeg: 0, rLeg: 0, eye: 0.6, ears: 0, tail: 0 }

/** The still part of each pose (the clock adds motion on top in `animate`). */
const TARGET: Record<Pose, Partial<Joints>> = {
  // relaxed, a paw raised in a little "hey", the phone held low in the other
  idle: { lArmZ: 0.5, lArmX: -0.25, lElbow: -1.9, rArmZ: -0.5, rArmX: -0.1, rElbow: -0.5 },
  walk: { rArmZ: -0.2, rArmX: -0.35, rElbow: -1.3, lArmZ: 0.15, eye: 0.7 },
  curious: { headTilt: 0.3, eye: 1, ears: 0.6, lArmZ: 0.2, lElbow: -0.4, rArmZ: -0.25, rElbow: -1.1, rArmX: -0.3 },
  // a paw cupped by the ear
  listening: { headTilt: -0.24, eye: 0.85, ears: 0.8, lArmZ: 1.0, lArmX: -0.2, lElbow: -2.4, rArmZ: -0.25, rArmX: -0.3, rElbow: -1.1 },
  // paw on chin, looking up
  thinking: { headNod: -0.2, headTilt: 0.14, eye: 0.45, lArmZ: 0.1, lArmX: -0.8, lElbow: -2.3, rArmZ: -0.25, rArmX: -0.3, rElbow: -1.1 },
  speaking: { eye: 0.8, ears: 0.3, lArmZ: 0.45, lArmX: -0.3, lElbow: -1.4, rArmZ: -0.3, rArmX: -0.35, rElbow: -1.2 },
  // sitting with his legs out, head dropped, eyes shut, ears drooping
  sleeping: { hipY: 1.6, lean: -0.1, headNod: 0.4, headTilt: 0.2, eye: 0, ears: -0.5, lLeg: -1.45, rLeg: -1.35, lArmZ: 0.15, lArmX: -0.45, lElbow: -0.5, rArmZ: -0.15, rArmX: -0.5, rElbow: -0.6 },
  // held up: legs dangle, arms out, eyes wide
  carried: { eye: 1, ears: 0.5, lArmZ: 0.9, lElbow: -0.6, rArmZ: -0.9, rElbow: -0.6, headNod: 0.1 },
  // crouched over a fish, both paws to his mouth, eyes squeezed happy, chomping
  eating: { hipY: LEG - 0.5, lean: 0.12, headNod: 0.28, eye: 0.15, ears: 0.5, lLeg: -0.25, rLeg: -0.15, lArmZ: 0.3, lArmX: -0.9, lElbow: -1.7, rArmZ: -0.3, rArmX: -0.9, rElbow: -1.7 }
}

const ELEVATION = (14 * Math.PI) / 180
/** World units visible from the window's centre to its edge, and the height that sits in the middle. */
const HALF = 12.6
const TARGET_Y = 11.4
/** How fast joints ease towards a new pose (1/s). */
const EASE = 7

function geometryOf(m: MeshData): BufferGeometry {
  const g = new BufferGeometry()
  g.setAttribute('position', new BufferAttribute(m.positions, 3))
  g.setAttribute('normal', new BufferAttribute(m.normals, 3))
  g.setAttribute('color', new BufferAttribute(m.colors, 3))
  g.setIndex(new BufferAttribute(m.indices, 1))
  return g
}

export function createFigure3D(canvas: HTMLCanvasElement, opts: Figure3DOptions = {}): Cat3D | null {
  const pixel = Math.max(1, Math.round(opts.pixel ?? 2))
  const size = Math.round(WINDOW_SIZE / Math.max(1, pixel * 0.7))
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

  const disposables: Array<{ dispose(): void }> = [renderer]
  const track = <T extends { dispose(): void }>(o: T): T => {
    disposables.push(o)
    return o
  }

  // ---------- scene and light (as for the four-legged cat) ----------
  const scene = new Scene()
  const camera = new OrthographicCamera(-HALF, HALF, HALF, -HALF, 1, 400)
  camera.position.set(0, TARGET_Y + Math.sin(ELEVATION) * 150, Math.cos(ELEVATION) * 150)
  camera.lookAt(0, TARGET_Y, 0)
  scene.add(new HemisphereLight(0xdbe7ff, 0x8a7a68, 1.5))
  scene.add(new AmbientLight(0xffffff, 0.35))
  const key = new DirectionalLight(0xfff3e0, 2.6)
  key.position.set(-22, 42, 30)
  scene.add(key)
  const rim = new DirectionalLight(0xb4ccff, 2.4)
  rim.position.set(24, 20, -30)
  scene.add(rim)

  // The look comes from a pet spec (null = the default black cat); `applySpec` rebuilds it live.
  let look: CompiledSpec = compileSpec(null)
  const furMat = track(new MeshStandardMaterial({ vertexColors: true, roughness: 0.5, metalness: 0 }))
  const flat = (color: string, opacity = 1): MeshBasicMaterial =>
    track(new MeshBasicMaterial({ color, ...(opacity < 1 ? { transparent: true, opacity, depthWrite: false } : {}) }))
  const geoms = new Map<SpecPart, BufferGeometry>()
  const partMeshes = new Map<SpecPart, Mesh[]>()
  const buildGeom = (name: SpecPart): BufferGeometry => geometryOf(meshFromGrid(buildFigurePart(name as never, look.shapes[name]), look.palette, { jitter: 0.05 }))
  const part = (name: SpecPart, parent: Object3D, at: [number, number, number] = [0, 0, 0]): Mesh => {
    let g = geoms.get(name)
    if (!g) {
      g = buildGeom(name)
      geoms.set(name, g)
    }
    const m = new Mesh(g, furMat)
    m.position.set(...at)
    parent.add(m)
    partMeshes.set(name, [...(partMeshes.get(name) ?? []), m])
    return m
  }
  const mesh = (g: BufferGeometry, m: Material, parent: Object3D, at: [number, number, number] = [0, 0, 0]): Mesh => {
    const o = new Mesh(track(g), m)
    o.position.set(...at)
    parent.add(o)
    return o
  }

  // ---------- the figure ----------
  const root = new Group()
  scene.add(root)
  const shadow = mesh(new CircleGeometry(3.6, 24), flat('#000000', 0.18), scene, [0, 0.02, 0])
  shadow.rotation.x = -Math.PI / 2
  shadow.scale.set(1, 0.6, 1)

  const hips = new Group()
  root.add(hips)
  const torso = part('torso', hips)

  const head = new Group()
  head.position.set(0, FIG_FRAME.neck, 0)
  hips.add(head)
  part('head', head)
  const ear = (side: 1 | -1): Group => {
    const g = new Group()
    g.position.set(side * FIG_FRAME.earX, FIG_FRAME.earY, -0.3)
    g.rotation.order = 'YXZ'
    part('ear', g)
    head.add(g)
    return g
  }
  const earL = ear(1)
  const earR = ear(-1)

  // eyes with lids: yellow, a slit pupil, and a fur-coloured lid that comes down over them (half-lidded is his relaxed look)
  let headGrid = buildFigurePart('head', look.shapes.head)
  const eyeMat = flat(look.coat.eye)
  const pupilMat = flat(look.coat.pupil)
  const lidMat = track(new MeshStandardMaterial({ color: look.coat.fur, roughness: 0.55 }))
  const mouthMat = flat(look.coat.mouth)
  const noseMat = flat(look.coat.nose)
  const eyeGroups: Group[] = []
  const EYE_H = 1.9
  const eyes: Array<{ pupil: Mesh; lid: Mesh }> = []
  for (const side of [1, -1] as const) {
    const g = new Group()
    const front = faceFrontZ(headGrid, side * FIG_FRAME.eyeX, FIG_FRAME.eyeY, 1)
    g.position.set(side * FIG_FRAME.eyeX, FIG_FRAME.eyeY, front - 0.45)
    g.userData['side'] = side
    eyeGroups.push(g)
    head.add(g)
    mesh(new BoxGeometry(1.7, EYE_H, 1), eyeMat, g)
    const pupil = mesh(new BoxGeometry(0.6, 1.7, 0.3), pupilMat, g, [side * -0.15, 0, 0.55])
    const lid = mesh(new BoxGeometry(1.9, 1, 0.6), lidMat, g, [0, EYE_H / 2, 0.35])
    eyes.push({ pupil, lid })
  }
  // an open mouth while he talks (the closed one is part of the head)
  const mouthOpen = mesh(new BoxGeometry(1.0, 0.8, 0.3), mouthMat, head, [0, 1.5, faceFrontZ(headGrid, 0, 1.5, 0.5) - 0.05])
  mouthOpen.visible = false
  const nose = mesh(new BoxGeometry(0.9, 0.55, 0.4), noseMat, head, [0, 2.45, faceFrontZ(headGrid, 0, 2.4, 0.5) + 0.05])

  // thought dots (thinking only)
  const dots = new Group()
  dots.position.set(3.4, 7.4, 1)
  head.add(dots)
  const dotList = [0, 1, 2].map((i) => mesh(new BoxGeometry(0.9, 0.9, 0.9), flat('#ffffff'), dots, [i * 1.3, i * 1.0, 0]))

  // arms (his front legs): shoulder -> upper arm, elbow -> forearm and paw
  const arm = (side: 1 | -1): { shoulder: Group; elbow: Group } => {
    const shoulder = new Group()
    shoulder.position.set(side * FIG_FRAME.shoulderX, FIG_FRAME.shoulderY, 0)
    hips.add(shoulder)
    part('upperArm', shoulder)
    const elbow = new Group()
    elbow.position.set(0, -2.6, 0)
    shoulder.add(elbow)
    part('foreArm', elbow)
    return { shoulder, elbow }
  }
  const armL = arm(1)
  const armR = arm(-1)
  // the little pink phone, in his right paw
  const phone = new Group()
  phone.position.set(-0.3, -2.6, 0.7)
  phone.rotation.set(0.1, -0.6, 0.2)
  armR.elbow.add(phone)
  part('phone', phone)

  const leg = (side: 1 | -1): Group => {
    const g = new Group()
    g.position.set(side * FIG_FRAME.hipX, 0, 0)
    hips.add(g)
    part('leg', g)
    return g
  }
  const legL = leg(1)
  const legR = leg(-1)

  // tail: a chain of segments that curls down, out and up at the tip
  const tail = new Group()
  tail.position.set(...FIG_FRAME.tail)
  tail.rotation.order = 'YXZ'
  hips.add(tail)
  const tailSegs: Group[] = []
  let parentSeg: Group = tail
  for (let i = 0; i < FIG_TAIL_SEGMENTS; i++) {
    const g = new Group()
    g.rotation.order = 'YXZ'
    if (i > 0) g.position.z = FIG_TAIL_LENGTH
    part('tailSegment', g)
    parentSeg.add(g)
    tailSegs.push(g)
    parentSeg = g
  }
  // an optional extra piece on the end of the tail (empty unless a pet spec adds one)
  const tailTip = part('tailTip', tailSegs[tailSegs.length - 1]!, [0, 0, FIG_TAIL_LENGTH])

  /** Restyle the figure from a pet spec (or back to the default with null): new colours, new voxel parts, hidden parts, size. */
  function applySpec(spec: PetSpec | null): void {
    look = compileSpec(spec)
    for (const [name, g] of geoms) {
      const next = track(buildGeom(name))
      for (const m of partMeshes.get(name) ?? []) m.geometry = next
      geoms.set(name, next)
      g.dispose()
    }
    for (const [name, meshes] of partMeshes) for (const m of meshes) m.visible = !look.hidden.has(name) && (name !== 'tailTip' || look.shapes.tailTip.length > 0)
    headGrid = buildFigurePart('head', look.shapes.head)
    for (const g of eyeGroups) {
      const side = g.userData['side'] as number
      g.position.z = faceFrontZ(headGrid, side * FIG_FRAME.eyeX, FIG_FRAME.eyeY, 1) - 0.45
    }
    mouthOpen.position.z = faceFrontZ(headGrid, 0, 1.5, 0.5) - 0.05
    nose.position.z = faceFrontZ(headGrid, 0, 2.4, 0.5) + 0.05
    eyeMat.color.set(look.coat.eye)
    pupilMat.color.set(look.coat.pupil)
    lidMat.color.set(look.coat.fur)
    mouthMat.color.set(look.coat.mouth)
    noseMat.color.set(look.coat.nose)
    root.scale.setScalar(look.scale)
    maskAt = -1e9 // the click mask must be read again
  }
  tailTip.visible = false

  // ---------- animation ----------
  let mode: Pose = 'idle'
  let dir: 1 | -1 = 1
  let heading: Heading = 'side'
  const j: Joints = { ...BASE, ...TARGET.idle }
  let yaw = 0.25
  let t = 0
  let walkPhase = 0
  let blinkAt = 3
  // a cycle that covers the ground at the walking speed: each step moves the planted foot back by about 2*LEG*sin(swing)
  const SWING = 0.38
  const pxPerUnit = WINDOW_SIZE / (2 * HALF)
  const gaitHz = WALK_SPEED / pxPerUnit / (4 * LEG * Math.sin(SWING))

  function targetFor(p: Pose): Joints {
    return { ...BASE, ...TARGET[p] }
  }
  function settle(p: Pose, d: 1 | -1, at: number): void {
    mode = p
    dir = d
    Object.assign(j, targetFor(p))
    yaw = yawFor(p, d)
    t = at
    walkPhase = at * gaitHz * Math.PI * 2
    animate(0)
  }
  function yawFor(p: Pose, d: 1 | -1): number {
    if (p === 'walk' && heading === 'toward') return d * 0.2 // coming down the screen: facing you
    if (p === 'walk' && heading === 'away') return d * (Math.PI - 0.25) // going up: his back, a little turned
    if (p === 'walk') return d * 1.1 // three-quarter profile towards where he is going
    if (p === 'eating') return d * 0.9 // turned to the fish
    if (p === 'sleeping') return d * 0.4
    return d * 0.3
  }

  function animate(dt: number): void {
    t += dt
    const target = targetFor(mode)
    const k = 1 - Math.exp(-EASE * dt)
    for (const key of Object.keys(j) as Array<keyof Joints>) j[key] += (target[key] - j[key]) * k
    yaw += (yawFor(mode, dir) - yaw) * (1 - Math.exp(-5 * dt))

    const s = Math.sin
    let bob = 0
    let lLeg = j.lLeg
    let rLeg = j.rLeg
    let lArmX = j.lArmX
    let rArmX = j.rArmX
    let lArmZ = j.lArmZ
    let lElbow = j.lElbow
    let headNod = j.headNod
    let headTilt = j.headTilt
    let tailSwing = j.tail + 0.15 * s(t * 1.3)
    const breathe = mode === 'sleeping' ? 0.03 * s(t * 1.4) : 0.012 * s(t * 2.2)

    if (mode === 'walk') {
      walkPhase += dt * gaitHz * Math.PI * 2
      const w = s(walkPhase)
      lLeg += -SWING * w
      rLeg += SWING * w
      lArmX += 0.45 * w
      rArmX += -0.12 * w
      bob = 0.3 * Math.abs(Math.cos(walkPhase))
      tailSwing += 0.3 * s(walkPhase)
      headTilt += 0.05 * s(walkPhase)
    } else if (mode === 'eating') {
      headNod += 0.12 * Math.abs(s(t * 7)) // chomp chomp
      lElbow += 0.15 * s(t * 7)
      tailSwing += 0.35 * s(t * 3) // happy tail
    } else if (mode === 'speaking') {
      lArmZ += 0.18 * s(t * 3.1)
      lElbow += 0.35 * s(t * 2.3 + 1)
      headNod += 0.06 * s(t * 4.2)
      headTilt += 0.05 * s(t * 1.7)
    } else if (mode === 'carried') {
      lLeg += 0.3 * s(t * 3)
      rLeg += -0.3 * s(t * 3 + 0.6)
      tailSwing += 0.35 * s(t * 2.4)
    } else if (mode === 'idle' || mode === 'curious') {
      headTilt += 0.04 * s(t * 0.7)
      lArmZ += 0.05 * s(t * 1.1)
    } else if (mode === 'listening') {
      headTilt += 0.05 * s(t * 1.2)
    } else if (mode === 'thinking') {
      headTilt += 0.06 * s(t * 0.9)
    }

    root.rotation.y = yaw
    hips.position.y = j.hipY + bob
    hips.rotation.x = j.lean
    torso.scale.y = 1 + breathe
    head.rotation.set(headNod, 0, headTilt)
    head.position.y = FIG_FRAME.neck + breathe * 3
    armL.shoulder.rotation.set(lArmX, 0, lArmZ)
    armL.elbow.rotation.set(lElbow, 0, 0)
    armR.shoulder.rotation.set(rArmX, 0, j.rArmZ)
    armR.elbow.rotation.set(j.rElbow, 0, 0)
    legL.rotation.x = lLeg
    legR.rotation.x = rLeg
    // tail: hangs back and down from the rump, then curls up towards the tip, swishing side to side
    tail.rotation.set(0.9, tailSwing, 0)
    tailSegs.forEach((g, i) => {
      if (i === 0) return
      g.rotation.set(-0.22 - (i > 4 ? 0.12 : 0), 0.08 * s(t * 1.6 - i * 0.5), 0)
    })
    // ears: perk up and forward when interested, droop when asleep, with a little twitch
    const tw = mode === 'sleeping' ? 0 : 0.04 * s(t * 2.1) * (s(t * 0.37) > 0.8 ? 3 : 1)
    earL.rotation.set(-j.ears * 0.25, 0, -0.32 + j.ears * 0.12 - Math.max(0, -j.ears) * 0.5 + tw)
    earR.rotation.set(-j.ears * 0.25, 0, 0.32 - j.ears * 0.12 + Math.max(0, -j.ears) * 0.5)

    // eyelids: half down when relaxed, up when interested, shut asleep, and a blink now and then
    let open = j.eye
    if (mode !== 'sleeping') {
      if (t > blinkAt) blinkAt = t + 2.5 + ((t * 7.31) % 3)
      if (blinkAt - t > 2.4 && blinkAt - t < 2.55) open = 0
    }
    const covered = Math.min(1, Math.max(0, 1 - open)) * EYE_H
    for (const e of eyes) {
      e.lid.visible = covered > 0.05
      e.lid.scale.y = Math.max(0.01, covered)
      e.lid.position.y = EYE_H / 2 - covered / 2
      e.pupil.scale.x = mode === 'carried' || mode === 'curious' ? 1.6 : 1 // round pupils when surprised
    }
    // mouth: open and moving while he talks
    const talking = mode === 'speaking' || mode === 'eating'
    mouthOpen.visible = talking
    if (talking) mouthOpen.scale.y = mode === 'eating' ? 0.2 + 0.8 * Math.abs(s(t * 7)) : 0.3 + 0.9 * Math.abs(s(t * 9.5) * s(t * 3.7 + 0.5))
    dots.visible = mode === 'thinking'
    if (dots.visible) dotList.forEach((d, i) => d.scale.setScalar(0.6 + 0.4 * Math.max(0, s(t * 3 - i * 0.9))))
    shadow.scale.set(mode === 'carried' ? 0.6 : 1, 0.6, 1)
  }

  // ---------- drawing, hit mask, frame policy (as in the 3D cat) ----------
  const pixels = new Uint8Array(size * size * 4)
  let mask = new Uint8Array(size * size)
  let maskAt = -Infinity
  let frames = 0
  const recent = new Float32Array(120)
  function draw(): void {
    const t0 = performance.now()
    renderer.render(scene, camera)
    recent[frames % recent.length] = performance.now() - t0
    frames++
    if (frames % 10 === 0) canvas.dataset['frames'] = String(frames)
  }

  /**
   * The click-through mask is read back from the GPU only when someone asks (the pointer is over the pet, or a test), never per frame:
   * reading pixels stalls until the GPU is done, and nobody needs the mask while the pointer is elsewhere. Re-rendering inside the
   * call keeps the drawing buffer readable, and a mask younger than one frame is reused.
   */
  function ensureMask(force = false): void {
    const now = performance.now()
    if (!force && now - maskAt < 33) return
    renderer.render(scene, camera)
    gl.readPixels(0, 0, size, size, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    const next = new Uint8Array(size * size)
    for (let i = 0; i < size * size; i++) next[i] = pixels[i * 4 + 3]! >= 170 ? 1 : 0
    // grown by a few rendered pixels all round, so clicks near the edge (ears, tail, paws) still catch him
    mask = growMask(next, size, GRAB_PX)
    maskAt = now
  }

  /** 24 fps while moving or talking, 12 while standing about, 4 asleep: enough for chunky voxel animation. */
  const interval = (): number => (mode === 'walk' || mode === 'speaking' || mode === 'carried' ? 1000 / 24 : mode === 'sleeping' ? 1000 / 4 : 1000 / 12)

  let raf = 0
  let last = performance.now()
  let acc = 0
  let paused = false
  let disposed = false
  function frame(now: number): void {
    if (disposed) return
    raf = requestAnimationFrame(frame)
    if (paused) return
    // nobody can see him (window hidden or on another Space): draw nothing; the loop itself costs next to nothing
    if (document.visibilityState === 'hidden') {
      last = now
      return
    }
    acc += now - last
    last = now
    if (acc < interval() - 1) return
    animate(Math.min(acc, 100) / 1000)
    acc = 0
    draw()
  }
  raf = requestAnimationFrame(frame)

  const lost = (e: Event): void => {
    e.preventDefault()
    fig.onLost?.()
  }
  canvas.addEventListener('webglcontextlost', lost)

  const poseOf = (m: string): Pose => ((POSES as readonly string[]).includes(m) ? (m as Pose) : 'idle')
  const fig: Cat3D = {
    onLost: null,
    setSpec(spec) {
      applySpec(spec)
    },
    setState(m: Mode, d, dragging, h) {
      dir = d
      heading = h ?? 'side'
      mode = dragging ? 'carried' : m === 'eating' ? 'eating' : poseOf(animationFor(m))
      canvas.dataset['pose'] = mode
    },
    hit(x, y) {
      const px = Math.floor((x * size) / WINDOW_SIZE)
      const py = Math.floor((y * size) / WINDOW_SIZE)
      if (px < 0 || py < 0 || px >= size || py >= size) return false
      ensureMask()
      return mask[(size - 1 - py) * size + px] === 1
    },
    dispose() {
      disposed = true
      cancelAnimationFrame(raf)
      canvas.removeEventListener('webglcontextlost', lost)
      for (const d of disposables) d.dispose()
    },
    debug: {
      freeze(pose, d, at) {
        paused = true
        // "walk-toward" / "walk-away": the walk seen coming down / going up the screen
        const [p, h] = String(pose).split('-')
        heading = h === 'toward' || h === 'away' ? h : 'side'
        settle(poseOf(p ?? pose), d, at)
        draw()
        ensureMask(true)
      },
      resume() {
        paused = false
        last = performance.now()
      },
      frames: () => frames,
      pose: () => mode as never,
      size: () => size,
      weights: () => Object.fromEntries(POSES.map((p) => [p, p === mode ? 1 : 0])) as never,
      yaw: () => yaw,
      bodyPoint() {
        // the middle of his tummy: always solid, never the face or the phone
        ensureMask(true)
        let best: [number, number] | null = null
        let bd = Infinity
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
        for (let y = 0; y < size; y++)
          for (let x = 0; x < size; x++)
            if (mask[(size - 1 - y) * size + x]) {
              const dd = (x - cx) ** 2 + (y - cy) ** 2
              if (dd < bd) {
                bd = dd
                best = [x, y]
              }
            }
        const scale = WINDOW_SIZE / size
        return best ? [(best[0] + 0.5) * scale, (best[1] + 0.5) * scale] : null
      },
      stats() {
        ensureMask(true)
        let opaque = 0
        let shadowPx = 0
        let clickable = 0
        let shadowClickable = 0
        for (let i = 0; i < size * size; i++) {
          const a = pixels[i * 4 + 3]!
          const m = mask[i]!
          if (a >= 170) opaque++
          else if (a >= 20) {
            shadowPx++
            if (m) shadowClickable++
          }
          if (m) clickable++
        }
        return { opaque, shadow: shadowPx, clickable, shadowClickable }
      },
      live(pose, d) {
        mode = poseOf(pose)
        dir = d
        paused = false
        last = performance.now()
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
  animate(0)
  draw()
  return fig
}
