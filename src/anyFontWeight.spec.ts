import { describe, expect, it } from 'vitest'
import { selfIntersections } from '../scripts/check.js'
import { anyFontWeight, variableGlyph } from './anyFontWeight.js'
import { boundsOf } from './geometry.js'
import type { Ring } from './types.js'

function rect(x: number, y: number, w: number, h: number): Ring {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ]
}

function size(rings: Ring[]) {
  return boundsOf(rings)
}

describe('anyFontWeight', () => {
  const bar = [rect(0, 40, 100, 20)]

  it('同一字重不改变外框', () => {
    const out = anyFontWeight(bar, { from: 400, to: 400, em: 100 })
    const box = size(out)
    expect(box.width).toBeCloseTo(100, 1)
    expect(box.height).toBeCloseTo(20, 1)
  })

  it('字重升高时笔画变粗，降低时变细', () => {
    const bold = size(anyFontWeight(bar, { from: 400, to: 700, em: 100 }))
    const light = size(anyFontWeight(bar, { from: 400, to: 200, em: 100 }))
    expect(bold.height).toBeGreaterThan(21)
    expect(bold.width).toBeGreaterThan(101)
    expect(light.height).toBeLessThan(19)
    expect(light.height).toBeGreaterThan(10)
  })

  it('加粗时字腔变小，但不会被填死', () => {
    const frame = [rect(0, 0, 100, 100), rect(40, 40, 20, 20)]
    const bold = anyFontWeight(frame, { from: 400, to: 900, em: 100 })
    const hole = size([bold[1]!])
    expect(hole.width).toBeLessThan(20)
    expect(hole.width).toBeGreaterThan(4)
    expect(hole.height).toBeGreaterThan(4)
  })

  it('点数不够的环会被跳过', () => {
    expect(anyFontWeight([[{ x: 0, y: 0 }, { x: 1, y: 1 }]], { to: 700, em: 10 })).toEqual([])
  })

  it('变细时凸角不会绕出小圈', () => {
    for (const ring of anyFontWeight(bar, { from: 400, to: 100, em: 100 })) expect(selfIntersections(ring)).toBe(0)
  })

  it('横竖比例 k 只改变横笔画的加粗量', () => {
    const iso = size(anyFontWeight(bar, { from: 400, to: 700, em: 100 }))
    const half = size(anyFontWeight(bar, { from: 400, to: 700, em: 100, k: 0.5 }))
    expect(half.width).toBeCloseTo(iso.width, 1)
    expect(half.height - 20).toBeCloseTo((iso.height - 20) / 2, 1)
  })

  it('外框收缩让字整体变小', () => {
    const plain = size(anyFontWeight(bar, { from: 400, to: 700, em: 100 }))
    const shrunk = size(anyFontWeight(bar, { from: 400, to: 700, em: 100, shrink: 0.01 }))
    expect(shrunk.width).toBeLessThan(plain.width - 2)
  })
})

describe('variableGlyph', () => {
  it('和 anyFontWeight 结果一致，各字重点数相同', () => {
    const glyph = [rect(0, 0, 100, 100), rect(30, 30, 40, 40)]
    const at = variableGlyph(glyph, { from: 400, em: 100 })
    const counts = at(400).map((r) => r.length)
    for (const w of [200, 550, 800]) {
      const out = at(w)
      expect(out).toEqual(anyFontWeight(glyph, { from: 400, to: w, em: 100 }))
      expect(out.map((r) => r.length)).toEqual(counts)
    }
  })

  it('没有可用的环时返回空', () => {
    expect(variableGlyph([], { em: 10 })(700)).toEqual([])
  })
})
