import { describe, expect, it } from 'vitest'
import { WALK_SPEED } from '../src/shared/brain'
import { BONES } from '../src/shared/cat3d/cat-model'
import {
  blinkFactor, CatAnimator, gaitHz, LEGS, PARAM_NAMES, POSE_NAMES, POSES, PX_PER_UNIT, pulse, rand01, solveTwoBone, speechEnvelope, torsoToRoot,
  type PoseName, type RigPose
} from '../src/shared/cat3d/rig'

const FPS = 60
const DT = 1 / FPS
const dist2 = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!)

/** Run an animator for `seconds`, returning the pose each frame. */
function run(a: CatAnimator, seconds: number, pose: PoseName, dir: 1 | -1 = 1): RigPose[] {
  const out: RigPose[] = []
  for (let i = 0; i < seconds * FPS; i++) {
    a.step(DT, pose, dir)
    out.push(a.pose())
  }
  return out
}
const flat = (p: RigPose): number[] => {
  const v: number[] = [p.yaw, ...p.torso.pos, p.torso.pitch, p.torso.roll, p.torso.breath, ...p.head.pos, p.head.pitch, p.head.yaw, p.head.roll, p.jaw, p.eyeOpen, p.stretch, p.walking]
  for (const e of [p.ears.L, p.ears.R]) v.push(e.pitch, e.roll, e.yaw)
  for (const l of LEGS) v.push(...p.legs[l].root, ...p.legs[l].knee, ...p.legs[l].foot, p.legs[l].upperAngle, p.legs[l].lowerAngle, p.legs[l].tilt, p.legs[l].roll)
  v.push(...p.tail.pos, p.tail.basePitch, p.tail.baseYaw)
  for (const s of p.tail.segs) v.push(s.pitch, s.yaw)
  v.push(p.decor.dots, p.decor.zzz, p.decor.waves)
  return v
}

describe('solveTwoBone', () => {
  it.each([
    [[0, 10], [3, 1.6], 5.5, 6.5, -1],
    [[0, 10], [-2, 3], 6, 6.5, 1],
    [[4, 12], [4, 1], 5.5, 6.5, -1],
    [[0, 5], [8, 1], 6, 6.5, 1]
  ] as const)('reaches %j -> %j with exact bone lengths', (root, foot, upper, lower, sign) => {
    const r = solveTwoBone(root, foot, upper, lower, sign)
    expect(r.stretched).toBe(false)
    expect(dist2(r.foot, foot)).toBeLessThan(1e-9)
    expect(dist2(r.knee, root)).toBeCloseTo(upper, 9)
    expect(dist2(r.foot, r.knee)).toBeCloseTo(lower, 9)
    // the angles reproduce the joint positions
    expect(root[0] + upper * Math.sin(r.upperAngle)).toBeCloseTo(r.knee[0], 9)
    expect(root[1] - upper * Math.cos(r.upperAngle)).toBeCloseTo(r.knee[1], 9)
    expect(r.knee[0] + lower * Math.sin(r.lowerAngle)).toBeCloseTo(r.foot[0], 9)
    expect(r.knee[1] - lower * Math.cos(r.lowerAngle)).toBeCloseTo(r.foot[1], 9)
  })
  it('puts the knee forward for +1 and backward for -1 when standing', () => {
    const fwd = solveTwoBone([0, 10], [0, 1.6], 6, 6.5, 1)
    const back = solveTwoBone([0, 10], [0, 1.6], 6, 6.5, -1)
    expect(fwd.knee[0]).toBeGreaterThan(0)
    expect(back.knee[0]).toBeLessThan(0)
  })
  it('stretches toward an unreachable target instead of producing NaN', () => {
    const r = solveTwoBone([0, 10], [0, -20], 6, 6.5, 1)
    expect(r.stretched).toBe(true)
    expect(Number.isFinite(r.upperAngle + r.lowerAngle + r.foot[0] + r.foot[1])).toBe(true)
    expect(dist2(r.foot, [0, 10])).toBeLessThan(12.5)
    expect(dist2(r.foot, [0, 10])).toBeGreaterThan(12.4)
  })
  it('copes with a target on the root and with one very close', () => {
    for (const foot of [[0, 10], [0.01, 9.99], [0, 9]] as const) {
      const r = solveTwoBone([0, 10], foot, 6, 6.5, 1)
      expect(Number.isFinite(r.upperAngle + r.lowerAngle + r.knee[0] + r.knee[1])).toBe(true)
      expect(dist2(r.knee, [0, 10])).toBeCloseTo(6, 9)
    }
  })
})

describe('torsoToRoot', () => {
  it('is a translation at zero pitch', () => {
    expect(torsoToRoot([1, 2, 3], 0, [4, 5, 6])).toEqual([5, 7, 9])
  })
  it('swings the front of the torso up as it pitches', () => {
    const p = torsoToRoot([0, 0, 0], Math.PI / 2, [0, 0, 10])
    expect(p[1]).toBeCloseTo(10, 9)
    expect(p[2]).toBeCloseTo(0, 9)
  })
  it('preserves distances', () => {
    const p = torsoToRoot([0, 0, 0], 0.7, [3, 4, 5])
    expect(Math.hypot(...p)).toBeCloseTo(Math.hypot(3, 4, 5), 9)
  })
})

describe('procedural helpers', () => {
  it('rand01 is deterministic and in range', () => {
    for (let i = 0; i < 200; i++) {
      const v = rand01(i, 5)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
      expect(rand01(i, 5)).toBe(v)
    }
  })
  it('pulse stays in 0..1 and fires once per period', () => {
    let fired = 0
    let prev = 0
    for (let t = 0; t < 60; t += 0.01) {
      const p = pulse(t, 5, 0.3, 4)
      expect(p).toBeGreaterThanOrEqual(0)
      expect(p).toBeLessThanOrEqual(1)
      if (p > 0.5 && prev <= 0.5) fired++
      prev = p
    }
    expect(fired).toBeGreaterThanOrEqual(11)
    expect(fired).toBeLessThanOrEqual(12)
  })
  it('blinks briefly and rarely', () => {
    let closed = 0
    let n = 0
    for (let t = 0; t < 120; t += 0.01) {
      const f = blinkFactor(t)
      expect(f).toBeGreaterThanOrEqual(0)
      expect(f).toBeLessThanOrEqual(1)
      if (f < 0.5) closed++
      n++
    }
    expect(closed / n).toBeGreaterThan(0.005)
    expect(closed / n).toBeLessThan(0.08)
  })
  it('speech envelope is in 0..1 with pauses and open mouths', () => {
    let zero = 0
    let open = 0
    for (let t = 0; t < 60; t += 0.01) {
      const e = speechEnvelope(t)
      expect(e).toBeGreaterThanOrEqual(0)
      expect(e).toBeLessThanOrEqual(1)
      if (e < 0.02) zero++
      if (e > 0.5) open++
    }
    expect(zero).toBeGreaterThan(100)
    expect(open).toBeGreaterThan(300)
  })
})

describe('pose tables', () => {
  it('every pose defines every parameter as a finite number', () => {
    for (const n of POSE_NAMES) for (const k of PARAM_NAMES) expect(Number.isFinite(POSES[n][k]), `${n}.${k}`).toBe(true)
  })
  it('only the walk pose has a stride, and only walking lifts feet', () => {
    for (const n of POSE_NAMES) expect(POSES[n].stride > 0).toBe(n === 'walk')
  })
  it('decorations belong to their own modes', () => {
    expect(POSES.thinking.dots).toBe(1)
    expect(POSES.sleeping.zzz).toBe(1)
    expect(POSES.listening.waves).toBe(1)
    for (const n of POSE_NAMES) {
      if (n !== 'thinking') expect(POSES[n].dots).toBe(0)
      if (n !== 'sleeping') expect(POSES[n].zzz).toBe(0)
      if (n !== 'listening') expect(POSES[n].waves).toBe(0)
    }
  })
})

describe('CatAnimator.settle', () => {
  it('jumps to a fully settled pose, with the clock and gait advanced', () => {
    const a = new CatAnimator()
    a.settle('walk', -1, 2)
    expect(a.weights.walk).toBe(1)
    expect(a.yaw).toBeCloseTo(-POSES.walk.yawMag, 9)
    expect(a.yawSpeed).toBe(0)
    expect(a.t).toBeGreaterThanOrEqual(2)
    expect(a.t).toBeLessThan(2.02)
    expect(a.gait).toBeGreaterThan(1.2) // about two seconds of walking
    expect(flat(a.pose()).every(Number.isFinite)).toBe(true)
  })
  it('leaves no stale motion behind: stepping from a settled pose stays settled', () => {
    const a = new CatAnimator()
    a.step(0.05, 'walk', 1) // some in-flight blend
    a.settle('sleeping', 1, 0)
    for (const p of run(a, 1, 'sleeping')) expect(p.eyeOpen).toBeLessThan(0.01)
    expect(a.weights.sleeping).toBeGreaterThan(0.9999)
  })
})

describe('CatAnimator', () => {
  it('starts settled in its pose', () => {
    const a = new CatAnimator({ start: 'sleeping' })
    expect(a.weights.sleeping).toBe(1)
    expect(a.pose().eyeOpen).toBe(0)
  })

  it('weights always sum to one and converge to the target', () => {
    const a = new CatAnimator()
    for (const pose of ['walk', 'speaking', 'sleeping', 'idle'] as const) {
      for (const p of run(a, 3, pose)) void p
      let sum = 0
      for (const n of POSE_NAMES) sum += a.weights[n]
      expect(sum).toBeCloseTo(1, 9)
      expect(a.weights[pose]).toBeGreaterThan(0.999)
    }
  })

  it('blends continuously: no joint jumps between frames when the mode changes', () => {
    const a = new CatAnimator()
    const seq: PoseName[] = ['idle', 'walk', 'curious', 'thinking', 'speaking', 'listening', 'sleeping', 'carried', 'idle']
    let prev: number[] | null = null
    let worst = 0
    for (const pose of seq) {
      for (const p of run(a, 1.2, pose)) {
        const v = flat(p)
        if (prev) for (let i = 0; i < v.length; i++) worst = Math.max(worst, Math.abs(v[i]! - prev[i]!))
        prev = v
      }
    }
    // A swinging foot or a folded elbow unfolding (waking a sleeping cat) is quick, but nothing may teleport:
    // 1.5 units/frame is about 90 units/s, a bit over a third of the cat's height per tenth of a second.
    expect(worst).toBeLessThan(1.5)
  })

  it('sit -> walk raises the hips smoothly without overshoot', () => {
    const a = new CatAnimator()
    const ys = run(a, 3, 'walk').map((p) => p.torso.pos[1])
    const lo = POSES.idle.hipY
    const hi = POSES.walk.hipY
    expect(ys[0]!).toBeGreaterThan(lo - 0.5)
    expect(ys.at(-1)!).toBeGreaterThan(hi - 0.5)
    expect(ys.at(-1)!).toBeLessThan(hi + 0.5)
    expect(Math.max(...ys)).toBeLessThan(hi + 0.6) // the bob is the only excursion
  })

  it('keeps every bone at its exact length in every pose and moment', () => {
    const a = new CatAnimator()
    for (const pose of POSE_NAMES) {
      for (const p of run(a, 2, pose)) {
        for (const leg of LEGS) {
          const L = p.legs[leg]
          if (L.stretched) continue
          const b = leg[0] === 'F' ? BONES.front : BONES.hind
          expect(dist2([L.root[2], L.root[1]], [L.knee[2], L.knee[1]])).toBeCloseTo(b.upper, 6)
          expect(dist2([L.knee[2], L.knee[1]], [L.foot[2], L.foot[1]])).toBeCloseTo(b.lower, 6)
        }
      }
    }
  })

  it('never pushes a foot through the floor (paws are 0 at ground, ankles at BONES.ankle)', () => {
    const a = new CatAnimator()
    let low = Infinity
    for (const pose of POSE_NAMES) for (const p of run(a, 2.5, pose)) for (const leg of LEGS) low = Math.min(low, p.legs[leg].foot[1])
    expect(low).toBeGreaterThanOrEqual(1.2 - 1e-9)
  })

  it('plants feet at ground speed: a stance foot slides back exactly as fast as the cat walks', () => {
    const a = new CatAnimator({ start: 'walk' })
    run(a, 1, 'walk')
    const unitsPerSec = WALK_SPEED / PX_PER_UNIT
    const samples = run(a, 1 / gaitHz(), 'walk')
    const speeds: number[] = []
    for (let i = 1; i < samples.length; i++) {
      const f0 = samples[i - 1]!.legs.HL.foot
      const f1 = samples[i]!.legs.HL.foot
      if (f0[1] <= BONES.ankle + 1e-9 && f1[1] <= BONES.ankle + 1e-9) speeds.push(-(f1[2] - f0[2]) / DT)
    }
    expect(speeds.length).toBeGreaterThan(20)
    for (const s of speeds) expect(s / unitsPerSec).toBeCloseTo(1, 1)
  })

  it('always keeps at least two feet on the ground while walking, and every foot takes steps', () => {
    const a = new CatAnimator({ start: 'walk' })
    const frames = run(a, 3, 'walk')
    const lifted = { FL: 0, FR: 0, HL: 0, HR: 0 }
    for (const p of frames) {
      const up = LEGS.filter((l) => p.legs[l].foot[1] > BONES.ankle + 0.05)
      expect(up.length).toBeLessThanOrEqual(2)
      for (const l of up) lifted[l]++
    }
    for (const l of LEGS) expect(lifted[l]).toBeGreaterThan(frames.length * 0.25)
  })

  it('a walking cycle repeats: same pose after one period', () => {
    const a = new CatAnimator({ start: 'walk' })
    run(a, 1, 'walk')
    const p0 = a.pose().legs.FL.foot
    const period = 1 / gaitHz()
    const n = Math.round(period * FPS)
    // advance exactly n frames; the animator is periodic in the gait phase up to the frame quantisation
    const frames = run(a, n / FPS, 'walk')
    const p1 = frames.at(-1)!.legs.FL.foot
    expect(dist2([p0[2], p0[1]], [p1[2], p1[1]])).toBeLessThan(0.6)
  })

  it('turns around by swinging through the camera, never overshooting', () => {
    const a = new CatAnimator()
    const yaws = [...run(a, 2, 'idle', 1).map((p) => p.yaw), ...run(a, 2, 'idle', -1).map((p) => p.yaw)]
    const settled = POSES.idle.yawMag
    expect(yaws[100]!).toBeCloseTo(settled, 2)
    expect(yaws.at(-1)!).toBeCloseTo(-settled, 2)
    const second = yaws.slice(120)
    expect(Math.min(...second)).toBeGreaterThanOrEqual(-settled - 1e-6)
    expect(second.some((y) => Math.abs(y) < 0.05)).toBe(true) // passes through front-facing
    for (let i = 1; i < second.length; i++) expect(second[i]!).toBeLessThanOrEqual(second[i - 1]! + 1e-9) // monotonic
  })

  it('walks side-on: heading approaches +/- yawMag', () => {
    const a = new CatAnimator()
    expect(run(a, 3, 'walk', 1).at(-1)!.yaw).toBeCloseTo(POSES.walk.yawMag, 2)
    expect(run(a, 3, 'walk', -1).at(-1)!.yaw).toBeCloseTo(-POSES.walk.yawMag, 2)
  })

  it('expresses each mode', () => {
    const settle = (pose: PoseName): RigPose => {
      const a = new CatAnimator()
      run(a, 3, pose)
      return a.pose()
    }
    expect(settle('sleeping').eyeOpen).toBeLessThan(0.01)
    expect(settle('sleeping').decor.zzz).toBeGreaterThan(0.99)
    expect(settle('thinking').decor.dots).toBeGreaterThan(0.99)
    expect(settle('listening').decor.waves).toBeGreaterThan(0.99)
    expect(settle('curious').eyeOpen).toBeGreaterThan(0.9)
    expect(settle('idle').decor).toEqual({ dots: expect.closeTo(0, 3), zzz: expect.closeTo(0, 3), waves: expect.closeTo(0, 3) })
    expect(settle('idle').walking).toBeLessThan(0.001)
    expect(settle('walk').walking).toBeGreaterThan(0.999)
    expect(settle('sleeping').head.pitch).toBeLessThan(settle('idle').head.pitch) // head down when asleep
    expect(settle('sleeping').torso.pitch).toBeLessThan(settle('idle').torso.pitch) // lying, not sitting up
  })

  it('opens the jaw only when speaking, and sometimes closes it', () => {
    const speaking = new CatAnimator({ start: 'speaking' })
    const jaws = run(speaking, 6, 'speaking').map((p) => p.jaw)
    expect(Math.max(...jaws)).toBeGreaterThan(0.2)
    expect(jaws.filter((j) => j < 0.02).length).toBeGreaterThan(10)
    const idle = new CatAnimator()
    expect(Math.max(...run(idle, 6, 'idle').map((p) => p.jaw))).toBeLessThan(0.001)
  })

  it('the tail has a segment per joint and moves', () => {
    const a = new CatAnimator()
    const frames = run(a, 4, 'idle')
    expect(frames[0]!.tail.segs.length).toBeGreaterThanOrEqual(6)
    const yaws = frames.map((p) => p.tail.segs.at(-1)!.yaw)
    expect(Math.max(...yaws) - Math.min(...yaws)).toBeGreaterThan(0.05)
  })

  it('breathes: the chest scale oscillates around zero', () => {
    const a = new CatAnimator()
    const b = run(a, 8, 'idle').map((p) => p.torso.breath)
    expect(Math.max(...b)).toBeGreaterThan(0.01)
    expect(Math.min(...b)).toBeLessThan(-0.01)
  })

  it('is symmetric: left and right legs mirror in x and match in y/z when standing still', () => {
    const a = new CatAnimator()
    const p = run(a, 3, 'idle').at(-1)!
    expect(p.legs.FL.root[0]).toBe(-p.legs.FR.root[0])
    expect(p.legs.HL.foot[0]).toBe(-p.legs.HR.foot[0])
    expect(p.legs.FL.foot[1]).toBeCloseTo(p.legs.FR.foot[1], 9)
    expect(p.legs.HL.foot[2]).toBeCloseTo(p.legs.HR.foot[2], 9)
  })

  it('survives a stalled frame (huge dt) as if it were 100 ms', () => {
    const a = new CatAnimator()
    const b = new CatAnimator()
    a.step(10, 'walk', 1)
    b.step(0.1, 'walk', 1)
    expect(flat(a.pose())).toEqual(flat(b.pose()))
    a.step(-5, 'idle', 1) // negative time is ignored
    expect(flat(a.pose()).every(Number.isFinite)).toBe(true)
  })

  it('never produces NaN or infinity under random mode and direction changes', () => {
    const a = new CatAnimator()
    let seed = 12345
    const rnd = (): number => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296)
    for (let i = 0; i < 5000; i++) {
      const pose = POSE_NAMES[Math.floor(rnd() * POSE_NAMES.length)]!
      a.step(rnd() * 0.05, pose, rnd() < 0.5 ? 1 : -1)
      if (i % 7 === 0) expect(flat(a.pose()).every(Number.isFinite)).toBe(true)
    }
  })
})

describe('the tail is a curve, not a rod', () => {
  it('while walking, each tail segment bends by a different amount, increasing towards the tip', () => {
    const p = run(new CatAnimator(), 3, 'walk').at(-1)!
    const pitches = p.tail.segs.map((s) => s.pitch)
    expect(new Set(pitches.map((x) => x.toFixed(3))).size).toBe(pitches.length)
    expect(pitches.at(-1)!).toBeGreaterThan(pitches[0]! + 0.15)
  })
  it('has a side-to-side S shape, so it is not in one plane', () => {
    const yaws = run(new CatAnimator(), 3, 'walk').at(-1)!.tail.segs.map((s) => s.yaw)
    expect(Math.max(...yaws) - Math.min(...yaws)).toBeGreaterThan(0.2)
  })
})
