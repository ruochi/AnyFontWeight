import { glyph } from 'flexlayer'
import type { Point, Ring } from '../../src/types.js'
import { ringsToCurvePath } from './bezier.js'
import { circle, offset, strokeLines, union } from './bool.js'
import { esc, layerDoc, n } from './draw.js'
import { HANZI_FONT, loadGlyphs } from './glyphs.js'
import { loadHanzi, type HanziData } from './hanzi.js'
import { icon, type IconName } from './icons.js'
import { ensureRings, needsHanzi, runSteps, STROKE_OPS, type Context, type Step, type Work } from './ops.js'
import type { SStroke } from './strokes.js'
import { mapRings, pathToRings, ringsBounds, ringsToPath, simplifyRing } from './outline.js'
import type { SwashParams } from './swash.js'

/** 长度单位都是 em，角度是度。 */
export type Recipe = {
  lines: string[]
  font?: string
  weight?: number
  /** 用 anyFontWeight 合成的字重 */
  synthWeight?: number
  /** 竖画、横画各自加粗多少 em，负数变细 */
  contrast?: { vertical: number; horizontal: number }
  size?: number
  /** 字距，负数让字挤在一起 */
  tracking?: number
  /** 行距 */
  leading?: number
  /** 每行的水平缩进 */
  indent?: number[]
  /** 单字微调。键是全文的字序号（从 0 起，跨行连续）或字本身 */
  glyphs?: Record<string, { dx?: number; dy?: number; scale?: number; rotate?: number }>
  /** 整体倾斜，正数向右倒 */
  skew?: number
  /** 旧写法，等于排在最前面的一步 `{ op: 'swash', items: swashes }` */
  swashes?: Array<{ target: string } & SwashParams>
  /** 逐字执行的操作，在字的本地坐标里做 */
  steps?: Step[]
  /** 排版之后对整段文字执行的操作 */
  post?: Step[]
  fill?: string
  glow?: string
  /** 原样写到字形 path 上的 flexlayer 属性，比如 `{ "inner-shadow": "0 6 10 #0006" }` */
  attrs?: Record<string, string>
  background?: string
  /** 字外面一圈描边（贴纸那种黑边），压住底下的装饰。`width` 是 em */
  outline?: { width: number; color?: string }
  decor?: Decor[]
  /** 画面四周留白 */
  padding?: number
  /** 输出时把折线拟合成贝塞尔曲线，默认开 */
  curves?: boolean
}

/**
 * 所有装饰共有的字段。默认画在字下面，`above` 画到字上面；
 * `outline` 给装饰自己加一圈 `outlineColor`（默认黑）的描边，宽度是 em。
 */
type Common = { color?: string; above?: boolean; outline?: number; outlineColor?: string }
/** 线的粗细沿长度变化：两头各用全长的多少比例从 0 长到 `width`；一个数表示两头一样 */
type Taper = number | [number, number]
export type Decor =
  | ({ type: 'sparkle'; at: [number, number]; size: number } & Common)
  | ({ type: 'dot'; at: [number, number]; size: number } & Common)
  | ({
      type: 'orbit'
      center: [number, number]
      rx: number
      ry: number
      rotate?: number
      from?: number
      to?: number
      width?: number
      taper?: Taper
      dash?: [number, number]
    } & Common)
  /** 折线，`dash` 是 [实, 虚] 的 em 长度；`smooth` 把折点连成圆滑曲线 */
  | ({
      type: 'line'
      points: Array<[number, number]>
      width?: number
      dash?: [number, number]
      cap?: 'round' | 'butt'
      smooth?: boolean
      taper?: Taper
    } & Common)
  /** 小字，比如拼音、英文副标题。`at` 是文字块的中心，`skew` 是斜体角度，正数向右倒 */
  | ({
      type: 'text'
      text: string
      at: [number, number]
      size: number
      font?: string
      weight?: number
      letterSpacing?: number
      vertical?: boolean
      rotate?: number
      skew?: number
    } & Common)
  /** 小图标，名字见 `icons.ts`。`size` 是图标宽度 */
  | ({ type: 'icon'; name: IconName; at: [number, number]; size: number; rotate?: number; flip?: boolean } & Common)

/** 一件装饰画出来的样子：flexlayer 和 SVG 两份，外加描边用的轮廓 */
export type DecorPiece = { layer: string; svg: string; above: boolean; knock?: { rings: Ring[]; color: string } }

export function recipeText(r: Recipe): string {
  return r.lines.join('')
}

export function sourceOptions(r: Recipe) {
  return { font: r.font ?? 'NotoSans', size: r.size ?? 400, weight: r.weight ?? 700, synthWeight: r.synthWeight, contrast: r.contrast }
}

export function recipeSteps(r: Recipe): Step[] {
  return [...(r.swashes?.length ? [{ op: 'swash' as const, items: r.swashes }] : []), ...(r.steps ?? [])]
}

export async function glyphWorks(r: Recipe, opts2: { hanzi?: boolean } = {}): Promise<{ works: Work[]; ctx: Context; baseline: number; advances: number[] }> {
  const opts = sourceOptions(r)
  const glyphs = await loadGlyphs(recipeText(r), opts)
  const hanzi = new Map<string, HanziData | null>()
  const fromData = opts.font === HANZI_FONT
  if (fromData || opts2.hanzi || needsHanzi([...recipeSteps(r), ...(r.post ?? [])])) for (const g of glyphs) hanzi.set(g.char, await loadHanzi(g.char))
  const works: Work[] = glyphs.map((g) => ({
    rings: g.rings,
    box: { x: 0, y: 0, w: g.advance, h: g.height },
    em: opts.size,
    index: g.index,
    char: g.char,
    cache: { analysis: g.analysis },
  }))
  return {
    works,
    ctx: { chars: glyphs.map((g) => g.char), hanzi, source: fromData ? 'hanzi' : undefined },
    baseline: glyphs[0]?.baseline ?? opts.size,
    advances: glyphs.map((g) => g.advance),
  }
}

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number }

/** 审阅用：每个字排版后的原字轮廓、字身盒子，以及最后一次画回轮廓前的骨架字形（都在排版坐标里）。 */
export type Trace = {
  glyphs: Array<{
    index: number
    char: string
    orig: Ring[]
    box: Bounds
    strokes: SStroke[]
    affine: [Point, Point, Point]
    /** 这个字自己的结果；有整段操作时字和字并在一起，没有这一项 */
    rings?: Ring[]
  }>
}

export type Composition = { rings: Ring[]; outline?: Ring[]; decor: DecorPiece[]; bounds: Bounds; trace?: Trace }

export async function compose(r: Recipe, opts: { trace?: boolean } = {}): Promise<Composition> {
  const em = sourceOptions(r).size
  const { works, ctx, baseline, advances } = await glyphWorks(r)
  const steps = recipeSteps(r)
  const carry = (r.post ?? []).some((s) => STROKE_OPS.has(s.op))
  const orig = works.map((w) => w.rings)
  const trace: Trace | undefined = opts.trace ? { glyphs: [] } : undefined
  for (const w of works) {
    if (trace) w.trace = []
    runSteps(w, steps, ctx)
    if (!carry) ensureRings(w)
  }
  const tracking = (r.tracking ?? 0) * em
  const leading = (r.leading ?? 1) * em
  const skew = Math.tan(((r.skew ?? 0) * Math.PI) / 180)
  let out: Ring[] = []
  const ref: Ring[] = []
  const strokes: SStroke[] = []
  let gi = 0
  r.lines.forEach((line, li) => {
    let x = (r.indent?.[li] ?? 0) * em
    const y = li * leading
    for (const _ of Array.from(line)) {
      const w = works[gi]!
      const tweak = r.glyphs?.[String(w.index)] ?? r.glyphs?.[w.char] ?? {}
      const cx = w.box.w / 2
      const cy = w.box.h / 2
      const sc = tweak.scale ?? 1
      const rot = ((tweak.rotate ?? 0) * Math.PI) / 180
      const ox = x + (tweak.dx ?? 0) * em
      const oy = y + (tweak.dy ?? 0) * em
      const place = (p: Point): Point => {
        const dx = (p.x - cx) * sc
        const dy = (p.y - cy) * sc
        const px = ox + cx + dx * Math.cos(rot) - dy * Math.sin(rot)
        const py = oy + cy + dx * Math.sin(rot) + dy * Math.cos(rot)
        return { x: px + (baseline - py) * skew, y: py }
      }
      const placed = mapRings(w.rings, place).map((ring) => simplifyRing(ring, em * 0.0006))
      if (trace) {
        const corners = [place({ x: 0, y: 0 }), place({ x: w.box.w, y: 0 }), place({ x: 0, y: w.box.h }), place({ x: w.box.w, y: w.box.h })]
        const last = w.trace?.[w.trace.length - 1]
        trace.glyphs.push({
          index: w.index,
          char: w.char,
          orig: mapRings(orig[gi]!, place),
          box: ringsBounds([corners]),
          affine: [place({ x: 0, y: 0 }), place({ x: 1, y: 0 }), place({ x: 0, y: 1 })],
          rings: r.post?.length ? undefined : placed,
          strokes: last ? last.strokes.map((s) => ({ ...s, pts: s.pts.map(place), width: s.width.map((v) => v * sc), glyph: w.index })) : [],
        })
      }
      if (w.strokes) {
        ref.push(...placed)
        for (const s of w.strokes.strokes) strokes.push({ ...s, pts: s.pts.map(place), width: s.width.map((v) => v * sc), glyph: w.index })
      } else out.push(...placed)
      x += advances[gi]! + tracking
      gi++
    }
  })
  if (r.post?.length) {
    const b = ringsBounds([...out, ...ref])
    const whole: Work = {
      rings: strokes.length ? [...out, ...ref] : union(out),
      box: { x: b.minX, y: b.minY, w: b.maxX - b.minX, h: b.maxY - b.minY },
      em,
      index: -1,
      char: '',
      cache: {},
      strokes: strokes.length ? { source: 'hybrid', strokes } : undefined,
      keep: strokes.length ? out : undefined,
      trace: trace ? [] : undefined,
    }
    runSteps(whole, r.post, ctx)
    ensureRings(whole)
    out = whole.rings
    const last = whole.trace?.[whole.trace.length - 1]
    if (trace && last) for (const g of trace.glyphs) g.strokes = last.strokes.filter((s) => s.glyph === g.index)
  }
  const { pieces, points } = await drawDecor(r.decor ?? [], em, r.fill ?? '#ffffff')
  const outline = r.outline ? offset(union(out), r.outline.width * em) : undefined
  const b = ringsBounds([...(outline ?? out), points])
  return { rings: out, outline, decor: pieces, bounds: b, trace }
}

function sparklePath(c: Point, size: number): string {
  const r = size / 2
  const k = r * 0.16
  const p = (x: number, y: number) => `${n(c.x + x)} ${n(c.y + y)}`
  return `M${p(0, -r)}Q${p(k, -k)} ${p(r, 0)}Q${p(k, k)} ${p(0, r)}Q${p(-k, k)} ${p(-r, 0)}Q${p(-k, -k)} ${p(0, -r)}Z`
}

function orbitPoints(d: Extract<Decor, { type: 'orbit' }>, em: number): Point[] {
  const from = ((d.from ?? 0) * Math.PI) / 180
  const to = ((d.to ?? 360) * Math.PI) / 180
  const rot = ((d.rotate ?? 0) * Math.PI) / 180
  const steps = 160
  const pts: Point[] = []
  for (let i = 0; i <= steps; i++) {
    const a = from + ((to - from) * i) / steps
    const x = Math.cos(a) * d.rx * em
    const y = Math.sin(a) * d.ry * em
    pts.push({ x: d.center[0] * em + x * Math.cos(rot) - y * Math.sin(rot), y: d.center[1] * em + x * Math.sin(rot) + y * Math.cos(rot) })
  }
  return pts
}

/** 把小字排成矢量轮廓，横排或竖排，再绕中心旋转。 */
async function textRings(d: Extract<Decor, { type: 'text' }>, em: number): Promise<Ring[]> {
  const size = d.size * em
  const gs = await glyph(d.text, { font: d.font ?? 'NotoSans', size, weight: d.weight ?? 500 })
  const gap = (d.letterSpacing ?? 0) * em
  const rings: Ring[] = []
  let x = 0
  let y = 0
  for (const g of gs) {
    const rs = pathToRings(g.d, size * 0.002)
    const dx = d.vertical ? -g.width / 2 : x
    const dy = d.vertical ? y : 0
    rings.push(...mapRings(rs, (p) => ({ x: p.x + dx, y: p.y + dy })))
    if (d.vertical) y += g.height * 0.82 + gap
    else x += g.width + gap
  }
  if (!rings.length) return []
  const b = ringsBounds(rings)
  const cx = (b.minX + b.maxX) / 2
  const cy = (b.minY + b.maxY) / 2
  const a = ((d.rotate ?? 0) * Math.PI) / 180
  const k = Math.tan(((d.skew ?? 0) * Math.PI) / 180)
  return mapRings(rings, (p) => {
    const uy = p.y - cy
    const ux = p.x - cx - uy * k
    return { x: d.at[0] * em + ux * Math.cos(a) - uy * Math.sin(a), y: d.at[1] * em + ux * Math.sin(a) + uy * Math.cos(a) }
  })
}

/** Catmull-Rom 曲线穿过每个折点 */
function smoothLine(pts: Point[], per = 16): Point[] {
  if (pts.length < 3) return pts
  const out: Point[] = [pts[0]!]
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)]!
    const p1 = pts[i]!
    const p2 = pts[i + 1]!
    const p3 = pts[Math.min(pts.length - 1, i + 2)]!
    for (let j = 1; j <= per; j++) {
      const t = j / per
      const t2 = t * t
      const t3 = t2 * t
      const f = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3)
      out.push({ x: f(p0.x, p1.x, p2.x, p3.x), y: f(p0.y, p1.y, p2.y, p3.y) })
    }
  }
  return out
}

/** 长段切成不超过 `step` 的小段，粗细才能沿长度变化 */
function densify(pts: Point[], step: number): Point[] {
  const out: Point[] = pts.slice(0, 1)
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!
    const b = pts[i]!
    const k = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step))
    for (let j = 1; j <= k; j++) out.push({ x: a.x + ((b.x - a.x) * j) / k, y: a.y + ((b.y - a.y) * j) / k })
  }
  return out
}

type Run = { pts: Point[]; s: number[] }

/** 按 [实, 虚] 把线切成一段段，每个点带着它在整条线上的弧长 */
function dashRuns(pts: Point[], dash?: [number, number]): { runs: Run[]; total: number } {
  const s = [0]
  for (let i = 1; i < pts.length; i++) s.push(s[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y))
  const total = s[s.length - 1]!
  if (!dash || dash[0] <= 0) return { runs: [{ pts, s }], total }
  const at = (d: number): Point => {
    let i = 1
    while (i < s.length - 1 && s[i]! < d) i++
    const t = (d - s[i - 1]!) / (s[i]! - s[i - 1]! || 1)
    return { x: pts[i - 1]!.x + (pts[i]!.x - pts[i - 1]!.x) * t, y: pts[i - 1]!.y + (pts[i]!.y - pts[i - 1]!.y) * t }
  }
  const runs: Run[] = []
  for (let d0 = 0; d0 < total; d0 += dash[0] + dash[1]) {
    const d1 = Math.min(total, d0 + dash[0])
    const run: Run = { pts: [at(d0)], s: [d0] }
    for (let i = 0; i < s.length; i++) if (s[i]! > d0 && s[i]! < d1) run.pts.push(pts[i]!), run.s.push(s[i]!)
    run.pts.push(at(d1))
    run.s.push(d1)
    runs.push(run)
  }
  return { runs, total }
}

/** 两头收尖的粗细：在收尖的那一段里按四分之一正弦从 0 长到满 */
function taperAt(s: number, total: number, taper: Taper): number {
  const [a, b] = typeof taper === 'number' ? [taper, taper] : taper
  const u = Math.min(1, a > 0 ? s / (a * total) : 1, b > 0 ? (total - s) / (b * total) : 1)
  return Math.sin((Math.max(0, u) * Math.PI) / 2)
}

/** 沿线铺一条宽度可变的带子 */
function ribbon(run: Run, width: (s: number) => number): Ring {
  const left: Point[] = []
  const right: Point[] = []
  const { pts } = run
  for (let i = 0; i < pts.length; i++) {
    const a = pts[Math.max(0, i - 1)]!
    const b = pts[Math.min(pts.length - 1, i + 1)]!
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
    const nx = -(b.y - a.y) / len
    const ny = (b.x - a.x) / len
    const h = width(run.s[i]!) / 2
    left.push({ x: pts[i]!.x + nx * h, y: pts[i]!.y + ny * h })
    right.push({ x: pts[i]!.x - nx * h, y: pts[i]!.y - ny * h })
  }
  return [...left, ...right.reverse()]
}

function linePoints(d: Extract<Decor, { type: 'orbit' | 'line' }>, em: number): Point[] {
  if (d.type === 'orbit') return orbitPoints(d, em)
  const pts = d.points.map(([x, y]) => ({ x: x * em, y: y * em }))
  return d.smooth ? smoothLine(pts) : pts
}

async function drawDecor(decor: Decor[], em: number, fallback: string): Promise<{ pieces: DecorPiece[]; points: Point[] }> {
  const pieces: DecorPiece[] = []
  const points: Point[] = []
  for (const d of decor) {
    const color = d.color ?? fallback
    let layer: string
    let svg: string
    let rings: Ring[]
    if (d.type === 'sparkle' || d.type === 'dot') {
      const c = { x: d.at[0] * em, y: d.at[1] * em }
      const size = d.size * em
      if (d.type === 'sparkle') {
        const path = sparklePath(c, size)
        layer = `<path d="${path}" fill="${color}" stroke="none" glow="${n(size * 0.6)} ${color}" />`
        svg = `<path d="${path}" fill="${color}"/>`
        rings = d.outline ? pathToRings(path, size * 0.005) : []
      } else {
        layer = `<circle cx="${n(c.x)}" cy="${n(c.y)}" r="${n(size / 2)}" fill="${color}" />`
        svg = `<circle cx="${n(c.x)}" cy="${n(c.y)}" r="${n(size / 2)}" fill="${color}"/>`
        rings = d.outline ? [circle(c, size / 2)] : []
      }
      points.push({ x: c.x - size / 2, y: c.y - size / 2 }, { x: c.x + size / 2, y: c.y + size / 2 })
    } else if (d.type === 'text' || d.type === 'icon') {
      rings = d.type === 'text' ? await textRings(d, em) : icon(d.name, { x: d.at[0] * em, y: d.at[1] * em }, d.size * em, d.rotate, d.flip)
      const path = ringsToPath(rings)
      layer = `<path d="${path}" fill="${color}" stroke="none" />`
      svg = `<path d="${path}" fill="${color}"/>`
    } else {
      const pts = linePoints(d, em)
      const w = (d.width ?? 0.006) * em
      const cap = d.type === 'line' ? (d.cap ?? 'round') : 'round'
      if (d.taper !== undefined || d.outline) {
        const { runs, total } = dashRuns(densify(pts, em * 0.01), d.dash && [d.dash[0] * em, d.dash[1] * em])
        const taper = d.taper
        rings =
          taper === undefined
            ? strokeLines(
                runs.map((r) => r.pts),
                w,
                cap,
              )
            : union(runs.map((r) => ribbon(r, (s) => w * taperAt(s, total, taper))))
        const path = ringsToPath(rings)
        layer = `<path d="${path}" fill="${color}" stroke="none" />`
        svg = `<path d="${path}" fill="${color}"/>`
      } else {
        const path = `M${pts.map((p) => `${n(p.x)} ${n(p.y)}`).join('L')}`
        const dash = d.dash ? ` stroke-dasharray="${n(d.dash[0] * em)} ${n(d.dash[1] * em)}"` : ''
        layer = `<path d="${path}" fill="none" stroke="${color}" stroke-width="${n(w)}" stroke-linecap="${cap}"${dash} />`
        svg = `<path d="${path}" fill="none" stroke="${color}" stroke-width="${n(w)}" stroke-linecap="${cap}"${dash}/>`
        rings = []
        points.push(...pts)
      }
    }
    const knock = d.outline && rings.length ? { rings: offset(union(rings), d.outline * em), color: d.outlineColor ?? '#000000' } : undefined
    points.push(...rings.flat(), ...(knock?.rings.flat() ?? []))
    pieces.push({ layer, svg, above: !!d.above, knock })
  }
  return { pieces, points }
}

function pieceDocs(pieces: DecorPiece[], kind: 'layer' | 'svg'): string[] {
  const out: string[] = []
  for (const p of pieces) {
    if (p.knock) {
      const d = ringsToPath(p.knock.rings)
      out.push(kind === 'layer' ? `<path d="${d}" fill="${p.knock.color}" stroke="none" />` : `<path d="${d}" fill="${p.knock.color}"/>`)
    }
    out.push(p[kind])
  }
  return out
}

export function toDocuments(r: Recipe, c: Composition): { layer: string; svg: string } {
  const em = r.size ?? 400
  const pad = (r.padding ?? 0.35) * em
  const w = c.bounds.maxX - c.bounds.minX + pad * 2
  const h = c.bounds.maxY - c.bounds.minY + pad * 2
  const ox = pad - c.bounds.minX
  const oy = pad - c.bounds.minY
  const fill = r.fill ?? '#ffffff'
  const toPath = (rings: Ring[]) => {
    const moved = mapRings(rings, (p) => ({ x: p.x + ox, y: p.y + oy }))
    return r.curves === false ? ringsToPath(moved) : ringsToCurvePath(moved, em * 0.0012)
  }
  const d = toPath(c.rings)
  const outline = c.outline ? toPath(c.outline) : ''
  const outlineColor = r.outline?.color ?? '#000000'
  const glow = r.glow ? ` glow="${esc(r.glow)}"` : ''
  const extra = Object.entries(r.attrs ?? {})
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join('')
  const bg = r.background ?? '#16181d'
  const below = c.decor.filter((p) => !p.above)
  const above = c.decor.filter((p) => p.above)
  const group = (body: string[]) => (body.length ? [`<g transform="translate(${n(ox)},${n(oy)})">`, ...body, `</g>`] : [])
  const layer = layerDoc(w, h, bg.includes('gradient') ? '#000000' : bg, [
    `<rect x="0" y="0" width="${n(w)}" height="${n(h)}" fill="${esc(bg)}" />`,
    ...group(pieceDocs(below, 'layer')),
    outline ? `<path d="${outline}" fill="${esc(outlineColor)}" stroke="none" />` : '',
    `<path d="${d}" fill="${esc(fill)}" stroke="none"${glow}${extra} />`,
    ...group(pieceDocs(above, 'layer')),
  ].filter(Boolean))
  const svgFill = fill.includes('gradient') ? '#ffffff' : fill
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(w)} ${n(h)}" width="${n(w)}" height="${n(h)}">`,
    bg.includes('gradient') ? '' : `<rect width="100%" height="100%" fill="${bg}"/>`,
    ...group(pieceDocs(below, 'svg')),
    outline ? `<path d="${outline}" fill="${outlineColor}" fill-rule="nonzero"/>` : '',
    `<path d="${d}" fill="${svgFill}" fill-rule="nonzero"/>`,
    ...group(pieceDocs(above, 'svg')),
    `</svg>`,
  ]
    .filter(Boolean)
    .join('\n')
  return { layer, svg }
}
