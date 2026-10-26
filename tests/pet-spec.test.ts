import { describe, expect, it } from 'vitest'
import { compileSpec, describeDefaults, EMPTY_SPEC, LIMITS, normaliseHex, parsePetSpec, quickRecolour, SPEC_PARTS } from '../src/shared/cat3d/pet-spec'
import { buildFigurePart, FIGURE_SHAPES } from '../src/shared/cat3d/figure-model'
import { loadPresets } from '../src/services/memory/pet-store'
import { join } from 'node:path'

const ok = (v: unknown) => {
  const r = parsePetSpec(v)
  if ('error' in r) throw new Error(r.error)
  return r.spec
}
const err = (v: unknown): string => {
  const r = parsePetSpec(v)
  if ('spec' in r) throw new Error('expected an error')
  return r.error
}
const shape = (over: Record<string, unknown> = {}) => ({ kind: 'ellipsoid', center: [0, 1, 0], radii: [1, 1, 1], color: 'fur', ...over })

describe('parsePetSpec', () => {
  it('accepts the smallest spec and fills in defaults', () => {
    expect(ok({})).toEqual({ name: 'Custom pet', palette: {}, parts: {}, hide: [], scale: 1 })
  })
  it('accepts a palette, shapes, hide and scale; normalises colours', () => {
    const s = ok({ name: ' Mermaid ', palette: { fur: '#ABC', eye: '#3B78E0' }, hide: ['leg', 'leg'], scale: 0.9, parts: { torso: { shapes: [shape({ color: '#FFAA00' })] } } })
    expect(s.name).toBe('Mermaid')
    expect(s.palette).toEqual({ fur: '#aabbcc', eye: '#3b78e0' })
    expect(s.hide).toEqual(['leg'])
    expect(s.parts.torso).toEqual({ replace: false, shapes: [{ kind: 'ellipsoid', center: [0, 1, 0], radii: [1, 1, 1], color: '#ffaa00' }] })
  })
  it.each([
    [null], ['str'], [[]], [5],
    [{ palette: { fur: 'green' } }], [{ palette: { fur: 'rgb(0,0,0)' } }], [{ palette: { nope: '#fff' } }], [{ palette: [] }],
    [{ scale: 5 }], [{ scale: 0 }], [{ scale: 'big' }],
    [{ hide: 'leg' }], [{ hide: ['wings'] }],
    [{ parts: { wings: { shapes: [] } } }], [{ parts: { torso: {} } }], [{ parts: { torso: { shapes: 'x' } } }], [{ parts: { torso: 5 } }],
    [{ parts: { torso: { shapes: [shape({ kind: 'sphere' })] } } }],
    [{ parts: { torso: { shapes: [shape({ center: [0, 0] })] } } }],
    [{ parts: { torso: { shapes: [shape({ center: [0, 99, 0] })] } } }],
    [{ parts: { torso: { shapes: [shape({ radii: [0, 1, 1] })] } } }],
    [{ parts: { torso: { shapes: [shape({ radii: [1, 1, 99] })] } } }],
    [{ parts: { torso: { shapes: [shape({ center: [NaN, 0, 0] })] } } }],
    [{ parts: { torso: { shapes: [shape({ color: 'eye' })] } } }],
    [{ parts: { torso: { shapes: [shape({ color: 'javascript:1' })] } } }],
    [{ parts: { torso: { shapes: ['x'] } } }]
  ])('rejects %j with a message', (bad) => {
    expect(err(bad).length).toBeGreaterThan(10)
  })
  it('limits the number of shapes per part, in total and the number of custom colours', () => {
    expect(err({ parts: { torso: { shapes: Array.from({ length: LIMITS.shapesPerPart + 1 }, () => shape()) } } })).toMatch(/too many shapes/)
    const parts = Object.fromEntries(['torso', 'head', 'ear', 'leg'].map((p) => [p, { shapes: Array.from({ length: 45 }, () => shape()) }]))
    expect(err({ parts })).toMatch(/in total/)
    const colours = Array.from({ length: LIMITS.extraColors + 1 }, (_, i) => shape({ color: `#${(i + 16).toString(16).padStart(2, '0')}0000` }))
    expect(err({ parts: { torso: { shapes: colours.slice(0, 40) }, head: { shapes: colours.slice(40) } } })).toMatch(/custom colours/)
  })
  it('a carve shape needs no colour', () => {
    expect(ok({ parts: { head: { shapes: [{ kind: 'box', center: [0, 1, 0], radii: [1, 1, 1], carve: true }] } } }).parts.head!.shapes[0]!.carve).toBe(true)
  })
  it('ignores unknown top-level keys such as the AI note', () => {
    expect(ok({ note: 'hello', extra: { a: 1 } }).name).toBe('Custom pet')
  })
  it('never lets prototype keys through', () => {
    expect(() => parsePetSpec(JSON.parse('{"__proto__":{"polluted":1},"parts":{"__proto__":{"shapes":[]}}}'))).not.toThrow()
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined()
  })
})

describe('normaliseHex', () => {
  it.each([['#abc', '#aabbcc'], ['#A1B2C3', '#a1b2c3'], ['#12345', null], ['123456', null], ['#gggggg', null], [5, null]])('%j -> %j', (v, out) => expect(normaliseHex(v)).toBe(out))
})

describe('compileSpec', () => {
  it('no spec is the default black cat with every default part and nothing hidden', () => {
    const c = compileSpec(null)
    expect(c.coat.fur).toBe('#4b5068')
    expect(c.hidden.size).toBe(0)
    expect(c.scale).toBe(1)
    for (const p of SPEC_PARTS) expect(c.shapes[p].length).toBe(p === 'tailTip' ? 0 : FIGURE_SHAPES[p as keyof typeof FIGURE_SHAPES].length)
    expect(compileSpec(EMPTY_SPEC).palette).toEqual(c.palette)
  })
  it('a palette change recolours the coat and the voxel palette', () => {
    const c = compileSpec(ok({ palette: { fur: '#00ff00' } }))
    expect(c.coat.fur).toBe('#00ff00')
    expect(c.palette[0]![1]).toBeGreaterThan(c.palette[0]![0]!)
  })
  it('extra shapes are added after the defaults; replace swaps them; custom colours get their own palette slots, shared when equal', () => {
    const add = compileSpec(ok({ parts: { head: { shapes: [shape({ color: '#112233' }), shape({ color: '#112233' }), shape({ color: '#445566' })] } } }))
    expect(add.shapes.head.length).toBe(FIGURE_SHAPES.head.length + 3)
    const idx = add.shapes.head.slice(-3).map((s) => s.color)
    expect(idx[0]).toBe(8)
    expect(idx[1]).toBe(8)
    expect(idx[2]).toBe(9)
    expect(add.palette).toHaveLength(9)
    const rep = compileSpec(ok({ parts: { head: { replace: true, shapes: [shape()] } } }))
    expect(rep.shapes.head).toHaveLength(1)
    expect(rep.shapes.head[0]!.color).toBe(1)
  })
  it('hidden parts and scale are carried', () => {
    const c = compileSpec(ok({ hide: ['leg', 'phone'], scale: 1.1 }))
    expect([...c.hidden].sort()).toEqual(['leg', 'phone'])
    expect(c.scale).toBe(1.1)
  })
  it('every part of a compiled spec voxelizes into a bounded grid', () => {
    const c = compileSpec(ok({ parts: { tailTip: { shapes: [shape({ center: [0, 0, 2], radii: [3, 0.5, 2] })] } } }))
    for (const p of SPEC_PARTS) {
      const g = buildFigurePart(p as never, c.shapes[p])
      expect(g.size[0]).toBeLessThan(40)
      expect(g.size[1]).toBeLessThan(40)
      expect(g.size[2]).toBeLessThan(40)
    }
    expect(buildFigurePart('torso' as never, c.shapes.tailTip).count).toBeGreaterThan(0)
  })
})

describe('quickRecolour', () => {
  it.each([
    ["change my cat's skin to green", 'green'],
    ['make him purple please', 'purple'],
    ['red, no wait, blue', 'blue']
  ])('%s', (text, colour) => {
    const s = quickRecolour(text, null)!
    expect(s.name.toLowerCase()).toContain(colour)
    expect(s.palette.fur).toMatch(/^#[0-9a-f]{6}$/)
    expect(s.palette.furHi).not.toBe(s.palette.fur)
  })
  it('keeps the rest of the current look', () => {
    const cur = ok({ hide: ['leg'], parts: { head: { shapes: [shape()] } } })
    const s = quickRecolour('go orange', cur)!
    expect(s.hide).toEqual(['leg'])
    expect(s.parts.head).toBeDefined()
  })
  it('returns null when no colour is named', () => expect(quickRecolour('turn into a mermaid', null)).toBeNull())
})

describe('describeDefaults', () => {
  it('lists the editable parts with plain colour roles', () => {
    const d = describeDefaults() as Record<string, Array<{ color: string }>>
    expect(Object.keys(d).sort()).toEqual(['ear', 'foreArm', 'head', 'leg', 'phone', 'torso', 'upperArm'])
    expect(d['torso']!.length).toBe(3)
    expect(JSON.stringify(d)).not.toContain('function')
  })
})

describe('the ready-made pets', () => {
  const presets = loadPresets(join(__dirname, '../assets'))
  it('all load and validate', () => {
    expect(presets.map((p) => p.id)).toEqual(['green', 'mermaid', 'robot', 'wizard'])
  })
  it.each(['green', 'mermaid', 'robot', 'wizard'])('%s compiles into bounded meshes', (id) => {
    const c = compileSpec(presets.find((p) => p.id === id)!.spec)
    for (const p of SPEC_PARTS) {
      const g = buildFigurePart(p as never, c.shapes[p])
      expect(Math.max(...g.size)).toBeLessThan(40)
    }
  })
})
