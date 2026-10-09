import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { layerDoc, label, n, toPng } from './draw.js'
import { describeTerminals, loadGlyphs, type SourceOptions } from './glyphs.js'
import { mapRings, ringsToPath } from './outline.js'
import { recipeText, sourceOptions, type Recipe } from './recipe.js'

/**
 * 用法：
 *   npx tsx lab/deform/analyze.ts <配方.json>
 *   npx tsx lab/deform/analyze.ts <文字> [字体] [字重] [合成字重]
 * 输出 lab/out/<名字>.terminals.json 和标注图 .terminals.png。
 */
const args = process.argv.slice(2)
let text: string
let source: SourceOptions
let name: string
if (args[0]?.endsWith('.json')) {
  const recipe = JSON.parse(await readFile(args[0], 'utf8')) as Recipe
  text = recipeText(recipe)
  source = sourceOptions(recipe)
  name = basename(args[0]).replace(/\.json$/, '')
} else {
  const [t = '遥不可及的爱', font = 'NotoSans', weightArg = '700', synthArg] = args
  text = t
  source = { font, size: 400, weight: Number(weightArg), synthWeight: synthArg ? Number(synthArg) : undefined }
  name = `${text}-${font}${synthArg ? `-w${synthArg}` : ''}`
}
const size = source.size
const glyphs = await loadGlyphs(text, source)

const pad = 70
const gap = 30
const height = (glyphs[0]?.height ?? size) + pad * 2
let x = pad
const shapes: string[] = []
for (const g of glyphs) {
  const ox = x
  const oy = pad
  shapes.push(`<rect x="${n(ox)}" y="${n(oy)}" width="${n(g.advance)}" height="${n(g.height)}" fill="#ffffff08" />`)
  const placed = mapRings(g.rings, (p) => ({ x: p.x + ox, y: p.y + oy }))
  shapes.push(`<path d="${ringsToPath(placed)}" fill="#c9ccd3" stroke="none" />`)
  g.analysis.terminals.forEach((t, k) => {
    const free = t.free == null || t.free > size * 0.12
    const color = free ? '#ff4f8b' : '#5aa9ff'
    const from = { x: t.base.x + ox, y: t.base.y + oy }
    const to = { x: t.tip.x + ox + t.dir.x * size * 0.07, y: t.tip.y + oy + t.dir.y * size * 0.07 }
    shapes.push(`<line x1="${n(t.A.x + ox)}" y1="${n(t.A.y + oy)}" x2="${n(t.B.x + ox)}" y2="${n(t.B.y + oy)}" stroke="${color}" stroke-width="3" />`)
    shapes.push(`<line x1="${n(from.x)}" y1="${n(from.y)}" x2="${n(to.x)}" y2="${n(to.y)}" stroke="${color}" stroke-width="3" />`)
    const lx = to.x + t.dir.x * 16
    const ly = to.y + t.dir.y * 16
    shapes.push(`<circle cx="${n(lx)}" cy="${n(ly)}" r="15" fill="${color}" />`)
    shapes.push(label(lx, ly, String(k + 1), '#ffffff', 17))
  })
  shapes.push(label(ox + g.advance / 2, oy + g.height + 18, `${g.index}  ${g.char}`, '#8a8f99', 18))
  x += g.advance + gap
}

const outDir = join(process.cwd(), 'lab/out')
await mkdir(outDir, { recursive: true })
const doc = layerDoc(x - gap + pad, height + 20, '#16181d', shapes)
await writeFile(join(outDir, `${name}.terminals.png`), await toPng(doc))
const report = { text, ...source, glyphs: describeTerminals(glyphs, size) }
await writeFile(join(outDir, `${name}.terminals.json`), JSON.stringify(report, null, 1))
console.log(join(outDir, `${name}.terminals.png`))
