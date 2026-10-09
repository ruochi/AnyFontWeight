import { describe, expect, it } from 'vitest'
import type { Ring } from '../../src/types.js'
import { difference, offset, union } from './bool.js'
import { applyStep, type Step, type Work } from './ops.js'
import { ringsBounds } from './outline.js'
import { buildSkeleton } from './skeleton.js'

const EM = 400

function rect(x: number, y: number, w: number, h: number): Ring {
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ]
}

function area(rings: Ring[]): number {
  let s = 0
  for (const r of rings)
    for (let i = 0; i < r.length; i++) {
      const a = r[i]!
      const b = r[(i + 1) % r.length]!
      s += a.x * b.y - b.x * a.y
    }
  return Math.abs(s / 2)
}

function work(rings: Ring[]): Work {
  return { rings, box: { x: 0, y: 0, w: EM, h: EM }, em: EM, index: 0, char: '十', cache: {} }
}

function run(rings: Ring[], ...steps: Step[]): Ring[] {
  const w = work(rings)
  for (const s of steps) applyStep(w, s, { chars: ['十'] })
  return w.rings
}

const cross = [rect(40, 180, 320, 40), rect(180, 40, 40, 320)]

describe('布尔运算', () => {
  it('重叠的两笔并成一块，面积不重复计算', () => {
    expect(area(union(cross))).toBeCloseTo(320 * 40 * 2 - 40 * 40, 0)
  })

  it('外扩之后再挖掉原形，剩下一圈', () => {
    const ring = difference(offset([rect(0, 0, 100, 100)], 10, 'miter'), [rect(0, 0, 100, 100)])
    expect(area(ring)).toBeCloseTo(120 * 120 - 100 * 100, 0)
  })
})

describe('骨架', () => {
  it('十字是一横一竖，交在一个点上', () => {
    const sk = buildSkeleton(cross, EM)
    expect(sk.strokes.map((s) => s.type).sort()).toEqual(['横', '竖'])
    expect(sk.nodes.filter((n) => n.kind === 'junction' && n.edges.length === 4)).toHaveLength(1)
    const h = sk.strokes.find((s) => s.type === '横')!
    expect(h.length).toBeGreaterThan(300)
  })

  it('离得远的小方块是点', () => {
    const sk = buildSkeleton([rect(40, 180, 320, 40), rect(180, 60, 36, 36)], EM)
    expect(sk.components.filter((c) => c.dot)).toHaveLength(1)
  })
})

describe('操作', () => {
  it('重描成单线：笔宽等于设定值，圆头不超出原字身', () => {
    const out = run([rect(40, 180, 320, 40)], { op: 'restroke', width: 0.02 })
    const b = ringsBounds(out)
    expect(b.maxY - b.minY).toBeCloseTo(8, 0)
    expect(b.minX).toBeGreaterThan(36)
    expect(b.maxX).toBeLessThan(364)
  })

  it('模板字断口：止于交叉点的那一笔不再和另一笔相连', () => {
    const t = [rect(40, 60, 320, 40), rect(180, 60, 40, 300)]
    const out = run(t, { op: 'restroke', width: 0.03, cap: 'butt', gap: 0.02 })
    expect(out.length).toBe(2)
  })

  it('切一刀变成两块，错开后整体变宽', () => {
    const bar = [rect(40, 40, 40, 320)]
    const out = run(bar, { op: 'slice', angle: 0, gap: 0.02, shift: 0.1 })
    expect(out).toHaveLength(2)
    const b = ringsBounds(out)
    expect(b.maxX - b.minX).toBeCloseTo(40 + 40, 0)
  })

  it('按朝向只改向下的末端', () => {
    const bar = [rect(180, 40, 40, 320)]
    const out = run(bar, { op: 'cap', style: 'point', size: 1, select: { dir: ['下'] } })
    const b = ringsBounds(out)
    expect(b.maxY).toBeGreaterThan(360 + 30)
    expect(b.minY).toBeCloseTo(40, 0)
  })

  it('小方块换成圆点', () => {
    const out = run([rect(40, 180, 320, 40), rect(180, 60, 30, 30)], { op: 'dots', shape: 'circle' })
    expect(area(out)).toBeCloseTo(320 * 40 + Math.PI * 15 * 15, -2)
  })

  it('几何化把斜边吸附到 45°', () => {
    const tilted: Ring = [
      { x: 0, y: 0 },
      { x: 200, y: 10 },
      { x: 210, y: 210 },
      { x: 5, y: 200 },
    ]
    const [ring] = run([tilted], { op: 'geometrize', tolerance: 0.001, snap: 45 })
    for (let i = 0; i < ring!.length; i++) {
      const a = ring![i]!
      const b = ring![(i + 1) % ring!.length]!
      const ang = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
      expect(Math.abs(ang / 45 - Math.round(ang / 45))).toBeLessThan(0.01)
    }
  })
})
