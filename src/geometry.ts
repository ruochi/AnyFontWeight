import type { Contour, Point, Ring } from './types.js'

const CORNER_COS = Math.cos((25 * Math.PI) / 180)

export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function sub(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y }
}

export function norm(a: Point): Point {
  const l = Math.hypot(a.x, a.y) || 1
  return { x: a.x / l, y: a.y / l }
}

export function lerp(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

/** 边 a→b 的左手单位法线（y 轴向下）。轮廓逆时针时，它指向外侧。 */
export function edgeNormal(a: Point, b: Point): Point {
  const d = norm(sub(b, a))
  return { x: d.y, y: -d.x }
}

export function vertexNormals(c: Contour): Point[] {
  const n = c.pts.length
  const out: Point[] = []
  for (let k = 0; k < n; k++) {
    const a = edgeNormal(c.pts[(k - 1 + n) % n]!, c.pts[k]!)
    const b = edgeNormal(c.pts[k]!, c.pts[(k + 1) % n]!)
    out.push(norm({ x: a.x + b.x, y: a.y + b.y }))
  }
  return out
}

function dropClosingDuplicate(ring: Ring): Ring {
  if (ring.length > 1 && dist(ring[0]!, ring[ring.length - 1]!) < 1e-6) return ring.slice(0, -1)
  return ring
}

/**
 * 把折线加密到大约 `step` 的间距，标出拐点，并统一成「左手法线指向墨迹外侧」。
 * 重叠的笔画要先在外面合并成不自交的轮廓，这里不做布尔运算。
 */
export function prepareRings(rings: Ring[], step: number): Contour[] {
  const contours: Contour[] = []
  for (const ring of rings) {
    const cleaned = dropClosingDuplicate(ring)
    if (cleaned.length < 3) continue
    const pts: Point[] = []
    const hard: boolean[] = []
    const n = cleaned.length
    for (let i = 0; i < n; i++) {
      const a = cleaned[i]!
      const b = cleaned[(i + 1) % n]!
      const segs = Math.max(1, Math.ceil(dist(a, b) / Math.max(step, 1e-6)))
      for (let k = 0; k < segs; k++) {
        pts.push(lerp(a, b, k / segs))
        hard.push(k === 0)
      }
    }
    contours.push(finishContour(pts, hard))
  }
  orientOutward(contours)
  return contours
}

function finishContour(pts: Point[], hard: boolean[]): Contour {
  const n = pts.length
  const corner = pts.map((_, k) => {
    if (!hard[k]) return false
    const a = pts[(k - 1 + n) % n]!
    const b = pts[k]!
    const c = pts[(k + 1) % n]!
    const u = norm(sub(b, a))
    const v = norm(sub(c, b))
    return u.x * v.x + u.y * v.y < CORNER_COS
  })
  return { pts, corner }
}

function orientOutward(contours: Contour[]) {
  for (const c of contours) {
    const n = c.pts.length
    let votes = 0
    for (let k = 0; k < n; k += Math.max(1, Math.floor(n / 16))) {
      const e = edgeNormal(c.pts[k]!, c.pts[(k + 1) % n]!)
      const mid = lerp(c.pts[k]!, c.pts[(k + 1) % n]!, 0.5)
      const probe = { x: mid.x + e.x * 0.25, y: mid.y + e.y * 0.25 }
      votes += insideEvenOdd(contours, probe) ? -1 : 1
    }
    if (votes < 0) {
      c.pts.reverse()
      c.corner.reverse()
    }
  }
}

export function insideEvenOdd(contours: Contour[], p: Point): boolean {
  let inside = false
  for (const c of contours) {
    const pts = c.pts
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const a = pts[i]!
      const b = pts[j]!
      if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
    }
  }
  return inside
}

export function boundsOf(rings: Ring[]): { width: number; height: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const ring of rings) {
    for (const p of ring) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
  }
  if (!Number.isFinite(minX)) return { width: 0, height: 0 }
  return { width: maxX - minX, height: maxY - minY }
}
