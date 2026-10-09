import { createCanvas, loadImage, Path2D } from '@napi-rs/canvas'
import { glyph } from 'flexlayer'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { toPng } from './draw.js'
import { pathToRings, ringsToPath } from './outline.js'
import { compose, toDocuments, type Recipe } from './recipe.js'

/**
 * 用法：npx tsx lab/deform/gallery.ts [输出路径，默认 lab/out/gallery.png]
 * 渲染 lab/recipes 下全部配方，拼成一张两列的总览图，每格下面写配方名和用到的操作。
 */
const outPath = process.argv[2] ?? join(process.cwd(), 'lab/out/gallery.png')
const dir = join(process.cwd(), 'lab/recipes')
const files = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort()

const CELL_W = 900
const CELL_H = 420
const CAPTION = 64
const GAP = 24
const COLS = 2

async function caption(text: string, size: number): Promise<{ d: string; width: number }> {
  const gs = await glyph(text, { font: 'NotoSans', size, weight: 400 })
  let x = 0
  const parts: string[] = []
  for (const g of gs) {
    const rings = pathToRings(g.d, size * 0.002).map((r) => r.map((p) => ({ x: p.x + x, y: p.y })))
    parts.push(ringsToPath(rings))
    x += g.width
  }
  return { d: parts.join(''), width: x }
}

function opsOf(r: Recipe): string {
  const ops = [...(r.swashes?.length ? ['swash'] : []), ...(r.steps ?? []).map((s) => s.op), ...(r.post ?? []).map((s) => `post:${s.op}`)]
  if (r.skew) ops.push('skew')
  if (r.contrast) ops.push('contrast')
  return ops.join(' · ')
}

const rows = Math.ceil(files.length / COLS)
const W = COLS * CELL_W + (COLS + 1) * GAP
const H = rows * (CELL_H + CAPTION) + (rows + 1) * GAP
const canvas = createCanvas(W, H)
const ctx = canvas.getContext('2d')
ctx.fillStyle = '#101114'
ctx.fillRect(0, 0, W, H)

for (const [i, file] of files.entries()) {
  const recipe = JSON.parse(await readFile(join(dir, file), 'utf8')) as Recipe
  const { layer } = toDocuments(recipe, await compose(recipe))
  const img = await loadImage(await toPng(layer, 0.5))
  const col = i % COLS
  const row = Math.floor(i / COLS)
  const x = GAP + col * (CELL_W + GAP)
  const y = GAP + row * (CELL_H + CAPTION + GAP)
  const k = Math.min(CELL_W / img.width, CELL_H / img.height)
  const w = img.width * k
  const h = img.height * k
  ctx.fillStyle = '#1b1d22'
  ctx.fillRect(x, y, CELL_W, CELL_H)
  ctx.drawImage(img, x + (CELL_W - w) / 2, y + (CELL_H - h) / 2, w, h)
  const name = await caption(file.replace(/\.json$/, ''), 30)
  ctx.save()
  ctx.translate(x, y + CELL_H + 4)
  ctx.fillStyle = '#e6e6e6'
  ctx.fill(new Path2D(name.d))
  ctx.restore()
  ctx.font = '20px sans-serif'
  ctx.fillStyle = '#8a8f99'
  ctx.textBaseline = 'middle'
  ctx.fillText(opsOf(recipe), x + name.width + 18, y + CELL_H + 30)
  console.log(file)
}

await mkdir(dirname(outPath), { recursive: true })
await writeFile(outPath, canvas.toBuffer('image/png'))
console.log(outPath)
