import { edgeNormal } from './geometry.js'
import type { MedialGlyph, PointInfo } from './medial.js'
import type { Point, Ring } from './types.js'

/**
 * 每个轮廓点沿外法线移动：
 *
 *   d = (b + c · rIn) · (nx² + k · ny²)
 *   加粗时不超过 α · rOut，避免字腔被糊死
 *   变细时半宽不低于 rMin，避免细笔画断开
 *
 * b 是整体加粗量（与轮廓同一单位）。c 让粗笔画比细笔画多长一点。
 * k 是横笔画相对竖笔画的比例，1 表示各向同性。
 * gamma、sigma 默认关闭：笔画密度和外框收缩留到有更多字体再定。
 */
export type ReweightParams = {
  b: number
  c: number
  k: number
  alpha: number
  rMin: number
  gamma: number
  sigma: number
}

/** 每 100 字重改变 0.006 em。这是保守默认值，不是按某一款字体拟合的结果。 */
export const EM_PER_100_WEIGHT = 0.006

export const SPACE_REF = 0.06

export function paramsForWeight(from: number, to: number, em: number): ReweightParams {
  return {
    b: ((to - from) / 100) * EM_PER_100_WEIGHT * em,
    c: 0,
    k: 1,
    alpha: 0.6,
    rMin: 0.004 * em,
    gamma: 0,
    sigma: 0,
  }
}

export function displacement(q: PointInfo, p: ReweightParams, density = 1): number {
  const dirW = q.n.x * q.n.x + p.k * q.n.y * q.n.y
  const raw = (p.b * density + p.c * q.rIn) * dirW
  if (raw > 0) return Math.min(raw, p.alpha * q.rOut)
  return Math.max(raw, -Math.max(0, q.rIn - p.rMin))
}

const MITER_LIMIT = 3

/** 每条边按两端位移的平均值平移，拐角用斜接，保持原来的尖角。 */
export function reweight(m: MedialGlyph, p: ReweightParams): Ring[] {
  const rings: Ring[] = []
  const density = p.gamma ? Math.pow(Math.max(1e-3, m.space) / SPACE_REF, p.gamma) : 1
  const s = 1 - p.sigma
  const place = (v: Point): Point => ({ x: m.center.x + (v.x - m.center.x) * s, y: m.center.y + (v.y - m.center.y) * s })
  for (const ring of m.contours) {
    const n = ring.length
    const d = smooth(ring.map((q) => displacement(q, p, density)), 1)
    const edgeN: Point[] = []
    const edgeD: number[] = []
    for (let i = 0; i < n; i++) {
      edgeN.push(edgeNormal(ring[i]!.p, ring[(i + 1) % n]!.p))
      edgeD.push((d[i]! + d[(i + 1) % n]!) / 2)
    }
    const pts: Point[] = []
    for (let i = 0; i < n; i++) {
      const n1 = edgeN[(i - 1 + n) % n]!
      const d1 = edgeD[(i - 1 + n) % n]!
      const n2 = edgeN[i]!
      const d2 = edgeD[i]!
      pts.push(add(place(ring[i]!.p), miterOffset(n1, d1, n2, d2)))
    }
    rings.push(pts)
  }
  return rings
}

function miterOffset(n1: Point, d1: number, n2: Point, d2: number): Point {
  const det = n1.x * n2.y - n1.y * n2.x
  const avg = (d1 + d2) / 2
  if (Math.abs(det) < 0.2) {
    const m = { x: n1.x + n2.x, y: n1.y + n2.y }
    const l = Math.hypot(m.x, m.y) || 1
    return { x: (m.x / l) * avg, y: (m.y / l) * avg }
  }
  const x = { x: (d1 * n2.y - d2 * n1.y) / det, y: (n1.x * d2 - n2.x * d1) / det }
  const len = Math.hypot(x.x, x.y)
  const lim = MITER_LIMIT * Math.max(Math.abs(d1), Math.abs(d2), 1e-6)
  return len > lim ? { x: (x.x / len) * lim, y: (x.y / len) * lim } : x
}

function smooth(v: number[], radius: number): number[] {
  const n = v.length
  return v.map((_, i) => {
    let s = 0
    for (let o = -radius; o <= radius; o++) s += v[(i + o + n) % n]!
    return s / (2 * radius + 1)
  })
}

function add(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y }
}
