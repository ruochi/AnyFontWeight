import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { toPng } from './draw.js'
import { describeSkeleton, describeTerminals } from './glyphs.js'
import { analysisOf, ensureRings, namesTerminals, runSteps, skeletonOf, strokesOf } from './ops.js'
import { glyphWorks, recipeSteps, recipeText, sourceOptions, type Recipe } from './recipe.js'
import { describeStrokes } from './strokes.js'
import { skeletonSheet, strokeSheet, terminalSheet } from './views.js'

/**
 * 用法：
 *   npx tsx lab/deform/analyze.ts <配方.json>
 *   npx tsx lab/deform/analyze.ts <文字> [字体] [字重] [合成字重]
 * 输出 lab/out/<名字>.terminals.png（末端）、.skeleton.png（自动骨架）、.strokes.png（骨架字形，带笔顺）和清单 .analysis.json。
 * 配方会先执行到第一个按编号点名末端的步骤之前，清单里的编号就是那一步看到的编号。
 */
const args = process.argv.slice(2)
let recipe: Recipe
let name: string
if (args[0]?.endsWith('.json')) {
  recipe = JSON.parse(await readFile(args[0], 'utf8')) as Recipe
  name = basename(args[0]).replace(/\.json$/, '')
} else {
  const [t = '遥不可及的爱', font = 'NotoSans', weightArg = '700', synthArg] = args
  recipe = { lines: [t], font, weight: Number(weightArg), synthWeight: synthArg ? Number(synthArg) : undefined }
  name = `${t}-${font}-${weightArg}${synthArg ? `-w${synthArg}` : ''}`
}
const source = sourceOptions(recipe)
const em = source.size
const { works, ctx, baseline } = await glyphWorks(recipe, { hanzi: true })
const steps = recipeSteps(recipe)
const stop = steps.findIndex(namesTerminals)
for (const w of works) runSteps(w, stop < 0 ? steps : steps.slice(0, stop), ctx)
// 骨架字形保留执行到这里时的状态；末端和自动骨架看的是画回去的轮廓
const strokeGlyphs = works.map((w) => {
  const had = !!w.strokes
  const sg = strokesOf(w, ctx)
  if (!had) w.strokes = undefined
  return sg
})
for (const w of works) ensureRings(w)

const glyphs = works.map((w) => ({
  index: w.index,
  char: w.char,
  advance: w.box.w,
  height: w.box.h,
  baseline,
  rings: w.rings,
  analysis: analysisOf(w),
}))
const sheets = glyphs.map((g, i) => ({ ...g, terminals: g.analysis.terminals, skeleton: skeletonOf(works[i]!) }))

const outDir = join(process.cwd(), 'lab/out')
await mkdir(outDir, { recursive: true })
await writeFile(join(outDir, `${name}.terminals.png`), await toPng(terminalSheet(sheets, em)))
await writeFile(join(outDir, `${name}.skeleton.png`), await toPng(skeletonSheet(sheets, em)))
await writeFile(join(outDir, `${name}.strokes.png`), await toPng(strokeSheet(sheets.map((g, i) => ({ ...g, strokes: strokeGlyphs[i]! })), em)))
const report = {
  text: recipeText(recipe),
  ...source,
  stoppedBefore: stop < 0 ? null : stop,
  terminals: describeTerminals(glyphs, em),
  skeleton: sheets.map((g) => describeSkeleton(g, g.skeleton, em)),
  strokes: sheets.map((g, i) => describeStrokes(g, strokeGlyphs[i]!, em)),
}
await writeFile(join(outDir, `${name}.analysis.json`), JSON.stringify(report, null, 1))
console.log(join(outDir, `${name}.skeleton.png`))
