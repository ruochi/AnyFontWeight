import { createCanvas, loadImage } from '@napi-rs/canvas'
import { glyph, renderLayer } from 'flexlayer'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Point, Ring } from '../../src/types.js'
import { difference, intersect, offset, union } from './bool.js'
import { esc, label, layerDoc, n, toPng } from './draw.js'
import { HANZI_FONT } from './glyphs.js'
import { STROKE_OPS, strokesOf, type Step } from './ops.js'
import { mapRings, pathToRings, ringsBounds, ringsToPath } from './outline.js'
import { compose, glyphWorks, recipeSteps, toDocuments, type Bounds, type Recipe, type Trace } from './recipe.js'
import { polyLength } from './skeleton.js'
import { brush } from './skelops.js'
import { inkTest, tangents, type SStroke, type StrokeSource } from './strokes.js'
import { STROKE_COLORS } from './views.js'

/**
 * 用法：npx tsx lab/deform/review.ts <配方.json> [--ref Kai] [--glyphs 0,2] [--set steps.3.width=0.02,0.03,0.05]
 *
 * 审阅一份配方，同时给出两样东西：
 * - 终端里的逐字指标和问题清单（带编号和位置），不用看图就知道哪里坏了；
 * - 一张大图 `<名字>.review.png`，每个字一行：骨架（实际画的中心线和笔顺）、结果、和原字的差异、参照字体。
 *   问题在差异图上用编号圈出来，和终端里的编号对应。
 * `--set` 给一个参数多个取值时，改为渲染一张对比图 `<名字>.sweep.png`，每格下面写问题数。
 */

type Issue = { glyph: number; kind: string; at: Point; detail: string }
type GlyphReport = {
  index: number
  char: string
  fidelity?: number
  kept: number
  spill: number
  issues: Issue[]
}

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--') && !isFlagValue(a))
if (!file) {
  console.error('用法：npx tsx lab/deform/review.ts <配方.json> [--ref Kai] [--glyphs 0,2] [--set steps.3.width=0.02,0.03]')
  process.exit(1)
}
function flag(name: string): string | undefined {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
function isFlagValue(a: string): boolean {
  const i = args.indexOf(a)
  return i > 0 && args[i - 1]!.startsWith('--')
}

const name = basename(file).replace(/\.json$/, '')
const outDir = join(process.cwd(), 'lab/out')
const base = JSON.parse(await readFile(file, 'utf8')) as Recipe
const em = base.size ?? 400
const only = flag('glyphs')?.split(',').map(Number)
const ref = flag('ref')
const set = flag('set')

const area = (rings: Ring[]) =>
  Math.abs(
    rings.reduce((s, r) => {
      let a = 0
      for (let i = 0; i < r.length; i++) {
        const p = r[i]!
        const q = r[(i + 1) % r.length]!
        a += p.x * q.y - q.x * p.y
      }
      return s + a / 2
    }, 0),
  )

/** 并集后的各个连通块（外环加它包住的洞）。 */
function pieces(rings: Ring[]): Ring[][] {
  const u = union(rings)
  if (!u.length) return []
  const signed = (r: Ring) => r.reduce((s, p, i) => s + p.x * r[(i + 1) % r.length]!.y - r[(i + 1) % r.length]!.x * p.y, 0)
  const largest = u.reduce((best, r) => (Math.abs(signed(r)) > Math.abs(signed(best)) ? r : best))
  const outerSign = Math.sign(signed(largest))
  const outers = u.filter((r) => Math.sign(signed(r)) === outerSign)
  const holes = u.filter((r) => Math.sign(signed(r)) !== outerSign)
  return outers.map((o) => {
    const inside = inkTest([o])
    return [o, ...holes.filter((h) => inside(h[0]!))]
  })
}

const centroid = (rings: Ring[]): Point => {
  const b = ringsBounds(rings)
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }
}

function rect(b: Bounds, pad: number): Ring {
  return [
    { x: b.minX - pad, y: b.minY - pad },
    { x: b.maxX + pad, y: b.minY - pad },
    { x: b.maxX + pad, y: b.maxY + pad },
    { x: b.minX - pad, y: b.maxY + pad },
  ]
}

function turning(pts: Point[]): number {
  const t = tangents(pts, 2)
  let sum = 0
  for (let i = 1; i < t.length; i++) sum += Math.abs(Math.atan2(t[i - 1]!.x * t[i]!.y - t[i - 1]!.y * t[i]!.x, t[i - 1]!.x * t[i]!.x + t[i - 1]!.y * t[i]!.y))
  return (sum * 180) / Math.PI
}

function distToStroke(p: Point, s: SStroke): { d: number; w: number } {
  let best = Infinity
  let w = s.width[0] ?? 0
  for (let i = 1; i < s.pts.length; i++) {
    const a = s.pts[i - 1]!
    const b = s.pts[i]!
    const dx = b.x - a.x
    const dy = b.y - a.y
    const l2 = dx * dx + dy * dy || 1
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2))
    const d = Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y)
    if (d < best) {
      best = d
      w = s.width[i - 1]! + (s.width[i]! - s.width[i - 1]!) * t
    }
  }
  return { d: best, w }
}

/** 牵丝：穿过别的笔画、绕圈。 */
function linkIssues(gi: number, strokes: SStroke[]): Issue[] {
  const issues: Issue[] = []
  const real = strokes.filter((s) => !s.link)
  for (const l of strokes.filter((s) => s.link)) {
    const from = l.start.kind === 'joint' ? l.start.stroke : -1
    const to = l.end.kind === 'joint' ? l.end.stroke : -1
    const total = polyLength(l.pts)
    let acc = 0
    let hit: Point | null = null
    let hitStroke = 0
    for (let i = 0; i < l.pts.length; i++) {
      if (i > 0) acc += Math.hypot(l.pts[i]!.x - l.pts[i - 1]!.x, l.pts[i]!.y - l.pts[i - 1]!.y)
      if (acc < em * 0.06 || total - acc < em * 0.06) continue
      for (const s of real) {
        if ((s.id === from || s.id === to) && s.glyph === l.glyph) continue
        const { d, w } = distToStroke(l.pts[i]!, s)
        if (d < w / 2) {
          hit = l.pts[i]!
          hitStroke = s.id
          break
        }
      }
      if (hit) break
    }
    if (hit) issues.push({ glyph: gi, kind: '牵丝穿笔', at: hit, detail: `${from}→${to} 的牵丝压过第 ${hitStroke} 笔` })
    const turn = turning(l.pts)
    if (turn > 220) issues.push({ glyph: gi, kind: '牵丝绕圈', at: l.pts[Math.floor(l.pts.length / 2)]!, detail: `${from}→${to} 转了 ${Math.round(turn)}°` })
  }
  return issues
}

function sourceOf(r: Recipe): StrokeSource | null {
  const all: Step[] = [...recipeSteps(r), ...(r.post ?? [])]
  if (!all.some((s) => STROKE_OPS.has(s.op))) return null
  const sk = all.find((s) => s.op === 'skeleton') as { source?: StrokeSource } | undefined
  return sk?.source ?? (r.font === HANZI_FONT ? 'hanzi' : 'hybrid')
}

type Affine = (p: Point) => Point

/** 骨架保真：按字体原宽画回去，和原字比。漏掉的墨、跑出去的墨、偏离墨迹的笔画都报出来。 */
async function fidelity(r: Recipe, source: StrokeSource, places: Affine[]) {
  const { works, ctx } = await glyphWorks(r, { hanzi: source !== 'auto' })
  return works.map((w, i) => {
    const sg = strokesOf({ ...w, strokes: undefined, cache: { ...w.cache } }, ctx, source)
    const drawn = brush(sg, { width: 'source', fit: false }, em)
    const orig = union(w.rings)
    const inter = area(intersect(orig, drawn))
    const uni = area(union(orig, drawn))
    const issues: Issue[] = []
    const place = places[i]!
    const minArea = (em * 0.035) ** 2
    for (const p of pieces(difference(orig, offset(drawn, em * 0.012)))) {
      const a = area(p)
      if (a > minArea) issues.push({ glyph: w.index, kind: '骨架漏墨', at: place(centroid(p)), detail: `${(a / em / em).toFixed(4)} em² 的墨没有骨架经过` })
    }
    const inside = inkTest(offset(orig, em * 0.01))
    for (const s of sg.strokes) {
      const on = s.pts.filter(inside).length / s.pts.length
      if (on < 0.85) {
        const off = s.pts.find((p) => !inside(p)) ?? s.pts[0]!
        issues.push({ glyph: w.index, kind: '笔画离墨', at: place(off), detail: `第 ${s.id} 笔（${s.type}）只有 ${Math.round(on * 100)}% 在墨迹里` })
      }
    }
    return { fidelity: uni ? inter / uni : 1, issues }
  })
}

async function refRings(char: string, font: string, target: Ring[]): Promise<Ring[]> {
  const [g] = await glyph(char, { font, size: em })
  if (!g || g.missing) return []
  const rings = pathToRings(g.d, em * 0.002)
  if (!rings.length || !target.length) return []
  const a = ringsBounds(rings)
  const b = ringsBounds(target)
  const k = Math.min((b.maxX - b.minX) / (a.maxX - a.minX || 1), (b.maxY - b.minY) / (a.maxY - a.minY || 1))
  const ca = { x: (a.minX + a.maxX) / 2, y: (a.minY + a.maxY) / 2 }
  const cb = { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2 }
  return mapRings(rings, (p) => ({ x: cb.x + (p.x - ca.x) * k, y: cb.y + (p.y - ca.y) * k }))
}

/** 审阅窗口：原字墨迹外扩一圈。 */
const windowOf = (g: Trace['glyphs'][number]) => rect(ringsBounds(g.orig), em * 0.12)

/** 这个字自己的结果；整段操作之后只能按窗口裁出来，会带进邻字伸过来的部分。 */
const own = (g: Trace['glyphs'][number], all: Ring[]) => g.rings ?? intersect(all, [windowOf(g)])

function placesOf(trace: Trace): Affine[] {
  return trace.glyphs.map((g) => {
    const [a, b, c] = g.affine
    return (p: Point) => ({ x: a!.x + (b!.x - a!.x) * p.x + (c!.x - a!.x) * p.y, y: a!.y + (b!.y - a!.y) * p.x + (c!.y - a!.y) * p.y })
  })
}

async function review(r: Recipe) {
  const c = await compose(r, { trace: true })
  const trace = c.trace!
  const source = sourceOf(r)
  const fid = source ? await fidelity(r, source, placesOf(trace)) : null
  const reports: GlyphReport[] = trace.glyphs.map((g, i) => {
    const fin = own(g, c.rings)
    const orig = union(g.orig)
    const oa = area(orig) || 1
    const issues: Issue[] = [...(fid?.[i]?.issues ?? []), ...linkIssues(g.index, g.strokes)]
    if (g.rings)
      for (const p of pieces(fin)) {
        const a = area(p)
        if (a < (em * 0.015) ** 2) issues.push({ glyph: g.index, kind: '碎块', at: centroid(p), detail: `${(a / em / em).toFixed(5)} em² 的孤立小块` })
      }
    return {
      index: g.index,
      char: g.char,
      fidelity: fid?.[i]?.fidelity,
      kept: area(intersect(fin, orig)) / oa,
      spill: area(difference(fin, orig)) / oa,
      issues,
    }
  })
  const { layer } = toDocuments(r, c)
  const { report } = await renderLayer(layer, { scale: 0.25 })
  const layerIssues = report.issues.filter((i) => i.level !== 'info')
  return { c, trace, reports, layer, layerIssues }
}

const BG = '#16181d'
const CELL = 340

function cellDoc(
  trace: Trace,
  rings: Ring[],
  reports: GlyphReport[],
  refs: Ring[][] | null,
  fill: string,
): { doc: string; numbered: Array<Issue & { no: number }> } {
  const cols = ['骨架', '结果', '差异', ...(refs ? [`参照 ${ref}`] : [])]
  const rows = trace.glyphs.filter((g) => !only || only.includes(g.index))
  const head = 40
  const pad = 20
  const shapes: string[] = []
  const numbered: Array<Issue & { no: number }> = []
  let no = 1
  cols.forEach((t, j) => shapes.push(label(pad + j * (CELL + pad) + CELL / 2, head / 2 + 4, t, '#8a8f99', 18)))
  rows.forEach((g, ri) => {
    const rep = reports.find((x) => x.index === g.index)!
    const win = windowOf(g)
    const wb = ringsBounds([win])
    const k = CELL / Math.max(wb.maxX - wb.minX, wb.maxY - wb.minY)
    const oy = head + ri * (CELL + pad + 30)
    const at = (j: number) => (p: Point): Point => ({ x: pad + j * (CELL + pad) + (p.x - wb.minX) * k, y: oy + (p.y - wb.minY) * k })
    const clip = (rs: Ring[]) => intersect(rs, [win])
    const path = (rs: Ring[], j: number, color: string) => {
      const m = mapRings(clip(rs), at(j))
      return m.length ? `<path d="${ringsToPath(m)}" fill="${color}" stroke="none" />` : ''
    }
    for (let j = 0; j < cols.length; j++) shapes.push(`<rect x="${n(pad + j * (CELL + pad))}" y="${n(oy)}" width="${CELL}" height="${CELL}" fill="#1f2228" />`)

    shapes.push(path(g.orig, 0, '#343a46'))
    const toCell = at(0)
    for (const s of g.strokes) {
      const pts = s.pts.map(toCell)
      if (pts.length < 2) continue
      const color = s.link ? '#ffffff' : STROKE_COLORS[s.type]
      shapes.push(`<path d="M${pts.map((p) => `${n(p.x)} ${n(p.y)}`).join('L')}" fill="none" stroke="${color}" stroke-width="${s.link ? 1.5 : 2.5}" ${s.link ? 'stroke-dasharray="5 4"' : ''} stroke-linecap="round" />`)
      if (!s.link) {
        shapes.push(`<circle cx="${n(pts[0]!.x)}" cy="${n(pts[0]!.y)}" r="8" fill="${color}" />`)
        shapes.push(label(pts[0]!.x, pts[0]!.y + 1, String(s.id), '#16181d', 11))
      }
    }

    const fin = clip(own(g, rings))
    shapes.push(path(fin, 1, fill))

    const orig = union(g.orig)
    shapes.push(path(intersect(fin, orig), 2, '#8f96a3'))
    shapes.push(path(difference(orig, fin), 2, '#2f6db5'))
    shapes.push(path(difference(fin, orig), 2, '#e8590c'))
    for (const is of rep.issues) {
      const p = at(2)(is.at)
      numbered.push({ ...is, no })
      shapes.push(`<circle cx="${n(p.x)}" cy="${n(p.y)}" r="13" fill="none" stroke="#ff2bd6" stroke-width="2.5" />`)
      shapes.push(label(p.x + 17, p.y - 13, String(no), '#ff2bd6', 15))
      no++
    }

    if (refs) shapes.push(path(refs[trace.glyphs.indexOf(g)]!, 3, '#d8d2c4'))

    const stats = [
      `${g.index} ${g.char}`,
      rep.fidelity != null ? `骨架保真 ${rep.fidelity.toFixed(2)}` : '',
      `保留 ${rep.kept.toFixed(2)}`,
      `溢出 ${rep.spill.toFixed(2)}`,
      `问题 ${rep.issues.length}`,
    ].filter(Boolean)
    shapes.push(`<layer x="${pad}" y="${n(oy + CELL + 4)}" color="#c9ccd3"><p style="font-size:16px; white-space:nowrap">${esc(stats.join('　'))}</p></layer>`)
  })
  const W = pad + cols.length * (CELL + pad)
  const H = head + rows.length * (CELL + pad + 30) + pad
  return { doc: layerDoc(W, H, BG, shapes), numbered }
}

function printReport(r: Recipe, reports: GlyphReport[], numbered: Array<Issue & { no: number }>, layerIssues: Array<{ level: string; code: string; message: string }>) {
  const steps = recipeSteps(r).map((s) => s.op).join('·')
  const post = (r.post ?? []).map((s) => s.op).join('·')
  console.log(`${name}  ${r.font ?? 'NotoSans'} ${r.weight ?? 700}  steps: ${steps || '-'}${post ? `  post: ${post}` : ''}`)
  console.log('字   保真  保留  溢出  问题')
  for (const g of reports) {
    if (only && !only.includes(g.index)) continue
    console.log(`${g.index} ${g.char}  ${g.fidelity != null ? g.fidelity.toFixed(2) : '  - '}  ${g.kept.toFixed(2)}  ${g.spill.toFixed(2)}  ${g.issues.length}`)
  }
  const shown = reports.filter((g) => !only || only.includes(g.index))
  const fids = shown.flatMap((g) => (g.fidelity != null ? [g.fidelity] : []))
  const kinds = new Map<string, number>()
  for (const g of shown) for (const i of g.issues) kinds.set(i.kind, (kinds.get(i.kind) ?? 0) + 1)
  console.log(
    `合计：${fids.length ? `平均保真 ${(fids.reduce((a, b) => a + b, 0) / fids.length).toFixed(3)}，` : ''}问题 ${[...kinds.values()].reduce((a, b) => a + b, 0)}` +
      (kinds.size ? `（${[...kinds].map(([k, v]) => `${k} ${v}`).join('、')}）` : ''),
  )
  if (!args.includes('--brief')) for (const is of numbered) console.log(`  [${is.no}] ${trace0.glyphs.find((g) => g.index === is.glyph)?.char ?? ''} ${is.kind}：${is.detail}`)
  if (layerIssues.length) for (const i of layerIssues) console.log(`  flexlayer ${i.level} ${i.code}：${i.message}`)
  else console.log('  flexlayer：没有问题')
}

function setPath(obj: unknown, path: string, value: unknown) {
  const keys = path.split('.')
  let o = obj as Record<string, unknown>
  for (const k of keys.slice(0, -1)) o = o[k] as Record<string, unknown>
  o[keys[keys.length - 1]!] = value
}

let trace0: Trace

await mkdir(outDir, { recursive: true })
const sweep = set ? (() => {
  const [path, vals] = set.split('=') as [string, string]
  return { path, values: vals.split(',').map((v) => JSON.parse(v) as unknown) }
})() : null

if (!sweep || sweep.values.length === 1) {
  const r = structuredClone(base)
  if (sweep) setPath(r, sweep.path, sweep.values[0])
  const { c, trace, reports, layerIssues } = await review(r)
  trace0 = trace
  const refs = ref ? await Promise.all(trace.glyphs.map((g) => refRings(g.char, ref, union(g.orig)))) : null
  const { doc, numbered } = cellDoc(trace, c.rings, reports, refs, '#ececec')
  printReport(r, reports, numbered, layerIssues)
  const out = join(outDir, `${name}.review.png`)
  await writeFile(out, await toPng(doc, 1))
  console.log(out)
} else {
  const cells: Array<{ png: Buffer; caption: string }> = []
  for (const v of sweep.values) {
    const r = structuredClone(base)
    setPath(r, sweep.path, v)
    const { reports, layer, trace } = await review(r)
    trace0 = trace
    const count = reports.reduce((s, g) => s + g.issues.length, 0)
    const kinds = [...new Set(reports.flatMap((g) => g.issues.map((i) => i.kind)))].join('、')
    const caption = `${sweep.path}=${JSON.stringify(v)}　问题 ${count}${kinds ? `（${kinds}）` : ''}`
    console.log(caption)
    cells.push({ png: await toPng(layer, 0.5), caption })
  }
  const imgs = await Promise.all(cells.map((c) => loadImage(c.png)))
  const cw = Math.max(...imgs.map((i) => i.width))
  const ch = Math.max(...imgs.map((i) => i.height))
  const cols = imgs.length > 3 ? 2 : 1
  const rows = Math.ceil(imgs.length / cols)
  const canvas = createCanvas(cols * cw, rows * (ch + 36))
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = BG
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  for (const [i, img] of imgs.entries()) {
    const x = (i % cols) * cw
    const y = Math.floor(i / cols) * (ch + 36)
    ctx.drawImage(img, x + (cw - img.width) / 2, y)
    const text = `<layer x="12" y="6" color="#c9ccd3"><p style="font-size:20px; white-space:nowrap">${esc(cells[i]!.caption)}</p></layer>`
    ctx.drawImage(await loadImage(await toPng(layerDoc(cw, 36, BG, [text]))), x, y + ch)
  }
  const out = join(outDir, `${name}.sweep.png`)
  await mkdir(dirname(out), { recursive: true })
  await writeFile(out, canvas.toBuffer('image/png'))
  console.log(out)
}
