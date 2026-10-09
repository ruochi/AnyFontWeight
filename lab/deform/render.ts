import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { toPng } from './draw.js'
import { compose, toDocuments, type Recipe } from './recipe.js'

/** 用法：npx tsx lab/deform/render.ts <配方.json> [输出名] */
const [file, nameArg] = process.argv.slice(2)
if (!file) throw new Error('要给一个配方文件')
const recipe = JSON.parse(await readFile(file, 'utf8')) as Recipe
const name = nameArg ?? basename(file).replace(/\.json$/, '')
const outDir = join(process.cwd(), 'lab/out')
await mkdir(outDir, { recursive: true })
const t0 = Date.now()
const comp = await compose(recipe)
const { layer, svg } = toDocuments(recipe, comp)
await writeFile(join(outDir, `${name}.layer`), layer)
await writeFile(join(outDir, `${name}.svg`), svg)
await writeFile(join(outDir, `${name}.png`), await toPng(layer, 0.5))
console.log(`${join(outDir, `${name}.png`)}  ${Date.now() - t0}ms`)
