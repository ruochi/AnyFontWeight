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

export function paramsForWeight(
  from: number,
  to: number,
  em: number,
  tuning: { perHundred?: number; k?: number; shrink?: number } = {},
): ReweightParams {
  const steps = (to - from) / 100
  return {
    b: steps * (tuning.perHundred ?? EM_PER_100_WEIGHT) * em,
    c: 0,
    k: tuning.k ?? 1,
    alpha: 0.6,
    rMin: 0.004 * em,
    gamma: 0,
    sigma: steps * (tuning.shrink ?? 0),
  }
}

/** `n` 决定横竖比例用哪个方向，默认是点的法线。 */
export function displacement(q: PointInfo, p: ReweightParams, density = 1, n: Point = q.n): number {
  const dirW = n.x * n.x + p.k * n.y * n.y
  const raw = (p.b * density + p.c * q.rIn) * dirW
  if (raw > 0) return Math.min(raw, p.alpha * q.rOut)
  return Math.max(raw, -Math.max(0, q.rIn - p.rMin))
}

const MITER_LIMIT = 3

/**
 * 每条边按两端位移的平均值平移，横竖比例按边自己的法线算，拐角用斜接，保持原来的尖角。
 * 平滑不跨过拐角，否则横边会混进竖边的位移。
 */
export function reweight(m: MedialGlyph, p: ReweightParams): Ring[] {
  const rings: Ring[] = []
  const density = p.gamma ? Math.pow(Math.max(1e-3, m.space) / SPACE_REF, p.gamma) : 1
  const s = 1 - p.sigma
  const place = (v: Point): Point => ({ x: m.center.x + (v.x - m.center.x) * s, y: m.center.y + (v.y - m.center.y) * s })
  for (const ring of m.contours) {
    const n = ring.length
    const edgeN: Point[] = []
    const raw: number[] = []
    for (let i = 0; i < n; i++) {
      const a = ring[i]!
      const b = ring[(i + 1) % n]!
      const e = edgeNormal(a.p, b.p)
      edgeN.push(e)
      raw.push((displacement(a, p, density, e) + displacement(b, p, density, e)) / 2)
    }
    const edgeD = smoothEdges(raw, ring)
    const pts: Point[] = []
    for (let i = 0; i < n; i++) {
      const n1 = edgeN[(i - 1 + n) % n]!
      const d1 = edgeD[(i - 1 + n) % n]!
      const n2 = edgeN[i]!
      const d2 = edgeD[i]!
      pts.push(add(place(ring[i]!.p), miterOffset(n1, d1, n2, d2)))
    }
    untangle(pts, loopWindow(ring, edgeD))
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

/** 夹角 θ 的尖缝两侧，越界的长度约为 d / tan(θ/2)，按 θ ≈ 5° 估算 */
const LOOP_REACH = 12

/** 拐角附近的点位移超过它到拐角的距离时会越过另一条边，窗口要覆盖这段距离两侧的点。 */
function loopWindow(ring: PointInfo[], d: number[]): number {
  const n = ring.length
  let len = 0
  for (let i = 0; i < n; i++) {
    const a = ring[i]!.p
    const b = ring[(i + 1) % n]!.p
    len += Math.hypot(b.x - a.x, b.y - a.y)
  }
  const maxD = d.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
  const step = len / n || 1
  return Math.min(Math.floor(n / 2) - 1, Math.ceil((2 * LOOP_REACH * maxD) / step) + 2)
}

/** 平移后拐角处相邻几段会交叉成小圈。把圈里的点收到交点上，点数不变。 */
function untangle(pts: Point[], window: number) {
  const n = pts.length
  for (let i = 0; i < n; i++) {
    const a = pts[i]!
    const b = pts[(i + 1) % n]!
    for (let g = window; g >= 2; g--) {
      const j = (i + g) % n
      const x = intersect(a, b, pts[j]!, pts[(j + 1) % n]!)
      if (!x) continue
      for (let k = 1; k <= g; k++) pts[(i + k) % n] = x
      break
    }
  }
}

function intersect(a: Point, b: Point, c: Point, d: Point): Point | null {
  const r = { x: b.x - a.x, y: b.y - a.y }
  const s = { x: d.x - c.x, y: d.y - c.y }
  const den = r.x * s.y - r.y * s.x
  if (Math.abs(den) < 1e-12) return null
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den
  const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den
  if (t < 0 || t > 1 || u < 0 || u > 1) return null
  return { x: a.x + r.x * t, y: a.y + r.y * t }
}

/** 边 i 连着点 i 和 i+1。和两侧相邻的边取平均，隔着拐角的那一侧不算。 */
function smoothEdges(v: number[], ring: PointInfo[]): number[] {
  const n = v.length
  return v.map((x, i) => {
    let s = x
    let w = 1
    if (!ring[i]!.corner) {
      s += v[(i - 1 + n) % n]!
      w++
    }
    if (!ring[(i + 1) % n]!.corner) {
      s += v[(i + 1) % n]!
      w++
    }
    return s / w
  })
}

function add(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y }
}
