import type { Point, Ring } from '../../src/types.js'
import { circle, difference, strokeLines, sweep, union, type Cap, type Join } from './bool.js'
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
}

function interp(vals: number[], u: number): number {
  if (vals.length === 1) return vals[0]!
  const x = u * (vals.length - 1)
  const i = Math.min(vals.length - 2, Math.floor(x))
  const f = x - i
  const e = f * f * (3 - 2 * f)
  return vals[i]! * (1 - e) + vals[i + 1]! * e
}

/** 逐点宽度不同的笔画：相邻两点的圆取凸包，全部并起来。 */
function variableStroke(pts: Point[], ws: number[], cap: Cap): Ring[] {
  const parts: Ring[] = []
  const disc = (p: Point, w: number) => circle(p, Math.max(w / 2, 0.05), 20)
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
export function brush(sg: StrokeGlyph, p: BrushParams, em: number): Ring[] {
  const cap = p.cap ?? 'round'
  const fit = p.fit ?? true
  const parts: Ring[] = []
  const constant = new Map<number, Point[][]>()
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
    let ws =
      p.width === 'source' || p.width == null
        ? r.width.map((w) => w * (p.scale ?? 1))
        : r.width.map(() => (p.widthByType?.[s.type] ?? (p.width as number)) * em)
    if (s.link) ws = ws.map((w) => w * s.link!)
    const variable = !!p.pressure || !!p.taper || p.width === 'source' || p.width == null
    if (!s.link && (p.pressure || p.taper)) {
      let acc = 0
      ws = ws.map((w, i) => {
        if (i > 0) acc += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y)
        const u = acc / (len || 1)
        let k = p.pressure ? interp(p.pressure, u) : 1
        if (p.taper) {
          const [a, b] = p.taper
          if (a > 0) k *= 0.12 + 0.88 * Math.min(1, acc / (a * em))
          if (b > 0) k *= 0.12 + 0.88 * Math.min(1, (len - acc) / (b * em))
        }
        return w * k
      })
    }
    if (fit && cap !== 'butt' && !s.link && p.pen !== 'nib') {
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
    if (p.pen === 'nib') {
      const w = ws.reduce((a, b) => a + b, 0) / ws.length
      parts.push(...sweep([pts], nib(w, p.nibThin ?? 0.25, p.nibAngle ?? -40)))
    } else if (variable) {
      parts.push(...variableStroke(pts, ws, cap))
    } else {
      const w = ws[0]!
      constant.set(w, [...(constant.get(w) ?? []), pts])
    }
  }
  for (const [w, lines] of constant) parts.push(...strokeLines(lines, w, cap, p.join ?? 'round'))
  return union(parts)
}
