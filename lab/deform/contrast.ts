import { edgeNormal, prepareRings } from '../../src/geometry.js'
import type { Point, Ring } from '../../src/types.js'
import { removeSpikes, simplifyRing } from './outline.js'
import { groupRings } from './terminals.js'

const MITER_LIMIT = 4

/**
 * 横竖分开加减粗：每条边按自己的法线取位移 v·nx² + h·ny²，拐角用斜接。
 * reweight 先算顶点位移再平均到边上，横竖符号相反时拐角会留下小耳朵，这里直接按边算。
 */
export function applyContrast(rings: Ring[], c: { vertical: number; horizontal: number }, em: number): Ring[] {
  const v = c.vertical * em
  const h = c.horizontal * em
  // 先简化、不加密：比偏移量还短的边在锐角处会翘出小刺
  return groupRings(rings).flatMap((group) =>
    prepareRings(
      group.map((r) => removeSpikes(simplifyRing(removeSpikes(r), em * 0.0008))),
      Infinity,
    ).map(({ pts }) => removeSpikes(removeLocalLoops(dropFlipped(offset(pts, v, h)), 24))),
  )
}

function offset(pts: Point[], v: number, h: number): Array<{ p: Point; from: Point }> {
  const n = pts.length
  const normals = pts.map((p, i) => edgeNormal(p, pts[(i + 1) % n]!))
  const d = normals.map((e) => v * e.x * e.x + h * e.y * e.y)
  return pts.map((p, i) => {
    const k = (i - 1 + n) % n
    const o = miter(normals[k]!, d[k]!, normals[i]!, d[i]!)
    return { p: { x: p.x + o.x, y: p.y + o.y }, from: p }
  })
}

/** 比偏移量还短的边偏移后会掉头，删掉掉头边的终点，直到没有掉头边。 */
function dropFlipped(moved: Array<{ p: Point; from: Point }>): Point[] {
  let ring = moved
  for (let pass = 0; pass < 8 && ring.length > 3; pass++) {
    const n = ring.length
    const keep = ring.filter((q, i) => {
      const r = ring[(i - 1 + n) % n]!
      const dot = (q.p.x - r.p.x) * (q.from.x - r.from.x) + (q.p.y - r.p.y) * (q.from.y - r.from.y)
      return dot > 0
    })
    if (keep.length === ring.length) break
    ring = keep
  }
  return ring.map((q) => q.p)
}

function cross(a: Point, b: Point, c: Point, d: Point): Point | null {
  const r = { x: b.x - a.x, y: b.y - a.y }
  const s = { x: d.x - c.x, y: d.y - c.y }
  const den = r.x * s.y - r.y * s.x
  if (Math.abs(den) < 1e-12) return null
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den
  const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den
  if (t <= 0 || t >= 1 || u <= 0 || u >= 1) return null
  return { x: a.x + r.x * t, y: a.y + r.y * t }
}

/** 拐角内侧偏移后会打一个小结。在附近 `window` 条边里找自交，把结剪掉。 */
function removeLocalLoops(pts: Point[], window: number): Point[] {
  let ring = pts
  for (let pass = 0; pass < 4; pass++) {
    const n = ring.length
    const drop = new Uint8Array(n)
    const replace = new Map<number, Point>()
    let changed = false
    for (let i = 0; i < n; i++) {
      if (drop[i]) continue
      for (let k = 2; k <= Math.min(window, n - 2); k++) {
        const j = (i + k) % n
        const hit = cross(ring[i]!, ring[(i + 1) % n]!, ring[j]!, ring[(j + 1) % n]!)
        if (!hit) continue
        for (let m = 1; m <= k; m++) drop[(i + m) % n] = 1
        replace.set((i + 1) % n, hit)
        changed = true
        i += k
        break
      }
    }
    if (!changed) return ring
    ring = ring.flatMap((p, i) => (replace.has(i) ? [replace.get(i)!] : drop[i] ? [] : [p]))
  }
  return ring
}

function miter(n1: Point, d1: number, n2: Point, d2: number): Point {
  const det = n1.x * n2.y - n1.y * n2.x
  if (Math.abs(det) < 0.05) {
    const avg = (d1 + d2) / 2
    const m = { x: n1.x + n2.x, y: n1.y + n2.y }
    const l = Math.hypot(m.x, m.y) || 1
    return { x: (m.x / l) * avg, y: (m.y / l) * avg }
  }
  const x = { x: (d1 * n2.y - d2 * n1.y) / det, y: (n1.x * d2 - n2.x * d1) / det }
  const len = Math.hypot(x.x, x.y)
  const lim = MITER_LIMIT * Math.max(Math.abs(d1), Math.abs(d2), 1e-6)
  return len > lim ? { x: (x.x / len) * lim, y: (x.y / len) * lim } : x
}
