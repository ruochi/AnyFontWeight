/**
 * 批量对比多款中英文字体。
 *
 *   npx tsx scripts/batchCompare.ts [/tmp/fonts/ready]
 */
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { variableGlyph } from '../src/anyFontWeight.js'
import { EM_PER_100_WEIGHT } from '../src/reweight.js'
import type { Ring } from '../src/types.js'
import { openFont, type Font } from './glyphs.js'
import { inkArea, iou, rasterize, type Box } from './raster.js'

const DIR = process.argv[2] ?? '/tmp/fonts/ready'
const OUT = '/opt/cursor/artifacts/multi-font'
mkdirSync(OUT, { recursive: true })

const CN = '永国圆字黑波我三省'
const EN = 'AaBbGgHhOoRrSsWw'
const TUNED = { perHundred: 0.0085, k: 0.89, shrink: 0.007 }
const DEFAULT = { perHundred: EM_PER_100_WEIGHT, k: 1, shrink: 0 }

type Row = {
  file: string
  name: string
  kind: 'zh' | 'en' | 'both'
  axis?: { min: number; max: number }
  from: number
  scores: Record<number, { unchanged: number; def: number; tuned: number; areaDef: number; areaTuned: number }>
}

function detectKind(font: Font, file: string): 'zh' | 'en' | 'both' {
  const hasCn = font.has('永') && font.has('国')
  const hasEn = font.has('A') && font.has('g')
  if (hasCn && hasEn) return 'both'
  if (hasCn) return 'zh'
  if (!hasEn) console.warn(`${file}: 找不到常用测试字符`)
  return 'en'
}

function charsFor(kind: Row['kind']): string {
  if (kind === 'zh') return CN
  if (kind === 'en') return EN
  return CN + EN.slice(0, 8)
}

function measure(font: Font, chars: string, from: number, targets: number[]): Row['scores'] {
  const box: Box = { x: -font.upm * 0.15, y: -font.upm * 1.05, size: font.upm * 1.3 }
  const R = 280
  const scores: Row['scores'] = {}
  for (const w of targets) scores[w] = { unchanged: 0, def: 0, tuned: 0, areaDef: 0, areaTuned: 0 }
  let n = 0
  for (const ch of chars) {
    const src = font.at(from).rings(ch)
    if (src.length === 0) continue
    n++
    const baseMask = rasterize(src, box, R)
    const atDef = variableGlyph(src, { from, em: font.upm, ...DEFAULT })
    const atTuned = variableGlyph(src, { from, em: font.upm, ...TUNED })
    for (const w of targets) {
      const truth = rasterize(font.at(w).rings(ch), box, R)
      const genDef = rasterize(atDef(w), box, R)
      const genTuned = rasterize(atTuned(w), box, R)
      const s = scores[w]!
      s.unchanged += iou(baseMask, truth)
      s.def += iou(genDef, truth)
      s.tuned += iou(genTuned, truth)
      s.areaDef += inkArea(genDef) / Math.max(1, inkArea(truth))
      s.areaTuned += inkArea(genTuned) / Math.max(1, inkArea(truth))
    }
  }
  if (!n) return scores
  for (const w of targets) {
    const s = scores[w]!
    s.unchanged /= n
    s.def /= n
    s.tuned /= n
    s.areaDef /= n
    s.areaTuned /= n
  }
  return scores
}

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
  const size = Math.max(x1 - x0, y1 - y0, 1) * 1.1
  return { x: (x0 + x1) / 2 - size / 2, y: (y0 + y1) / 2 - size / 2, size }
}

function renderSheet(
  font: Font,
  label: string,
  chars: string,
  from: number,
  targets: number[],
  tuning: typeof DEFAULT,
  outPath: string,
  overlayTruth: boolean,
) {
  const sample = [...chars].slice(0, Math.min(8, chars.length))
  const rows = sample.map((ch) => {
    const at = variableGlyph(font.at(from).rings(ch), { from, em: font.upm, ...tuning })
    return targets.map((w) => ({ gen: at(w), truth: overlayTruth ? font.at(w).rings(ch) : undefined }))
  })
  const box = boundsBox(rows.flat().flatMap((c) => [...c.gen, ...(c.truth ?? [])]))
  const CELL = 120
  const HEAD = 36
  const width = CELL * targets.length
  const height = HEAD + CELL * rows.length + 22
  const svg: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="100%" height="100%" fill="#fff"/>`,
    `<text x="8" y="16" font-size="13" font-family="sans-serif" fill="#333">${label}</text>`,
  ]
  targets.forEach((w, j) => {
    const tag = w === from ? `${w} 原字` : `${w}`
    svg.push(
      `<text x="${j * CELL + CELL / 2}" y="34" font-size="12" text-anchor="middle" font-family="sans-serif" fill="#555">${tag}</text>`,
    )
  })
  rows.forEach((row, i) =>
    row.forEach((cell, j) => {
      const t = `translate(${j * CELL} ${HEAD + i * CELL}) scale(${CELL / box.size}) translate(${-box.x} ${-box.y})`
      svg.push(`<g transform="${t}">`)
      if (cell.truth) {
        svg.push(`<path d="${toPath(cell.truth)}" fill="#bbb" fill-rule="nonzero"/>`)
        svg.push(`<path d="${toPath(cell.gen)}" fill="none" stroke="#d22" stroke-width="${box.size / 220}"/>`)
      } else {
        svg.push(`<path d="${toPath(cell.gen)}" fill="${targets[j] === from ? '#246' : '#111'}" fill-rule="nonzero"/>`)
      }
      svg.push('</g>')
    }),
  )
  svg.push('</svg>')
  writeFileSync(outPath, new Resvg(svg.join('\n')).render().asPng())
}

const files = readdirSync(DIR)
  .filter((f) => /\.(ttf|otf)$/i.test(f))
  .sort()
const rows: Row[] = []
const summary: string[] = ['# 多字体字重合成对比', '', `字体目录: \`${DIR}\``, '']

for (const file of files) {
  const path = join(DIR, file)
  const font = openFont(path)
  const kind = detectKind(font, file)
  const chars = charsFor(kind)
  const from = font.axis ? Math.min(Math.max(400, font.axis.min), font.axis.max) : font.defaultWeight
  const name = basename(file).replace(/\.(ttf|otf)$/i, '')
  console.log(`→ ${name} (${kind}, from ${from}${font.axis ? `, wght ${font.axis.min}–${font.axis.max}` : ', 静态'})`)

  const targets = font.axis
    ? [300, 400, 500, 700, 800].filter((w) => w >= font.axis!.min && w <= font.axis!.max)
    : [Math.max(100, from - 400), Math.max(100, from - 200), from, Math.min(900, from + 200), Math.min(900, from + 400)].filter(
        (w, i, a) => a.indexOf(w) === i,
      )

  const row: Row = {
    file,
    name,
    kind,
    axis: font.axis,
    from,
    scores: font.axis ? measure(font, chars, from, targets.filter((w) => w !== from)) : {},
  }
  rows.push(row)

  const sheetChars = kind === 'en' ? EN : kind === 'zh' ? CN : CN.slice(0, 4) + EN.slice(0, 4)
  if (font.axis) {
    renderSheet(font, `${name} · 默认参数`, sheetChars, from, targets, DEFAULT, join(OUT, `${name}_default.png`), true)
    renderSheet(font, `${name} · 端黑实测参数`, sheetChars, from, targets, TUNED, join(OUT, `${name}_tuned.png`), true)
  } else {
    renderSheet(font, `${name} · 默认参数`, sheetChars, from, targets, DEFAULT, join(OUT, `${name}_synth.png`), false)
  }
}

summary.push('## 可变字体：从 400（或最接近的可用字重）生成，与真实字重对比', '')
summary.push('| 字体 | 目标 | 不动 | 默认 IoU | 实测 IoU | 默认面积比 | 实测面积比 |')
summary.push('| --- | --- | --- | --- | --- | --- | --- |')
for (const row of rows.filter((r) => r.axis)) {
  for (const [w, s] of Object.entries(row.scores).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    summary.push(
      `| ${row.name} | ${w} | ${s.unchanged.toFixed(3)} | ${s.def.toFixed(3)} | ${s.tuned.toFixed(3)} | ${s.areaDef.toFixed(3)} | ${s.areaTuned.toFixed(3)} |`,
    )
  }
}

summary.push('', '## 平均提升（相对原字不动）', '')
summary.push('| 字体 | 语言 | 默认 ΔIoU@700 | 实测 ΔIoU@700 | 默认面积@700 | 实测面积@700 |')
summary.push('| --- | --- | --- | --- | --- | --- |')
for (const row of rows.filter((r) => r.axis)) {
  const s = row.scores[700] ?? row.scores[800] ?? Object.values(row.scores)[0]
  if (!s) continue
  const w = row.scores[700] ? 700 : row.scores[800] ? 800 : Number(Object.keys(row.scores)[0])
  summary.push(
    `| ${row.name} | ${row.kind} | +${(s.def - s.unchanged).toFixed(3)} (@${w}) | +${(s.tuned - s.unchanged).toFixed(3)} | ${s.areaDef.toFixed(3)} | ${s.areaTuned.toFixed(3)} |`,
  )
}

summary.push('', '## 静态字体', '')
for (const row of rows.filter((r) => !r.axis)) {
  summary.push(`- **${row.name}**（${row.kind}，字重 ${row.from}）：已从该字重合成多档字重图`)
}

summary.push('', '## 参数说明', '')
summary.push(`- 默认：\`perHundred=${DEFAULT.perHundred}\`, \`k=${DEFAULT.k}\`, \`shrink=${DEFAULT.shrink}\``)
summary.push(`- 实测（来自寒蝉端黑）：\`perHundred=${TUNED.perHundred}\`, \`k=${TUNED.k}\`, \`shrink=${TUNED.shrink}\``)
summary.push('- 灰色 = 字体自带字重；红线 = 合成结果（仅可变字体）')

writeFileSync(join(OUT, 'SUMMARY.md'), summary.join('\n') + '\n')
console.log('\n' + summary.join('\n'))
console.log(`\n图片与摘要写入 ${OUT}`)
