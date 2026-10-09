import type { Point, Ring } from '../../src/types.js'

const TOKEN = /([MLHVCSQTZmlhvcsqtz])|([+-]?(?:\d*\.\d+|\d+)(?:[eE][+-]?\d+)?)/g
const ARITY: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, Z: 0 }

/** 把 SVG 路径展开成闭合折线。曲线按 `tolerance`（与路径同一单位）细分。不支持圆弧。 */
export function pathToRings(d: string, tolerance = 0.5): Ring[] {
  const tokens: Array<string | number> = []
  for (const m of d.matchAll(TOKEN)) tokens.push(m[1] ?? Number(m[2]))
  const rings: Ring[] = []
  let ring: Ring = []
  let cur: Point = { x: 0, y: 0 }
  let start: Point = cur
  let lastCtrl: Point | null = null
  let lastOp = ''
  let op = 'M'
  let i = 0
  const close = () => {
    if (ring.length >= 3) rings.push(ring)
    ring = []
  }
  while (i < tokens.length) {
    if (typeof tokens[i] === 'string') op = tokens[i++] as string
    const upper = op.toUpperCase()
    const rel = op !== upper
    if (upper === 'Z') {
      close()
      cur = start
      lastOp = 'Z'
      continue
    }
    const n = ARITY[upper]
    if (n == null || i + n > tokens.length) break
    const a = tokens.slice(i, i + n) as number[]
    i += n
    const pt = (k: number): Point => (rel ? { x: cur.x + a[k]!, y: cur.y + a[k + 1]! } : { x: a[k]!, y: a[k + 1]! })
    if (upper === 'M') {
      close()
      cur = start = pt(0)
      ring.push(cur)
      op = rel ? 'l' : 'L'
      lastCtrl = null
    } else if (upper === 'L' || upper === 'H' || upper === 'V') {
      const next =
        upper === 'H' ? { x: rel ? cur.x + a[0]! : a[0]!, y: cur.y } : upper === 'V' ? { x: cur.x, y: rel ? cur.y + a[0]! : a[0]! } : pt(0)
      ring.push(next)
      cur = next
      lastCtrl = null
    } else if (upper === 'Q' || upper === 'T') {
      const c: Point =
        upper === 'Q' ? pt(0) : lastCtrl && (lastOp === 'Q' || lastOp === 'T') ? reflect(lastCtrl, cur) : cur
      const end = upper === 'Q' ? pt(2) : pt(0)
      quad(ring, cur, c, end, tolerance)
      lastCtrl = c
      cur = end
    } else if (upper === 'C' || upper === 'S') {
      const c1: Point = upper === 'C' ? pt(0) : lastCtrl && (lastOp === 'C' || lastOp === 'S') ? reflect(lastCtrl, cur) : cur
      const c2 = upper === 'C' ? pt(2) : pt(0)
      const end = upper === 'C' ? pt(4) : pt(2)
      cubic(ring, cur, c1, c2, end, tolerance)
      lastCtrl = c2
      cur = end
    }
    lastOp = upper
  }
  close()
  return rings.map(dedupe).filter((r) => r.length >= 3)
}

function reflect(c: Point, about: Point): Point {
  return { x: 2 * about.x - c.x, y: 2 * about.y - c.y }
}

function steps(len: number, tolerance: number): number {
  return Math.max(2, Math.min(64, Math.ceil(Math.sqrt(len / Math.max(tolerance, 1e-3)) * 1.5)))
}

function quad(out: Ring, p0: Point, c: Point, p1: Point, tol: number) {
  const n = steps(Math.hypot(c.x - p0.x, c.y - p0.y) + Math.hypot(p1.x - c.x, p1.y - c.y), tol)
  for (let k = 1; k <= n; k++) {
    const t = k / n
    const u = 1 - t
    out.push({ x: u * u * p0.x + 2 * u * t * c.x + t * t * p1.x, y: u * u * p0.y + 2 * u * t * c.y + t * t * p1.y })
  }
}

function cubic(out: Ring, p0: Point, c1: Point, c2: Point, p1: Point, tol: number) {
  const len =
    Math.hypot(c1.x - p0.x, c1.y - p0.y) + Math.hypot(c2.x - c1.x, c2.y - c1.y) + Math.hypot(p1.x - c2.x, p1.y - c2.y)
  const n = steps(len, tol)
  for (let k = 1; k <= n; k++) {
    const t = k / n
    const u = 1 - t
    const a = u * u * u
    const b = 3 * u * u * t
    const c = 3 * u * t * t
    const e = t * t * t
    out.push({ x: a * p0.x + b * c1.x + c * c2.x + e * p1.x, y: a * p0.y + b * c1.y + c * c2.y + e * p1.y })
  }
}

function dedupe(r: Ring): Ring {
  const out: Ring = []
  for (const p of r) {
    const q = out[out.length - 1]
    if (!q || Math.hypot(p.x - q.x, p.y - q.y) > 1e-6) out.push(p)
  }
  if (out.length > 1 && Math.hypot(out[0]!.x - out[out.length - 1]!.x, out[0]!.y - out[out.length - 1]!.y) < 1e-6) out.pop()
  return out
}

/** 去掉原路折返的尖刺：前后两条边几乎反向时删掉中间的点，反复直到没有。 */
export function removeSpikes(r: Ring): Ring {
  let ring = r
  for (let pass = 0; pass < 16 && ring.length > 3; pass++) {
    const n = ring.length
    const drop = new Uint8Array(n)
    let changed = false
    for (let i = 0; i < n; i++) {
      const a = ring[(i - 1 + n) % n]!
      const b = ring[i]!
      const c = ring[(i + 1) % n]!
      const u = { x: b.x - a.x, y: b.y - a.y }
      const v = { x: c.x - b.x, y: c.y - b.y }
      const lu = Math.hypot(u.x, u.y)
      const lv = Math.hypot(v.x, v.y)
      if (lu < 1e-9 || lv < 1e-9 || (u.x * v.x + u.y * v.y) / (lu * lv) < -0.995) {
        drop[i] = 1
        changed = true
        i++
      }
    }
    if (!changed) break
    ring = ring.filter((_, i) => !drop[i])
  }
  return ring
}

/** 闭合折线的 Douglas–Peucker 简化。 */
export function simplifyRing(r: Ring, tol: number): Ring {
  if (r.length < 8) return r
  let far = 0
  let best = -1
  for (let i = 1; i < r.length; i++) {
    const d = Math.hypot(r[i]!.x - r[0]!.x, r[i]!.y - r[0]!.y)
    if (d > best) {
      best = d
      far = i
    }
  }
  const a = dp(r.slice(0, far + 1), tol)
  const b = dp([...r.slice(far), r[0]!], tol)
  return [...a.slice(0, -1), ...b.slice(0, -1)]
}

function dp(pts: Point[], tol: number): Point[] {
  const keep = new Uint8Array(pts.length)
  keep[0] = 1
  keep[pts.length - 1] = 1
  const stack: Array<[number, number]> = [[0, pts.length - 1]]
  while (stack.length) {
    const [s, e] = stack.pop()!
    const p = pts[s]!
    const q = pts[e]!
    const dx = q.x - p.x
    const dy = q.y - p.y
    const len = Math.hypot(dx, dy) || 1
    let max = -1
    let idx = -1
    for (let i = s + 1; i < e; i++) {
      const d = Math.abs((pts[i]!.x - p.x) * dy - (pts[i]!.y - p.y) * dx) / len
      if (d > max) {
        max = d
        idx = i
      }
    }
    if (max > tol && idx > 0) {
      keep[idx] = 1
      stack.push([s, idx], [idx, e])
    }
  }
  return pts.filter((_, i) => keep[i])
}

export function ringsToPath(rings: Ring[], digits = 2): string {
  const f = (n: number) => {
    const v = Number(n.toFixed(digits))
    return String(Object.is(v, -0) ? 0 : v)
  }
  return rings
    .filter((r) => r.length >= 3)
    .map((r) => `M${r.map((p) => `${f(p.x)} ${f(p.y)}`).join('L')}Z`)
    .join('')
}

export function mapRings(rings: Ring[], fn: (p: Point) => Point): Ring[] {
  return rings.map((r) => r.map(fn))
}

export function ringsBounds(rings: Ring[]): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const r of rings)
    for (const p of r) {
      minX = Math.min(minX, p.x)
      minY = Math.min(minY, p.y)
      maxX = Math.max(maxX, p.x)
      maxY = Math.max(maxY, p.y)
    }
  return { minX, minY, maxX, maxY }
}
