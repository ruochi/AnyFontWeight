import { glyph } from 'flexlayer'
import type { Point, Ring } from '../../src/types.js'
import { ringsToCurvePath } from './bezier.js'
import { union } from './bool.js'
import { esc, layerDoc, n } from './draw.js'
import { loadGlyphs } from './glyphs.js'
import { loadHanzi, type HanziData } from './hanzi.js'
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
  decor?: Decor[]
  /** 画面四周留白 */
  padding?: number
  /** 输出时把折线拟合成贝塞尔曲线，默认开 */
  curves?: boolean
}

type Color = { color?: string }
export type Decor =
  | ({ type: 'sparkle'; at: [number, number]; size: number } & Color)
  | ({ type: 'dot'; at: [number, number]; size: number } & Color)
  | ({
      type: 'orbit'
      center: [number, number]
      rx: number
      ry: number
      rotate?: number
      from?: number
      to?: number
      width?: number
    } & Color)
  /** 折线，`dash` 是 [实, 虚] 的 em 长度 */
  | ({ type: 'line'; points: Array<[number, number]>; width?: number; dash?: [number, number]; cap?: 'round' | 'butt' } & Color)
  /** 小字，比如拼音、英文副标题。`at` 是文字块的中心 */
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
    } & Color)

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
  if (opts2.hanzi || needsHanzi([...recipeSteps(r), ...(r.post ?? [])])) for (const g of glyphs) hanzi.set(g.char, await loadHanzi(g.char))
  const works: Work[] = glyphs.map((g) => ({
    rings: g.rings,
    box: { x: 0, y: 0, w: g.advance, h: g.height },
    em: opts.size,
    index: g.index,
    char: g.char,
    cache: { analysis: g.analysis },
  }))
  return { works, ctx: { chars: glyphs.map((g) => g.char), hanzi }, baseline: glyphs[0]?.baseline ?? opts.size, advances: glyphs.map((g) => g.advance) }
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

export type Composition = { rings: Ring[]; decorShapes: string[]; decorSvg: string[]; bounds: Bounds; trace?: Trace }

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
  const { shapes, svg, points } = await drawDecor(r.decor ?? [], em, r.fill ?? '#ffffff')
  const b = ringsBounds([...out, points])
  return { rings: out, decorShapes: shapes, decorSvg: svg, bounds: b, trace }
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
  return mapRings(rings, (p) => {
    const ux = p.x - cx
    const uy = p.y - cy
    return { x: d.at[0] * em + ux * Math.cos(a) - uy * Math.sin(a), y: d.at[1] * em + ux * Math.sin(a) + uy * Math.cos(a) }
  })
}

async function drawDecor(decor: Decor[], em: number, fallback: string): Promise<{ shapes: string[]; svg: string[]; points: Point[] }> {
  const shapes: string[] = []
  const svg: string[] = []
  const points: Point[] = []
  for (const d of decor) {
    const color = d.color ?? fallback
    if (d.type === 'sparkle' || d.type === 'dot') {
      const c = { x: d.at[0] * em, y: d.at[1] * em }
      const size = d.size * em
      points.push({ x: c.x - size / 2, y: c.y - size / 2 }, { x: c.x + size / 2, y: c.y + size / 2 })
      if (d.type === 'sparkle') {
        const path = sparklePath(c, size)
        shapes.push(`<path d="${path}" fill="${color}" stroke="none" glow="${n(size * 0.6)} ${color}" />`)
        svg.push(`<path d="${path}" fill="${color}"/>`)
      } else {
        shapes.push(`<circle cx="${n(c.x)}" cy="${n(c.y)}" r="${n(size / 2)}" fill="${color}" />`)
        svg.push(`<circle cx="${n(c.x)}" cy="${n(c.y)}" r="${n(size / 2)}" fill="${color}"/>`)
      }
    } else if (d.type === 'text') {
      const rings = await textRings(d, em)
      points.push(...rings.flat())
      const path = ringsToPath(rings)
      shapes.push(`<path d="${path}" fill="${color}" stroke="none" />`)
      svg.push(`<path d="${path}" fill="${color}"/>`)
    } else {
      const pts =
        d.type === 'orbit' ? orbitPoints(d, em) : d.points.map(([x, y]) => ({ x: x * em, y: y * em }))
      points.push(...pts)
      const path = `M${pts.map((p) => `${n(p.x)} ${n(p.y)}`).join('L')}`
      const w = n((d.width ?? 0.006) * em)
      const cap = d.type === 'line' ? (d.cap ?? 'round') : 'round'
      const dash = d.type === 'line' && d.dash ? ` stroke-dasharray="${n(d.dash[0] * em)} ${n(d.dash[1] * em)}"` : ''
      shapes.push(`<path d="${path}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="${cap}"${dash} />`)
      svg.push(`<path d="${path}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="${cap}"${dash}/>`)
    }
  }
  return { shapes, svg, points }
}

export function toDocuments(r: Recipe, c: Composition): { layer: string; svg: string } {
  const em = r.size ?? 400
  const pad = (r.padding ?? 0.35) * em
  const w = c.bounds.maxX - c.bounds.minX + pad * 2
  const h = c.bounds.maxY - c.bounds.minY + pad * 2
  const ox = pad - c.bounds.minX
  const oy = pad - c.bounds.minY
  const fill = r.fill ?? '#ffffff'
  const moved = mapRings(c.rings, (p) => ({ x: p.x + ox, y: p.y + oy }))
  const d = r.curves === false ? ringsToPath(moved) : ringsToCurvePath(moved, em * 0.0012)
  const glow = r.glow ? ` glow="${esc(r.glow)}"` : ''
  const extra = Object.entries(r.attrs ?? {})
    .map(([k, v]) => ` ${k}="${esc(v)}"`)
    .join('')
  const bg = r.background ?? '#16181d'
  const layer = layerDoc(w, h, bg.includes('gradient') ? '#000000' : bg, [
    `<rect x="0" y="0" width="${n(w)}" height="${n(h)}" fill="${esc(bg)}" />`,
    `<g transform="translate(${n(ox)},${n(oy)})">`,
    ...c.decorShapes,
    `</g>`,
    `<path d="${d}" fill="${esc(fill)}" stroke="none"${glow}${extra} />`,
  ])
  const svgFill = fill.includes('gradient') ? '#ffffff' : fill
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(w)} ${n(h)}" width="${n(w)}" height="${n(h)}">`,
    bg.includes('gradient') ? '' : `<rect width="100%" height="100%" fill="${bg}"/>`,
    `<g transform="translate(${n(ox)},${n(oy)})">`,
    ...c.decorSvg,
    `</g>`,
    `<path d="${d}" fill="${svgFill}" fill-rule="nonzero"/>`,
    `</svg>`,
  ]
    .filter(Boolean)
    .join('\n')
  return { layer, svg }
}
