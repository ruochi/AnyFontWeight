import type { Point, Ring } from '../../src/types.js'
import { circle, difference, intersect, offset, roundCorners, strokeLines, sweep, translate, union, type Cap, type Join } from './bool.js'
import { applyContrast } from './contrast.js'
import { ringsBounds, simplifyLine, simplifyRing, snapLine } from './outline.js'
import { shape, type ShapeName } from './shapes.js'
import { buildSkeleton, gaussianSmooth, type Skeleton, type StrokeType } from './skeleton.js'
import { spliceContour, swashOutline, type SwashParams } from './swash.js'
import type { HanziData } from './hanzi.js'
import {
  brush,
  connectStrokes,
  extendStrokes,
  filletStrokes,
  jitterStrokes,
  selectStrokes,
  smoothStrokes,
  snapStrokes,
  straightenStrokes,
  transformStrokes,
  type BrushParams,
  type StrokeFilter,
} from './skelops.js'
import { fromHanzi, fromSkeleton, hybrid, resampleW, type StrokeGlyph, type StrokeSource } from './strokes.js'
import { analyzeGlyph, compass, type GlyphAnalysis, type Terminal } from './terminals.js'

/**
 * 字形操作。长度单位都是 em，角度是度（屏幕坐标，y 向下，0° 朝右，90° 朝下）。
 * 每一步可以用 `glyphs` 只作用于部分字：数字是全文字序号，字符串是字本身。
 */
export type Step = { glyphs?: Array<number | string> } & StepBody

export type StepBody =
  /** 末端飘带。`items` 按编号点名，或用 `select` 按条件批量选，参数写在步骤上 */
  | ({ op: 'swash'; items?: Array<{ target: string } & SwashParams>; select?: TerminalFilter } & SwashParams)
  /** 末端改形：圆头、尖头、斜切、球头 */
  | { op: 'cap'; select?: TerminalFilter; style: 'round' | 'point' | 'cut' | 'ball'; angle?: number; size?: number }
  /** 提取骨架后用单线笔重新描一遍 */
  | ({ op: 'restroke' } & RestrokeParams)
  /** 把小块的点换成几何图形 */
  | { op: 'dots'; shape: ShapeName; size?: number; scale?: number; maxSize?: number; angle?: number }
  /** 凸角、凹角倒圆，数值是圆角半径 */
  | { op: 'round'; convex?: number; concave?: number }
  /** 整体外扩（加粗）或内缩（变细） */
  | { op: 'offset'; delta: number; join?: Join }
  | { op: 'contrast'; vertical: number; horizontal: number }
  /** 只留一圈边，变成空心字 */
  | { op: 'outline'; width: number }
  /** 在笔画内部刻一道线 */
  | { op: 'inline'; width: number; inset: number }
  /** 用直线切开。`at` 是切口在包围盒里的位置（0–1，沿切线的法向），`shift` 让切开的一侧沿切线错开 */
  | { op: 'slice'; angle: number; gap: number; at?: number | number[]; shift?: number }
  /** 几何化：简化轮廓，再把边的方向吸附到 `snap` 度的整数倍 */
  | { op: 'geometrize'; tolerance: number; snap?: number }
  /** 整体弯成拱形（`arc`，正数中间向上拱）或波浪（`wave`，`period` 是波长） */
  | { op: 'warp'; kind: 'arc' | 'wave'; amount: number; period?: number }
  /**
   * 以下是骨架层的操作。第一次用到时把字转成骨架字形，`brush` 再画回轮廓。
   * 没写 `brush` 就按字体原来的笔宽画回去。
   */
  | { op: 'skeleton'; source?: StrokeSource }
  | ({ op: 'transform'; select?: StrokeFilter } & Parameters<typeof transformStrokes>[1])
  | ({ op: 'extend'; select?: StrokeFilter } & Parameters<typeof extendStrokes>[1])
  | { op: 'snap'; angle: number; tolerance?: number; select?: StrokeFilter }
  | { op: 'smooth'; amount: number; select?: StrokeFilter }
  /** 规整：接近水平、竖直的直段拉成正横正竖 */
  | { op: 'straighten'; within?: number; tolerance?: number; select?: StrokeFilter }
  /** 圆转：折角换成圆弧 */
  | { op: 'fillet'; radius: number; select?: StrokeFilter }
  | { op: 'jitter'; amount: number; wavelength?: number; seed?: number; select?: StrokeFilter }
  /** 按笔顺连笔；`across` 时把每个字的末笔接到下一个字的首笔，要写在 `post` 里 */
  | { op: 'connect'; maxGap?: number; tension?: number; across?: boolean; width?: number; minDot?: number }
  | ({ op: 'brush' } & BrushParams)

export type RestrokeParams = {
  width: number
  /** 各类笔画单独的宽度，覆盖 `width` */
  widthByType?: Partial<Record<StrokeType, number>>
  /** `round` 是圆笔；`nib` 是扁笔尖，笔尖长 `width`、厚 `width·nibThin`，与水平成 `nibAngle` 度 */
  pen?: 'round' | 'nib'
  nibAngle?: number
  nibThin?: number
  cap?: Cap
  join?: Join
  /** 中心线再平滑多少 em */
  smooth?: number
  /** 中心线简化容差 */
  simplify?: number
  /** 线段方向吸附到多少度的整数倍 */
  snap?: number
  /** 在交叉点断开：止于别的笔画的一端留出这么宽的缝，像镂空模板字 */
  gap?: number
  /** 自由末端回缩半个笔宽，让圆头不超出原来的字身。默认开 */
  fit?: boolean
  /** 点画换成图形 */
  dots?: { shape: ShapeName; size?: number; scale?: number; angle?: number }
}

export type TerminalFilter = {
  /** 末端编号（从 1 起），配合步骤上的 `glyphs` 使用 */
  ids?: number[]
  /** 朝向，用 右、右下、下、左下、左、左上、上、右上 */
  dir?: string[]
  /** `open` 前方空旷，`blocked` 前方不远处有别的墨迹 */
  free?: 'open' | 'blocked'
  minRun?: number
  minWidth?: number
  maxWidth?: number
  /** 末端尖端落在字身盒子里的范围 [x0, y0, x1, y1]，0–1 */
  region?: [number, number, number, number]
}

/** 一个被操作的对象：一个字，或者排好版的整段文字。 */
export type Work = {
  rings: Ring[]
  /** 选择器里 `region` 的参照盒子 */
  box: { x: number; y: number; w: number; h: number }
  em: number
  index: number
  char: string
  cache: { analysis?: GlyphAnalysis; skeleton?: Skeleton }
  /** 骨架层的状态。有它时 `rings` 只是参照轮廓 */
  strokes?: StrokeGlyph
  /** 画回轮廓时要并进去的、不在骨架里的墨 */
  keep?: Ring[]
  /** 审阅时记下每次画回轮廓前的骨架字形 */
  trace?: StrokeGlyph[]
}

export type Context = {
  chars: string[]
  hanzi?: Map<string, HanziData | null>
  /** `skeleton` 没写 `source` 时用哪种；字形本身来自逐笔数据时是 `hanzi` */
  source?: StrokeSource
}

export const STROKE_OPS = new Set(['skeleton', 'transform', 'extend', 'snap', 'smooth', 'straighten', 'fillet', 'jitter', 'connect', 'brush'])

/** 要不要预先下载逐笔数据 */
export function needsHanzi(steps: Step[]): boolean {
  return steps.some((s) => STROKE_OPS.has(s.op) && !(s.op === 'skeleton' && s.source === 'auto'))
}

export function strokesOf(w: Work, ctx: Context, wanted?: StrokeSource): StrokeGlyph {
  if (w.strokes) return w.strokes
  const source = wanted ?? ctx.source ?? 'hybrid'
  const data = source === 'auto' ? null : (ctx.hanzi?.get(w.char) ?? null)
  const sg = !data ? fromSkeleton(skeletonOf(w), w.em) : source === 'hanzi' ? fromHanzi(data, w.rings, w.em) : hybrid(data, w.rings, skeletonOf(w), w.em)
  for (const s of sg.strokes) s.glyph = w.index
  w.strokes = sg
  return sg
}

/** 骨架层画回轮廓。 */
export function ensureRings(w: Work, params: BrushParams = { width: 'source' }) {
  if (!w.strokes) return
  w.trace?.push({ source: w.strokes.source, strokes: w.strokes.strokes.map((s) => ({ ...s, pts: s.pts.slice(), width: s.width.slice() })) })
  const out = brush(w.strokes, params, w.em)
  const keep = w.keep ?? []
  w.strokes = undefined
  w.keep = undefined
  setRings(w, keep.length ? union(keep, out) : out)
}

export function setRings(w: Work, rings: Ring[]) {
  w.rings = rings
  w.cache = {}
}

export function analysisOf(w: Work): GlyphAnalysis {
  return (w.cache.analysis ??= analyzeGlyph(w.rings, w.em))
}

export function skeletonOf(w: Work): Skeleton {
  return (w.cache.skeleton ??= buildSkeleton(w.rings, w.em))
}

export function stepApplies(step: Step, w: Work): boolean {
  if (!step.glyphs) return true
  return step.glyphs.some((g) => (typeof g === 'number' ? g === w.index : /^\d+$/.test(g) ? Number(g) === w.index : g === w.char))
}

/** 这一步是否按编号点名末端。编号依赖前面步骤的结果，所以分析清单要停在这一步之前。 */
export function namesTerminals(step: Step): boolean {
  return (step.op === 'swash' && !!step.items?.length) || ((step.op === 'swash' || step.op === 'cap') && !!step.select?.ids)
}

export function runSteps(w: Work, steps: Step[], ctx: Context) {
  for (const step of steps) if (stepApplies(step, w)) applyStep(w, step, ctx)
}

export function applyStep(w: Work, step: Step, ctx: Context) {
  const em = w.em
  if (STROKE_OPS.has(step.op)) return strokeStep(w, step, ctx)
  if (step.op === 'warp') return warpStep(w, step)
  ensureRings(w)
  switch (step.op) {
    case 'swash':
      return swashStep(w, step, ctx)
    case 'cap':
      return capStep(w, step)
    case 'restroke':
      return setRings(w, restroke(w, step))
    case 'dots':
      return setRings(w, replaceDots(w.rings, step, em))
    case 'round':
      return setRings(w, roundCorners(w.rings, (step.convex ?? 0) * em, (step.concave ?? 0) * em))
    case 'offset':
      return setRings(w, offset(w.rings, step.delta * em, step.join ?? 'round'))
    case 'contrast':
      return setRings(w, applyContrast(w.rings, step, em))
    case 'outline': {
      const ink = union(w.rings)
      return setRings(w, difference(ink, offset(ink, -step.width * em, 'miter')))
    }
    case 'inline': {
      const ink = union(w.rings)
      const outer = offset(ink, -step.inset * em, 'round')
      const inner = offset(ink, -(step.inset + step.width) * em, 'round')
      return setRings(w, difference(ink, difference(outer, inner)))
    }
    case 'slice':
      return setRings(w, slice(w.rings, step, em))
    case 'geometrize':
      return setRings(w, union(w.rings.map((r) => geometrizeRing(r, step.tolerance * em, step.snap))))
  }
}

function strokeStep(w: Work, step: Step, ctx: Context) {
  const em = w.em
  const sg = strokesOf(w, ctx, step.op === 'skeleton' ? step.source : undefined)
  const pick = (f?: StrokeFilter) => selectStrokes(sg, f, w.box)
  switch (step.op) {
    case 'transform':
      return transformStrokes(pick(step.select), step, em)
    case 'extend':
      return extendStrokes(pick(step.select), step, em)
    case 'snap':
      return snapStrokes(pick(step.select), step.angle, step.tolerance ?? 0.01, em)
    case 'smooth':
      return smoothStrokes(pick(step.select), step.amount, em)
    case 'straighten':
      return straightenStrokes(pick(step.select), step, em)
    case 'fillet':
      return filletStrokes(pick(step.select), step.radius, em)
    case 'jitter':
      return jitterStrokes(pick(step.select), step.amount, step.wavelength ?? 0.2, step.seed ?? 1, em)
    case 'connect':
      return connectStrokes(sg, step, em)
    case 'brush': {
      const { op: _op, glyphs: _g, ...params } = step
      return ensureRings(w, params)
    }
  }
}

function warpStep(w: Work, step: Extract<Step, { op: 'warp' }>) {
  const em = w.em
  const { x, w: bw } = w.box
  const cx = x + bw / 2
  const map = (p: Point): Point => {
    if (step.kind === 'arc') {
      const t = (p.x - cx) / (bw / 2 || 1)
      return { x: p.x, y: p.y - step.amount * em * (1 - t * t) }
    }
    return { x: p.x, y: p.y + step.amount * em * Math.sin((2 * Math.PI * (p.x - x)) / ((step.period ?? 2) * em)) }
  }
  if (w.strokes) {
    for (const s of w.strokes.strokes) s.pts = s.pts.map(map)
    if (w.keep) w.keep = w.keep.map((r) => densify(r, em * 0.01).map(map))
    return
  }
  setRings(
    w,
    w.rings.map((r) => densify(r, em * 0.01).map(map)),
  )
}

function densify(r: Ring, step: number): Ring {
  const out: Ring = []
  for (let i = 0; i < r.length; i++) {
    const a = r[i]!
    const b = r[(i + 1) % r.length]!
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step))
    for (let k = 0; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n })
  }
  return out
}

function terminalHit(t: Terminal, k: number, f: TerminalFilter | undefined, w: Work): boolean {
  if (!f) return true
  const em = w.em
  if (f.ids && !f.ids.includes(k + 1)) return false
  if (f.dir && !f.dir.includes(compass(t.dir))) return false
  if (f.free === 'open' && t.free != null && t.free < em * 0.3) return false
  if (f.free === 'blocked' && (t.free == null || t.free >= em * 0.3)) return false
  if (f.minRun != null && t.run < f.minRun * em) return false
  if (f.minWidth != null && t.width < f.minWidth * em) return false
  if (f.maxWidth != null && t.width > f.maxWidth * em) return false
  if (f.region) {
    const u = (t.tip.x - w.box.x) / w.box.w
    const v = (t.tip.y - w.box.y) / w.box.h
    const [x0, y0, x1, y1] = f.region
    if (u < x0 || u > x1 || v < y0 || v > y1) return false
  }
  return true
}

function selectTerminals(w: Work, f: TerminalFilter | undefined): number[] {
  return analysisOf(w)
    .terminals.map((t, k) => (terminalHit(t, k, f, w) ? k : -1))
    .filter((k) => k >= 0)
}

/** `target` 是「字.末端号」或「字序号.末端号」；同一个字出现多次时按字名只认第一个。 */
function targetsGlyph(target: string, w: Work, ctx: Context): number | null {
  const dot = target.lastIndexOf('.')
  const head = target.slice(0, dot)
  const index = /^\d+$/.test(head) ? Number(head) : ctx.chars.indexOf(head)
  if (index < 0) throw new Error(`找不到字 ${head}`)
  return index === w.index ? Number(target.slice(dot + 1)) - 1 : null
}

function swashStep(w: Work, step: Extract<Step, { op: 'swash' }>, ctx: Context) {
  const { op: _op, items, select, glyphs: _g, ...shared } = step
  const plan: Array<{ k: number; params: SwashParams }> = []
  for (const it of items ?? []) {
    const k = targetsGlyph(it.target, w, ctx)
    if (k == null) continue
    const { target: _t, ...params } = it
    plan.push({ k, params })
  }
  if (!items?.length || select) for (const k of selectTerminals(w, select)) plan.push({ k, params: shared })
  if (plan.length === 0) return
  const a = analysisOf(w)
  for (const p of plan) if (!a.terminals[p.k]) throw new Error(`${w.char} 没有第 ${p.k + 1} 个末端，共 ${a.terminals.length} 个`)
  splice(
    w,
    plan.map((p) => ({ t: a.terminals[p.k]!, with: swashOutline(a.terminals[p.k]!, p.params, w.em) })),
  )
}

function splice(w: Work, parts: Array<{ t: Terminal; with: Point[] }>) {
  const a = analysisOf(w)
  const byContour = new Map<number, Array<{ a: number; b: number; with: Point[] }>>()
  for (const p of parts) {
    const list = byContour.get(p.t.contour) ?? []
    list.push({ a: p.t.a, b: p.t.b, with: p.with })
    byContour.set(p.t.contour, list)
  }
  setRings(
    w,
    a.contours.map((c, ci) => spliceContour(c.pts, byContour.get(ci) ?? [])),
  )
}

function capStep(w: Work, step: Extract<Step, { op: 'cap' }>) {
  const ks = selectTerminals(w, step.select)
  if (ks.length === 0) return
  const ts = ks.map((k) => analysisOf(w).terminals[k]!)
  const size = step.size ?? 1
  if (step.style === 'round' || step.style === 'point') {
    splice(
      w,
      ts.map((t) => ({ t, with: step.style === 'round' ? arcCap(t, size) : pointCap(t, size) })),
    )
    return
  }
  if (step.style === 'ball') {
    const balls = ts.map((t) => {
      const r = (t.width / 2) * (step.size ?? 1.35)
      return circle({ x: t.base.x + t.dir.x * (r - t.width * 0.35), y: t.base.y + t.dir.y * (r - t.width * 0.35) }, r)
    })
    splice(
      w,
      ts.map((t) => ({ t, with: arcCap(t, 1) })),
    )
    setRings(w, union(w.rings, balls))
    return
  }
  // 斜切：过末端中点、与笔画垂线成 angle 度的直线，把外侧的墨切掉
  const angle = ((step.angle ?? 35) * Math.PI) / 180
  const knives = ts.map((t) => {
    const n = rot(t.dir, angle)
    const along = { x: -n.y, y: n.x }
    const L = t.width * 2
    const c = t.base
    const half: Ring = [
      { x: c.x + along.x * L, y: c.y + along.y * L },
      { x: c.x + along.x * L + n.x * L, y: c.y + along.y * L + n.y * L },
      { x: c.x - along.x * L + n.x * L, y: c.y - along.y * L + n.y * L },
      { x: c.x - along.x * L, y: c.y - along.y * L },
    ]
    const side = { x: -t.dir.y, y: t.dir.x }
    const s = t.width * 0.6
    const strip: Ring = [
      { x: c.x + side.x * s - t.dir.x * L, y: c.y + side.y * s - t.dir.y * L },
      { x: c.x + side.x * s + t.dir.x * L, y: c.y + side.y * s + t.dir.y * L },
      { x: c.x - side.x * s + t.dir.x * L, y: c.y - side.y * s + t.dir.y * L },
      { x: c.x - side.x * s - t.dir.x * L, y: c.y - side.y * s - t.dir.y * L },
    ]
    return intersect([half], [strip])
  })
  setRings(w, difference(w.rings, knives.flat()))
}

function rot(v: Point, a: number): Point {
  return { x: v.x * Math.cos(a) - v.y * Math.sin(a), y: v.x * Math.sin(a) + v.y * Math.cos(a) }
}

/** 从 A 绕过末端到 B 的半椭圆，`size` 是向外鼓出的长度相对半宽的倍数。 */
function arcCap(t: Terminal, size: number): Point[] {
  const ax = t.A.x - t.base.x
  const ay = t.A.y - t.base.y
  const h = (t.width / 2) * size
  return Array.from({ length: 17 }, (_, i) => {
    const a = (i / 16) * Math.PI
    return { x: t.base.x + Math.cos(a) * ax + Math.sin(a) * t.dir.x * h, y: t.base.y + Math.cos(a) * ay + Math.sin(a) * t.dir.y * h }
  })
}

function pointCap(t: Terminal, size: number): Point[] {
  const h = t.width * size
  return [t.A, { x: t.base.x + t.dir.x * h, y: t.base.y + t.dir.y * h }, t.B]
}

function polyLen(pts: Point[]): number {
  let s = 0
  for (let i = 1; i < pts.length; i++) s += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y)
  return s
}

/** 从一端剪掉 d 长度（d 为负则沿端点切线延长）。 */
function trimEnd(pts: Point[], d: number, atStart: boolean): Point[] {
  const p = atStart ? pts : pts.slice().reverse()
  let out: Point[]
  if (d < 0) {
    const a = p[0]!
    let k = 1
    while (k < p.length - 1 && Math.hypot(p[k]!.x - a.x, p[k]!.y - a.y) < -d) k++
    const b = p[k]!
    const l = Math.hypot(a.x - b.x, a.y - b.y) || 1
    out = [{ x: a.x + ((a.x - b.x) / l) * -d, y: a.y + ((a.y - b.y) / l) * -d }, ...p]
  } else {
    let left = d
    let i = 0
    while (i < p.length - 1) {
      const l = Math.hypot(p[i + 1]!.x - p[i]!.x, p[i + 1]!.y - p[i]!.y)
      if (l >= left) break
      left -= l
      i++
    }
    if (i >= p.length - 1) return []
    const a = p[i]!
    const b = p[i + 1]!
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1
    out = [{ x: a.x + ((b.x - a.x) * left) / l, y: a.y + ((b.y - a.y) * left) / l }, ...p.slice(i + 1)]
  }
  return atStart ? out : out.reverse()
}

/**
 * 止于交叉点的一端：从倒数 reach 处顺着走势直线伸到交叉点旁，
 * 只要落点离交叉点不超过 tol 就替换掉原来弯进去的那一截。
 */
function aimAt(pts: Point[], target: Point, tol: number, reach: number, atStart: boolean): Point[] {
  const p = atStart ? pts.slice().reverse() : pts
  const n = p.length
  if (n < 4) return pts
  let i = n - 1
  let acc = 0
  while (i > 1 && acc < reach) {
    acc += Math.hypot(p[i]!.x - p[i - 1]!.x, p[i]!.y - p[i - 1]!.y)
    i--
  }
  if (i <= 1) return pts
  let j = i
  let back = 0
  while (j > 0 && back < reach) {
    back += Math.hypot(p[j]!.x - p[j - 1]!.x, p[j]!.y - p[j - 1]!.y)
    j--
  }
  const q = p[i]!
  const r = p[j]!
  const l = Math.hypot(q.x - r.x, q.y - r.y)
  if (l < 1e-6) return pts
  const t = { x: (q.x - r.x) / l, y: (q.y - r.y) / l }
  const u = (target.x - q.x) * t.x + (target.y - q.y) * t.y
  if (u <= 0) return pts
  const e = { x: q.x + t.x * u, y: q.y + t.y * u }
  if (Math.hypot(e.x - target.x, e.y - target.y) > tol) return pts
  const out = [...p.slice(0, i + 1), e]
  return atStart ? out.reverse() : out
}

/** 自由末端最后 reach 长的一截换成顺着走势的直线，去掉中轴拐进斜切口角落形成的小钩。 */
function straightTip(pts: Point[], reach: number, atStart: boolean): Point[] {
  const p = atStart ? pts.slice().reverse() : pts
  const n = p.length
  const total = polyLen(p)
  if (n < 4 || total < reach * 3) return pts
  let i = n - 1
  let acc = 0
  while (i > 1 && acc < reach) {
    acc += Math.hypot(p[i]!.x - p[i - 1]!.x, p[i]!.y - p[i - 1]!.y)
    i--
  }
  let j = i
  let back = 0
  while (j > 0 && back < reach) {
    back += Math.hypot(p[j]!.x - p[j - 1]!.x, p[j]!.y - p[j - 1]!.y)
    j--
  }
  const q = p[i]!
  const r = p[j]!
  const l = Math.hypot(q.x - r.x, q.y - r.y)
  if (l < 1e-6) return pts
  const out = [...p.slice(0, i + 1), { x: q.x + ((q.x - r.x) / l) * acc, y: q.y + ((q.y - r.y) / l) * acc }]
  return atStart ? out.reverse() : out
}

function geometrizeRing(r: Ring, tol: number, snap?: number): Ring {
  const s = simplifyRing(r, tol)
  return snap ? snapLine(s, snap, true) : s
}

function nibPolygon(w: number, thin: number, angle: number): Ring {
  const a = (angle * Math.PI) / 180
  return Array.from({ length: 24 }, (_, i) => {
    const t = (i / 24) * Math.PI * 2
    const x = (Math.cos(t) * w) / 2
    const y = (Math.sin(t) * w * thin) / 2
    return { x: x * Math.cos(a) - y * Math.sin(a), y: x * Math.sin(a) + y * Math.cos(a) }
  })
}

export function restroke(w: Work, p: RestrokeParams): Ring[] {
  const em = w.em
  const sk = skeletonOf(w)
  const cap = p.cap ?? 'round'
  const fit = p.fit ?? true
  const gap = (p.gap ?? 0) * em
  const dotComps = p.dots ? sk.components.filter((c) => c.dot) : []
  const dotEdges = new Set(dotComps.flatMap((c) => c.edges))
  const byWidth = new Map<number, { lines: Point[][]; loops: Point[][] }>()
  // 有笔画穿过的交叉点，止于这里的方头被穿过的那一笔盖住，不用再伸
  const endsAt = new Map<number, number>()
  for (const s of sk.strokes) for (const id of s.ends) endsAt.set(id, (endsAt.get(id) ?? 0) + 1)
  const crossed = (id: number) => (endsAt.get(id) ?? 0) < sk.nodes[id]!.edges.length
  for (const s of sk.strokes) {
    if (p.dots && s.edges.every((e) => dotEdges.has(e))) continue
    const width = (p.widthByType?.[s.type] ?? p.width) * em
    let pts = s.pts
    const spacing = polyLen(pts) / Math.max(1, pts.length - 1) || 1
    if (p.smooth) pts = gaussianSmooth(pts, (p.smooth * em) / spacing)
    const [n0, n1] = s.ends.map((id) => sk.nodes[id]!)
    const loop = s.ends[0] === s.ends[1] && n0!.kind === 'loop'
    if (!loop && s.length < em * 0.16) pts = [pts[0]!, pts[pts.length - 1]!]
    if (!loop) {
      if (n0?.kind === 'junction') pts = aimAt(pts, n0.p, width * 0.5, Math.max(n0.r * 2.5, em * 0.045), true)
      if (n1?.kind === 'junction') pts = aimAt(pts, n1.p, width * 0.5, Math.max(n1.r * 2.5, em * 0.045), false)
      const rs = s.edges.flatMap((e) => sk.edges[e]!.r).sort((a, b) => a - b)
      const tip = Math.max((rs[Math.floor(rs.length / 2)] ?? 0) * 1.5, em * 0.012)
      if (n0?.kind === 'end') pts = straightTip(pts, tip, true)
      if (n1?.kind === 'end') pts = straightTip(pts, tip, false)
      const adjust = (node: typeof n0, atStart: boolean) => {
        if (!node) return
        if (node.kind === 'end') {
          if (fit && cap !== 'butt') pts = trimEnd(pts, width / 2, atStart)
        } else if (node.kind === 'junction') {
          if (gap > 0) pts = trimEnd(pts, width / 2 + gap + (cap === 'butt' ? 0 : width / 2), atStart)
          else if (cap === 'butt' && !crossed(node.id)) pts = trimEnd(pts, -width / 2, atStart)
        }
      }
      adjust(n0, true)
      if (pts.length >= 2) adjust(n1, false)
      if (pts.length < 2) continue
    }
    pts = simplifyLine(pts, (p.simplify ?? 0.002) * em)
    if (p.snap) pts = snapLine(pts, p.snap, loop)
    const bucket = byWidth.get(width) ?? { lines: [], loops: [] }
    ;(loop ? bucket.loops : bucket.lines).push(pts)
    byWidth.set(width, bucket)
  }
  const parts: Ring[] = []
  for (const [width, b] of byWidth) {
    if (p.pen === 'nib') parts.push(...sweep(b.lines, nibPolygon(width, p.nibThin ?? 0.25, p.nibAngle ?? -40), b.loops))
    else parts.push(...strokeLines(b.lines, width, cap, p.join ?? 'round', b.loops))
  }
  if (p.dots) {
    for (const c of dotComps) {
      const size = p.dots.size != null ? p.dots.size * em : p.width * em * (p.dots.scale ?? 1.5)
      parts.push(...shape(p.dots.shape, c.center, size, p.dots.angle))
    }
  }
  return union(parts)
}

/** 包围盒最长边小于 maxSize 的独立墨块当作点。 */
export function replaceDots(rings: Ring[], step: Extract<Step, { op: 'dots' }>, em: number): Ring[] {
  const ink = union(rings)
  const keep: Ring[] = []
  const add: Ring[] = []
  for (const g of groupsOf(ink)) {
    const b = ringsBounds(g)
    const size = Math.max(b.maxX - b.minX, b.maxY - b.minY)
    if (size >= (step.maxSize ?? 0.2) * em) {
      keep.push(...g)
      continue
    }
    const c = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }
    add.push(...shape(step.shape, c, step.size != null ? step.size * em : size * (step.scale ?? 1), step.angle))
  }
  return union(keep, add)
}

function signedArea(r: Ring): number {
  let s = 0
  for (let i = 0; i < r.length; i++) {
    const a = r[i]!
    const b = r[(i + 1) % r.length]!
    s += a.x * b.y - b.x * a.y
  }
  return s / 2
}

function inside(r: Ring, p: Point): boolean {
  let c = false
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
    const a = r[i]!
    const b = r[j]!
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c
  }
  return c
}

/** Clipper 的并集结果按「外轮廓 + 它直接包含的洞」分组。 */
function groupsOf(rings: Ring[]): Ring[][] {
  const areas = rings.map(signedArea)
  const outerSign = Math.sign(areas.reduce((best, a) => (Math.abs(a) > Math.abs(best) ? a : best), 0)) || 1
  const outers = rings.map((_, i) => i).filter((i) => Math.sign(areas[i]!) === outerSign)
  const groups = new Map<number, Ring[]>(outers.map((i) => [i, [rings[i]!]]))
  rings.forEach((r, i) => {
    if (Math.sign(areas[i]!) === outerSign) return
    const owner = outers.filter((o) => inside(rings[o]!, r[0]!)).sort((p, q) => Math.abs(areas[p]!) - Math.abs(areas[q]!))[0]
    if (owner != null) groups.get(owner)!.push(r)
  })
  return [...groups.values()]
}

function slice(rings: Ring[], step: Extract<Step, { op: 'slice' }>, em: number): Ring[] {
  const a = (step.angle * Math.PI) / 180
  const d = { x: Math.cos(a), y: Math.sin(a) }
  const nrm = { x: -d.y, y: d.x }
  let out = union(rings)
  const b = ringsBounds(out)
  const corners = [
    { x: b.minX, y: b.minY },
    { x: b.maxX, y: b.minY },
    { x: b.maxX, y: b.maxY },
    { x: b.minX, y: b.maxY },
  ]
  const proj = corners.map((c) => c.x * nrm.x + c.y * nrm.y)
  const lo = Math.min(...proj)
  const hi = Math.max(...proj)
  const cx = (b.minX + b.maxX) / 2
  const cy = (b.minY + b.maxY) / 2
  const c0 = cx * nrm.x + cy * nrm.y
  const L = Math.hypot(b.maxX - b.minX, b.maxY - b.minY) + em
  const ats = Array.isArray(step.at) ? step.at : [step.at ?? 0.5]
  const band = (s0: number, s1: number): Ring => {
    const base = { x: cx + nrm.x * (s0 - c0), y: cy + nrm.y * (s0 - c0) }
    const top = { x: cx + nrm.x * (s1 - c0), y: cy + nrm.y * (s1 - c0) }
    return [
      { x: base.x - d.x * L, y: base.y - d.y * L },
      { x: base.x + d.x * L, y: base.y + d.y * L },
      { x: top.x + d.x * L, y: top.y + d.y * L },
      { x: top.x - d.x * L, y: top.y - d.y * L },
    ]
  }
  const g = (step.gap * em) / 2
  for (const t of ats) {
    const s = lo + (hi - lo) * t
    out = difference(out, [band(s - g, s + g)])
    if (step.shift) {
      const far = intersect(out, [band(s, hi + em)])
      const near = intersect(out, [band(lo - em, s)])
      out = union(near, translate(far, d.x * step.shift * em, d.y * step.shift * em))
    }
  }
  return out
}
