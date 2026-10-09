import { glyph } from 'flexlayer'
import { anyFontWeight } from '../../src/anyFontWeight.js'
import type { Ring } from '../../src/types.js'
import { applyContrast } from './contrast.js'
import { pathToRings, removeSpikes } from './outline.js'
import type { Skeleton } from './skeleton.js'
import { analyzeGlyph, compass, groupRings, type GlyphAnalysis, type Terminal } from './terminals.js'

export type SourceGlyph = {
  index: number
  char: string
  advance: number
  height: number
  baseline: number
  rings: Ring[]
  analysis: GlyphAnalysis
}

export type SourceOptions = {
  font: string
  size: number
  weight?: number
  /** 用 anyFontWeight 从字体实际字重合成的目标字重 */
  synthWeight?: number
  /** 竖画、横画各自沿法线移动多少 em，正数加粗。用来做粗细对比 */
  contrast?: { vertical: number; horizontal: number }
}

export async function loadGlyphs(text: string, opts: SourceOptions): Promise<SourceGlyph[]> {
  const gs = await glyph(text, { font: opts.font, size: opts.size, weight: opts.weight })
  return gs.map((g, index) => {
    let rings = pathToRings(g.d, opts.size * 0.0008)
    if (opts.synthWeight != null && rings.length) {
      const to = opts.synthWeight
      rings = groupRings(rings).flatMap((group) => anyFontWeight(group, { from: g.weight, to, em: opts.size }).map(removeSpikes))
    }
    if (opts.contrast && rings.length) rings = applyContrast(rings, opts.contrast, opts.size)
    return {
      index,
      char: g.text,
      advance: g.width,
      height: g.height,
      baseline: g.baseline,
      rings,
      analysis: analyzeGlyph(rings, opts.size),
    }
  })
}

/** 给模型读的笔画清单。`id` 是「字.s编号」，`from`、`to` 是相对字身盒子的位置。 */
export function describeSkeleton(g: { index: number; char: string; advance: number; height: number }, sk: Skeleton, em: number) {
  const r = (v: number) => Math.round(v * 1000) / 1000
  const rel = (p: { x: number; y: number }) => [r(p.x / g.advance), r(p.y / g.height)]
  return {
    index: g.index,
    char: g.char,
    strokes: sk.strokes.map((s) => ({
      id: `${g.char}.s${s.id + 1}`,
      type: s.type,
      length: r(s.length / em),
      angle: Math.round(s.angle),
      from: rel(s.pts[0]!),
      to: rel(s.pts[s.pts.length - 1]!),
    })),
    dots: sk.components.filter((c) => c.dot).map((c) => rel(c.center)),
  }
}

/** 给模型读的末端清单。长度单位都是 em，位置是相对字身盒子的 0–1。 */
export function describeTerminals(glyphs: SourceGlyph[], em: number) {
  const r = (v: number) => Math.round(v * 1000) / 1000
  return glyphs.map((g) => ({
    index: g.index,
    char: g.char,
    terminals: g.analysis.terminals.map((t: Terminal, k: number) => ({
      id: `${g.char}.${k + 1}`,
      dir: compass(t.dir),
      angle: Math.round((Math.atan2(t.dir.y, t.dir.x) * 180) / Math.PI),
      at: [r(t.tip.x / g.advance), r(t.tip.y / g.height)],
      width: r(t.width / em),
      run: r(t.run / em),
      free: t.free == null ? null : r(t.free / em),
    })),
  }))
}
