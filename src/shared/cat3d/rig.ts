/**
 * The 3D cat's skeleton and animation, as pure maths (no WebGL), so it can be unit-tested.
 *
 * Every pet mode is a *pose*: a table of numbers (body height and tilt, where the feet go, how the head is held, ears, tail...).
 * The animator keeps a weight per pose and eases the weights toward the current mode, so changing mode is always a smooth
 * blend of every joint at once (sit -> walk -> sleep never snaps). On top of the blended pose, small procedural motions run
 * on a clock: breathing, blinking, ear flicks, a tail that follows through, a walk cycle with real two-bone leg IK, and jaw
 * movement while speaking. Body yaw is a critically damped spring, so turning around swings through the camera.
 */
import { WALK_SPEED } from '../brain'
import { CAT_ZOOM } from '../sprite'
import { BONES, HEAD_FRAME, TAIL_SEGMENTS, TORSO_FRAME } from './cat-model'

export type Vec3 = [number, number, number]

/** The view: how many screen pixels one voxel covers at the pet window's native size. Shared with the renderer. */
export const PX_PER_UNIT = 4.3 * CAT_ZOOM

export const POSE_NAMES = ['idle', 'walk', 'curious', 'thinking', 'speaking', 'sleeping', 'listening', 'carried'] as const
export type PoseName = (typeof POSE_NAMES)[number]
export const LEGS = ['FL', 'FR', 'HL', 'HR'] as const
export type LegName = (typeof LEGS)[number]

export interface PoseParams {
  // posture
  hipY: number
  pitch: number
  shiftZ: number
  fFootZ: number
  fFootY: number
  fSpread: number
  hFootZ: number
  hFootY: number
  hSpread: number
  // walk cycle
  stride: number
  lift: number
  bob: number
  swing: number
  // head
  headPitch: number
  headLook: number
  headRoll: number
  headTurn: number
  nod: number
  jaw: number
  eyeOpen: number
  blink: number
  // ears
  earPitch: number
  earSpread: number
  earSwivel: number
  earFlick: number
  // tail
  tailPitch0: number
  tailPitchStep: number
  tailYaw0: number
  tailYawStep: number
  tailSway: number
  tailFlick: number
  /** Extra bend from root to tip (rad per segment, linear): positive makes the tip curl over (a question-mark tail), so the tail is a curve, not a rod. */
  tailCurl: number
  /** Side-to-side S shape along the tail (rad). */
  tailS: number
  // body
  breath: number
  yawMag: number
  /** Scale of the leg bones (0 hides them: the sleeping cat's legs are tucked under it, only the paws show). */
  legScale: number
  // decoration visibility
  dots: number
  zzz: number
  waves: number
}

const SIT: PoseParams = {
  hipY: 4.6, pitch: 0.95, shiftZ: -5,
  fFootZ: 9.4, fFootY: BONES.ankle, fSpread: 3.0, hFootZ: 7.5, hFootY: BONES.ankle, hSpread: 4.8,
  stride: 0, lift: 0, bob: 0, swing: 0,
  headPitch: 0.04, headLook: 0.7, headRoll: 0, headTurn: 0, nod: 0, jaw: 0, eyeOpen: 1, blink: 1,
  earPitch: 0.1, earSpread: 0.14, earSwivel: 0, earFlick: 0.3,
  tailPitch0: -0.35, tailPitchStep: 0, tailYaw0: 0.5, tailYawStep: 0.3, tailSway: 0.16, tailFlick: 0, tailCurl: 0, tailS: 0,
  breath: 0.02, yawMag: 0.55, legScale: 1,
  dots: 0, zzz: 0, waves: 0
}

const WALK: PoseParams = {
  ...SIT,
  hipY: 12.2, pitch: 0.02, shiftZ: -6,
  fFootZ: 11.4, fSpread: 3.0, hFootZ: 0.8, hSpread: 3.6,
  stride: 3.4, lift: 2.4, bob: 0.35,
  headPitch: 0, headLook: 0, earPitch: 0, earSpread: 0.12, earFlick: 0.15,
  tailPitch0: 0.05, tailPitchStep: 0.16, tailCurl: 0.17, tailS: 0.2, tailYaw0: 0, tailYawStep: 0, tailSway: 0.14,
  breath: 0.01, yawMag: 1.4
}

export const POSES: Record<PoseName, PoseParams> = {
  idle: SIT,
  walk: WALK,
  curious: {
    ...SIT,
    headPitch: 0.2, headLook: 1, headRoll: 0.2, earPitch: 0.45, earSpread: 0.04, eyeOpen: 1.15, earFlick: 0.1,
    tailSway: 0.1, tailFlick: 0.5, yawMag: 0.2
  },
  thinking: {
    ...SIT,
    headPitch: 0.4, headLook: 0.15, headRoll: -0.18, headTurn: 0.5, eyeOpen: 0.7, earPitch: 0.15,
    tailSway: 0.3, tailYawStep: 0.12, yawMag: 0.9, dots: 1
  },
  speaking: {
    ...SIT,
    headPitch: 0.1, headLook: 1, nod: 0.07, jaw: 1, earPitch: 0.3, earSpread: 0.1, eyeOpen: 1.05, tailSway: 0.2, yawMag: 0.25
  },
  listening: {
    ...SIT,
    headPitch: 0.14, headLook: 1, headRoll: 0.14, earPitch: 0.5, earSpread: 0.02, earSwivel: 0.4, eyeOpen: 1.12, earFlick: 0.05,
    tailSway: 0.08, yawMag: 0.3, waves: 1
  },
  sleeping: {
    ...SIT,
    hipY: 4.3, pitch: 0, shiftZ: -7, fFootZ: 16.2, fFootY: 1.2, fSpread: 2.6, hFootZ: 4.5, hFootY: 1.2, hSpread: 4.4, legScale: 0,
    headPitch: -0.1, headLook: 1, headRoll: 0.55, headTurn: 0, eyeOpen: 0, blink: 0, earPitch: -0.1, earSpread: 0.35, earFlick: 0,
    tailPitch0: -0.15, tailYaw0: 0.5, tailYawStep: 0.4, tailSway: 0.02, breath: 0.045, yawMag: 0.5, zzz: 1
  },
  carried: {
    ...SIT,
    hipY: 10.5, pitch: 0.5, shiftZ: -4, fFootZ: 9.5, fFootY: 3.2, fSpread: 2.6, hFootZ: 3.5, hFootY: 3.0, hSpread: 3.2, swing: 0.1,
    headPitch: 0.1, headLook: 0.85, eyeOpen: 1.2, earPitch: -0.1, earSpread: 0.55, jaw: 0.3,
    tailPitch0: -0.7, tailCurl: 0.12, tailS: 0.1, tailYaw0: 0, tailYawStep: 0.05, tailSway: 0.1, breath: 0.03, yawMag: 0.3
  }
}

export const PARAM_NAMES = Object.keys(SIT) as Array<keyof PoseParams>

// ---------- small maths ----------
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))
const frac = (v: number): number => v - Math.floor(v)
const easeInOut = (s: number): number => s * s * (3 - 2 * s)
const TAU = Math.PI * 2

/** Deterministic 0..1 from an integer and a seed. */
export function rand01(n: number, seed = 0): number {
  let h = Math.imul(n | 0, 0x9e3779b1) ^ Math.imul(seed | 0, 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d)
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39)
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296
}

/** A short smooth bump (0..1..0) that happens once per `period` seconds at a pseudo-random moment. */
export function pulse(t: number, period: number, width: number, seed: number): number {
  const n = Math.floor(t / period)
  const start = n * period + rand01(n, seed) * (period - width)
  const u = (t - start) / width
  return u >= 0 && u <= 1 ? Math.sin(Math.PI * u) ** 2 : 0
}

/** 1 = eyes open, dipping to 0 for a quick blink every few seconds. */
export function blinkFactor(t: number): number {
  return 1 - pulse(t, 3.4, 0.16, 7)
}

/** How far the mouth opens (0..1) at time t while talking: syllables of varying size with short pauses. */
export function speechEnvelope(t: number): number {
  const cell = Math.floor(t * 4.5)
  const level = rand01(cell, 3)
  const u = frac(t * 4.5)
  const pause = level < 0.18 ? 0 : 1
  return pause * (0.35 + 0.65 * level) * Math.sin(Math.PI * u) ** 0.8
}

/** One step of a critically damped spring (no overshoot, starts and ends gently). Returns [position, velocity]. */
export function springStep(x: number, v: number, target: number, omega: number, dt: number): [number, number] {
  const d = x - target
  const a = v + omega * d
  const e = Math.exp(-omega * dt)
  return [target + (d + a * dt) * e, (v - omega * a * dt) * e]
}

/** Two-bone IK in the leg's side-view plane. Angles are measured from "straight down" toward +z. */
export function solveTwoBone(
  root: readonly [number, number],
  foot: readonly [number, number],
  upper: number,
  lower: number,
  kneeSign: 1 | -1
): { upperAngle: number; lowerAngle: number; knee: [number, number]; foot: [number, number]; stretched: boolean } {
  const dz = foot[0] - root[0]
  const dy = foot[1] - root[1]
  const raw = Math.hypot(dz, dy)
  const minReach = Math.abs(upper - lower) + 0.05
  const maxReach = upper + lower - 0.02
  const d = clamp(raw, minReach, maxReach)
  const alpha = Math.atan2(dz, -dy)
  const cosA = clamp((upper * upper + d * d - lower * lower) / (2 * upper * d), -1, 1)
  const upperAngle = alpha + kneeSign * Math.acos(cosA)
  const knee: [number, number] = [root[0] + upper * Math.sin(upperAngle), root[1] - upper * Math.cos(upperAngle)]
  const reached: [number, number] = [root[0] + d * Math.sin(alpha), root[1] - d * Math.cos(alpha)]
  const lowerAngle = Math.atan2(reached[0] - knee[0], -(reached[1] - knee[1]))
  return { upperAngle, lowerAngle, knee, foot: reached, stretched: raw > maxReach }
}

/** A point in the torso's frame -> root frame (the torso pivots about the hips, tilted up by `pitch`). */
export function torsoToRoot(hips: Vec3, pitch: number, p: readonly [number, number, number]): Vec3 {
  const c = Math.cos(pitch)
  const s = Math.sin(pitch)
  return [hips[0] + p[0], hips[1] + p[1] * c + p[2] * s, hips[2] - p[1] * s + p[2] * c]
}

// ---------- the animator ----------
export interface LegPose {
  /** Joint positions in the root frame. */
  root: Vec3
  knee: Vec3
  foot: Vec3
  /** Bone angles from straight down toward +z. */
  upperAngle: number
  lowerAngle: number
  /** Paw tilt (toes down while the foot swings), radians. */
  tilt: number
  /** Outward splay of the whole leg (rotation about the front-back axis), radians. */
  roll: number
  stretched: boolean
}

export interface RigPose {
  /** Body heading about the vertical axis: 0 faces the camera, +PI/2 faces screen-right. */
  yaw: number
  torso: { pos: Vec3; pitch: number; roll: number; breath: number }
  head: { pos: Vec3; pitch: number; yaw: number; roll: number }
  jaw: number
  ears: { L: { pitch: number; roll: number; yaw: number }; R: { pitch: number; roll: number; yaw: number } }
  eyeOpen: number
  legs: Record<LegName, LegPose>
  tail: { pos: Vec3; basePitch: number; baseYaw: number; segs: Array<{ pitch: number; yaw: number }> }
  decor: { dots: number; zzz: number; waves: number }
  /** Leg bone scale, 0..1. */
  legScale: number
  /** Ground blob under the cat: how elongated it is along the body (0 = round, 1 = long). */
  stretch: number
  /** Walk weight (0..1), for the renderer's frame-rate policy. */
  walking: number
}

const GAIT_PHASE: Record<LegName, number> = { HL: 0, FL: 0.25, HR: 0.5, FR: 0.75 }
const STANCE = 0.6

/** Cycles per second at which the feet keep up with the ground speed of the walk (stance moves 2*stride in STANCE of a cycle). */
export function gaitHz(): number {
  const unitsPerSec = WALK_SPEED / PX_PER_UNIT
  return (unitsPerSec * STANCE) / (2 * WALK.stride)
}

export interface AnimatorOptions {
  /** Angular frequency of the spring that blends between poses (higher = quicker; about 4.6/omega seconds to settle). */
  blendOmega?: number
  /** Angular frequency of the turn spring. */
  turnOmega?: number
  /** Start already settled in this pose. */
  start?: PoseName
}

export class CatAnimator {
  /** Weight of each pose; always sums to 1. */
  readonly weights: Record<PoseName, number>
  t = 0
  gait = 0
  yaw = 0
  private yawVel = 0
  private readonly weightVel: Record<PoseName, number>
  private readonly blendOmega: number
  private readonly omega: number
  private readonly blended: PoseParams = { ...SIT }
  private target: PoseName
  private dir: 1 | -1 = 1

  constructor(opts: AnimatorOptions = {}) {
    this.blendOmega = opts.blendOmega ?? 11
    this.omega = opts.turnOmega ?? 9
    this.target = opts.start ?? 'idle'
    this.weights = Object.fromEntries(POSE_NAMES.map((n) => [n, n === this.target ? 1 : 0])) as Record<PoseName, number>
    this.weightVel = Object.fromEntries(POSE_NAMES.map((n) => [n, 0])) as Record<PoseName, number>
    this.yaw = this.dir * POSES[this.target].yawMag
    this.blend() // so pose() is right before the first step
  }

  /** How fast the body is turning (rad/s); near zero when the heading has settled. */
  get yawSpeed(): number {
    return this.yawVel
  }

  /** Jump to a fully settled `pose` facing `dir`, with the clock at `t` seconds (for stills and tests). */
  settle(pose: PoseName, dir: 1 | -1, t = 0): void {
    for (const n of POSE_NAMES) {
      this.weights[n] = n === pose ? 1 : 0
      this.weightVel[n] = 0
    }
    this.target = pose
    this.dir = dir
    this.yaw = dir * POSES[pose].yawMag
    this.yawVel = 0
    this.t = 0
    this.gait = 0
    this.blend()
    while (this.t < t) this.step(Math.min(1 / 60, t - this.t + 1e-9), pose, dir)
  }

  /** Advance by `dt` seconds toward `pose`, facing `dir` (+1 screen-right, -1 screen-left). */
  step(dt: number, pose: PoseName, dir: 1 | -1): void {
    dt = clamp(dt, 0, 0.1) // a stalled frame must not make the spring or the blend explode
    this.target = pose
    this.dir = dir
    this.t += dt
    for (const n of POSE_NAMES) [this.weights[n], this.weightVel[n]] = springStep(this.weights[n], this.weightVel[n], n === pose ? 1 : 0, this.blendOmega, dt)
    this.blend()
    this.gait += dt * gaitHz() * this.weights.walk
    // Critically damped spring toward the heading for this pose.
    ;[this.yaw, this.yawVel] = springStep(this.yaw, this.yawVel, dir * this.blended.yawMag, this.omega, dt)
  }

  private blend(): void {
    const b = this.blended
    for (const key of PARAM_NAMES) {
      let v = 0
      for (const n of POSE_NAMES) v += this.weights[n] * POSES[n][key]
      b[key] = v
    }
  }

  /** The current skeleton pose. */
  pose(): RigPose {
    const b = this.blended
    const t = this.t
    // -1..1: which way the body is turned, continuous so asymmetric features (tail curl, head tilt) swap sides smoothly as it turns
    const side = clamp(this.yaw / 0.45, -1, 1)
    const walk = this.weights.walk
    const carried = this.weights.carried
    const ph = this.gait
    // body motion
    const bobY = b.bob * Math.sin(2 * TAU * ph + 0.6)
    const swing = b.swing * Math.sin(TAU * 1.1 * t)
    const pitch = b.pitch + 0.02 * walk * Math.sin(2 * TAU * ph) + swing
    const roll = 0.035 * walk * Math.sin(TAU * ph) + 0.05 * carried * Math.sin(TAU * 0.8 * t)
    const breathPhase = Math.sin((TAU * t) / (3.2 + 1.6 * this.weights.sleeping))
    const hips: Vec3 = [0, b.hipY + bobY, b.shiftZ]
    const breath = b.breath * breathPhase

    // head
    const neck = torsoToRoot(hips, pitch, TORSO_FRAME.neck)
    const nod = b.nod * Math.sin(TAU * 2.6 * t) + 0.012 * Math.sin(TAU * 0.35 * t)
    const headPitch = b.headPitch + nod - 0.04 * walk * Math.sin(2 * TAU * ph + 0.6) - swing * 0.5
    const headYaw = -this.yaw * b.headLook + side * b.headTurn
    const headRoll = side * b.headRoll - roll * 0.5 + 0.02 * Math.sin(TAU * 0.4 * t)
    const jaw = b.jaw * speechEnvelope(t) * 0.55 + (b.jaw > 0 && b.jaw < 1 ? 0.2 * b.jaw : 0)

    // ears
    const flickL = pulse(t, 5.3, 0.22, 1) * b.earFlick
    const flickR = pulse(t, 6.7, 0.22, 2) * b.earFlick
    const ears = {
      L: { pitch: b.earPitch - flickL * 0.9, roll: -b.earSpread - flickL * 0.2, yaw: b.earSwivel },
      R: { pitch: b.earPitch - flickR * 0.9, roll: b.earSpread + flickR * 0.2, yaw: -b.earSwivel }
    }

    // legs
    const frontBones = BONES.front
    const hindBones = BONES.hind
    const legs = {} as Record<LegName, LegPose>
    for (const leg of LEGS) {
      const front = leg[0] === 'F'
      const side = leg[1] === 'L' ? 1 : -1
      const rootT = front
        ? torsoToRoot(hips, pitch, [side * TORSO_FRAME.shoulderX, TORSO_FRAME.shoulderY, TORSO_FRAME.shoulderZ])
        : torsoToRoot(hips, pitch, [side * TORSO_FRAME.hipX, TORSO_FRAME.hipY, TORSO_FRAME.hipZ])
      const u = frac(ph + GAIT_PHASE[leg])
      let dz: number
      let dy = 0
      let tilt = 0
      if (u < STANCE) dz = b.stride * (1 - (2 * u) / STANCE)
      else {
        const s = (u - STANCE) / (1 - STANCE)
        dz = b.stride * (-1 + 2 * easeInOut(s))
        dy = b.lift * Math.sin(Math.PI * s)
        tilt = 0.5 * Math.sin(Math.PI * s) * (b.stride > 0.05 ? 1 : 0)
      }
      const footZ = (front ? b.fFootZ : b.hFootZ) + b.shiftZ + dz
      const footY = (front ? b.fFootY : b.hFootY) + dy
      const footX = side * (front ? b.fSpread : b.hSpread)
      const bones = front ? frontBones : hindBones
      const ik = solveTwoBone([rootT[2], rootT[1]], [footZ, footY], bones.upper, bones.lower, front ? -1 : 1)
      // Dangling legs sway a little when carried.
      const rootX = side * (front ? TORSO_FRAME.shoulderX : TORSO_FRAME.hipX)
      const dangle = carried * 0.18 * Math.sin(TAU * 1.1 * t + (front ? 0 : 1.4) + (side > 0 ? 0 : 0.7))
      legs[leg] = {
        root: [rootX, rootT[1], rootT[2]],
        knee: [rootX, ik.knee[1], ik.knee[0]],
        foot: [footX, ik.foot[1], ik.foot[0]],
        upperAngle: ik.upperAngle + dangle,
        lowerAngle: ik.lowerAngle + dangle * 1.4,
        tilt,
        roll: Math.atan2(footX - rootX, Math.max(1, rootT[1] - ik.foot[1])),
        stretched: ik.stretched
      }
    }

    // tail: a chain; each segment lags the one before it, so a wave runs down it
    const tailPos = torsoToRoot(hips, pitch, TORSO_FRAME.tail)
    const segs: Array<{ pitch: number; yaw: number }> = []
    for (let i = 0; i < TAIL_SEGMENTS; i++) {
      const lag = i * 0.55
      const wave = Math.sin(TAU * 0.55 * t - lag) + 0.4 * Math.sin(TAU * 1.3 * t - lag * 1.4)
      const flick = b.tailFlick * Math.max(0, Math.sin(TAU * 1.7 * t - lag * 1.8)) * (i / TAIL_SEGMENTS)
      const walkWave = walk * 0.08 * Math.sin(TAU * ph - lag)
      segs.push({
        pitch: b.tailPitchStep + b.tailCurl * ((i - (TAIL_SEGMENTS - 1) / 2) / ((TAIL_SEGMENTS - 1) / 2)) + flick * 0.6,
        yaw: side * b.tailYawStep + b.tailS * Math.sin(i * 0.9 + 0.4) + (b.tailSway * wave * (0.35 + i / TAIL_SEGMENTS)) / 2 + walkWave
      })
    }

    return {
      yaw: this.yaw,
      torso: { pos: hips, pitch, roll, breath },
      head: { pos: neck, pitch: headPitch, yaw: headYaw, roll: headRoll },
      jaw,
      ears,
      eyeOpen: clamp(b.eyeOpen, 0, 1.25) * (b.blink > 0.01 ? 1 - b.blink * (1 - blinkFactor(t)) : 1),
      legs,
      tail: { pos: tailPos, basePitch: b.tailPitch0 + pitch, baseYaw: side * b.tailYaw0, segs },
      decor: { dots: b.dots, zzz: b.zzz, waves: b.waves },
      legScale: b.legScale,
      stretch: clamp(walk + this.weights.sleeping * 0.7, 0, 1),
      walking: walk
    }
  }
}

/** Head anchor positions the renderer needs without re-deriving them. */
export const HEAD_ANCHORS = HEAD_FRAME
