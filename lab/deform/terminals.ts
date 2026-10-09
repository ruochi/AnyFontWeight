import { prepareRings } from '../../src/geometry.js'
import { computeMedial } from '../../src/medial.js'
import type { Contour, Point, Ring } from '../../src/types.js'

/**
 * 笔画末端：轮廓上一段约 180° 的凸转弯，两侧是近似平行的笔画边。
 * `a`、`b` 是这段转弯在加密轮廓上的首尾下标，可能跨过 0。
 */
export type Terminal = {
  contour: number
  a: number
  b: number
  /** 末端两侧的起点 A=pts[a]、终点 B=pts[b]，以及它们的中点 */
  A: Point
  B: Point
  base: Point
  /** 末端朝外的单位方向 */
  dir: Point
  tip: Point
  /** A 到 B 的距离 */
  width: number
  /** 末端后面笔画边保持顺直的长度 */
  run: number
  /** 从末端顺着 dir 到本字其它墨迹的距离，碰不到时为 null */
  free: number | null
}

export type GlyphAnalysis = {
  contours: Contour[]
  terminals: Terminal[]
}

const DEG = Math.PI / 180

function edgeDirs(pts: Point[]): Point[] {
  const n = pts.length
  const out: Array<Point | null> = pts.map((p, i) => {
    const q = pts[(i + 1) % n]!
    const l = Math.hypot(q.x - p.x, q.y - p.y)
    return l > 1e-9 ? { x: (q.x - p.x) / l, y: (q.y - p.y) / l } : null
  })
  // 零长度的边沿用前一条边的方向，否则拐角的转角会被吞掉
  const first = out.findIndex((e) => e)
  if (first < 0) return pts.map(() => ({ x: 1, y: 0 }))
  for (let k = 1; k <= n; k++) {
    const i = (first + k) % n
    if (!out[i]) out[i] = out[(i - 1 + n) % n]!
  }
  return out as Point[]
}

function dropNearDuplicates(r: Ring, eps: number): Ring {
  const out: Ring = []
  for (const p of r) {
    const q = out[out.length - 1]
    if (!q || Math.hypot(p.x - q.x, p.y - q.y) > eps) out.push(p)
  }
  while (out.length > 1 && Math.hypot(out[0]!.x - out[out.length - 1]!.x, out[0]!.y - out[out.length - 1]!.y) <= eps) out.pop()
  return out
}

/** 顶点 i 处从边 i-1 转到边 i 的角度。轮廓已统一成墨迹在右手，正值是朝墨迹一侧的凸转。 */
function turns(dirs: Point[]): number[] {
  const n = dirs.length
  return dirs.map((e, i) => {
    const f = dirs[(i - 1 + n) % n]!
    return Math.atan2(f.x * e.y - f.y * e.x, f.x * e.x + f.y * e.y)
  })
}

function segLen(pts: Point[], i: number): number {
  const n = pts.length
  const p = pts[((i % n) + n) % n]!
  const q = pts[(((i + 1) % n) + n) % n]!
  return Math.hypot(q.x - p.x, q.y - p.y)
}

type Candidate = { a: number; b: number; sum: number; len: number }

function signedArea(r: Ring): number {
  let s = 0
  for (let i = 0; i < r.length; i++) {
    const p = r[i]!
    const q = r[(i + 1) % r.length]!
    s += p.x * q.y - q.x * p.y
  }
  return s / 2
}

function inRing(r: Ring, p: Point): boolean {
  let inside = false
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i]!
    const b = r[j]!
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

function winding(r: Ring, p: Point): number {
  let w = 0
  for (let i = 0; i < r.length; i++) {
    const a = r[i]!
    const b = r[(i + 1) % r.length]!
    if (a.y <= p.y) {
      if (b.y > p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) > 0) w++
    } else if (b.y <= p.y && (b.x - a.x) * (p.y - a.y) - (p.x - a.x) * (b.y - a.y) < 0) w--
  }
  return w
}

/**
 * 字体轮廓常常逐笔重叠（可变字体导出的静态字重尤其如此）。
 * 把每个外轮廓和它包住的字腔分成一组，组内不重叠，中轴才量得准。
 */
export function groupRings(rings: Ring[]): Ring[][] {
  if (rings.length === 0) return []
  const areas = rings.map(signedArea)
  const outerSign = Math.sign(areas.reduce((best, a) => (Math.abs(a) > Math.abs(best) ? a : best), 0))
  const outers = rings.map((_, i) => i).filter((i) => Math.sign(areas[i]!) === outerSign)
  const groups = new Map<number, Ring[]>(outers.map((i) => [i, [rings[i]!]]))
  rings.forEach((r, i) => {
    if (Math.sign(areas[i]!) === outerSign) return
    const owner = outers
      .filter((o) => inRing(rings[o]!, r[0]!))
      .sort((p, q) => Math.abs(areas[p]!) - Math.abs(areas[q]!))[0]
    if (owner == null) groups.set(i, [r])
    else groups.get(owner)!.push(r)
  })
  return [...groups.values()]
}

export function analyzeGlyph(rings: Ring[], em: number): GlyphAnalysis {
  const groups = groupRings(rings)
  const contours: Contour[] = []
  const owner: number[] = []
  const medialR: number[][] = []
  groups.forEach((g, gi) => {
    const cs = prepareRings(
      g.map((r) => dropNearDuplicates(r, em * 0.0005)),
      em * 0.005,
    )
    if (cs.length === 0) return
    const m = computeMedial(cs, em)
    cs.forEach((c, k) => {
      contours.push(c)
      owner.push(gi)
      medialR.push(m.contours[k]!.map((q) => q.rIn))
    })
  })
  if (contours.length === 0) return { contours, terminals: [] }
  const hidden = (t: Terminal) => {
    const probe = { x: t.tip.x - t.dir.x * t.width * 0.3, y: t.tip.y - t.dir.y * t.width * 0.3 }
    let w = 0
    groups.forEach((g, gi) => {
      if (gi !== owner[t.contour]) for (const r of g) w += winding(r, probe)
    })
    return w !== 0
  }
  const terminals: Terminal[] = []
  contours.forEach((c, ci) => {
    const pts = c.pts
    const n = pts.length
    if (n < 8) return
    const dirs = edgeDirs(pts)
    const tau = turns(dirs)
    const rIn = medialR[ci]!
    const maxLen = em * 0.55
    const found: Candidate[] = []
    for (let a = 0; a < n; a++) {
      let sum = 0
      let neg = 0
      let len = 0
      for (let k = 0; k < n; k++) {
        const j = (a + k) % n
        sum += tau[j]!
        if (tau[j]! < 0) neg += tau[j]!
        if (neg < -25 * DEG || sum < -30 * DEG) break
        if (sum >= 160 * DEG) {
          if (sum <= 215 * DEG) found.push({ a, b: j, sum, len })
          break
        }
        len += segLen(pts, j)
        if (len > maxLen) break
      }
    }
    for (const cand of pickBest(found, n)) {
      const t = buildTerminal(ci, pts, dirs, tau, rIn, cand, em)
      if (t && !hidden(t)) terminals.push(t)
    }
  })
  for (const t of terminals) t.free = freeAhead(contours, t, em)
  terminals.sort((p, q) => Math.round(p.tip.y / (em * 0.12)) - Math.round(q.tip.y / (em * 0.12)) || p.tip.x - q.tip.x)
  return { contours, terminals }
}

/** 同一处末端会被很多起点命中，按下标区间重叠分组，每组留转角最接近 180° 且最短的一个。 */
function pickBest(found: Candidate[], n: number): Candidate[] {
  const span = (c: Candidate) => (c.b - c.a + n) % n
  const overlaps = (p: Candidate, q: Candidate) => {
    const inside = (i: number, c: Candidate) => (i - c.a + n) % n <= span(c)
    return inside(p.a, q) || inside(p.b, q) || inside(q.a, p) || inside(q.b, p)
  }
  const groups: Candidate[][] = []
  for (const c of found) {
    const g = groups.find((grp) => grp.some((o) => overlaps(o, c)))
    if (g) g.push(c)
    else groups.push([c])
  }
  return groups.map((g) =>
    g.reduce((best, c) => {
      const score = (x: Candidate) => Math.abs(x.sum - Math.PI) * 2 + x.len / 100
      return score(c) < score(best) ? c : best
    }),
  )
}

function median(v: number[]): number {
  if (v.length === 0) return 0
  const s = v.slice().sort((x, y) => x - y)
  return s[Math.floor(s.length / 2)]!
}

function buildTerminal(
  ci: number,
  pts: Point[],
  dirs: Point[],
  tau: number[],
  rIn: number[],
  cand: Candidate,
  em: number,
): Terminal | null {
  const n = pts.length
  let { a, b } = cand
  const at = (i: number) => pts[((i % n) + n) % n]!
  const chord = () => Math.hypot(at(a).x - at(b).x, at(a).y - at(b).y)
  // 尖头的末端弦太短，往两边退，直到开口像一段笔画。途中再遇到急转，多半是自交的小环，不算末端
  for (let guard = 0; chord() < em * 0.03; guard++) {
    if (guard >= 40) return null
    a = (a - 1 + n) % n
    b = (b + 1) % n
    if (Math.abs(tau[a]!) > 30 * DEG || Math.abs(tau[b]!) > 30 * DEG) return null
  }
  const W = chord()
  if (W > em * 0.24) return null
  const back = (from: number, step: number) => {
    let len = 0
    let turn = 0
    const radii: number[] = []
    for (let k = 1; k < n / 2; k++) {
      const i = (((from + step * k) % n) + n) % n
      turn += Math.abs(tau[i]!)
      if (turn > 22 * DEG) break
      len += segLen(pts, step > 0 ? i - 1 : i)
      radii.push(rIn[i]!)
    }
    return { len, r: median(radii) }
  }
  const sideA = back(a, -1)
  const sideB = back(b, 1)
  const half = Math.max(sideA.r, sideB.r)
  if (half > 0 && W / (2 * half) > 1.9) return null
  const run = Math.min(sideA.len, sideB.len)
  if (run < W * 0.35) return null
  const ein = dirs[(a - 1 + n) % n]!
  const eout = dirs[b]!
  let dir = { x: ein.x - eout.x, y: ein.y - eout.y }
  const dl = Math.hypot(dir.x, dir.y) || 1
  dir = { x: dir.x / dl, y: dir.y / dl }
  const A = at(a)
  const B = at(b)
  const base = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 }
  let tip = base
  let depth = -Infinity
  for (let k = 0; k <= (b - a + n) % n; k++) {
    const p = at(a + k)
    const d = (p.x - base.x) * dir.x + (p.y - base.y) * dir.y
    if (d > depth) {
      depth = d
      tip = p
    }
  }
  tip = { x: base.x + dir.x * Math.max(depth, 0), y: base.y + dir.y * Math.max(depth, 0) }
  return { contour: ci, a, b, A, B, base, dir, tip, width: W, run, free: null }
}

/** 从末端顺着方向射出去，量到本字其它轮廓的距离。 */
function freeAhead(contours: Contour[], t: Terminal, em: number): number | null {
  const o = { x: t.tip.x + t.dir.x * em * 0.01, y: t.tip.y + t.dir.y * em * 0.01 }
  let best = Infinity
  for (const c of contours) {
    const pts = c.pts
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!
      const q = pts[(i + 1) % pts.length]!
      const ex = q.x - p.x
      const ey = q.y - p.y
      const den = t.dir.x * ey - t.dir.y * ex
      if (Math.abs(den) < 1e-9) continue
      const s = ((p.x - o.x) * ey - (p.y - o.y) * ex) / den
      const u = ((p.x - o.x) * t.dir.y - (p.y - o.y) * t.dir.x) / den
      if (s > 0 && u >= 0 && u <= 1) best = Math.min(best, s)
    }
  }
  return Number.isFinite(best) ? best : null
}

const COMPASS = ['右', '右下', '下', '左下', '左', '左上', '上', '右上']

export function compass(dir: Point): string {
  const ang = (Math.atan2(dir.y, dir.x) * 180) / Math.PI
  return COMPASS[((Math.round(ang / 45) % 8) + 8) % 8]!
}
