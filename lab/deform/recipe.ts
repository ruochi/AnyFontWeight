import type { Point, Ring } from '../../src/types.js'
import { esc, layerDoc, n } from './draw.js'
import { loadGlyphs, type SourceGlyph } from './glyphs.js'
import { mapRings, ringsBounds, ringsToPath, simplifyRing } from './outline.js'
import { spliceContour, swashOutline, type SwashParams } from './swash.js'

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
  /** `target` 写「字.末端号」，如 `爱.12`；同一个字出现多次时写「字序号.末端号」，如 `5.12` */
  swashes?: Array<{ target: string } & SwashParams>
  fill?: string
  glow?: string
  background?: string
  decor?: Decor[]
  /** 画面四周留白 */
  padding?: number
}

export type Decor =
  | { type: 'sparkle'; at: [number, number]; size: number; color?: string }
  | { type: 'dot'; at: [number, number]; size: number; color?: string }
  | {
      type: 'orbit'
      center: [number, number]
      rx: number
      ry: number
      rotate?: number
      from?: number
      to?: number
      width?: number
      color?: string
    }

export function recipeText(r: Recipe): string {
  return r.lines.join('')
}

export function sourceOptions(r: Recipe) {
  return { font: r.font ?? 'NotoSans', size: r.size ?? 400, weight: r.weight ?? 700, synthWeight: r.synthWeight, contrast: r.contrast }
}

function resolveTarget(target: string, glyphs: SourceGlyph[]): { glyph: SourceGlyph; terminal: number } {
  const dot = target.lastIndexOf('.')
  const head = target.slice(0, dot)
  const k = Number(target.slice(dot + 1)) - 1
  const glyph = /^\d+$/.test(head) ? glyphs[Number(head)] : glyphs.find((g) => g.char === head)
  if (!glyph) throw new Error(`找不到字 ${head}`)
  if (!glyph.analysis.terminals[k]) throw new Error(`${glyph.char} 没有第 ${k + 1} 个末端，共 ${glyph.analysis.terminals.length} 个`)
  return { glyph, terminal: k }
}

function deformGlyph(g: SourceGlyph, swashes: Array<{ terminal: number; params: SwashParams }>, em: number): Ring[] {
  const byContour = new Map<number, Array<{ a: number; b: number; with: Point[] }>>()
  for (const s of swashes) {
    const t = g.analysis.terminals[s.terminal]!
    const list = byContour.get(t.contour) ?? []
    list.push({ a: t.a, b: t.b, with: swashOutline(t, s.params, em) })
    byContour.set(t.contour, list)
  }
  return g.analysis.contours.map((c, ci) => spliceContour(c.pts, byContour.get(ci) ?? []))
}

export type Composition = { rings: Ring[]; decorShapes: string[]; decorSvg: string[]; bounds: { minX: number; minY: number; maxX: number; maxY: number } }

export async function compose(r: Recipe): Promise<Composition> {
  const opts = sourceOptions(r)
  const em = opts.size
  const glyphs = await loadGlyphs(recipeText(r), opts)
  const plan = new Map<number, Array<{ terminal: number; params: SwashParams }>>()
  for (const s of r.swashes ?? []) {
    const { target, ...params } = s
    const hit = resolveTarget(target, glyphs)
    const list = plan.get(hit.glyph.index) ?? []
    list.push({ terminal: hit.terminal, params })
    plan.set(hit.glyph.index, list)
  }
  const tracking = (r.tracking ?? 0) * em
  const leading = (r.leading ?? 1) * em
  const skew = Math.tan(((r.skew ?? 0) * Math.PI) / 180)
  const baseline0 = glyphs[0]?.baseline ?? em
  const out: Ring[] = []
  let gi = 0
  r.lines.forEach((line, li) => {
    let x = (r.indent?.[li] ?? 0) * em
    const y = li * leading
    for (const _ of Array.from(line)) {
      const g = glyphs[gi]!
      const tweak = r.glyphs?.[String(g.index)] ?? r.glyphs?.[g.char] ?? {}
      const rings = deformGlyph(g, plan.get(g.index) ?? [], em)
      const cx = g.advance / 2
      const cy = g.height / 2
      const sc = tweak.scale ?? 1
      const rot = ((tweak.rotate ?? 0) * Math.PI) / 180
      const ox = x + (tweak.dx ?? 0) * em
      const oy = y + (tweak.dy ?? 0) * em
      const placed = mapRings(rings, (p) => {
        const dx = (p.x - cx) * sc
        const dy = (p.y - cy) * sc
        const px = ox + cx + dx * Math.cos(rot) - dy * Math.sin(rot)
        const py = oy + cy + dx * Math.sin(rot) + dy * Math.cos(rot)
        return { x: px + (baseline0 - py) * skew, y: py }
      })
      out.push(...placed.map((ring) => simplifyRing(ring, em * 0.0006)))
      x += g.advance + tracking
      gi++
    }
  })
  const { shapes, svg, points } = drawDecor(r.decor ?? [], em, r.fill ?? '#ffffff')
  const b = ringsBounds([...out, points])
  return { rings: out, decorShapes: shapes, decorSvg: svg, bounds: b }
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

function drawDecor(decor: Decor[], em: number, fallback: string): { shapes: string[]; svg: string[]; points: Point[] } {
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
    } else {
      const pts = orbitPoints(d, em)
      points.push(...pts)
      const path = `M${pts.map((p) => `${n(p.x)} ${n(p.y)}`).join('L')}`
      const w = n((d.width ?? 0.006) * em)
      shapes.push(`<path d="${path}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round" />`)
      svg.push(`<path d="${path}" fill="none" stroke="${color}" stroke-width="${w}" stroke-linecap="round"/>`)
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
  const d = ringsToPath(mapRings(c.rings, (p) => ({ x: p.x + ox, y: p.y + oy })))
  const glow = r.glow ? ` glow="${esc(r.glow)}"` : ''
  const bg = r.background ?? '#16181d'
  const layer = layerDoc(w, h, bg.includes('gradient') ? '#000000' : bg, [
    `<rect x="0" y="0" width="${n(w)}" height="${n(h)}" fill="${esc(bg)}" />`,
    `<g transform="translate(${n(ox)},${n(oy)})">`,
    ...c.decorShapes,
    `</g>`,
    `<path d="${d}" fill="${fill}" stroke="none"${glow} />`,
  ])
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n(w)} ${n(h)}" width="${n(w)}" height="${n(h)}">`,
    `<g transform="translate(${n(ox)},${n(oy)})">`,
    ...c.decorSvg,
    `</g>`,
    `<path d="${d}" fill="${fill}" fill-rule="nonzero"/>`,
    `</svg>`,
  ].join('\n')
  return { layer, svg }
}
