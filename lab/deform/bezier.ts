import type { Point, Ring } from '../../src/types.js'

/**
 * 把折线拟合成三次贝塞尔（Schneider 1990）。先在转角大于 `corner` 度的顶点处断开，
 * 每段单独拟合，误差超过 `tol` 就在误差最大处再分。
 */
export type Cubic = [Point, Point, Point, Point]

const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y })
const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y })
const mul = (a: Point, k: number): Point => ({ x: a.x * k, y: a.y * k })
const dot = (a: Point, b: Point) => a.x * b.x + a.y * b.y
const len = (a: Point) => Math.hypot(a.x, a.y)
const unit = (a: Point): Point => {
  const l = len(a) || 1
  return { x: a.x / l, y: a.y / l }
}

function bez(c: Cubic, t: number): Point {
  const u = 1 - t
  return {
    x: u * u * u * c[0].x + 3 * u * u * t * c[1].x + 3 * u * t * t * c[2].x + t * t * t * c[3].x,
    y: u * u * u * c[0].y + 3 * u * u * t * c[1].y + 3 * u * t * t * c[2].y + t * t * t * c[3].y,
  }
}

function chordParams(pts: Point[]): number[] {
  const u = [0]
  for (let i = 1; i < pts.length; i++) u.push(u[i - 1]! + len(sub(pts[i]!, pts[i - 1]!)))
  const total = u[u.length - 1] || 1
  return u.map((v) => v / total)
}

function generate(pts: Point[], u: number[], t1: Point, t2: Point): Cubic {
  const p0 = pts[0]!
  const p3 = pts[pts.length - 1]!
  let c00 = 0
  let c01 = 0
  let c11 = 0
  let x0 = 0
  let x1 = 0
  for (let i = 0; i < pts.length; i++) {
    const t = u[i]!
    const b0 = (1 - t) ** 3
    const b1 = 3 * t * (1 - t) ** 2
    const b2 = 3 * t * t * (1 - t)
    const b3 = t ** 3
    const a1 = mul(t1, b1)
    const a2 = mul(t2, b2)
    c00 += dot(a1, a1)
    c01 += dot(a1, a2)
    c11 += dot(a2, a2)
    const tmp = sub(pts[i]!, add(mul(p0, b0 + b1), mul(p3, b2 + b3)))
    x0 += dot(a1, tmp)
    x1 += dot(a2, tmp)
  }
  const det = c00 * c11 - c01 * c01
  const seg = len(sub(p3, p0))
  let a = det !== 0 ? (x0 * c11 - x1 * c01) / det : 0
  let b = det !== 0 ? (c00 * x1 - c01 * x0) / det : 0
  // 控制柄太长或反向时解是病态的，退回弦长的三分之一
  if (!(a > seg * 1e-3 && b > seg * 1e-3 && a < seg * 2 && b < seg * 2)) a = b = seg / 3
  return [p0, add(p0, mul(t1, a)), add(p3, mul(t2, b)), p3]
}

function maxError(pts: Point[], u: number[], c: Cubic): { err: number; at: number } {
  let err = 0
  let at = Math.floor(pts.length / 2)
  for (let i = 1; i < pts.length - 1; i++) {
    const d = len(sub(bez(c, u[i]!), pts[i]!))
    if (d > err) {
      err = d
      at = i
    }
  }
  return { err, at }
}

function reparam(pts: Point[], u: number[], c: Cubic): number[] {
  const d1: Cubic = [mul(sub(c[1], c[0]), 3), mul(sub(c[2], c[1]), 3), mul(sub(c[3], c[2]), 3), { x: 0, y: 0 }]
  return u.map((t, i) => {
    const p = bez(c, t)
    const u1 = 1 - t
    const q1 = add(add(mul(d1[0], u1 * u1), mul(d1[1], 2 * u1 * t)), mul(d1[2], t * t))
    const q2 = add(mul(sub(d1[1], d1[0]), 2 * u1), mul(sub(d1[2], d1[1]), 2 * t))
    const diff = sub(p, pts[i]!)
    const den = dot(q1, q1) + dot(diff, q2)
    return den === 0 ? t : Math.min(1, Math.max(0, t - dot(diff, q1) / den))
  })
}

function fitSegment(pts: Point[], t1: Point, t2: Point, tol: number, out: Cubic[], depth = 0) {
  if (pts.length === 2) {
    const d = len(sub(pts[1]!, pts[0]!)) / 3
    out.push([pts[0]!, add(pts[0]!, mul(t1, d)), add(pts[1]!, mul(t2, d)), pts[1]!])
    return
  }
  let u = chordParams(pts)
  let c = generate(pts, u, t1, t2)
  let { err, at } = maxError(pts, u, c)
  if (err < tol) return void out.push(c)
  if (err < tol * 4) {
    for (let k = 0; k < 4; k++) {
      u = reparam(pts, u, c)
      c = generate(pts, u, t1, t2)
      ;({ err, at } = maxError(pts, u, c))
      if (err < tol) return void out.push(c)
    }
  }
  if (depth > 12) return void out.push(c)
  const center = unit(sub(pts[at - 1]!, pts[at + 1]!))
  fitSegment(pts.slice(0, at + 1), t1, center, tol, out, depth + 1)
  fitSegment(pts.slice(at), mul(center, -1), t2, tol, out, depth + 1)
}

/** 闭合折线拟合成贝塞尔，转角处保持尖角。 */
export function fitRing(input: Ring, tol: number, corner = 40): Cubic[] {
  // 误差只在数据点上检查，长直边中间要补点，否则曲线会在两点之间鼓出去
  const ring = densify(input, tol * 10)
  const n = ring.length
  if (n < 3) return []
  const turn = (i: number) => {
    const a = unit(sub(ring[i]!, ring[(i - 1 + n) % n]!))
    const b = unit(sub(ring[(i + 1) % n]!, ring[i]!))
    return Math.acos(Math.max(-1, Math.min(1, dot(a, b))))
  }
  const cos = (corner * Math.PI) / 180
  let corners = ring.map((_, i) => i).filter((i) => turn(i) > cos)
  if (corners.length === 0) corners = [0]
  const out: Cubic[] = []
  for (let k = 0; k < corners.length; k++) {
    const a = corners[k]!
    const b = corners[(k + 1) % corners.length]!
    const seg: Point[] = []
    for (let i = a; ; i = (i + 1) % n) {
      seg.push(ring[i]!)
      if (i === b && seg.length > 1) break
    }
    if (seg.length < 2) continue
    const smoothStart = corners.length === 1
    const t1 = smoothStart ? unit(sub(seg[1]!, ring[(a - 1 + n) % n]!)) : unit(sub(seg[1]!, seg[0]!))
    const t2 = smoothStart ? unit(sub(ring[(b - 1 + n) % n]!, seg[1 % seg.length]!)) : unit(sub(seg[seg.length - 2]!, seg[seg.length - 1]!))
    fitSegment(seg, t1, smoothStart ? mul(t1, -1) : t2, tol, out)
  }
  return out
}

export function ringsToCurvePath(rings: Ring[], tol: number, digits = 2): string {
  const f = (v: number) => {
    const r = Number(v.toFixed(digits))
    return String(Object.is(r, -0) ? 0 : r)
  }
  const p = (q: Point) => `${f(q.x)} ${f(q.y)}`
  return rings
    .filter((r) => r.length >= 3)
    .map((r) => {
      const cs = fitRing(r, tol)
      if (cs.length === 0) return ''
      return `M${p(cs[0]![0])}` + cs.map((c) => (isLine(c) ? `L${p(c[3])}` : `C${p(c[1])} ${p(c[2])} ${p(c[3])}`)).join('') + 'Z'
    })
    .join('')
}

/** 控制点都落在弦上就写成直线，文件更小。 */
function isLine(c: Cubic): boolean {
  const d = sub(c[3], c[0])
  const l = len(d) || 1
  const off = (q: Point) => Math.abs(((q.x - c[0].x) * d.y - (q.y - c[0].y) * d.x) / l)
  return off(c[1]) < 0.05 && off(c[2]) < 0.05
}

function densify(r: Ring, step: number): Ring {
  const out: Ring = []
  for (let i = 0; i < r.length; i++) {
    const a = r[i]!
    const b = r[(i + 1) % r.length]!
    const k = Math.max(1, Math.ceil(len(sub(b, a)) / step))
    for (let j = 0; j < k; j++) out.push({ x: a.x + ((b.x - a.x) * j) / k, y: a.y + ((b.y - a.y) * j) / k })
  }
  return out
}
