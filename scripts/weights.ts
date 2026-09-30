/**
 * 从字体里取几个字，用 anyfontweight 生成一组字重。
 *
 *   npm run weights -- <字体文件> [--chars 永国圆] [--from 400] [--to 300,500,700] [--out weights.png]
 *                                 [--per100 0.0085] [--k 0.89] [--shrink 0.007] [--cell 160]
 *
 * 可变字体会同时取出每个目标字重的真实轮廓：灰色是真实字重，红线是生成结果，并打印重合率和面积比。
 * 静态字体只画生成结果。
 */
import { writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { Resvg } from '@resvg/resvg-js'
import { variableGlyph } from '../src/anyFontWeight.js'
import { EM_PER_100_WEIGHT } from '../src/reweight.js'
import type { Ring } from '../src/types.js'
import { openFont } from './glyphs.js'
import { inkArea, iou, rasterize, type Box } from './raster.js'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    chars: { type: 'string', default: '永国圆字黑波我三' },
    from: { type: 'string' },
    to: { type: 'string' },
    out: { type: 'string', default: 'weights.png' },
    per100: { type: 'string' },
    k: { type: 'string' },
    shrink: { type: 'string' },
    cell: { type: 'string', default: '160' },
  },
})
const path = positionals[0]
if (!path) {
  console.error('用法: npm run weights -- <字体文件> [--chars 永国] [--from 400] [--to 300,500,700]')
  process.exit(1)
}

const font = openFont(path)
const from = Number(values.from ?? font.defaultWeight)
const targets = (values.to ?? '300,400,500,600,700,800,900')
  .split(',')
  .map(Number)
  .filter((w) => !font.axis || (w >= font.axis.min && w <= font.axis.max))
const chars = [...values.chars!]
const tuning = {
  perHundred: values.per100 ? Number(values.per100) : EM_PER_100_WEIGHT,
  k: values.k ? Number(values.k) : 1,
  shrink: values.shrink ? Number(values.shrink) : 0,
}

type Cell = { gen: Ring[]; truth?: Ring[] }
const rows: Cell[][] = chars.map((ch) => {
  const at = variableGlyph(font.at(from).rings(ch), { from, em: font.upm, ...tuning })
  return targets.map((w) => ({ gen: at(w), truth: font.axis ? font.at(w).rings(ch) : undefined }))
})

const box = boundsBox(rows.flat().flatMap((c) => [...c.gen, ...(c.truth ?? [])]))

if (font.axis) {
  const R = 400
  console.log(`从 ${from} 生成，每侧 ${tuning.perHundred} em/100 字重，横竖比 ${tuning.k}，收缩 ${tuning.shrink}/100 字重`)
  console.log('字重   重合率(生成)  重合率(不动)  面积比')
  targets.forEach((w, j) => {
    let a = 0
    let b = 0
    let ratio = 0
    rows.forEach((row, i) => {
      const truth = rasterize(row[j]!.truth!, box, R)
      const gen = rasterize(row[j]!.gen, box, R)
      a += iou(gen, truth)
      b += iou(rasterize(font.at(from).rings(chars[i]!), box, R), truth)
      ratio += inkArea(gen) / inkArea(truth)
    })
    const n = rows.length
    console.log(`${w}   ${(a / n).toFixed(3)}        ${(b / n).toFixed(3)}        ${(ratio / n).toFixed(3)}`)
  })
}

const CELL = Number(values.cell)
const HEAD = 28
const svg: string[] = []
const width = CELL * targets.length
const height = HEAD + CELL * rows.length
svg.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`)
svg.push(`<rect width="100%" height="100%" fill="#fff"/>`)
targets.forEach((w, j) => {
  const label = w === from ? `${w} 原字` : `${w}`
  svg.push(`<text x="${j * CELL + CELL / 2}" y="20" font-size="15" text-anchor="middle" font-family="sans-serif" fill="#444">${label}</text>`)
})
rows.forEach((row, i) =>
  row.forEach((cell, j) => {
    const t = `translate(${j * CELL} ${HEAD + i * CELL}) scale(${CELL / box.size}) translate(${-box.x} ${-box.y})`
    svg.push(`<g transform="${t}">`)
    if (cell.truth) {
      svg.push(`<path d="${toPath(cell.truth)}" fill="#bbb" fill-rule="nonzero"/>`)
      svg.push(`<path d="${toPath(cell.gen)}" fill="none" stroke="#d22" stroke-width="${box.size / 250}"/>`)
    } else {
      svg.push(`<path d="${toPath(cell.gen)}" fill="${targets[j] === from ? '#246' : '#111'}" fill-rule="nonzero"/>`)
    }
    svg.push('</g>')
  }),
)
svg.push('</svg>')
const out = values.out!
if (out.endsWith('.svg')) writeFileSync(out, svg.join('\n'))
else writeFileSync(out, new Resvg(svg.join('\n')).render().asPng())
console.log(`已写入 ${out}`)

function toPath(rings: Ring[]): string {
  return rings.map((r) => 'M' + r.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('L') + 'Z').join('')
}

function boundsBox(rings: Ring[]): Box {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const r of rings)
    for (const p of r) {
      x0 = Math.min(x0, p.x)
      y0 = Math.min(y0, p.y)
      x1 = Math.max(x1, p.x)
      y1 = Math.max(y1, p.y)
    }
  const size = Math.max(x1 - x0, y1 - y0) * 1.08
  return { x: (x0 + x1) / 2 - size / 2, y: (y0 + y1) / 2 - size / 2, size }
}
