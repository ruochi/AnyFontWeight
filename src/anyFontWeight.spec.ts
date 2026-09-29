import { describe, expect, it } from 'vitest'
import { anyFontWeight } from './anyFontWeight.js'
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
})
