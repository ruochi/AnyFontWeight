import type { Point, Ring } from '../../src/types.js'
import { circle, difference, offset, strokeLines, sweep, union, type Cap, type Join } from './bool.js'
import { BRUSHES } from './brushes.js'
import { footprintStroke, type Footprint } from './pen.js'
import { simplifyLine, snapLine } from './outline.js'
import { shape, type ShapeName } from './shapes.js'
import { gaussianSmooth, polyLength, type StrokeType } from './skeleton.js'
import { resampleW, tangents, type SStroke, type StrokeGlyph } from './strokes.js'
import { swashCenterline, type SwashParams } from './swash.js'

/** 骨架层的选择器。`ids` 是笔顺号；`region` 按笔画中点落在参照盒子里的位置筛。 */
export type StrokeFilter = {
  ids?: number[]
  types?: StrokeType[]
  /** 只选第几个、倒数第几个，比如 [1, -1] 是首笔和末笔 */
  nth?: number[]
  region?: [number, number, number, number]
  links?: boolean
}

export type Box = { x: number; y: number; w: number; h: number }

export function selectStrokes(sg: StrokeGlyph, f: StrokeFilter | undefined, box: Box): SStroke[] {
  const real = sg.strokes.filter((s) => !s.link)
  return sg.strokes.filter((s) => {
    if (s.link) return !!f?.links
    if (!f) return true
    if (f.ids && !f.ids.includes(s.id)) return false
    if (f.types && !f.types.includes(s.type)) return false
    if (f.nth) {
      const k = real.indexOf(s)
      if (!f.nth.some((i) => (i > 0 ? i - 1 : real.length + i) === k)) return false
    }
    if (f.region) {
      const m = s.pts[Math.floor(s.pts.length / 2)]!
      const u = (m.x - box.x) / box.w
      const v = (m.y - box.y) / box.h
      const [x0, y0, x1, y1] = f.region
      if (u < x0 || u > x1 || v < y0 || v > y1) return false
    }
    return true
  })
}

const rad = (deg: number) => (deg * Math.PI) / 180

/** 绕笔画中点（或起点、终点）旋转、缩放、平移。 */
export function transformStrokes(
  strokes: SStroke[],
  p: { rotate?: number; scale?: number; scaleX?: number; scaleY?: number; dx?: number; dy?: number; origin?: 'center' | 'start' | 'end' },
  em: number,
) {
  const a = rad(p.rotate ?? 0)
  const sx = (p.scale ?? 1) * (p.scaleX ?? 1)
  const sy = (p.scale ?? 1) * (p.scaleY ?? 1)
  for (const s of strokes) {
    const o =
      p.origin === 'start'
        ? s.pts[0]!
        : p.origin === 'end'
          ? s.pts[s.pts.length - 1]!
          : (() => {
              const xs = s.pts.map((q) => q.x)
              const ys = s.pts.map((q) => q.y)
              return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 }
            })()
    s.pts = s.pts.map((q) => {
      const x = (q.x - o.x) * sx
      const y = (q.y - o.y) * sy
      return { x: o.x + x * Math.cos(a) - y * Math.sin(a) + (p.dx ?? 0) * em, y: o.y + x * Math.sin(a) + y * Math.cos(a) + (p.dy ?? 0) * em }
    })
  }
}

/** 两端各自延长（正）或剪短（负）。延长段可以拐弯、卷起，宽度按 `taper` 收。 */
export function extendStrokes(
  strokes: SStroke[],
  p: { start?: number; end?: number; taper?: number } & Pick<SwashParams, 'bend' | 'curl' | 'curlRadius' | 'curlTighten'>,
  em: number,
) {
  for (const s of strokes) {
    for (const which of ['start', 'end'] as const) {
      const len = p[which]
      if (!len && !(which === 'end' && p.curl && p.end == null)) continue
      let pts = which === 'start' ? s.pts.slice().reverse() : s.pts.slice()
      let ws = which === 'start' ? s.width.slice().reverse() : s.width.slice()
      if ((len ?? 0) < 0) {
        const keep = Math.max(0, polyLength(pts) + len! )
        ;({ pts, ws } = cut(pts, ws, keep))
      } else {
        const n = pts.length
        const t = tangents(pts, 3)[n - 1]!
        const w0 = ws[n - 1]!
        const line = swashCenterline(pts[n - 1]!, t, { length: len ?? 0, bend: p.bend, curl: p.curl, curlRadius: p.curlRadius, curlTighten: p.curlTighten }, em, w0 / 2)
        const total = line[line.length - 1]!.s || 1
        const taper = p.taper ?? 1
        for (const q of line.slice(1)) {
          const u = q.s / total
          pts.push(q.p)
          ws.push(w0 * (1 + (taper - 1) * u * u * (3 - 2 * u)))
        }
      }
      if (which === 'start') {
        pts.reverse()
        ws.reverse()
      }
      s.pts = pts
      s.width = ws
    }
  }
}

/** 从头开始只保留 keep 长度。 */
function cut(pts: Point[], ws: number[], keep: number): { pts: Point[]; ws: number[] } {
  const out: Point[] = [pts[0]!]
  const ow: number[] = [ws[0]!]
  let acc = 0
  for (let i = 1; i < pts.length; i++) {
    const l = Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y)
    if (acc + l >= keep) {
      const u = (keep - acc) / (l || 1)
      out.push({ x: pts[i - 1]!.x + (pts[i]!.x - pts[i - 1]!.x) * u, y: pts[i - 1]!.y + (pts[i]!.y - pts[i - 1]!.y) * u })
      ow.push(ws[i - 1]! + (ws[i]! - ws[i - 1]!) * u)
      return { pts: out, ws: ow }
    }
    acc += l
    out.push(pts[i]!)
    ow.push(ws[i]!)
  }
  return { pts: out, ws: ow }
}

/** 简化后把每段方向吸附到 angle 的整数倍，宽度按新长度重新取样。 */
export function snapStrokes(strokes: SStroke[], angle: number, tolerance: number, em: number) {
  for (const s of strokes) {
    const simple = simplifyLine(s.pts, tolerance * em)
    const snapped = snapLine(simple, angle, false)
    const avg = s.width.reduce((a, b) => a + b, 0) / s.width.length
    const r = resampleW(
      snapped,
      snapped.map(() => avg),
      em * 0.008,
    )
    s.pts = r.pts
    s.width = r.width
  }
}

/** 转角处的点序号：简化后转弯超过 `minTurn` 度的顶点。 */
function corners(pts: Point[], em: number, minTurn: number): number[] {
  const simple = simplifyLine(pts, em * 0.012)
  const out: number[] = []
  for (let k = 1; k < simple.length - 1; k++) {
    const a = simple[k - 1]!
    const b = simple[k]!
    const c = simple[k + 1]!
    let d = Math.abs(Math.atan2(c.y - b.y, c.x - b.x) - Math.atan2(b.y - a.y, b.x - a.x))
    if (d > Math.PI) d = Math.PI * 2 - d
    if ((d * 180) / Math.PI < minTurn) continue
    let best = 0
    for (let i = 1; i < pts.length; i++) if (Math.hypot(pts[i]!.x - b.x, pts[i]!.y - b.y) < Math.hypot(pts[best]!.x - b.x, pts[best]!.y - b.y)) best = i
    out.push(best)
  }
  return [...new Set(out)].sort((x, y) => x - y)
}

/**
 * 规整：每笔按转角分段，接近水平或竖直（`within` 度以内）且够直的段拉成正横正竖，
 * 相邻两段都拉直时转角取两条线的交点；弯的段（撇、捺）不动，只把端点接上。
 * 楷体的横微微上扬、竖略带弧，规整后接近黑体的骨架。
 */
export function straightenStrokes(strokes: SStroke[], p: { within?: number; tolerance?: number }, em: number) {
  const within = ((p.within ?? 12) * Math.PI) / 180
  const tol = (p.tolerance ?? 0.035) * em
  for (const s of strokes) {
    if (s.pts.length < 3) continue
    const r = resampleW(s.pts, s.width, em * 0.006)
    const pts = r.pts
    const cs = corners(pts, em, 25)
    const bounds = [0, ...cs, pts.length - 1]
    type Seg = { a: number; b: number; line?: { dir: Point; c: Point } }
    const segs: Seg[] = []
    for (let i = 1; i < bounds.length; i++) {
      const a = bounds[i - 1]!
      const b = bounds[i]!
      if (b <= a) continue
      const pa = pts[a]!
      const pb = pts[b]!
      const ang = Math.atan2(pb.y - pa.y, pb.x - pa.x)
      const near = [0, Math.PI / 2, Math.PI, -Math.PI / 2, -Math.PI].find((t) => Math.abs(ang - t) < within)
      let dev = 0
      const l = Math.hypot(pb.x - pa.x, pb.y - pa.y) || 1
      for (let k = a; k <= b; k++) dev = Math.max(dev, Math.abs(((pts[k]!.x - pa.x) * (pb.y - pa.y) - (pts[k]!.y - pa.y) * (pb.x - pa.x)) / l))
      const seg: Seg = { a, b }
      // 楷体长横会微微拱起，允许的偏差随段长放宽
      if (near != null && dev < Math.max(tol, l * 0.05) && l > em * 0.03) {
        const n = b - a + 1
        const c = { x: 0, y: 0 }
        for (let k = a; k <= b; k++) {
          c.x += pts[k]!.x / n
          c.y += pts[k]!.y / n
        }
        seg.line = { dir: { x: Math.round(Math.cos(near)), y: Math.round(Math.sin(near)) }, c }
      }
      segs.push(seg)
    }
    // 楷体的起笔小钩、收笔小尾巴在正横正竖上不要
    const segLen = (g: Seg) => Math.hypot(pts[g.b]!.x - pts[g.a]!.x, pts[g.b]!.y - pts[g.a]!.y)
    if (segs.length > 1 && !segs[0]!.line && segs[1]!.line && segLen(segs[0]!) < em * 0.07) segs.shift()
    if (segs.length > 1 && !segs[segs.length - 1]!.line && segs[segs.length - 2]!.line && segLen(segs[segs.length - 1]!) < em * 0.04) segs.pop()
    const project = (q: Point, ln: { dir: Point; c: Point }) => {
      const t = (q.x - ln.c.x) * ln.dir.x + (q.y - ln.c.y) * ln.dir.y
      return { x: ln.c.x + ln.dir.x * t, y: ln.c.y + ln.dir.y * t }
    }
    const ends = segs.map((g) => ({ a: g.line ? project(pts[g.a]!, g.line) : pts[g.a]!, b: g.line ? project(pts[g.b]!, g.line) : pts[g.b]! }))
    for (let i = 1; i < segs.length; i++) {
      const L = segs[i - 1]!.line
      const R = segs[i]!.line
      if (L && R && L.dir.x * R.dir.x + L.dir.y * R.dir.y === 0) {
        const corner = L.dir.x !== 0 ? { x: R.c.x, y: L.c.y } : { x: L.c.x, y: R.c.y }
        ends[i - 1]!.b = corner
        ends[i]!.a = corner
      } else if (L) ends[i]!.a = ends[i - 1]!.b
      else if (R) ends[i - 1]!.b = ends[i]!.a
    }
    const out: Point[] = []
    const ow: number[] = []
    segs.forEach((g, i) => {
      const { a: ea, b: eb } = ends[i]!
      const n = g.b - g.a
      for (let k = i === 0 ? 0 : 1; k <= n; k++) {
        const u = k / (n || 1)
        ow.push(r.width[g.a + k]!)
        if (g.line) out.push({ x: ea.x + (eb.x - ea.x) * u, y: ea.y + (eb.y - ea.y) * u })
        else {
          const q = pts[g.a + k]!
          const da = { x: ea.x - pts[g.a]!.x, y: ea.y - pts[g.a]!.y }
          const db = { x: eb.x - pts[g.b]!.x, y: eb.y - pts[g.b]!.y }
          out.push({ x: q.x + da.x * (1 - u) + db.x * u, y: q.y + da.y * (1 - u) + db.y * u })
        }
      }
    })
    s.pts = out
    s.width = ow
  }
}

/** 圆转：转角附近换成圆滑的弯，`radius` 越大弯得越开。两端不动。 */
export function filletStrokes(strokes: SStroke[], radius: number, em: number) {
  const step = em * 0.006
  for (const s of strokes) {
    if (s.pts.length < 3) continue
    const r = resampleW(s.pts, s.width, step)
    const cs = corners(r.pts, em, 30)
    if (!cs.length) continue
    const R = radius * em
    const smooth = gaussianSmooth(r.pts, (R / step) * 0.6)
    let acc = 0
    const arc = r.pts.map((p, i) => (i ? (acc += Math.hypot(p.x - r.pts[i - 1]!.x, p.y - r.pts[i - 1]!.y)) : 0))
    s.pts = r.pts.map((p, i) => {
      if (i === 0 || i === r.pts.length - 1) return p
      const d = Math.min(...cs.map((c) => Math.abs(arc[i]! - arc[c]!)))
      const w = Math.exp(-((d / R) ** 2))
      return { x: p.x * (1 - w) + smooth[i]!.x * w, y: p.y * (1 - w) + smooth[i]!.y * w }
    })
    s.width = r.width
  }
}

export function smoothStrokes(strokes: SStroke[], amount: number, em: number) {
  for (const s of strokes) {
    const r = resampleW(s.pts, s.width, em * 0.006)
    s.pts = gaussianSmooth(r.pts, (amount * em) / (em * 0.006))
    s.width = r.width
  }
}

/** 低频抖动，像手写。同一个 seed 结果不变。 */
export function jitterStrokes(strokes: SStroke[], amount: number, wavelength: number, seed: number, em: number) {
  let state = seed * 9301 + 49297
  const rnd = () => {
    state = (state * 9301 + 49297) % 233280
    return state / 233280
  }
  for (const s of strokes) {
    const r = resampleW(s.pts, s.width, em * 0.006)
    const len = polyLength(r.pts)
    const k = Math.max(2, Math.ceil(len / (wavelength * em)) + 1)
    const knots = Array.from({ length: k + 1 }, () => ({ x: (rnd() * 2 - 1) * amount * em, y: (rnd() * 2 - 1) * amount * em }))
    let acc = 0
    s.pts = r.pts.map((p, i) => {
      if (i > 0) acc += Math.hypot(p.x - r.pts[i - 1]!.x, p.y - r.pts[i - 1]!.y)
      const u = (acc / (len || 1)) * k
      const j = Math.min(k - 1, Math.floor(u))
      const f = u - j
      const e = f * f * (3 - 2 * f)
      return { x: p.x + knots[j]!.x * (1 - e) + knots[j + 1]!.x * e, y: p.y + knots[j]!.y * (1 - e) + knots[j + 1]!.y * e }
    })
    s.width = r.width
  }
}

/**
 * 连笔：按笔顺把上一笔的收笔和下一笔的起笔用一段三次曲线接起来，像行书的牵丝。
 * `across` 时改成把每个字的末笔接到下一个字的首笔。
 */
export function connectStrokes(sg: StrokeGlyph, p: { maxGap?: number; tension?: number; across?: boolean; width?: number; minDot?: number }, em: number) {
  const real = sg.strokes.filter((s) => !s.link)
  const pairs: Array<[SStroke, SStroke]> = []
  if (p.across) {
    const byGlyph = new Map<number, SStroke[]>()
    for (const s of real) byGlyph.set(s.glyph ?? 0, [...(byGlyph.get(s.glyph ?? 0) ?? []), s])
    const keys = [...byGlyph.keys()].sort((a, b) => a - b)
    for (let i = 1; i < keys.length; i++) {
      const prev = byGlyph.get(keys[i - 1]!)!
      const next = byGlyph.get(keys[i]!)!
      pairs.push([prev[prev.length - 1]!, next[0]!])
    }
  } else {
    for (let i = 1; i < real.length; i++) if ((real[i - 1]!.glyph ?? 0) === (real[i]!.glyph ?? 0)) pairs.push([real[i - 1]!, real[i]!])
  }
  const maxGap = (p.maxGap ?? 0.45) * em
  const tension = p.tension ?? 0.35
  for (const [a, b] of pairs) {
    const P0 = a.pts[a.pts.length - 1]!
    const P3 = b.pts[0]!
    const L = Math.hypot(P3.x - P0.x, P3.y - P0.y)
    if (L > maxGap || L < em * 0.01) continue
    const t0 = tangents(a.pts, 3)[a.pts.length - 1]!
    const t1 = tangents(b.pts, 3)[0]!
    const dir = { x: (P3.x - P0.x) / L, y: (P3.y - P0.y) / L }
    const d0 = t0.x * dir.x + t0.y * dir.y
    const d1 = t1.x * dir.x + t1.y * dir.y
    // 几乎掉头的牵丝会绕大圈，不连；方向越背离，控制柄越短，收成小钩
    if (d0 < (p.minDot ?? -0.75) || d1 < (p.minDot ?? -0.75)) continue
    const h0 = L * tension * Math.max(0.2, (1 + d0) / 2)
    const h1 = L * tension * Math.max(0.2, (1 + d1) / 2)
    const P1 = { x: P0.x + t0.x * h0, y: P0.y + t0.y * h0 }
    const P2 = { x: P3.x - t1.x * h1, y: P3.y - t1.y * h1 }
    const n = Math.max(8, Math.ceil(L / (em * 0.008)))
    const pts = Array.from({ length: n + 1 }, (_, i) => {
      const u = i / n
      const v = 1 - u
      return {
        x: v * v * v * P0.x + 3 * v * v * u * P1.x + 3 * v * u * u * P2.x + u * u * u * P3.x,
        y: v * v * v * P0.y + 3 * v * v * u * P1.y + 3 * v * u * u * P2.y + u * u * u * P3.y,
      }
    })
    const w = Math.min(a.width[a.width.length - 1]!, b.width[0]!)
    sg.strokes.push({ id: 0, type: a.type, pts, width: pts.map(() => w), start: { kind: 'joint', stroke: a.id }, end: { kind: 'joint', stroke: b.id }, link: p.width ?? 0.3, glyph: a.glyph })
  }
}

export type BrushParams = {
  /** 笔宽（em）；写 `source` 用量出来的字体笔宽 */
  width?: number | 'source'
  /** `source` 宽度的倍数 */
  scale?: number
  widthByType?: Partial<Record<StrokeType, number>>
  pen?: 'round' | 'nib'
  nibAngle?: number
  nibThin?: number
  cap?: Cap
  join?: Join
  /** 沿每一笔均匀分布的宽度倍数，比如 [0.6, 1.2, 0.3] 是起笔轻、中段重、收笔出锋 */
  pressure?: number[]
  /** 起笔、收笔各用多长收成尖 */
  taper?: [number, number]
  /** 自由端回缩半个笔宽，圆头不超出原来的长度。默认开 */
  fit?: boolean
  /** 短的点画换成图形；`all` 时连接在别的笔画上的点也换 */
  dots?: { shape: ShapeName; size?: number; scale?: number; angle?: number; all?: boolean }
  /** 用 `lab/deform/brushes.ts` 里的预设，这里写的参数覆盖预设 */
  preset?: string
  /** 变宽笔画的笔尖印：长轴斜 `angle` 度、短轴是长轴 `thin` 倍的椭圆。毛笔斜着落笔，横比竖细 */
  tip?: { angle?: number; thin?: number }
  /** 各类笔画单独的压感和出锋，覆盖 `pressure`、`taper` */
  pressureByType?: Partial<Record<StrokeType, number[]>>
  taperByType?: Partial<Record<StrokeType, [number, number]>>
  /** 飞白：笔画拆成 `count` 根笔毛，越往后、越靠边越容易断，`dry` 是干的程度 0–1 */
  bristles?: { count?: number; dry?: number; seed?: number }
  /** 画完后只留一圈这么宽的边，成空心双线 */
  hollow?: number
  /** 不画连续的线，沿笔画每隔 `spacing` 盖一个图形；大小是 `size`（em）或笔宽的 `scale` 倍 */
  stamp?: { shape?: ShapeName; spacing?: number; size?: number; scale?: number; angle?: number }
  /** 形状笔尖（圆、方、矩形），可以随走向转，起笔、收笔、转折处转笔、顿笔，见 `pen.ts`。写了它 `width` 不起作用 */
  footprint?: Footprint
}

export function resolveBrush(p: BrushParams): BrushParams {
  if (!p.preset) return p
  const base = BRUSHES[p.preset]
  if (!base) throw new Error(`没有叫「${p.preset}」的笔刷，可选：${Object.keys(BRUSHES).join('、')}`)
  const { note: _note, ...params } = base
  return { ...params, ...p, preset: undefined }
}

function interp(vals: number[], u: number): number {
  if (vals.length === 1) return vals[0]!
  const x = u * (vals.length - 1)
  const i = Math.min(vals.length - 2, Math.floor(x))
  const f = x - i
  const e = f * f * (3 - 2 * f)
  return vals[i]! * (1 - e) + vals[i + 1]! * e
}

/** 逐点宽度不同的笔画：相邻两点的笔尖印（圆，或写了 `tip` 时的斜椭圆）取凸包，全部并起来。 */
function variableStroke(pts: Point[], ws: number[], cap: Cap, tip?: BrushParams['tip']): Ring[] {
  const parts: Ring[] = []
  const a = rad(tip?.angle ?? 0)
  const thin = tip?.thin ?? 1
  const disc = (p: Point, w: number) => {
    const r = Math.max(w / 2, 0.05)
    if (thin === 1) return circle(p, r, 20)
    return Array.from({ length: 20 }, (_, i) => {
      const t = (i / 20) * Math.PI * 2
      const x = Math.cos(t) * r
      const y = Math.sin(t) * r * thin
      return { x: p.x + x * Math.cos(a) - y * Math.sin(a), y: p.y + x * Math.sin(a) + y * Math.cos(a) }
    })
  }
  if (pts.length === 1) return [disc(pts[0]!, ws[0]!)]
  for (let i = 1; i < pts.length; i++) parts.push(hull([...disc(pts[i - 1]!, ws[i - 1]!), ...disc(pts[i]!, ws[i]!)]))
  let out = union(parts)
  if (cap === 'butt' || cap === 'square') {
    const knives: Ring[] = []
    for (const atStart of [true, false]) {
      const n = pts.length
      const p = atStart ? pts[0]! : pts[n - 1]!
      const q = atStart ? pts[Math.min(3, n - 1)]! : pts[Math.max(0, n - 4)]!
      const l = Math.hypot(p.x - q.x, p.y - q.y) || 1
      const t = { x: (p.x - q.x) / l, y: (p.y - q.y) / l }
      const w = (atStart ? ws[0]! : ws[n - 1]!) * 0.6 + 1
      const o = cap === 'square' ? (atStart ? ws[0]! : ws[n - 1]!) / 2 : 0
      const c = { x: p.x + t.x * o, y: p.y + t.y * o }
      knives.push([
        { x: c.x - t.y * w, y: c.y + t.x * w },
        { x: c.x - t.y * w + t.x * w * 2, y: c.y + t.x * w + t.y * w * 2 },
        { x: c.x + t.y * w + t.x * w * 2, y: c.y - t.x * w + t.y * w * 2 },
        { x: c.x + t.y * w, y: c.y - t.x * w },
      ])
    }
    out = difference(out, knives)
  }
  return out
}

function hull(points: Point[]): Ring {
  const ps = points.slice().sort((a, b) => a.x - b.x || a.y - b.y)
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: Point[] = []
  for (const p of ps) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: Point[] = []
  for (const p of ps.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop()
    upper.push(p)
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

function nib(w: number, thin: number, angle: number): Ring {
  const a = rad(angle)
  return Array.from({ length: 24 }, (_, i) => {
    const t = (i / 24) * Math.PI * 2
    const x = (Math.cos(t) * w) / 2
    const y = (Math.sin(t) * w * thin) / 2
    return { x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) }
  })
}

/** 用一支笔把骨架字形画成轮廓。 */
export function brush(sg: StrokeGlyph, params: BrushParams, em: number): Ring[] {
  const p = resolveBrush(params)
  const cap = p.cap ?? 'round'
  const fit = p.fit ?? true
  const parts: Ring[] = []
  const constant = new Map<number, Point[][]>()
  const placed: Point[] = []
  for (const s of sg.strokes) {
    if (s.pts.length === 0) continue
    const len = polyLength(s.pts)
    const avgSrc = s.width.reduce((a, b) => a + b, 0) / s.width.length
    if (p.dots && !s.link && s.type === '点' && len < em * 0.24 && (p.dots.all || (s.start.kind === 'free' && s.end.kind === 'free'))) {
      const m = s.pts[Math.floor(s.pts.length / 2)]!
      const base = p.width === 'source' || p.width == null ? avgSrc * (p.scale ?? 1) : p.width * em
      parts.push(...shape(p.dots.shape, m, p.dots.size != null ? p.dots.size * em : base * (p.dots.scale ?? 1.6), p.dots.angle))
      continue
    }
    const r = resampleW(s.pts, s.width, em * 0.006)
    let pts = r.pts
    let ws = p.footprint
      ? r.width.map(() => 1)
      : p.width === 'source' || p.width == null
        ? r.width.map((w) => w * (p.scale ?? 1))
        : r.width.map(() => (p.widthByType?.[s.type] ?? (p.width as number)) * em)
    if (s.link) ws = ws.map((w) => w * s.link!)
    const pressure = p.pressureByType?.[s.type] ?? p.pressure
    const taper = p.taperByType?.[s.type] ?? p.taper
    const variable = !!pressure || !!taper || !!p.bristles || p.width === 'source' || p.width == null
    if (!s.link && s.type === '折' && p.pressureByType) {
      const k = foldProfile(pts, p, em)
      ws = ws.map((w, i) => w * k[i]!)
    } else if (!s.link && (pressure || taper)) {
      let acc = 0
      ws = ws.map((w, i) => {
        if (i > 0) acc += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y)
        const u = acc / (len || 1)
        let k = pressure ? interp(pressure, u) : 1
        if (taper) {
          const [a, b] = taper
          if (a > 0) k *= 0.12 + 0.88 * Math.min(1, acc / (a * em))
          if (b > 0) k *= 0.12 + 0.88 * Math.min(1, (len - acc) / (b * em))
        }
        return w * k
      })
    }
    if (fit && cap !== 'butt' && !s.link && p.pen !== 'nib' && !p.footprint) {
      const trim = (atStart: boolean) => {
        const end = atStart ? s.start : s.end
        if (end.kind !== 'free' || pts.length < 3) return
        const w = atStart ? ws[0]! : ws[ws.length - 1]!
        let acc = 0
        while (pts.length > 2 && acc < w / 2) {
          const [a, b] = atStart ? [pts[0]!, pts[1]!] : [pts[pts.length - 1]!, pts[pts.length - 2]!]
          acc += Math.hypot(a.x - b.x, a.y - b.y)
          if (atStart) {
            pts = pts.slice(1)
            ws = ws.slice(1)
          } else {
            pts = pts.slice(0, -1)
            ws = ws.slice(0, -1)
          }
        }
      }
      trim(true)
      trim(false)
    }
    if (p.stamp && !s.link) {
      parts.push(...stamps(pts, ws, p.stamp, em, placed))
    } else if (p.footprint) {
      parts.push(...footprintStroke(pts, ws, s.type, corners(pts, em, 40), p.footprint, em, !!s.link))
    } else if (p.pen === 'nib') {
      const w = ws.reduce((a, b) => a + b, 0) / ws.length
      parts.push(...sweep([pts], nib(w, p.nibThin ?? 0.25, p.nibAngle ?? -40)))
    } else if (p.bristles && !s.link) {
      parts.push(...bristleStroke(pts, ws, p.bristles, s.id, em))
    } else if (variable || p.tip) {
      parts.push(...variableStroke(pts, ws, cap, p.tip))
    } else {
      const w = ws[0]!
      constant.set(w, [...(constant.get(w) ?? []), pts])
    }
  }
  for (const [w, lines] of constant) parts.push(...strokeLines(lines, w, cap, p.join ?? 'round'))
  const out = union(parts)
  return p.hollow ? difference(out, offset(out, -p.hollow * em, 'round')) : out
}

/**
 * 折笔按转角拆段，每段按走向当作横、竖、撇、提（末尾短的一段是钩，也按提）各用各的压感，
 * 这样转角处有顿笔，钩会出锋。起笔用第一段的出锋设置，收笔用最后一段的。
 */
function foldProfile(pts: Point[], p: BrushParams, em: number): number[] {
  const cs = corners(pts, em, 40)
  const bounds = [0, ...cs, pts.length - 1]
  const k = pts.map(() => 1)
  const arc: number[] = [0]
  for (let i = 1; i < pts.length; i++) arc.push(arc[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y))
  for (let s = 1; s < bounds.length; s++) {
    const a = bounds[s - 1]!
    const b = bounds[s]!
    if (b <= a) continue
    const dx = pts[b]!.x - pts[a]!.x
    const dy = pts[b]!.y - pts[a]!.y
    const ang = (Math.atan2(dy, dx) * 180) / Math.PI
    const len = arc[b]! - arc[a]!
    const last = s === bounds.length - 1
    const type: StrokeType =
      last && s > 1 && len < em * 0.1 ? '提' : Math.abs(ang) < 30 ? '横' : ang >= 60 && ang <= 120 ? '竖' : ang > 120 ? '撇' : ang < -30 ? '提' : ang > 0 ? '捺' : '横'
    const pr = p.pressureByType?.[type] ?? p.pressure ?? [1]
    const tp = p.taperByType?.[type] ?? p.taper
    for (let i = a; i <= b; i++) {
      const acc = arc[i]! - arc[a]!
      let m = interp(pr, len ? acc / len : 0)
      if (tp && s === 1 && tp[0] > 0) m *= 0.12 + 0.88 * Math.min(1, arc[i]! / (tp[0] * em))
      if (tp && last && tp[1] > 0) m *= 0.12 + 0.88 * Math.min(1, (arc[pts.length - 1]! - arc[i]!) / (tp[1] * em))
      k[i] = i === a && s > 1 ? Math.max(k[i]!, m) : m
    }
  }
  return k
}

/** 沿笔画按弧长等距盖图形。离别的笔画已盖的点太近就跳过，交叉处不会挤成一团。 */
function stamps(pts: Point[], ws: number[], st: NonNullable<BrushParams['stamp']>, em: number, placed: Point[]): Ring[] {
  const spacing = (st.spacing ?? 0.05) * em
  const out: Ring[] = []
  const others = placed.length
  const crowded = (q: Point) => {
    for (let j = 0; j < others; j++) if (Math.hypot(placed[j]!.x - q.x, placed[j]!.y - q.y) < spacing * 0.85) return true
    return false
  }
  let acc = spacing
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) acc += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y)
    if (acc < spacing && i < pts.length - 1) continue
    if (acc < spacing * 0.5) continue
    if (crowded(pts[i]!)) continue
    acc = 0
    placed.push(pts[i]!)
    out.push(...shape(st.shape ?? 'circle', pts[i]!, st.size != null ? st.size * em : ws[i]! * (st.scale ?? 1), st.angle))
  }
  return out
}

/**
 * 飞白：横跨笔宽排 `count` 根笔毛，各自是一条细的变宽线。
 * 每根笔毛沿长度有一条平滑噪声，低于阈值的地方断开；阈值随长度和离中心的距离变大，
 * 所以起笔饱满，越往后、越靠边越干。
 */
function bristleStroke(pts: Point[], ws: number[], b: NonNullable<BrushParams['bristles']>, salt: number, em: number): Ring[] {
  const count = Math.max(2, b.count ?? 8)
  const dry = b.dry ?? 0.5
  const ts = tangents(pts, 2)
  const total = polyLength(pts) || 1
  const arc: number[] = [0]
  for (let i = 1; i < pts.length; i++) arc.push(arc[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y))
  const out: Ring[] = []
  for (let k = 0; k < count; k++) {
    const side = ((k + 0.5) / count) * 2 - 1
    const rnd = hashNoise((b.seed ?? 1) * 7919 + salt * 131 + k * 17, em * 0.07)
    let run: Point[] = []
    let rw: number[] = []
    const flush = () => {
      if (run.length >= 3) out.push(...variableStroke(run, rw, 'round'))
      run = []
      rw = []
    }
    for (let i = 0; i < pts.length; i++) {
      const u = arc[i]! / total
      const threshold = dry * (0.15 + 0.85 * u * u) * (0.45 + 0.55 * Math.abs(side))
      if (rnd(arc[i]!) < threshold) {
        flush()
        continue
      }
      const w = ws[i]!
      const off = side * w * 0.42
      run.push({ x: pts[i]!.x - ts[i]!.y * off, y: pts[i]!.y + ts[i]!.x * off })
      rw.push((w / count) * 1.9)
    }
    flush()
  }
  return out
}

/** 一维平滑值噪声，0–1，`wavelength` 是起伏的尺度。 */
function hashNoise(seed: number, wavelength: number): (x: number) => number {
  const h = (i: number) => {
    const s = Math.sin(i * 127.1 + seed * 311.7) * 43758.5453
    return s - Math.floor(s)
  }
  return (x: number) => {
    const t = x / wavelength
    const i = Math.floor(t)
    const f = t - i
    const e = f * f * (3 - 2 * f)
    return h(i) * (1 - e) + h(i + 1) * e
  }
}
