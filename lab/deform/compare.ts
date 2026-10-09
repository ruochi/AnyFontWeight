import { createCanvas, loadImage } from '@napi-rs/canvas'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { toPng } from './draw.js'
import { loadGlyphs } from './glyphs.js'
import { loadHanzi } from './hanzi.js'
import { buildSkeleton } from './skeleton.js'
import { fromHanzi, fromSkeleton, hybrid, type StrokeSource } from './strokes.js'
import { strokeSheet } from './views.js'

/**
 * 用法：npx tsx lab/deform/compare.ts 海棠未雨 [字体 NotoSans] [字重 400] [输出路径]
 * 同一段字用三种骨架来源各画一行笔画图，上下叠成一张，方便比较。
 */
const [text = '海棠未雨', font = 'NotoSans', weight = '400'] = process.argv.slice(2)
const outPath = process.argv[5] ?? join(process.cwd(), `lab/out/${text}-${font}-${weight}.compare.png`)
const em = 400
const gs = await loadGlyphs(text, { font, size: em, weight: Number(weight) })
const prepared = await Promise.all(gs.map(async (g) => ({ g, sk: buildSkeleton(g.rings, em), data: await loadHanzi(g.char) })))

const images = []
for (const source of ['auto', 'hanzi', 'hybrid'] as StrokeSource[]) {
  const rows = prepared.map(({ g, sk, data }) => ({
    ...g,
    strokes: source === 'auto' || !data ? fromSkeleton(sk, em) : source === 'hanzi' ? fromHanzi(data, g.rings, em) : hybrid(data, g.rings, sk, em),
  }))
  images.push(await loadImage(await toPng(strokeSheet(rows, em), 0.6)))
}

const W = Math.max(...images.map((i) => i.width))
const H = images.reduce((s, i) => s + i.height, 0)
const canvas = createCanvas(W, H)
const ctx = canvas.getContext('2d')
let y = 0
for (const img of images) {
  ctx.drawImage(img, 0, y)
  y += img.height
}
await mkdir(dirname(outPath), { recursive: true })
await writeFile(outPath, canvas.toBuffer('image/png'))
console.log(outPath)
