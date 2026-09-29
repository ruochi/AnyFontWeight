import { vertexNormals } from './geometry.js'
import type { Contour, Point } from './types.js'

/** 每个轮廓点的局部几何：内侧是笔画半宽，外侧是到相邻笔画的半空隙。 */
export type PointInfo = {
  p: Point
  /** 指向墨迹外侧的单位法线 */
  n: Point
  rIn: number
  rOut: number
  cIn: Point
  cOut: Point
  reliableIn: boolean
  reliableOut: boolean
  corner: boolean
}

export type MedialGlyph = {
  contours: PointInfo[][]
  /** 整字平均半空隙，单位是 em */
  space: number
  center: Point
}

export type MedialOptions = {
  /** 外侧空隙上限（em），超过视为开阔 */
  rOutMax: number
  /** 计算整字密度时 rOut 的截断值（em） */
  spaceCap: number
  /** 接触角阈值（度）。更小的圆落在拐角上，不当成笔画宽度 */
  minContactAngle: number
  medianRadius: number
}

export const DEFAULT_MEDIAL: MedialOptions = { rOutMax: 0.4, spaceCap: 0.15, minContactAngle: 110, medianRadius: 3 }

class Grid {
  private cells = new Map<number, number[]>()
  constructor(
    private pts: Point[],
    private size: number,
  ) {
    pts.forEach((p, i) => {
      const k = this.key(Math.floor(p.x / size), Math.floor(p.y / size))
      const cell = this.cells.get(k)
      if (cell) cell.push(i)
      else this.cells.set(k, [i])
    })
  }
  private key(gx: number, gy: number) {
    return (gx + 4096) * 8192 + (gy + 4096)
  }
  nearest(q: Point): { index: number; d: number } {
    const gx = Math.floor(q.x / this.size)
    const gy = Math.floor(q.y / this.size)
    let best = -1
    let bestD2 = Infinity
    for (let ring = 0; ring < 512; ring++) {
      for (let dx = -ring; dx <= ring; dx++) {
        for (let dy = -ring; dy <= ring; dy++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue
          const cell = this.cells.get(this.key(gx + dx, gy + dy))
          if (!cell) continue
          for (const i of cell) {
            const p = this.pts[i]!
            const d2 = (p.x - q.x) ** 2 + (p.y - q.y) ** 2
            if (d2 < bestD2) {
              bestD2 = d2
              best = i
            }
          }
        }
      }
      if (best >= 0 && ring * this.size >= Math.sqrt(bestD2)) break
    }
    return { index: best, d: Math.sqrt(bestD2) }
  }
}

/** 沿 dir 收缩，直到圆恰好经过另一个采样点。 */
function shrinkingBall(
  i: number,
  pts: Point[],
  grid: Grid,
  dir: Point,
  rMax: number,
): { r: number; c: Point; contact: number } {
  const p = pts[i]!
  let r = rMax
  let contact = -1
  for (let iter = 0; iter < 40; iter++) {
    const c = { x: p.x + dir.x * r, y: p.y + dir.y * r }
    const { index: j, d } = grid.nearest(c)
    if (j === i || j < 0 || d >= r - 1e-4) break
    const q = pts[j]!
    const denom = 2 * (dir.x * (q.x - p.x) + dir.y * (q.y - p.y))
    if (denom <= 1e-9) break
    const next = ((p.x - q.x) ** 2 + (p.y - q.y) ** 2) / denom
    if (next >= r - 1e-6) break
    r = next
    contact = j
  }
  return { r, c: { x: p.x + dir.x * r, y: p.y + dir.y * r }, contact }
}

function contactAngle(p: Point, c: Point, q: Point | undefined): number {
  if (!q) return 180
  const a = Math.atan2(p.y - c.y, p.x - c.x)
  const b = Math.atan2(q.y - c.y, q.x - c.x)
  let d = Math.abs(a - b)
  if (d > Math.PI) d = 2 * Math.PI - d
  return (d * 180) / Math.PI
}

export function computeMedial(contours: Contour[], em: number, opts: MedialOptions = DEFAULT_MEDIAL): MedialGlyph {
  const rOutMax = opts.rOutMax * em
  const all: Point[] = []
  const normals: Point[] = []
  const owner: Array<[number, number]> = []
  contours.forEach((c, ci) => {
    const ns = vertexNormals(c)
    c.pts.forEach((p, k) => {
      all.push(p)
      normals.push(ns[k]!)
      owner.push([ci, k])
    })
  })
  const grid = new Grid(all, Math.max(em * 0.025, 1e-4))
  const out: PointInfo[][] = contours.map(() => [])
  for (let i = 0; i < all.length; i++) {
    const p = all[i]!
    const n = normals[i]!
    const [ci, k] = owner[i]!
    const inner = shrinkingBall(i, all, grid, { x: -n.x, y: -n.y }, rOutMax)
    const outer = shrinkingBall(i, all, grid, n, rOutMax)
    out[ci]![k] = {
      p,
      n,
      rIn: inner.r,
      rOut: outer.r,
      cIn: inner.c,
      cOut: outer.c,
      reliableIn: contactAngle(p, inner.c, all[inner.contact]) >= opts.minContactAngle,
      reliableOut: outer.contact < 0 || contactAngle(p, outer.c, all[outer.contact]) >= opts.minContactAngle,
      corner: contours[ci]!.corner[k]!,
    }
  }
  for (const ring of out) {
    fillUnreliable(ring, 'rIn', 'reliableIn')
    fillUnreliable(ring, 'rOut', 'reliableOut')
    medianFilter(ring, 'rIn', opts.medianRadius)
  }
  const flat = out.flat()
  const cap = opts.spaceCap * em
  const space = flat.reduce((s, q) => s + Math.min(q.rOut, cap), 0) / Math.max(1, flat.length) / em
  const xs = all.map((p) => p.x)
  const ys = all.map((p) => p.y)
  return {
    contours: out,
    space,
    center: {
      x: (Math.min(...xs) + Math.max(...xs)) / 2,
      y: (Math.min(...ys) + Math.max(...ys)) / 2,
    },
  }
}

function fillUnreliable(ring: PointInfo[], key: 'rIn' | 'rOut', flag: 'reliableIn' | 'reliableOut') {
  const n = ring.length
  if (ring.every((q) => q[flag]) || ring.every((q) => !q[flag])) return
  const src = ring.map((q) => q[key])
  for (let i = 0; i < n; i++) {
    if (ring[i]![flag]) continue
    let back = 1
    while (!ring[(i - back + n) % n]![flag]) back++
    let fwd = 1
    while (!ring[(i + fwd) % n]![flag]) fwd++
    const a = src[(i - back + n) % n]!
    const b = src[(i + fwd) % n]!
    ring[i]![key] = a + ((b - a) * back) / (back + fwd)
  }
}

function medianFilter(ring: PointInfo[], key: 'rIn' | 'rOut', radius: number) {
  if (radius <= 0) return
  const n = ring.length
  const src = ring.map((q) => q[key])
  const win: number[] = []
  for (let i = 0; i < n; i++) {
    win.length = 0
    for (let o = -radius; o <= radius; o++) win.push(src[(i + o + n) % n]!)
    win.sort((a, b) => a - b)
    ring[i]![key] = win[radius]!
  }
}
