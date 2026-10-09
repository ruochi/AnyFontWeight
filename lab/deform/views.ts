import type { Ring } from '../../src/types.js'
import { label, layerDoc, n } from './draw.js'
import { mapRings, ringsToPath } from './outline.js'
import type { Skeleton, StrokeType } from './skeleton.js'
import type { Terminal } from './terminals.js'

export type SheetGlyph = { index: number; char: string; advance: number; height: number; rings: Ring[] }

export const STROKE_COLORS: Record<StrokeType, string> = {
  横: '#ff6b6b',
  竖: '#4dabf7',
  撇: '#ffd43b',
  捺: '#69db7c',
  点: '#f783ac',
  提: '#b197fc',
  折: '#ffa94d',
}

const PAD = 70
const GAP = 30

function sheet<G extends SheetGlyph>(glyphs: G[], em: number, draw: (g: G, ox: number, oy: number, shapes: string[]) => void): string {
  const height = (glyphs[0]?.height ?? em) + PAD * 2
  let x = PAD
  const shapes: string[] = []
  for (const g of glyphs) {
    const ox = x
    const oy = PAD
    shapes.push(`<rect x="${n(ox)}" y="${n(oy)}" width="${n(g.advance)}" height="${n(g.height)}" fill="#ffffff08" />`)
    draw(g, ox, oy, shapes)
    shapes.push(label(ox + g.advance / 2, oy + g.height + 18, `${g.index}  ${g.char}`, '#8a8f99', 18))
    x += g.advance + GAP
  }
  return layerDoc(x - GAP + PAD, height + 20, '#16181d', shapes)
}

/** 每个末端画一条从开口中点指出去的线，标上编号。粉色前方开阔，蓝色很快撞到本字其它笔画。 */
export function terminalSheet(glyphs: Array<SheetGlyph & { terminals: Terminal[] }>, em: number): string {
  return sheet(glyphs, em, (g, ox, oy, shapes) => {
    const placed = mapRings(g.rings, (p) => ({ x: p.x + ox, y: p.y + oy }))
    shapes.push(`<path d="${ringsToPath(placed)}" fill="#c9ccd3" stroke="none" />`)
    g.terminals.forEach((t, k) => {
      const free = t.free == null || t.free > em * 0.12
      const color = free ? '#ff4f8b' : '#5aa9ff'
      const from = { x: t.base.x + ox, y: t.base.y + oy }
      const to = { x: t.tip.x + ox + t.dir.x * em * 0.07, y: t.tip.y + oy + t.dir.y * em * 0.07 }
      shapes.push(`<line x1="${n(t.A.x + ox)}" y1="${n(t.A.y + oy)}" x2="${n(t.B.x + ox)}" y2="${n(t.B.y + oy)}" stroke="${color}" stroke-width="3" />`)
      shapes.push(`<line x1="${n(from.x)}" y1="${n(from.y)}" x2="${n(to.x)}" y2="${n(to.y)}" stroke="${color}" stroke-width="3" />`)
      const lx = to.x + t.dir.x * 16
      const ly = to.y + t.dir.y * 16
      shapes.push(`<circle cx="${n(lx)}" cy="${n(ly)}" r="15" fill="${color}" />`)
      shapes.push(label(lx, ly, String(k + 1), '#ffffff', 17))
    })
  })
}

/** 骨架按笔画类型上色，每笔标「类型+编号」，交叉点画白点，点状部件画圈。 */
export function skeletonSheet(glyphs: Array<SheetGlyph & { skeleton: Skeleton }>, em: number): string {
  return sheet(glyphs, em, (g, ox, oy, shapes) => {
    const placed = mapRings(g.rings, (p) => ({ x: p.x + ox, y: p.y + oy }))
    shapes.push(`<path d="${ringsToPath(placed)}" fill="#3a3f4a" stroke="none" />`)
    const sk = g.skeleton
    for (const c of sk.components) {
      if (!c.dot) continue
      shapes.push(`<circle cx="${n(c.center.x + ox)}" cy="${n(c.center.y + oy)}" r="${n(em * 0.06)}" fill="none" stroke="#f783ac" stroke-width="2" stroke-dasharray="5 4" />`)
    }
    for (const s of sk.strokes) {
      const d = `M${s.pts.map((p) => `${n(p.x + ox)} ${n(p.y + oy)}`).join('L')}`
      shapes.push(`<path d="${d}" fill="none" stroke="${STROKE_COLORS[s.type]}" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" />`)
    }
    for (const node of sk.nodes) {
      if (node.kind !== 'junction' || node.edges.length < 3) continue
      shapes.push(`<circle cx="${n(node.p.x + ox)}" cy="${n(node.p.y + oy)}" r="5" fill="#ffffff" />`)
    }
    for (const s of sk.strokes) {
      const mid = s.pts[Math.floor(s.pts.length / 2)]!
      shapes.push(`<rect x="${n(mid.x + ox - 19)}" y="${n(mid.y + oy - 12)}" width="38" height="24" rx="6" fill="#16181dcc" />`)
      shapes.push(label(mid.x + ox, mid.y + oy, `${s.type}${s.id + 1}`, STROKE_COLORS[s.type], 15))
    }
  })
}
