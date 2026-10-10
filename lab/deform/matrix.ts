import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { BRUSHES } from './brushes.js'
import { esc, layerDoc, n, toPng } from './draw.js'
import { HANZI_FONT } from './glyphs.js'
import type { Step } from './ops.js'
import { mapRings, ringsBounds, ringsToPath } from './outline.js'
import { compose, type Recipe } from './recipe.js'

/**
 * 用法：npx tsx lab/deform/matrix.ts [文字，默认 永字八法] [笔刷，逗号分隔，默认全部] [输出路径]
 *
 * 同一副开源骨架，每列一种骨架变形，每行一种笔刷，拼成一张对照表。
 */
const text = process.argv[2] ?? '永字八法'
const brushNames = process.argv[3] ? process.argv[3].split(',') : Object.keys(BRUSHES)
const outPath = process.argv[4] ?? join(process.cwd(), `lab/out/${text}.matrix.png`)

export const DEFORMS: Array<{ name: string; steps: Step[] }> = [
  { name: '原样', steps: [] },
  { name: '规整', steps: [{ op: 'straighten' }] },
  { name: '圆转', steps: [{ op: 'straighten' }, { op: 'fillet', radius: 0.07 }] },
  { name: '抖动', steps: [{ op: 'jitter', amount: 0.01, wavelength: 0.18, seed: 2 }] },
  {
    name: '飞扬',
    steps: [
      { op: 'transform', select: { types: ['横'] }, rotate: -7 },
      { op: 'extend', select: { types: ['捺'] }, end: 0.14, curl: 0.7, curlRadius: 0.07, taper: 0.4 },
      { op: 'extend', select: { types: ['撇'] }, end: 0.08, bend: -25 },
    ],
  },
  { name: '连笔', steps: [{ op: 'connect', maxGap: 0.5, tension: 0.4 }] },
]

const em = 400
const CW = 380
const CH = 130
const LEFT = 170
const TOP = 50
const GAP = 14

const shapes: string[] = []
DEFORMS.forEach((d, j) => {
  shapes.push(
    `<layer x="${n(LEFT + j * (CW + GAP) + CW / 2)}" y="${TOP / 2}" anchor="center" color="#c9ccd3"><p style="font-size:22px; white-space:nowrap">${esc(d.name)}</p></layer>`,
  )
})
for (const [i, name] of brushNames.entries()) {
  const y = TOP + i * (CH + GAP)
  shapes.push(`<layer x="16" y="${n(y + CH / 2 - 26)}" color="#e6e6e6"><p style="font-size:22px; white-space:nowrap">${esc(name)}</p></layer>`)
  const note = BRUSHES[name]?.note ?? ''
  shapes.push(`<layer x="16" y="${n(y + CH / 2 + 4)}" width="${LEFT - 28}" color="#7d828c"><p style="font-size:12px; line-height:1.35">${esc(note)}</p></layer>`)
  for (const [j, d] of DEFORMS.entries()) {
    const recipe: Recipe = {
      lines: [text],
      font: HANZI_FONT,
      size: em,
      tracking: -0.04,
      steps: [{ op: 'skeleton' }, ...d.steps, { op: 'brush', preset: name }],
    }
    const c = await compose(recipe)
    const x = LEFT + j * (CW + GAP)
    shapes.push(`<rect x="${n(x)}" y="${n(y)}" width="${CW}" height="${CH}" fill="#f1ece2" />`)
    if (!c.rings.length) continue
    const b = ringsBounds(c.rings)
    const k = Math.min((CW - 24) / (b.maxX - b.minX), (CH - 20) / (b.maxY - b.minY))
    const ox = x + (CW - (b.maxX - b.minX) * k) / 2
    const oy = y + (CH - (b.maxY - b.minY) * k) / 2
    const placed = mapRings(c.rings, (p) => ({ x: ox + (p.x - b.minX) * k, y: oy + (p.y - b.minY) * k }))
    shapes.push(`<path d="${ringsToPath(placed)}" fill="#1b1b1b" stroke="none" />`)
  }
  console.log(name)
}

const W = LEFT + DEFORMS.length * (CW + GAP)
const H = TOP + brushNames.length * (CH + GAP)
await mkdir(dirname(outPath), { recursive: true })
await writeFile(outPath, await toPng(layerDoc(W, H, '#16181d', shapes), 1))
console.log(outPath)
