import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Point } from '../../src/types.js'
import { union } from './bool.js'
import { BRUSHES } from './brushes.js'
import { esc, layerDoc, n, toPng } from './draw.js'
import { HANZI_FONT } from './glyphs.js'
import type { Step } from './ops.js'
import { mapRings, ringsBounds, ringsToPath } from './outline.js'
import { footprintPrints, footprintStroke, type Footprint } from './pen.js'
import { compose, type Recipe } from './recipe.js'

/**
 * 用法：npx tsx lab/deform/pens.ts [文字，默认 永国东书心] [输出路径]
 *
 * 形状笔尖对照：每行一支笔，左边是笔尖沿一个横折走的示意，右边两格是同一支笔画在两种骨架上：
 * 规整后的开源骨架、配准到 NotoSans 的骨架。最后几行是真实字体，用来对照。
 */
const text = process.argv[2] ?? '永国东书心'
const outPath = process.argv[3] ?? join(process.cwd(), `lab/out/${text}.pens.png`)

const PENS = ['圆笔', '方笔随转', '方笔不转', '斜切黑', '横扁笔', '宋体笔', '魏碑笔']
const REFS: Array<{ name: string; note: string; font: string; weight: number }> = [
  { name: '黑体', note: 'NotoSans 400', font: 'NotoSans', weight: 400 },
  { name: '宋体', note: '思源宋体 400', font: 'Song', weight: 400 },
  { name: '楷体', note: '霞鹜文楷 400', font: 'Kai', weight: 400 },
]
const SKELETONS: Array<{ name: string; font: string; steps: Step[] }> = [
  { name: '开源骨架（规整）', font: HANZI_FONT, steps: [{ op: 'skeleton' }, { op: 'straighten' }] },
  { name: '配准到黑体的骨架', font: 'NotoSans', steps: [{ op: 'skeleton', source: 'hybrid' }] },
]
const RAW_FOR = new Set(['魏碑笔'])

const em = 400
const LEFT = 250
const DIAGRAM = 150
const CW = 640
const CH = 150
const TOP = 56
const GAP = 14
const PAPER = '#f3eee4'
const INK = '#1d1d1d'

const shapes: string[] = []

function title(x: number, y: number, s: string, size: number, color: string, anchor = 'center') {
  shapes.push(`<layer x="${n(x)}" y="${n(y)}" anchor="${anchor}" color="${color}"><p style="font-size:${size}px; font-weight:650; white-space:nowrap">${esc(s)}</p></layer>`)
}

function place(rings: ReturnType<typeof union>, x: number, y: number, w: number, h: number, fill: string, pad = 16) {
  if (!rings.length) return
  const b = ringsBounds(rings)
  const k = Math.min((w - pad * 2) / (b.maxX - b.minX), (h - pad * 2) / (b.maxY - b.minY))
  const ox = x + (w - (b.maxX - b.minX) * k) / 2
  const oy = y + (h - (b.maxY - b.minY) * k) / 2
  shapes.push(`<path d="${ringsToPath(mapRings(rings, (p) => ({ x: ox + (p.x - b.minX) * k, y: oy + (p.y - b.minY) * k })))}" fill="${fill}" stroke="none" />`)
}

/** 笔尖沿一个横折走：先画扫出来的形状，再每隔几个点描一个笔尖印。 */
function diagram(fp: Footprint, x: number, y: number) {
  const E = 100
  const pts: Point[] = []
  for (let i = 0; i <= 50; i++) pts.push({ x: 20 + i * 1.2, y: 30 })
  for (let i = 1; i <= 45; i++) pts.push({ x: 80, y: 30 + i * 1.2 })
  const ks = pts.map(() => 1)
  const cuts = [50]
  const ink = union(footprintStroke(pts, ks, '折', cuts, fp, E))
  const prints = footprintPrints(pts, ks, '折', cuts, fp, E)
  const b = ringsBounds([...ink, ...prints])
  const box = DIAGRAM - 20
  const k = Math.min(box / (b.maxX - b.minX), box / (b.maxY - b.minY))
  const ox = x + (DIAGRAM - (b.maxX - b.minX) * k) / 2
  const oy = y + (DIAGRAM - (b.maxY - b.minY) * k) / 2
  const f = (p: Point) => ({ x: ox + (p.x - b.minX) * k, y: oy + (p.y - b.minY) * k })
  shapes.push(`<rect x="${n(x)}" y="${n(y)}" width="${DIAGRAM}" height="${DIAGRAM}" fill="#fffdf8" />`)
  shapes.push(`<path d="${ringsToPath(mapRings(ink, f))}" fill="#d9cfbe" stroke="none" />`)
  const every = [0, 12, 25, 38, 46, 50, 51, 60, 72, 84, prints.length - 1]
  for (const i of every) {
    const pr = prints[i]
    if (!pr) continue
    shapes.push(`<path d="${ringsToPath([pr.map(f)])}" fill="none" stroke="#c0392b" stroke-width="1.6" />`)
  }
  const line = pts.map(f)
  shapes.push(`<path d="M${line.map((p) => `${n(p.x)} ${n(p.y)}`).join('L')}" fill="none" stroke="#2b2b2b" stroke-width="1" stroke-dasharray="3 3" />`)
}

SKELETONS.forEach((s, j) => title(LEFT + DIAGRAM + GAP + j * (CW + GAP) + CW / 2, TOP / 2, s.name, 20, '#c9ccd3'))
title(LEFT + DIAGRAM / 2, TOP / 2, '笔尖走横折', 16, '#8a8f99')

let y = TOP
for (const name of PENS) {
  const preset = BRUSHES[name]!
  title(16, y + 34, name, 22, '#f0f0f0', 'start')
  shapes.push(`<layer x="16" y="${n(y + 64)}" width="${LEFT - 30}" color="#8a8f99"><p style="font-size:12px; line-height:1.4">${esc(preset.note)}</p></layer>`)
  diagram(preset.footprint!, LEFT, y)
  for (const [j, sk] of SKELETONS.entries()) {
    const steps = RAW_FOR.has(name) && sk.font === HANZI_FONT ? [{ op: 'skeleton' } as Step] : sk.steps
    const r: Recipe = { lines: [text], font: sk.font, weight: 400, size: em, tracking: 0.02, steps: [...steps, { op: 'brush', preset: name }] }
    const c = await compose(r)
    const x = LEFT + DIAGRAM + GAP + j * (CW + GAP)
    shapes.push(`<rect x="${n(x)}" y="${n(y)}" width="${CW}" height="${CH}" fill="${PAPER}" />`)
    place(c.rings, x, y, CW, CH, INK)
  }
  console.log(name)
  y += CH + GAP
}

y += 18
title(16, y - 2, '真实字体', 18, '#8a8f99', 'start')
y += 18
for (const ref of REFS) {
  title(16, y + 34, ref.name, 22, '#f0f0f0', 'start')
  title(16, y + 64, ref.note, 12, '#8a8f99', 'start')
  const c = await compose({ lines: [text], font: ref.font, weight: ref.weight, size: em, tracking: 0.02, steps: [] })
  const x = LEFT + DIAGRAM + GAP
  shapes.push(`<rect x="${n(x)}" y="${n(y)}" width="${CW}" height="${CH}" fill="${PAPER}" />`)
  place(c.rings, x, y, CW, CH, INK)
  y += CH + GAP
}

const W = LEFT + DIAGRAM + GAP + SKELETONS.length * (CW + GAP)
await mkdir(dirname(outPath), { recursive: true })
await writeFile(outPath, await toPng(layerDoc(W, y, '#16181d', shapes), 1))
console.log(outPath)
