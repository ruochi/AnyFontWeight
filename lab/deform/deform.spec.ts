import { describe, expect, it } from 'vitest'
import type { Ring } from '../../src/types.js'
import { applyContrast } from './contrast.js'
import { removeSpikes, ringsBounds } from './outline.js'
import { spliceContour, swashOutline } from './swash.js'
import { analyzeGlyph, compass } from './terminals.js'

function rect(x: number, y: number, w: number, h: number): Ring {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ]
}

describe('末端检测', () => {
  it('一条横画有左右两个末端，宽度是笔画粗细', () => {
    const { terminals } = analyzeGlyph([rect(10, 40, 80, 12)], 100)
    expect(terminals.map((t) => compass(t.dir)).sort()).toEqual(['右', '左'])
    for (const t of terminals) expect(t.width).toBeCloseTo(12, 0)
  })

  it('逐笔重叠的十字只认四个露在外面的末端', () => {
    const { terminals } = analyzeGlyph([rect(10, 44, 80, 12), rect(44, 10, 12, 80)], 100)
    expect(terminals.map((t) => compass(t.dir)).sort()).toEqual(['上', '下', '右', '左'])
  })

  it('口字框没有末端', () => {
    expect(analyzeGlyph([rect(10, 10, 80, 80), rect(22, 22, 56, 56).reverse()], 100).terminals).toEqual([])
  })
})

describe('延长末端', () => {
  it('从 A 出发、回到 B，横画向右变长', () => {
    const em = 100
    const { contours, terminals } = analyzeGlyph([rect(10, 40, 60, 12)], em)
    const right = terminals.find((t) => compass(t.dir) === '右')!
    const swash = swashOutline(right, { length: 0.3, taper: 0.1 }, em)
    expect(swash[0]!.x).toBeCloseTo(right.A.x, 6)
    expect(swash[swash.length - 1]!.y).toBeCloseTo(right.B.y, 6)
    const ring = spliceContour(contours[right.contour]!.pts, [{ a: right.a, b: right.b, with: swash }])
    const box = ringsBounds([ring])
    expect(box.maxX).toBeGreaterThan(70 + 28)
    expect(box.minX).toBeCloseTo(10, 0)
  })

  it('卷起来的末端停在离起点不远的地方', () => {
    const em = 100
    const { terminals } = analyzeGlyph([rect(10, 40, 60, 12)], em)
    const right = terminals.find((t) => compass(t.dir) === '右')!
    const swash = swashOutline(right, { length: 0.1, curl: 1, curlRadius: 0.12 }, em)
    const box = ringsBounds([swash])
    expect(box.maxX - right.base.x).toBeLessThan(0.1 * em + 2 * 0.12 * em + 12)
    expect(box.maxY - box.minY).toBeGreaterThan(0.12 * em)
  })
})

describe('横竖对比', () => {
  it('竖画加粗、横画变细，拐角不留耳朵', () => {
    const [bar] = applyContrast([rect(0, 40, 100, 20)], { vertical: 0.05, horizontal: -0.05 }, 100)
    const box = ringsBounds([bar!])
    expect(box.maxY - box.minY).toBeCloseTo(10, 6)
    expect(box.maxX - box.minX).toBeCloseTo(110, 6)
    expect(bar).toHaveLength(4)
  })

  it('字腔不会被翻转或压没', () => {
    const rings = applyContrast([rect(0, 0, 100, 100), rect(20, 20, 60, 60).reverse()], { vertical: 0.04, horizontal: -0.04 }, 100)
    const hole = ringsBounds([rings[1]!])
    expect(hole.maxX - hole.minX).toBeCloseTo(52, 6)
    expect(hole.maxY - hole.minY).toBeCloseTo(68, 6)
  })
})

it('去掉原路折返的尖刺', () => {
  const ring = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: -3 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ]
  expect(removeSpikes(ring)).toHaveLength(4)
})
