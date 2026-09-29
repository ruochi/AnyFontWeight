import type { Point, Ring } from '../src/types.js'

/** 同一个环里互不相邻的两段相交的次数。连续重复的点先合并。 */
export function selfIntersections(ring: Ring): number {
  const pts = ring.filter((p, i) => {
    const q = ring[(i + 1) % ring.length]!
    return Math.hypot(p.x - q.x, p.y - q.y) > 1e-7
  })
  const n = pts.length
  let hits = 0
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue
      if (crosses(pts[i]!, pts[(i + 1) % n]!, pts[j]!, pts[(j + 1) % n]!)) hits++
    }
  }
  return hits
}

function crosses(a: Point, b: Point, c: Point, d: Point): boolean {
  const r = { x: b.x - a.x, y: b.y - a.y }
  const s = { x: d.x - c.x, y: d.y - c.y }
  const den = r.x * s.y - r.y * s.x
  if (Math.abs(den) < 1e-12) return false
  const t = ((c.x - a.x) * s.y - (c.y - a.y) * s.x) / den
  const u = ((c.x - a.x) * r.y - (c.y - a.y) * r.x) / den
  const e = 1e-9
  return t > e && t < 1 - e && u > e && u < 1 - e
}
