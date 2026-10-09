import { describe, expect, it } from 'vitest'
import type { Point, Ring } from '../../src/types.js'
import { fitRing } from './bezier.js'
import type { HanziData } from './hanzi.js'
import { applyStep, type Work } from './ops.js'
import { ringsBounds } from './outline.js'
import { brush, connectStrokes, extendStrokes } from './skelops.js'
import { buildSkeleton, polyLength } from './skeleton.js'
import { fromSkeleton, hybrid, type SStroke, type StrokeGlyph } from './strokes.js'

const EM = 400

function rect(x: number, y: number, w: number, h: number): Ring {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ]
}

const cross = [rect(40, 180, 320, 40), rect(180, 40, 40, 320)]

function bez(c: [Point, Point, Point, Point], t: number): Point {
  const u = 1 - t
  return {
    x: u * u * u * c[0].x + 3 * u * u * t * c[1].x + 3 * u * t * t * c[2].x + t * t * t * c[3].x,
    y: u * u * u * c[0].y + 3 * u * u * t * c[1].y + 3 * u * t * t * c[2].y + t * t * t * c[3].y,
  }
}

function line(a: Point, b: Point, w: number, n = 40): SStroke {
  const pts = Array.from({ length: n + 1 }, (_, i) => ({ x: a.x + ((b.x - a.x) * i) / n, y: a.y + ((b.y - a.y) * i) / n }))
  return { id: 1, type: '横', pts, width: pts.map(() => w), start: { kind: 'free' }, end: { kind: 'free' } }
}

describe('贝塞尔拟合', () => {
  it('圆拟合后处处贴着原圆', () => {
    const ring = Array.from({ length: 64 }, (_, i) => ({ x: 100 + Math.cos((i / 64) * Math.PI * 2) * 80, y: 100 + Math.sin((i / 64) * Math.PI * 2) * 80 }))
    const cs = fitRing(ring, 0.5)
    expect(cs.length).toBeLessThan(16)
    for (const c of cs) for (let t = 0; t <= 1; t += 0.1) expect(Math.abs(Math.hypot(bez(c, t).x - 100, bez(c, t).y - 100) - 80)).toBeLessThan(1)
  })

  it('细长条的长边不会鼓出去', () => {
    const cs = fitRing(rect(0, 0, 300, 8), 0.5)
    for (const c of cs)
      for (let t = 0; t <= 1; t += 0.05) {
        const p = bez(c, t)
        expect(p.y).toBeGreaterThan(-0.6)
        expect(p.y).toBeLessThan(8.6)
      }
  })
})

describe('骨架字形', () => {
  it('自动骨架：十字是两笔，宽度是原笔画粗细', () => {
    const sg = fromSkeleton(buildSkeleton(cross, EM), EM)
    expect(sg.strokes.map((s) => s.type).sort()).toEqual(['横', '竖'])
    for (const s of sg.strokes) {
      const mid = s.width[Math.floor(s.width.length / 2)]!
      expect(mid).toBeGreaterThan(30)
      expect(mid).toBeLessThan(48)
    }
  })

  it('混合：沿用逐笔数据的笔顺，位置吸到字体的中心线上', () => {
    // 逐笔数据里先竖后横，位置故意偏一点
    const data: HanziData = {
      char: '十',
      strokes: [[rect(480, 60, 60, 900)], [rect(60, 470, 900, 60)]],
      medians: [
        [
          { x: 510, y: 80 },
          { x: 510, y: 940 },
        ],
        [
          { x: 80, y: 500 },
          { x: 940, y: 500 },
        ],
      ],
    }
    const sg = hybrid(data, cross, buildSkeleton(cross, EM), EM)
    expect(sg.strokes.map((s) => s.type)).toEqual(['竖', '横'])
    const [v, h] = sg.strokes
    for (const p of v!.pts) expect(Math.abs(p.x - 200)).toBeLessThan(4)
    for (const p of h!.pts) expect(Math.abs(p.y - 200)).toBeLessThan(4)
    expect(Math.abs(v!.width[Math.floor(v!.width.length / 4)]! - 40)).toBeLessThan(6)
  })
})

describe('骨架变形和笔刷', () => {
  it('延长收笔，长度加上延长量', () => {
    const s = line({ x: 0, y: 0 }, { x: 200, y: 0 }, 20)
    extendStrokes([s], { end: 0.1 }, EM)
    expect(polyLength(s.pts)).toBeCloseTo(240, 0)
  })

  it('前一笔收笔离下一笔起笔不远就连一根牵丝', () => {
    const a = line({ x: 0, y: 0 }, { x: 100, y: 0 }, 20)
    const b = { ...line({ x: 140, y: 30 }, { x: 240, y: 30 }, 20), id: 2 }
    const sg: StrokeGlyph = { source: 'auto', strokes: [a, b] }
    connectStrokes(sg, {}, EM)
    expect(sg.strokes.filter((s) => s.link)).toHaveLength(1)
  })

  it('定宽笔刷的粗细等于设定值；压感让收笔变细', () => {
    const sg: StrokeGlyph = { source: 'auto', strokes: [line({ x: 0, y: 0 }, { x: 300, y: 0 }, 30)] }
    const flat = ringsBounds(brush(sg, { width: 0.05, cap: 'butt' }, EM))
    expect(flat.maxY - flat.minY).toBeCloseTo(20, 0)
    const pressed = brush(sg, { width: 0.05, pressure: [1, 1, 0.2], cap: 'butt' }, EM)
    const tail = pressed.flat().filter((p) => p.x > 290)
    expect(Math.max(...tail.map((p) => Math.abs(p.y)))).toBeLessThan(4)
  })

  it('步骤里把横画转 90° 再画回去，字变高', () => {
    const w: Work = { rings: [rect(40, 180, 320, 40)], box: { x: 0, y: 0, w: EM, h: EM }, em: EM, index: 0, char: '一', cache: {} }
    const ctx = { chars: ['一'] }
    applyStep(w, { op: 'skeleton', source: 'auto' }, ctx)
    applyStep(w, { op: 'transform', select: { types: ['横'] }, rotate: 90 }, ctx)
    applyStep(w, { op: 'brush', width: 0.04 }, ctx)
    const b = ringsBounds(w.rings)
    expect(b.maxY - b.minY).toBeGreaterThan(250)
    expect(b.maxX - b.minX).toBeLessThan(30)
  })
})
