import { describe, expect, it } from 'vitest'
import type { Point } from '../../src/types.js'
import { BRUSHES } from './brushes.js'
import { brush, filletStrokes, resolveBrush, straightenStrokes } from './skelops.js'
import { inkTest, smoothMedian, type SStroke, type StrokeGlyph } from './strokes.js'

const EM = 400

function stroke(pts: Point[], w = 20, type: SStroke['type'] = '横'): SStroke {
  return { id: 1, type, pts, width: pts.map(() => w), start: { kind: 'free' }, end: { kind: 'free' } }
}

function glyph(...strokes: SStroke[]): StrokeGlyph {
  return { source: 'hanzi', strokes: strokes.map((s, i) => ({ ...s, id: i + 1 })) }
}

const turn = (a: Point, b: Point, c: Point) => {
  const t1 = Math.atan2(b.y - a.y, b.x - a.x)
  const t2 = Math.atan2(c.y - b.y, c.x - b.x)
  return Math.abs(((t2 - t1 + 3 * Math.PI) % (2 * Math.PI)) - Math.PI)
}

describe('中线平滑', () => {
  it('横折的折角还在，直段上没有起伏', () => {
    const pts = smoothMedian([{ x: 40, y: 100 }, { x: 200, y: 100 }, { x: 360, y: 100 }, { x: 360, y: 260 }, { x: 360, y: 360 }], EM)
    const corner = pts.findIndex((p) => Math.hypot(p.x - 360, p.y - 100) < 1e-6)
    expect(corner).toBeGreaterThan(0)
    expect(turn(pts[corner - 1]!, pts[corner]!, pts[corner + 1]!)).toBeGreaterThan(Math.PI / 3)
    for (const p of pts.slice(0, corner)) expect(Math.abs(p.y - 100)).toBeLessThan(0.5)
  })
})

describe('规整', () => {
  it('略斜、略拱的长横拉成正横', () => {
    const pts = Array.from({ length: 41 }, (_, i) => ({ x: 40 + i * 8, y: 200 - i * 0.6 - Math.sin((i / 40) * Math.PI) * 10 }))
    const s = stroke(pts)
    straightenStrokes([s], {}, EM)
    const ys = s.pts.map((p) => p.y)
    expect(Math.max(...ys) - Math.min(...ys)).toBeLessThan(1e-6)
  })

  it('竖前面的楷体小起钩去掉，竖变正竖', () => {
    const hook = [{ x: 186, y: 56 }, { x: 196, y: 64 }]
    const body = Array.from({ length: 30 }, (_, i) => ({ x: 200 + i * 0.3, y: 70 + i * 10 }))
    const s = stroke([...hook, ...body], 20, '竖')
    straightenStrokes([s], {}, EM)
    const xs = s.pts.map((p) => p.x)
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(1e-6)
    expect(s.pts[0]!.y).toBeGreaterThan(60)
    expect(s.width.length).toBe(s.pts.length)
  })

  it('正横接正竖时交在同一个角上', () => {
    const s = stroke([{ x: 40, y: 104 }, { x: 200, y: 100 }, { x: 352, y: 96 }, { x: 356, y: 230 }, { x: 360, y: 360 }], 20, '折')
    straightenStrokes([s], {}, EM)
    const corner = s.pts.find((p) => Math.abs(p.x - s.pts[s.pts.length - 1]!.x) < 1e-6 && Math.abs(p.y - s.pts[0]!.y) < 1e-6)
    expect(corner).toBeTruthy()
  })
})

describe('圆转', () => {
  it('折角变圆，两端不动', () => {
    const pts = Array.from({ length: 81 }, (_, i) => (i <= 40 ? { x: 40 + i * 8, y: 100 } : { x: 360, y: 100 + (i - 40) * 6 }))
    const s = stroke(pts, 20, '折')
    filletStrokes([s], 0.07, EM)
    expect(s.pts[0]).toEqual({ x: 40, y: 100 })
    expect(s.pts[s.pts.length - 1]).toEqual({ x: 360, y: 340 })
    const near = s.pts.reduce((m, p) => Math.min(m, Math.hypot(p.x - 360, p.y - 100)), Infinity)
    expect(near).toBeGreaterThan(EM * 0.01)
    for (let i = 1; i < s.pts.length - 1; i++) expect(turn(s.pts[i - 1]!, s.pts[i]!, s.pts[i + 1]!)).toBeLessThan(Math.PI / 6)
  })
})

describe('笔刷预设', () => {
  const h = stroke(Array.from({ length: 41 }, (_, i) => ({ x: 40 + i * 8, y: 200 })))

  it('每个预设都能画出墨', () => {
    for (const preset of Object.keys(BRUSHES)) expect(brush(glyph(h), { preset }, EM).length, preset).toBeGreaterThan(0)
  })

  it('没有的预设报错，自己写的参数盖过预设', () => {
    expect(() => resolveBrush({ preset: '没有这个' })).toThrow()
    expect(resolveBrush({ preset: '圆体', width: 0.01 }).width).toBe(0.01)
    expect(resolveBrush({ preset: '圆体' }).width).toBe(BRUSHES['圆体']!.width)
  })

  it('空心笔中间是空的，边上有墨', () => {
    const solid = inkTest(brush(glyph(h), { preset: '圆体' }, EM))
    const hollow = inkTest(brush(glyph(h), { preset: '空心' }, EM))
    expect(solid({ x: 200, y: 200 })).toBe(true)
    expect(hollow({ x: 200, y: 200 })).toBe(false)
    expect(hollow({ x: 200, y: 200 + (0.11 * EM) / 2 - 2 })).toBe(true)
  })

  it('点阵按间距盖点，交叉处不重复盖', () => {
    const rings = brush(glyph(h), { preset: '点阵' }, EM)
    const spacing = (BRUSHES['点阵']!.stamp!.spacing ?? 0.05) * EM
    expect(rings.length).toBeGreaterThanOrEqual(Math.floor(320 / spacing))
    expect(rings.length).toBeLessThanOrEqual(Math.ceil(320 / spacing) + 2)
    const v = stroke(Array.from({ length: 41 }, (_, i) => ({ x: 200, y: 40 + i * 8 })), 20, '竖')
    const both = brush(glyph(h, v), { preset: '点阵' }, EM)
    const centers = both.map((r) => ({ x: r.reduce((a, p) => a + p.x, 0) / r.length, y: r.reduce((a, p) => a + p.y, 0) / r.length }))
    for (let i = 0; i < centers.length; i++)
      for (let j = i + 1; j < centers.length; j++) expect(Math.hypot(centers[i]!.x - centers[j]!.x, centers[i]!.y - centers[j]!.y)).toBeGreaterThan(spacing * 0.5)
  })

  it('飞白起笔饱满，越往后越干', () => {
    const ink = inkTest(brush(glyph(h), { preset: '飞白' }, EM))
    const cover = (x0: number) => {
      let n = 0
      let all = 0
      for (let x = x0; x < x0 + 60; x += 2) for (let y = 186; y <= 214; y += 2, all++) if (ink({ x, y })) n++
      return n / all
    }
    expect(cover(60)).toBeGreaterThan(cover(290))
    expect(cover(290)).toBeLessThan(0.9)
  })

  it('毛笔的斜笔尖让横比竖细', () => {
    const v = stroke(Array.from({ length: 41 }, (_, i) => ({ x: 200, y: 40 + i * 8 })), 20, '竖')
    const thick = (s: SStroke, probe: (t: number) => Point) => {
      const ink = inkTest(brush(glyph(s), { preset: '毛笔', pressureByType: undefined, taperByType: undefined }, EM))
      let n = 0
      for (let t = -60; t <= 60; t += 0.5) if (ink(probe(t))) n++
      return n
    }
    expect(thick(h, (t) => ({ x: 200, y: 200 + t }))).toBeLessThan(thick(v, (t) => ({ x: 200 + t, y: 200 })))
  })
})
