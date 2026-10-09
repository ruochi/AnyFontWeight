import { createCanvas, Path2D } from '@napi-rs/canvas'
import type { Point, Ring } from '../../src/types.js'
import { ringsBounds, ringsToPath } from './outline.js'

/**
 * 骨架图。端点和交叉点是节点，两节点之间的中心线是边，边上每个点带笔画半宽。
 * 边按走势在交叉点两两接上，就是笔画。
 */
/** `joint` 是剪枝后只剩两条边、已经并掉的点；`gone` 是剪掉的枝杈端点。 */
export type SkNode = { id: number; p: Point; r: number; kind: 'end' | 'junction' | 'loop' | 'joint' | 'gone'; edges: number[] }
export type SkEdge = { id: number; a: number; b: number; pts: Point[]; r: number[] }
export type StrokeType = '横' | '竖' | '撇' | '捺' | '点' | '提' | '折'
/** `ends` 是起点、终点所在的节点 */
export type Stroke = { id: number; edges: number[]; pts: Point[]; ends: [number, number]; type: StrokeType; length: number; angle: number }
export type Component = { nodes: number[]; edges: number[]; center: Point; size: number; length: number; dot: boolean }
export type Skeleton = { nodes: SkNode[]; edges: SkEdge[]; strokes: Stroke[]; components: Component[] }

type Raster = { w: number; h: number; s: number; ox: number; oy: number; ink: Uint8Array }

function rasterize(rings: Ring[], s: number): Raster {
  const b = ringsBounds(rings)
  const pad = 3
  const ox = b.minX - pad / s
  const oy = b.minY - pad / s
  const w = Math.ceil((b.maxX - b.minX) * s) + pad * 2
  const h = Math.ceil((b.maxY - b.minY) * s) + pad * 2
  const canvas = createCanvas(w, h)
  const ctx = canvas.getContext('2d')
  ctx.setTransform(s, 0, 0, s, -ox * s, -oy * s)
  ctx.fillStyle = '#fff'
  ctx.fill(new Path2D(ringsToPath(rings, 3)), 'nonzero')
  const data = ctx.getImageData(0, 0, w, h).data
  const ink = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) ink[i] = data[i * 4 + 3]! > 127 ? 1 : 0
  return { w, h, s, ox, oy, ink }
}

/** Felzenszwalb 的精确欧氏距离变换：每个墨迹像素到最近空白像素的距离。 */
function distanceTransform(r: Raster): Float32Array {
  const { w, h, ink } = r
  const INF = 1e20
  const f = new Float64Array(Math.max(w, h))
  const d = new Float64Array(Math.max(w, h))
  const v = new Int32Array(Math.max(w, h))
  const z = new Float64Array(Math.max(w, h) + 1)
  const grid = new Float64Array(w * h)
  for (let i = 0; i < w * h; i++) grid[i] = ink[i] ? INF : 0
  const pass = (n: number) => {
    let k = 0
    v[0] = 0
    z[0] = -INF
    z[1] = INF
    for (let q = 1; q < n; q++) {
      let sv = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!)
      while (sv <= z[k]!) {
        k--
        sv = (f[q]! + q * q - (f[v[k]!]! + v[k]! * v[k]!)) / (2 * q - 2 * v[k]!)
      }
      k++
      v[k] = q
      z[k] = sv
      z[k + 1] = INF
    }
    k = 0
    for (let q = 0; q < n; q++) {
      while (z[k + 1]! < q) k++
      d[q] = (q - v[k]!) * (q - v[k]!) + f[v[k]!]!
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) f[y] = grid[y * w + x]!
    pass(h)
    for (let y = 0; y < h; y++) grid[y * w + x] = d[y]!
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) f[x] = grid[y * w + x]!
    pass(w)
    for (let x = 0; x < w; x++) grid[y * w + x] = d[x]!
  }
  const out = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) out[i] = Math.sqrt(grid[i]!)
  return out
}

const DX = [0, 1, 1, 1, 0, -1, -1, -1]
const DY = [-1, -1, 0, 1, 1, 1, 0, -1]

/** Zhang–Suen 细化，得到 8 连通、一像素宽的骨架。 */
function thin(r: Raster): Uint8Array {
  const { w, h } = r
  const img = r.ink.slice()
  const nb = (i: number, k: number) => img[i + DY[k]! * w + DX[k]!]!
  let changed = true
  const del: number[] = []
  while (changed) {
    changed = false
    for (let step = 0; step < 2; step++) {
      del.length = 0
      for (let y = 1; y < h - 1; y++)
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x
          if (!img[i]) continue
          let count = 0
          let trans = 0
          for (let k = 0; k < 8; k++) {
            const a = nb(i, k)
            count += a
            if (!a && nb(i, (k + 1) % 8)) trans++
          }
          if (count < 2 || count > 6 || trans !== 1) continue
          const [p2, p4, p6, p8] = [nb(i, 0), nb(i, 2), nb(i, 4), nb(i, 6)]
          if (step === 0 ? p2 * p4 * p6 === 0 && p4 * p6 * p8 === 0 : p2 * p4 * p8 === 0 && p2 * p6 * p8 === 0) del.push(i)
        }
      for (const i of del) img[i] = 0
      if (del.length) changed = true
    }
  }
  return img
}

/** 交叉数：环绕一圈从空到墨的次数。1 是端点，2 是线上，3 及以上是交叉。 */
function crossing(sk: Uint8Array, w: number, i: number): number {
  let t = 0
  for (let k = 0; k < 8; k++) if (!sk[i + DY[k]! * w + DX[k]!] && sk[i + DY[(k + 1) % 8]! * w + DX[(k + 1) % 8]!]) t++
  return t
}

function polyLength(pts: Point[]): number {
  let s = 0
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y)
  return s
}

export type SkeletonOptions = {
  /** 每单位长度多少像素 */
  resolution?: number
  /** 末端枝杈短于交叉点半宽的多少倍就剪掉 */
  prune?: number
}

export function buildSkeleton(rings: Ring[], em: number, opts: SkeletonOptions = {}): Skeleton {
  if (rings.length === 0) return { nodes: [], edges: [], strokes: [], components: [] }
  const s = opts.resolution ?? 600 / em
  const ras = rasterize(rings, s)
  const dist = distanceTransform(ras)
  const sk = thin(ras)
  const { w, h } = ras
  const toPt = (i: number): Point => ({ x: ((i % w) + 0.5) / s + ras.ox, y: (Math.floor(i / w) + 0.5) / s + ras.oy })
  const radius = (i: number) => dist[i]! / s

  const nodeOf = new Int32Array(w * h).fill(-1)
  const nodes: Array<{ pix: number[]; kind: SkNode['kind'] }> = []
  // 交叉像素按 5×5 邻域聚成一个节点
  const junction = new Uint8Array(w * h)
  for (let i = 0; i < w * h; i++) if (sk[i] && crossing(sk, w, i) >= 3) junction[i] = 1
  for (let i = 0; i < w * h; i++) {
    if (!junction[i] || nodeOf[i] >= 0) continue
    const id = nodes.length
    const pix: number[] = []
    const queue = [i]
    nodeOf[i] = id
    while (queue.length) {
      const q = queue.pop()!
      pix.push(q)
      for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const j = q + dy * w + dx
          if (j >= 0 && j < w * h && junction[j] && nodeOf[j] < 0) {
            nodeOf[j] = id
            queue.push(j)
          }
        }
    }
    nodes.push({ pix, kind: 'junction' })
  }
  for (let i = 0; i < w * h; i++) {
    if (!sk[i] || nodeOf[i] >= 0) continue
    let n = 0
    for (let k = 0; k < 8; k++) n += sk[i + DY[k]! * w + DX[k]!]!
    if (n <= 1) {
      nodeOf[i] = nodes.length
      nodes.push({ pix: [i], kind: 'end' })
    }
  }

  const visited = new Uint8Array(w * h)
  const rawEdges: Array<{ a: number; b: number; pix: number[] }> = []
  const nearestJunction = (cur: number) => {
    const cx = cur % w
    const cy = Math.floor(cur / w)
    const reach = dist[cur]! * 1.6 + 2
    let best = -1
    let bestD = Infinity
    nodes.forEach((n, id) => {
      if (n.kind !== 'junction') return
      for (const q of n.pix) {
        const d = Math.hypot((q % w) - cx, Math.floor(q / w) - cy)
        if (d < bestD) {
          bestD = d
          best = id
        }
      }
    })
    return bestD <= reach ? best : -1
  }
  const trace = (start: number, first: number) => {
    const path = [first]
    visited[first] = 1
    let cur = first
    for (;;) {
      let hitNode = -1
      const cand: number[] = []
      for (let k = 0; k < 8; k++) {
        const j = cur + DY[k]! * w + DX[k]!
        if (!sk[j]) continue
        const nj = nodeOf[j]!
        if (nj >= 0) {
          if (nj !== start || path.length > 3) hitNode = nj
        } else if (!visited[j]) cand.push(k)
      }
      if (hitNode >= 0) return rawEdges.push({ a: start, b: hitNode, pix: path })
      if (cand.length === 0) {
        // 走进死路但旁边就是交叉点：路被另一条边先占了，其实是接在交叉点上
        const near = nearestJunction(cur)
        if (near >= 0 && near !== start) return rawEdges.push({ a: start, b: near, pix: path })
        const id = nodes.length
        nodes.push({ pix: [cur], kind: 'end' })
        nodeOf[cur] = id
        path.pop()
        return rawEdges.push({ a: start, b: id, pix: path })
      }
      const k = cand.find((c) => c % 2 === 0) ?? cand[0]!
      cur = cur + DY[k]! * w + DX[k]!
      visited[cur] = 1
      path.push(cur)
    }
  }
  const expand = (id: number) => {
    for (const q of nodes[id]!.pix)
      for (let k = 0; k < 8; k++) {
        const j = q + DY[k]! * w + DX[k]!
        if (!sk[j] || visited[j]) continue
        const nj = nodeOf[j]!
        if (nj < 0) trace(id, j)
        else if (nj !== id && !rawEdges.some((e) => (e.a === id && e.b === nj) || (e.a === nj && e.b === id))) {
          rawEdges.push({ a: id, b: nj, pix: [] })
        }
      }
  }
  for (let id = 0; id < nodes.length; id++) expand(id)
  // 没有端点也没有交叉的闭环，比如细线画的口
  for (let i = 0; i < w * h; i++) {
    if (!sk[i] || visited[i] || nodeOf[i] >= 0) continue
    const id = nodes.length
    nodes.push({ pix: [i], kind: 'loop' })
    nodeOf[i] = id
    visited[i] = 1
    expand(id)
  }

  const center = (pix: number[]) => {
    const ps = pix.map(toPt)
    return { x: ps.reduce((a, p) => a + p.x, 0) / ps.length, y: ps.reduce((a, p) => a + p.y, 0) / ps.length }
  }
  const g: Graph = {
    nodes: nodes.map((n, id) => ({ id, p: center(n.pix), r: Math.max(...n.pix.map(radius)), kind: n.kind, edges: [] })),
    edges: [],
  }
  for (const e of rawEdges) {
    if (e.a === e.b && e.pix.length < 4) continue
    const pts = [g.nodes[e.a]!.p, ...e.pix.map(toPt), g.nodes[e.b]!.p]
    const r = [g.nodes[e.a]!.r, ...e.pix.map(radius), g.nodes[e.b]!.r]
    addEdge(g, e.a, e.b, pts, r)
  }
  contractShort(g)
  pruneSpurs(g, opts.prune ?? 1.5, em)
  const edges = finishEdges(g, ras, em)
  return assemble(g, edges, em)
}

type Graph = { nodes: SkNode[]; edges: Array<SkEdge | null> }

function addEdge(g: Graph, a: number, b: number, pts: Point[], r: number[]) {
  const id = g.edges.length
  g.edges.push({ id, a, b, pts, r })
  g.nodes[a]!.edges.push(id)
  if (b !== a) g.nodes[b]!.edges.push(id)
}

function removeEdge(g: Graph, id: number) {
  const e = g.edges[id]!
  for (const n of [e.a, e.b]) g.nodes[n]!.edges = g.nodes[n]!.edges.filter((x) => x !== id)
  g.edges[id] = null
}

/** 两个交叉点挨得比笔画还近时，多半是十字交叉被细化拆成了两个，合并。 */
function contractShort(g: Graph) {
  for (const e of g.edges) {
    if (!e || e.a === e.b) continue
    const A = g.nodes[e.a]!
    const B = g.nodes[e.b]!
    if (A.kind !== 'junction' || B.kind !== 'junction') continue
    if (polyLength(e.pts) > Math.max(A.r, B.r)) continue
    removeEdge(g, e.id)
    A.p = { x: (A.p.x + B.p.x) / 2, y: (A.p.y + B.p.y) / 2 }
    A.r = Math.max(A.r, B.r)
    for (const id of B.edges.slice()) {
      const f = g.edges[id]!
      if (f.a === B.id) {
        f.a = A.id
        f.pts[0] = A.p
      }
      if (f.b === B.id) {
        f.b = A.id
        f.pts[f.pts.length - 1] = A.p
      }
      A.edges.push(id)
    }
    B.edges = []
    B.kind = 'gone'
  }
}

/** 剪掉笔画端角和拐角处细化留下的短枝杈，剩下两条边的交叉点并回一条边。 */
function pruneSpurs(g: Graph, k: number, em: number) {
  for (let changed = true; changed; ) {
    changed = false
    for (const e of g.edges) {
      if (!e) continue
      const A = g.nodes[e.a]!
      const B = g.nodes[e.b]!
      const [end, hub] = A.edges.length === 1 ? [A, B] : B.edges.length === 1 ? [B, A] : [null, null]
      if (!end || !hub || hub.edges.length < 3) continue
      if (polyLength(e.pts) < Math.max(k * hub.r, em * 0.02)) {
        removeEdge(g, e.id)
        end.kind = 'gone'
        changed = true
      }
    }
    for (const n of g.nodes) {
      if (n.edges.length !== 2 || n.kind === 'end') continue
      const [i, j] = n.edges as [number, number]
      if (i === j) continue
      const e1 = g.edges[i]!
      const e2 = g.edges[j]!
      const p1 = e1.b === n.id ? e1.pts : e1.pts.slice().reverse()
      const r1 = e1.b === n.id ? e1.r : e1.r.slice().reverse()
      const p2 = e2.a === n.id ? e2.pts : e2.pts.slice().reverse()
      const r2 = e2.a === n.id ? e2.r : e2.r.slice().reverse()
      const a = e1.b === n.id ? e1.a : e1.b
      const b = e2.a === n.id ? e2.b : e2.a
      removeEdge(g, i)
      removeEdge(g, j)
      addEdge(g, a, b, [...p1, ...p2.slice(1)], [...r1, ...r2.slice(1)])
      n.kind = 'joint'
      changed = true
    }
  }
}

function resample(pts: Point[], r: number[], step: number): { pts: Point[]; r: number[] } {
  const out: Point[] = [pts[0]!]
  const rr: number[] = [r[0]!]
  let carry = 0
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!
    const b = pts[i]!
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    let t = step - carry
    while (t <= len) {
      const u = t / len
      out.push({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u })
      rr.push(r[i - 1]! + (r[i]! - r[i - 1]!) * u)
      t += step
    }
    carry = len - (t - step)
  }
  const last = pts[pts.length - 1]!
  if (Math.hypot(out[out.length - 1]!.x - last.x, out[out.length - 1]!.y - last.y) > step * 0.3) {
    out.push(last)
    rr.push(r[r.length - 1]!)
  } else {
    out[out.length - 1] = last
  }
  return { pts: out, r: rr }
}

export function gaussianSmooth(pts: Point[], sigma: number, closed = false): Point[] {
  if (sigma <= 0 || pts.length < 3) return pts
  const k = Math.ceil(sigma * 2.5)
  const wts = Array.from({ length: 2 * k + 1 }, (_, i) => Math.exp(-((i - k) ** 2) / (2 * sigma * sigma)))
  const n = pts.length
  return pts.map((p, i) => {
    if (!closed && (i === 0 || i === n - 1)) return p
    let sx = 0
    let sy = 0
    let sw = 0
    for (let o = -k; o <= k; o++) {
      let j = i + o
      if (closed) j = (j + n) % n
      else if (j < 0 || j >= n) continue
      // 开放折线在端点附近收窄窗口，端点不被拉进去
      if (!closed && (i - Math.abs(o) < 0 || i + Math.abs(o) > n - 1)) continue
      const wt = wts[o + k]!
      sx += pts[j]!.x * wt
      sy += pts[j]!.y * wt
      sw += wt
    }
    return { x: sx / sw, y: sy / sw }
  })
}

/** 平滑中心线；交叉点附近拉直；端点顺着走势延伸到原来的笔画尽头。 */
function finishEdges(g: Graph, ras: Raster, em: number): SkEdge[] {
  const step = 1 / ras.s
  const inside = (p: Point) => {
    const x = Math.floor((p.x - ras.ox) * ras.s)
    const y = Math.floor((p.y - ras.oy) * ras.s)
    return x >= 0 && y >= 0 && x < ras.w && y < ras.h && ras.ink[y * ras.w + x] === 1
  }
  const out: SkEdge[] = []
  for (const e of g.edges) {
    if (!e) continue
    let { pts, r } = resample(e.pts, e.r, step)
    pts = gaussianSmooth(pts, 2.5)
    const A = g.nodes[e.a]!
    const B = g.nodes[e.b]!
    const straighten = (node: SkNode, atStart: boolean) => {
      if (node.kind !== 'junction') return
      const order = atStart ? pts.map((_, i) => i) : pts.map((_, i) => pts.length - 1 - i)
      let cut = 0
      for (const i of order) {
        if (Math.hypot(pts[i]!.x - node.p.x, pts[i]!.y - node.p.y) > node.r * 1.1) break
        cut++
      }
      cut = Math.min(cut, pts.length - 2)
      if (cut <= 1) return
      if (atStart) {
        pts = [node.p, ...pts.slice(cut)]
        r = [node.r, ...r.slice(cut)]
      } else {
        pts = [...pts.slice(0, pts.length - cut), node.p]
        r = [...r.slice(0, r.length - cut), node.r]
      }
    }
    straighten(A, true)
    straighten(B, false)
    const extend = (atStart: boolean) => {
      const n = pts.length
      if (n < 2) return
      const end = atStart ? pts[0]! : pts[n - 1]!
      const back = Math.max(3, Math.min(n - 1, Math.round(((atStart ? r[0]! : r[n - 1]!) * 1.5) / step)))
      const ref = atStart ? pts[back]! : pts[n - 1 - back]!
      const l = Math.hypot(end.x - ref.x, end.y - ref.y) || 1
      const t = { x: (end.x - ref.x) / l, y: (end.y - ref.y) / l }
      let d = 0
      while (d < em * 0.3 && inside({ x: end.x + t.x * (d + step), y: end.y + t.y * (d + step) })) d += step
      if (d < step) return
      const tip = { x: end.x + t.x * d, y: end.y + t.y * d }
      const rr = Math.max(step, (atStart ? r[0]! : r[n - 1]!) * 0.5)
      if (atStart) {
        pts.unshift(tip)
        r.unshift(rr)
      } else {
        pts.push(tip)
        r.push(rr)
      }
    }
    if (A.kind === 'end') extend(true)
    if (B.kind === 'end') extend(false)
    out.push({ id: out.length, a: e.a, b: e.b, pts, r })
  }
  return out
}

function tangentAt(e: SkEdge, fromNode: number, reach: number): Point {
  const pts = e.a === fromNode ? e.pts : e.pts.slice().reverse()
  const p0 = pts[0]!
  let q = pts[pts.length - 1]!
  for (const p of pts) {
    if (Math.hypot(p.x - p0.x, p.y - p0.y) >= reach) {
      q = p
      break
    }
  }
  const l = Math.hypot(q.x - p0.x, q.y - p0.y) || 1
  return { x: (q.x - p0.x) / l, y: (q.y - p0.y) / l }
}

function classify(pts: Point[], em: number): { type: StrokeType; angle: number } {
  const length = polyLength(pts)
  const a = pts[0]!
  const b = pts[pts.length - 1]!
  const angle = (Math.atan2(b.y - a.y, b.x - a.x) * 180) / Math.PI
  if (length < em * 0.13) return { type: '点', angle }
  // 中途拐了大弯就算折
  const reach = em * 0.08
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!
    const before = pts.slice(0, i).reverse().find((q) => Math.hypot(q.x - p.x, q.y - p.y) >= reach)
    const after = pts.slice(i + 1).find((q) => Math.hypot(q.x - p.x, q.y - p.y) >= reach)
    if (!before || !after) continue
    const u = Math.atan2(p.y - before.y, p.x - before.x)
    const v = Math.atan2(after.y - p.y, after.x - p.x)
    let d = Math.abs(u - v)
    if (d > Math.PI) d = 2 * Math.PI - d
    if (d > (60 * Math.PI) / 180) return { type: '折', angle }
  }
  const t = ((angle % 180) + 180) % 180
  if (t < 22 || t > 158) return { type: '横', angle }
  if (t > 68 && t < 112) return { type: '竖', angle }
  // 走向在「左上–右下」这条线上的是捺，另一条线上的是撇或提
  if (t < 90) return { type: length < em * 0.2 ? '点' : '捺', angle }
  return { type: length < em * 0.22 && Math.min(a.y, b.y) > em * 0.5 ? '提' : '撇', angle }
}

function assemble(g: Graph, edges: SkEdge[], em: number): Skeleton {
  const nodes = g.nodes
  for (const n of nodes) n.edges = []
  for (const e of edges) {
    nodes[e.a]!.edges.push(e.id)
    if (e.b !== e.a) nodes[e.b]!.edges.push(e.id)
  }
  // 在交叉点上把走势最顺的两条边接成一笔
  const link = new Map<string, string>()
  const key = (edge: number, node: number) => `${edge}@${node}`
  for (const n of nodes) {
    if (n.edges.length < 2) continue
    const ts = n.edges.map((id) => ({ id, t: tangentAt(edges[id]!, n.id, Math.max(n.r * 2, em * 0.05)) }))
    const pairs: Array<{ i: number; j: number; cos: number }> = []
    for (let i = 0; i < ts.length; i++)
      for (let j = i + 1; j < ts.length; j++) pairs.push({ i, j, cos: -(ts[i]!.t.x * ts[j]!.t.x + ts[i]!.t.y * ts[j]!.t.y) })
    pairs.sort((p, q) => q.cos - p.cos)
    const used = new Set<number>()
    for (const p of pairs) {
      if (p.cos < Math.cos((30 * Math.PI) / 180) || used.has(p.i) || used.has(p.j)) continue
      if (ts[p.i]!.id === ts[p.j]!.id) continue
      used.add(p.i)
      used.add(p.j)
      link.set(key(ts[p.i]!.id, n.id), key(ts[p.j]!.id, n.id))
      link.set(key(ts[p.j]!.id, n.id), key(ts[p.i]!.id, n.id))
    }
  }
  const strokes: Stroke[] = []
  const taken = new Set<number>()
  const walk = (edge: number, from: number) => {
    const ids: number[] = []
    const pts: Point[] = []
    let e = edge
    let at = from
    let last = from
    for (;;) {
      if (taken.has(e)) break
      taken.add(e)
      ids.push(e)
      const E = edges[e]!
      const seg = E.a === at ? E.pts : E.pts.slice().reverse()
      pts.push(...(pts.length ? seg.slice(1) : seg))
      const other = E.a === at ? E.b : E.a
      last = other
      const next = link.get(key(e, other))
      if (!next) break
      e = Number(next.split('@')[0])
      at = other
    }
    return { ids, pts, ends: [from, last] as [number, number] }
  }
  const startEnds = edges.flatMap((e) => [e.a, e.b].filter((n) => !link.has(key(e.id, n))).map((n) => ({ e: e.id, n })))
  for (const s of startEnds) {
    if (taken.has(s.e)) continue
    const { ids, pts, ends } = walk(s.e, s.n)
    strokes.push(makeStroke(strokes.length, ids, pts, ends, em))
  }
  for (const e of edges) {
    if (taken.has(e.id)) continue
    const { ids, pts, ends } = walk(e.id, e.a)
    strokes.push(makeStroke(strokes.length, ids, pts, ends, em))
  }
  const comps = components(nodes, edges, em)
  const dotEdges = new Set(comps.filter((c) => c.dot).flatMap((c) => c.edges))
  for (const s of strokes) if (s.edges.every((e) => dotEdges.has(e))) s.type = '点'
  return { nodes, edges, strokes, components: comps }
}

/** 统一书写方向：横从左到右，其余从上到下。 */
function makeStroke(id: number, ids: number[], pts: Point[], ends: [number, number], em: number): Stroke {
  const a = pts[0]!
  const b = pts[pts.length - 1]!
  const flip = Math.abs(b.x - a.x) > Math.abs(b.y - a.y) * 2.5 ? b.x < a.x : b.y < a.y
  const p = flip ? pts.slice().reverse() : pts
  const { type, angle } = classify(p, em)
  return { id, edges: ids, pts: p, ends: flip ? [ends[1], ends[0]] : ends, type, length: polyLength(p), angle }
}

function components(nodes: SkNode[], edges: SkEdge[], em: number): Component[] {
  const seen = new Set<number>()
  const out: Component[] = []
  for (const n of nodes) {
    if (seen.has(n.id) || n.kind === 'gone' || n.kind === 'joint' || (n.edges.length === 0 && n.kind !== 'end')) continue
    const ns: number[] = []
    const es = new Set<number>()
    const stack = [n.id]
    seen.add(n.id)
    while (stack.length) {
      const id = stack.pop()!
      ns.push(id)
      for (const e of nodes[id]!.edges) {
        es.add(e)
        const E = edges[e]!
        for (const m of [E.a, E.b])
          if (!seen.has(m)) {
            seen.add(m)
            stack.push(m)
          }
      }
    }
    const pts = es.size ? [...es].flatMap((e) => edges[e]!.pts) : ns.map((id) => nodes[id]!.p)
    const xs = pts.map((p) => p.x)
    const ys = pts.map((p) => p.y)
    const size = Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys))
    const length = [...es].reduce((sum, e) => sum + polyLength(edges[e]!.pts), 0)
    const center = { x: (Math.max(...xs) + Math.min(...xs)) / 2, y: (Math.max(...ys) + Math.min(...ys)) / 2 }
    const dot = (es.size <= 1 && size < em * 0.26) || (size < em * 0.15 && length < em * 0.2)
    out.push({ nodes: ns, edges: [...es], center, size, length, dot })
  }
  return out
}
