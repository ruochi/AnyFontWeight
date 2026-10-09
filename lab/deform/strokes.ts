import type { Point, Ring } from '../../src/types.js'
import type { HanziData } from './hanzi.js'
import { ringsBounds, simplifyLine } from './outline.js'
import { classify, gaussianSmooth, polyLength, type Skeleton, type StrokeType } from './skeleton.js'

/**
 * 骨架字形：每一笔是一条中心线加逐点宽度，带笔顺、类型和两端的连接关系。
 * 坐标和轮廓一样是字的本地坐标（y 向下），宽度是全宽。
 */
export type StrokeEnd = { kind: 'free' } | { kind: 'joint'; stroke: number }
export type SStroke = {
  /** 从 1 起，等于笔顺 */
  id: number
  type: StrokeType
  pts: Point[]
  width: number[]
  start: StrokeEnd
  end: StrokeEnd
  /** 连笔生成的牵丝，值是相对两端笔宽的比例 */
  link?: number
  /** 排版后属于第几个字 */
  glyph?: number
}
export type StrokeSource = 'auto' | 'hanzi' | 'hybrid'
export type StrokeGlyph = { source: StrokeSource; strokes: SStroke[] }

const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y)

export function resampleW(pts: Point[], ws: number[], step: number): { pts: Point[]; width: number[] } {
  if (pts.length < 2) return { pts: pts.slice(), width: ws.slice() }
  const out: Point[] = [pts[0]!]
  const ow: number[] = [ws[0]!]
  let carry = 0
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!
    const b = pts[i]!
    const len = dist(a, b)
    let t = step - carry
    while (t < len) {
      const u = t / len
      out.push({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u })
      ow.push(ws[i - 1]! + (ws[i]! - ws[i - 1]!) * u)
      t += step
    }
    carry = len - (t - step)
  }
  const last = pts[pts.length - 1]!
  if (dist(out[out.length - 1]!, last) > step * 0.25) {
    out.push(last)
    ow.push(ws[ws.length - 1]!)
  } else {
    out[out.length - 1] = last
    ow[ow.length - 1] = ws[ws.length - 1]!
  }
  return { pts: out, width: ow }
}

export function tangents(pts: Point[], reach = 2): Point[] {
  return pts.map((_, i) => {
    const a = pts[Math.max(0, i - reach)]!
    const b = pts[Math.min(pts.length - 1, i + reach)]!
    const l = dist(a, b) || 1
    return { x: (b.x - a.x) / l, y: (b.y - a.y) / l }
  })
}

/** 非零环绕规则下点是否在墨里。 */
export function inkTest(rings: Ring[]): (p: Point) => boolean {
  const boxes = rings.map((r) => ringsBounds([r]))
  return (p) => {
    let wn = 0
    rings.forEach((r, k) => {
      const b = boxes[k]!
      if (p.x < b.minX || p.x > b.maxX || p.y < b.minY || p.y > b.maxY) return
      for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
        const a = r[j]!
        const c = r[i]!
        if (a.y <= p.y) {
          if (c.y > p.y && (c.x - a.x) * (p.y - a.y) - (p.x - a.x) * (c.y - a.y) > 0) wn++
        } else if (c.y <= p.y && (c.x - a.x) * (p.y - a.y) - (p.x - a.x) * (c.y - a.y) < 0) wn--
      }
    })
    return wn !== 0
  }
}

function distToPolyline(p: Point, pts: Point[]): number {
  let best = Infinity
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!
    const b = pts[i]!
    const dx = b.x - a.x
    const dy = b.y - a.y
    const l2 = dx * dx + dy * dy || 1
    const u = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2))
    best = Math.min(best, Math.hypot(a.x + dx * u - p.x, a.y + dy * u - p.y))
  }
  return pts.length === 1 ? dist(p, pts[0]!) : best
}

/** 一端落在别的笔画墨里就算接在那一笔上。 */
function linkEnds(strokes: SStroke[]) {
  const avg = (s: SStroke) => s.width.reduce((a, b) => a + b, 0) / Math.max(1, s.width.length)
  for (const s of strokes) {
    for (const which of ['start', 'end'] as const) {
      const p = which === 'start' ? s.pts[0]! : s.pts[s.pts.length - 1]!
      let best: { id: number; d: number } | null = null
      for (const o of strokes) {
        if (o === s) continue
        const d = distToPolyline(p, o.pts) - avg(o) / 2 - avg(s) * 0.35
        if (d < 0 && (!best || d < best.d)) best = { id: o.id, d }
      }
      s[which] = best ? { kind: 'joint', stroke: best.id } : { kind: 'free' }
    }
  }
}

/** 写字方向已知时，撇和提按走向分。 */
function typeOf(pts: Point[], em: number): StrokeType {
  const { type, angle } = classify(pts, em)
  const a = pts[0]!
  const b = pts[pts.length - 1]!
  const t = ((angle % 180) + 180) % 180
  const strictLine = t < 10 || t > 170 || (t > 80 && t < 100)
  if (type !== '折' && !strictLine && b.y > a.y && polyLength(pts) < em * 0.24) return '点'
  if (type === '撇' || type === '提') return b.y < a.y ? '提' : '撇'
  if (type === '竖' && b.y < a.y && !strictLine) return '提'
  return type
}

/** 从自动骨架得到骨架字形。笔顺按起点从上到下、从左到右粗排。 */
export function fromSkeleton(sk: Skeleton, em: number): StrokeGlyph {
  const strokes = sk.strokes.map((s) => {
    const samples = s.edges.flatMap((e) => sk.edges[e]!.pts.map((p, i) => ({ p, r: sk.edges[e]!.r[i]! })))
    const width = s.pts.map((p) => {
      let best = samples[0]
      for (const q of samples) if (dist(q.p, p) < dist(best!.p, p)) best = q
      return Math.max((best?.r ?? 0) * 2, em * 0.004)
    })
    return { s, pts: s.pts, width }
  })
  const band = em * 0.08
  strokes.sort((a, b) => Math.round(a.pts[0]!.y / band) - Math.round(b.pts[0]!.y / band) || a.pts[0]!.x - b.pts[0]!.x)
  const out: SStroke[] = strokes.map((x, i) => ({
    id: i + 1,
    type: x.s.type,
    pts: x.pts,
    width: gaussianSmooth(
      x.width.map((w) => ({ x: w, y: 0 })),
      4,
    ).map((p) => p.x),
    start: { kind: 'free' },
    end: { kind: 'free' },
  }))
  linkEnds(out)
  return { source: 'auto', strokes: out }
}

type Frame = { map: (p: Point) => Point; scale: number }

/** 把 Make Me a Hanzi 的方框按包围盒对齐到字体的墨迹上。 */
function alignFrame(data: HanziData, rings: Ring[]): Frame {
  const src = ringsBounds(data.strokes.flat())
  const dst = ringsBounds(rings)
  const sx = (dst.maxX - dst.minX) / (src.maxX - src.minX || 1)
  const sy = (dst.maxY - dst.minY) / (src.maxY - src.minY || 1)
  return {
    map: (p) => ({ x: dst.minX + (p.x - src.minX) * sx, y: dst.minY + (p.y - src.minY) * sy }),
    scale: Math.sqrt(sx * sy),
  }
}

/** 中心线上每一点到本笔轮廓的距离，乘 2 是笔宽。 */
function widthsFromOutline(pts: Point[], outline: Ring[]): number[] {
  return pts.map((p) => {
    let best = Infinity
    for (const r of outline) best = Math.min(best, distToPolyline(p, [...r, r[0]!]))
    return best * 2
  })
}

/** 只用开源数据：结构是楷体的，按包围盒拉到字体的位置上。 */
export function fromHanzi(data: HanziData, rings: Ring[], em: number): StrokeGlyph {
  const f = alignFrame(data, rings)
  const step = em * 0.008
  const strokes: SStroke[] = data.medians.map((m, i) => {
    const pts = m.map(f.map)
    const outline = data.strokes[i]!.map((r) => r.map(f.map))
    const raw = resampleW(pts, pts.map(() => 0), step)
    const width = gaussianSmooth(
      widthsFromOutline(raw.pts, outline).map((w) => ({ x: w, y: 0 })),
      3,
    ).map((p) => Math.max(p.x, em * 0.006))
    return { id: i + 1, type: typeOf(raw.pts, em), pts: raw.pts, width, start: { kind: 'free' }, end: { kind: 'free' } }
  })
  linkEnds(strokes)
  return { source: 'hanzi', strokes }
}

/**
 * 混合：开源数据给出有几笔、笔顺和每笔的走向，再把每一笔吸到字体自动骨架上走势一致的那段中心线，
 * 宽度取字体在那里的实际笔画宽度。吸不上的点按两边插值。
 */
export function hybrid(data: HanziData, rings: Ring[], sk: Skeleton, em: number): StrokeGlyph {
  const base = fromHanzi(data, rings, em)
  const samples: Array<{ p: Point; t: Point; r: number }> = []
  for (const e of sk.edges) {
    const ts = tangents(e.pts, 3)
    e.pts.forEach((p, i) => samples.push({ p, t: ts[i]!, r: e.r[i]! }))
  }
  const inside = inkTest(rings)
  const strokes = base.strokes.map((s) => {
    const short = polyLength(s.pts) < em * 0.15
    const cosMin = Math.cos(((short ? 55 : 35) * Math.PI) / 180)
    const ts = tangents(s.pts, 3)
    const match = (p: Point, t: Point, R: number) => {
      let best: (typeof samples)[number] | null = null
      let bd = R
      for (const q of samples) {
        const d = dist(q.p, p)
        if (d >= bd || Math.abs(q.t.x * t.x + q.t.y * t.y) < cosMin) continue
        bd = d
        best = q
      }
      return best
    }
    // 先用整笔的中位位移把楷体结构挪到字体的位置，再在附近细找
    const first = s.pts.map((p, i) => match(p, ts[i]!, em * 0.09))
    const dxs = first.flatMap((q, i) => (q ? [q.p.x - s.pts[i]!.x] : [])).sort((a, b) => a - b)
    const dys = first.flatMap((q, i) => (q ? [q.p.y - s.pts[i]!.y] : [])).sort((a, b) => a - b)
    const shift = { x: dxs[Math.floor(dxs.length / 2)] ?? 0, y: dys[Math.floor(dys.length / 2)] ?? 0 }
    let second = s.pts.map((p, i) => match({ x: p.x + shift.x, y: p.y + shift.y }, ts[i]!, em * 0.05))
    const rate = (xs: unknown[]) => xs.filter(Boolean).length / xs.length
    if (rate(second) < 0.4 && rate(first) > rate(second)) second = first
    // 两头吸不上的短短一截多半是楷体的入笔、出锋，字体里没有，去掉；长的保留按插值移动
    const step = s.pts.length > 1 ? dist(s.pts[0]!, s.pts[1]!) : 1
    const maxDrop = Math.ceil((em * 0.1) / step)
    let lo = 0
    let hi = second.length - 1
    while (lo < hi - 1 && !second[lo]) lo++
    while (hi > lo + 1 && !second[hi]) hi--
    if (lo > maxDrop) lo = 0
    if (second.length - 1 - hi > maxDrop) hi = second.length - 1
    const src = s.pts.slice(lo, hi + 1)
    const got = second.slice(lo, hi + 1)
    const d = got.map((q, i) => (q ? { x: q.p.x - src[i]!.x, y: q.p.y - src[i]!.y } : null))
    const avgW = s.width.reduce((a, b) => a + b, 0) / s.width.length
    const filledD = gaussianSmooth(fill(d, shift), 6)
    const filledW = gaussianSmooth(
      fill(
        got.map((q) => (q ? { x: q.r * 2, y: 0 } : null)),
        { x: avgW, y: 0 },
      ),
      6,
    ).map((p) => Math.max(p.x, em * 0.004))
    const moved = src.map((p, i) => ({ x: p.x + filledD[i]!.x, y: p.y + filledD[i]!.y }))
    // 抹掉吸附时在两条中心线之间跳来跳去留下的抖动
    const simple = simplifyLine(gaussianSmooth(moved, 4), em * 0.004)
    const r = resampleW(
      simple,
      simple.map(() => 0),
      em * 0.008,
    )
    const width = r.pts.map((p) => {
      let best = 0
      for (let i = 1; i < moved.length; i++) if (dist(moved[i]!, p) < dist(moved[best]!, p)) best = i
      return filledW[best]!
    })
    return { ...s, pts: r.pts, width }
  })
  for (const s of strokes) {
    if (s.start.kind === 'free') fitEnd(s, true, inside, em)
    else reachJoint(s, true, strokes, em)
    if (s.end.kind === 'free') fitEnd(s, false, inside, em)
    else reachJoint(s, false, strokes, em)
    s.type = typeOf(s.pts, em)
  }
  return { source: 'hybrid', strokes }
}

/** 接在别的笔画上的一端：顺着走势伸到那一笔的中心线为止。 */
function reachJoint(s: SStroke, atStart: boolean, strokes: SStroke[], em: number) {
  const e = atStart ? s.start : s.end
  if (e.kind !== 'joint') return
  const other = strokes.find((o) => o.id === e.stroke)
  if (!other || s.pts.length < 3) return
  const n = s.pts.length
  const end = atStart ? s.pts[0]! : s.pts[n - 1]!
  const ref = atStart ? s.pts[Math.min(3, n - 1)]! : s.pts[Math.max(0, n - 4)]!
  const l = dist(end, ref) || 1
  const t = { x: (end.x - ref.x) / l, y: (end.y - ref.y) / l }
  const step = em * 0.004
  let d = 0
  let best = distToPolyline(end, other.pts)
  while (d < em * 0.1) {
    const q = { x: end.x + t.x * (d + step), y: end.y + t.y * (d + step) }
    const dq = distToPolyline(q, other.pts)
    if (dq >= best) break
    best = dq
    d += step
  }
  if (d < step) return
  const tip = { x: end.x + t.x * d, y: end.y + t.y * d }
  const w = atStart ? s.width[0]! : s.width[n - 1]!
  if (atStart) {
    s.pts.unshift(tip)
    s.width.unshift(w)
  } else {
    s.pts.push(tip)
    s.width.push(w)
  }
}

/** 缺的值按前后最近的已知值线性插，两头沿用最近的已知值。 */
function fill(vals: Array<Point | null>, fallback: Point): Point[] {
  const known = vals.map((v, i) => (v ? i : -1)).filter((i) => i >= 0)
  if (known.length === 0) return vals.map(() => fallback)
  return vals.map((v, i) => {
    if (v) return v
    const prev = [...known].reverse().find((k) => k < i)
    const next = known.find((k) => k > i)
    if (prev == null) return vals[next!]!
    if (next == null) return vals[prev]!
    const u = (i - prev) / (next - prev)
    const a = vals[prev]!
    const b = vals[next]!
    return { x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }
  })
}

/** 自由端：先剪掉伸出墨外的部分，再顺着走势延伸到字体笔画的尽头。 */
function fitEnd(s: SStroke, atStart: boolean, inside: (p: Point) => boolean, em: number) {
  let pts = atStart ? s.pts.slice().reverse() : s.pts.slice()
  let ws = atStart ? s.width.slice().reverse() : s.width.slice()
  while (pts.length > 3 && !inside(pts[pts.length - 1]!)) {
    pts.pop()
    ws.pop()
  }
  const n = pts.length
  if (n >= 3) {
    const end = pts[n - 1]!
    const ref = pts[Math.max(0, n - 4)]!
    const l = dist(end, ref) || 1
    const t = { x: (end.x - ref.x) / l, y: (end.y - ref.y) / l }
    const step = em * 0.004
    let d = 0
    while (d < em * 0.12 && inside({ x: end.x + t.x * (d + step), y: end.y + t.y * (d + step) })) d += step
    const w = ws[n - 1]!
    // 圆头会多出半个笔宽，延伸时先扣掉
    const reach = Math.max(0, d - w * 0.25)
    if (reach > step) {
      pts.push({ x: end.x + t.x * reach, y: end.y + t.y * reach })
      ws.push(w)
    }
  }
  if (atStart) {
    pts = pts.reverse()
    ws = ws.reverse()
  }
  s.pts = pts
  s.width = ws
}

export function describeStrokes(g: { index: number; char: string; advance: number; height: number }, sg: StrokeGlyph, em: number) {
  const r = (v: number) => Math.round(v * 1000) / 1000
  const rel = (p: Point) => [r(p.x / g.advance), r(p.y / g.height)]
  const end = (e: StrokeEnd) => (e.kind === 'free' ? 'free' : `joint:${e.stroke}`)
  return {
    index: g.index,
    char: g.char,
    source: sg.source,
    strokes: sg.strokes.map((s) => ({
      id: `${g.char}.${s.id}`,
      type: s.type,
      length: r(polyLength(s.pts) / em),
      from: rel(s.pts[0]!),
      to: rel(s.pts[s.pts.length - 1]!),
      width: r(s.width.reduce((a, b) => a + b, 0) / s.width.length / em),
      start: end(s.start),
      end: end(s.end),
    })),
  }
}
