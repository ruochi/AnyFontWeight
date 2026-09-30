/**
 * 字重合成的提升空间实验：
 *
 * - oracle：每条边沿法线直接移到真实目标字重的轮廓上，是"只沿法线移动"能达到的上限
 * - grid：每款字体单独搜 perHundred / k / shrink，相当于拿到这款字体的一个粗体做标定
 * - ridge / gbdt：用其他字体的 oracle 位移训练每条边的位移，留一款字体做测试
 *
 *   npx tsx scripts/research.ts [/tmp/fonts/ready]
 */
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { Resvg } from '@resvg/resvg-js'
import { edgeNormal, prepareRings } from '../src/geometry.js'
import { computeMedial, type MedialGlyph } from '../src/medial.js'
import { offsetEdges, paramsForWeight, reweight } from '../src/reweight.js'
import type { Point, Ring } from '../src/types.js'
import { selfIntersections } from './check.js'
import { openFont, type Font } from './glyphs.js'
import { iou, rasterize, type Box, type Mask } from './raster.js'

const DIR = process.argv[2] ?? '/tmp/fonts/ready'
const OUT = '/opt/cursor/artifacts/research'
mkdirSync(OUT, { recursive: true })

const CN = '永国圆字黑波我三省'
const EN = 'AaBbGgHhOoRrSsWw'
const FROM = 400
const TARGETS = [300, 700]
const TUNED = { perHundred: 0.0085, k: 0.89, shrink: 0.007 }
const R = 280
const MAX_RAY = 0.08

type Sample = {
  font: string
  ch: string
  em: number
  box: Box
  medial: MedialGlyph
  base: Mask
  truth: Record<number, { rings: Ring[]; mask: Mask; oracle: number[][] }>
  feats: number[][][]
}

function charsFor(font: Font): string {
  const cn = font.has('永') && font.has('国')
  const en = font.has('A') && font.has('g')
  if (cn && en) return CN + EN.slice(0, 8)
  return cn ? CN : EN
}

/** 从边中点沿法线找最近的、朝向一致的目标轮廓交点，找不到返回 NaN */
function rayToTruth(m: Point, e: Point, truth: Ring[], maxT: number): number {
  let best = NaN
  for (const r of truth) {
    for (let i = 0; i < r.length; i++) {
      const c = r[i]!
      const d = r[(i + 1) % r.length]!
      const s = { x: d.x - c.x, y: d.y - c.y }
      const den = e.x * s.y - e.y * s.x
      if (Math.abs(den) < 1e-12) continue
      const t = ((c.x - m.x) * s.y - (c.y - m.y) * s.x) / den
      const u = ((c.x - m.x) * e.y - (c.y - m.y) * e.x) / den
      if (u < 0 || u > 1 || Math.abs(t) > maxT) continue
      const tn = edgeNormal(c, d)
      if (tn.x * e.x + tn.y * e.y < 0.3) continue
      if (Number.isNaN(best) || Math.abs(t) < Math.abs(best)) best = t
    }
  }
  return best
}

function features(md: MedialGlyph, em: number): number[][][] {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  const rIns: number[] = []
  for (const ring of md.contours)
    for (const q of ring) {
      x0 = Math.min(x0, q.p.x)
      y0 = Math.min(y0, q.p.y)
      x1 = Math.max(x1, q.p.x)
      y1 = Math.max(y1, q.p.y)
      if (q.reliableIn) rIns.push(q.rIn)
    }
  rIns.sort((a, b) => a - b)
  const medIn = rIns[rIns.length >> 1] ?? 0.05 * em
  return md.contours.map((ring) => {
    const n = ring.length
    const normals = ring.map((a, i) => edgeNormal(a.p, ring[(i + 1) % n]!.p))
    return ring.map((a, i) => {
      const b = ring[(i + 1) % n]!
      const e = normals[i]!
      const prev = normals[(i - 1 + n) % n]!
      const next = normals[(i + 1) % n]!
      const turn = (prev.x * next.y - prev.y * next.x) / 2
      const mx = (a.p.x + b.p.x) / 2
      const my = (a.p.y + b.p.y) / 2
      const rIn = (a.rIn + b.rIn) / 2 / em
      const rOut = Math.min((a.rOut + b.rOut) / 2 / em, 0.15)
      const toHull = Math.min(
        e.x > 0 ? (x1 - mx) / em / Math.max(e.x, 1e-3) : e.x < 0 ? (mx - x0) / em / Math.max(-e.x, 1e-3) : 1,
        e.y > 0 ? (y1 - my) / em / Math.max(e.y, 1e-3) : e.y < 0 ? (my - y0) / em / Math.max(-e.y, 1e-3) : 1,
        1,
      )
      const ex2 = e.x * e.x
      const ey2 = e.y * e.y
      const rel = rIn / Math.max(medIn / em, 1e-4)
      return [
        rIn,
        rOut,
        ((a.reliableIn ? 1 : 0) + (b.reliableIn ? 1 : 0)) / 2,
        ((a.reliableOut ? 1 : 0) + (b.reliableOut ? 1 : 0)) / 2,
        ex2,
        ey2,
        a.corner || b.corner ? 1 : 0,
        md.space,
        turn,
        toHull,
        Math.exp(-toHull / 0.03),
        rel,
        medIn / em,
        rIn * ex2,
        rIn * ey2,
        rOut * ex2,
        rOut * ey2,
        Math.min(rOut, 0.05),
        Math.min(rIn, 0.02),
        ((mx - md.center.x) * e.x + (my - md.center.y) * e.y) / em,
      ]
    })
  })
}

function smooth(v: number[], corner: boolean[]): number[] {
  const n = v.length
  return v.map((x, i) => {
    let s = x
    let w = 1
    if (!corner[i]) {
      s += v[(i - 1 + n) % n]!
      w++
    }
    if (!corner[(i + 1) % n]) {
      s += v[(i + 1) % n]!
      w++
    }
    return s / w
  })
}

/** 预测值换成每条边的位移：平滑、不糊死字腔、不把笔画削断 */
function toEdgeDs(s: Sample, pred: (f: number[]) => number): number[][] {
  return s.medial.contours.map((ring, c) => {
    const n = ring.length
    const raw = ring.map((a, i) => {
      const b = ring[(i + 1) % n]!
      const d = pred(s.feats[c]![i]!) * s.em
      const rOut = Math.min(a.rOut, b.rOut)
      const rIn = Math.min(a.rIn, b.rIn)
      if (d > 0) return Math.min(d, 0.6 * rOut)
      return Math.max(d, -Math.max(0, rIn - 0.004 * s.em))
    })
    return smooth(
      raw,
      ring.map((q) => q.corner),
    )
  })
}

function load(): Sample[] {
  const out: Sample[] = []
  for (const file of readdirSync(DIR).sort()) {
    const font = openFont(join(DIR, file))
    if (!font.axis || font.axis.min > 300 || font.axis.max < 700) continue
    const name = file.replace(/\.(ttf|otf)$/, '').replace(/\[.*\]/, '')
    const em = font.upm
    const box: Box = { x: -em * 0.15, y: -em * 1.05, size: em * 1.3 }
    for (const ch of charsFor(font)) {
      const src = font.at(FROM).rings(ch)
      if (!src.length) continue
      const contours = prepareRings(src, em * 0.008)
      if (!contours.length) continue
      const medial = computeMedial(contours, em)
      const truth: Sample['truth'] = {}
      for (const w of TARGETS) {
        const rings = font.at(w).rings(ch)
        const oracle = medial.contours.map((ring) =>
          ring.map((a, i) => {
            const b = ring[(i + 1) % ring.length]!
            const e = edgeNormal(a.p, b.p)
            return rayToTruth({ x: (a.p.x + b.p.x) / 2, y: (a.p.y + b.p.y) / 2 }, e, rings, MAX_RAY * em)
          }),
        )
        truth[w] = { rings, mask: rasterize(rings, box, R), oracle }
      }
      out.push({ font: name, ch, em, box, medial, base: rasterize(src, box, R), truth, feats: features(medial, em) })
    }
    console.error(`loaded ${name}`)
  }
  return out
}

// ---------- 模型 ----------

type Model = (f: number[]) => number

function trainingSet(samples: Sample[], w: number) {
  const X: number[][] = []
  const y: number[] = []
  for (const s of samples)
    s.medial.contours.forEach((ring, c) =>
      ring.forEach((_, i) => {
        const t = s.truth[w]!.oracle[c]![i]!
        if (Number.isNaN(t)) return
        X.push(s.feats[c]![i]!)
        y.push(t / s.em)
      }),
    )
  return { X, y }
}

function ridge(X: number[][], y: number[], lambda = 1e-3): Model {
  const d = X[0]!.length + 1
  const mu = new Array(d - 1).fill(0)
  const sd = new Array(d - 1).fill(0)
  for (const r of X) r.forEach((v, j) => (mu[j] += v / X.length))
  for (const r of X) r.forEach((v, j) => (sd[j] += (v - mu[j]) ** 2 / X.length))
  for (let j = 0; j < sd.length; j++) sd[j] = Math.sqrt(sd[j]) || 1
  const z = (r: number[]) => [1, ...r.map((v, j) => (v - mu[j]) / sd[j])]
  const A = Array.from({ length: d }, () => new Array(d).fill(0))
  const bv = new Array(d).fill(0)
  X.forEach((r, k) => {
    const zr = z(r)
    for (let i = 0; i < d; i++) {
      bv[i] += zr[i]! * y[k]!
      for (let j = 0; j < d; j++) A[i]![j] += zr[i]! * zr[j]!
    }
  })
  for (let i = 1; i < d; i++) A[i]![i] += lambda * X.length
  const wv = solve(A, bv)
  return (f) => z(f).reduce((s, v, i) => s + v * wv[i]!, 0)
}

function solve(A: number[][], b: number[]): number[] {
  const n = b.length
  const M = A.map((r, i) => [...r, b[i]!])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r
    ;[M[c], M[p]] = [M[p]!, M[c]!]
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = M[r]![c]! / M[c]![c]!
      for (let k = c; k <= n; k++) M[r]![k] -= f * M[c]![k]!
    }
  }
  return M.map((r, i) => r[n]! / r[i]!)
}

type Node = { f: number; t: number; l: Node | number; r: Node | number }

/** 直方图分裂的梯度提升树，Huber 损失，抗 oracle 里偶尔打到别的笔画上的离群值 */
function gbdt(X: number[][], y: number[], trees = 150, depth = 4, lr = 0.1): Model {
  const nF = X[0]!.length
  const BINS = 32
  const cuts: number[][] = []
  for (let j = 0; j < nF; j++) {
    const col = X.map((r) => r[j]!).sort((a, b) => a - b)
    const c: number[] = []
    for (let k = 1; k < BINS; k++) c.push(col[Math.floor((k * col.length) / BINS)]!)
    cuts.push([...new Set(c)])
  }
  const bin = X.map((r) => r.map((v, j) => lowerBound(cuts[j]!, v)))
  const base = median(y)
  const pred = new Array(y.length).fill(base)
  const forest: Node[] = []
  const importance = new Array(nF).fill(0)
  const delta = 0.004
  for (let t = 0; t < trees; t++) {
    const g = y.map((v, i) => {
      const r = v - pred[i]
      return Math.abs(r) <= delta ? r : Math.sign(r) * delta
    })
    const idx = [...y.keys()].filter(() => Math.random() < 0.5)
    const tree = grow(idx, 0)
    forest.push(tree as Node)
    for (let i = 0; i < y.length; i++) pred[i] += lr * evalTree(tree, X[i]!)
    function grow(ids: number[], lvl: number): Node | number {
      let sum = 0
      for (const i of ids) sum += g[i]!
      const leaf = ids.length ? sum / ids.length : 0
      if (lvl >= depth || ids.length < 200) return leaf
      let best = { gain: 0, f: -1, b: -1 }
      for (let j = 0; j < nF; j++) {
        const hs = new Array(cuts[j]!.length + 1).fill(0)
        const hc = new Array(cuts[j]!.length + 1).fill(0)
        for (const i of ids) {
          hs[bin[i]![j]!] += g[i]!
          hc[bin[i]![j]!]++
        }
        let ls = 0
        let lc = 0
        for (let b = 0; b < hs.length - 1; b++) {
          ls += hs[b]
          lc += hc[b]
          const rc = ids.length - lc
          if (lc < 50 || rc < 50) continue
          const gain = (ls * ls) / lc + ((sum - ls) * (sum - ls)) / rc - (sum * sum) / ids.length
          if (gain > best.gain) best = { gain, f: j, b }
        }
      }
      if (best.f < 0) return leaf
      importance[best.f] += best.gain
      const L = ids.filter((i) => bin[i]![best.f]! <= best.b)
      const Rr = ids.filter((i) => bin[i]![best.f]! > best.b)
      return { f: best.f, t: cuts[best.f]![best.b]!, l: grow(L, lvl + 1), r: grow(Rr, lvl + 1) }
    }
  }
  const total = importance.reduce((a, b) => a + b, 0) || 1
  importance.forEach((v, j) => (IMPORTANCE[j] = (IMPORTANCE[j] ?? 0) + v / total))
  return (f) => base + lr * forest.reduce((s, tr) => s + evalTree(tr, f), 0)
}

const FEATURE_NAMES = [
  'rIn', 'rOut', 'reliableIn', 'reliableOut', 'nx²', 'ny²', 'corner', 'space', 'turn', 'toHull', 'nearHull',
  'rIn/median', 'medianIn', 'rIn·nx²', 'rIn·ny²', 'rOut·nx²', 'rOut·ny²', 'rOut≤0.05', 'rIn≤0.02', 'outward',
]
let IMPORTANCE: number[] = []

function evalTree(n: Node | number, f: number[]): number {
  while (typeof n !== 'number') n = f[n.f]! <= n.t ? n.l : n.r
  return n
}

function lowerBound(a: number[], v: number): number {
  let lo = 0
  let hi = a.length
  while (lo < hi) {
    const m = (lo + hi) >> 1
    if (a[m]! < v) lo = m + 1
    else hi = m
  }
  return lo
}

function median(v: number[]): number {
  const s = [...v].sort((a, b) => a - b)
  return s[s.length >> 1]!
}

// ---------- 评测 ----------

type Score = { iou: number; x: number }

function score(s: Sample, w: number, rings: Ring[]): Score {
  return { iou: iou(rasterize(rings, s.box, R), s.truth[w]!.mask), x: rings.reduce((k, r) => k + selfIntersections(r), 0) }
}

function formula(s: Sample, w: number, t: typeof TUNED): Ring[] {
  return reweight(s.medial, paramsForWeight(FROM, w, s.em, t))
}

function oracleRings(s: Sample, w: number): Ring[] {
  const tuned = paramsForWeight(FROM, w, s.em, TUNED)
  const ds = s.medial.contours.map((ring, c) =>
    ring.map((a, i) => {
      const t = s.truth[w]!.oracle[c]![i]!
      if (!Number.isNaN(t)) return t
      const e = edgeNormal(a.p, ring[(i + 1) % ring.length]!.p)
      return tuned.b * (e.x * e.x + tuned.k * e.y * e.y)
    }),
  )
  return offsetEdges(s.medial, ds)
}

const GRID: (typeof TUNED)[] = []
for (const perHundred of [0.005, 0.0065, 0.008, 0.0095, 0.011, 0.0125, 0.014])
  for (const k of [0.55, 0.7, 0.85, 1])
    for (const shrink of [0, 0.007, 0.014, 0.021]) GRID.push({ perHundred, k, shrink })

const SHEET_FONTS = ['ChillDuanSansVF', 'Manrope', 'NotoSerifSC']
const SHEET_CHARS = '永国我aGR'
const CELL = 150

function toPath(rings: Ring[]): string {
  return rings.map((r) => 'M' + r.map((p) => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('L') + 'Z').join('')
}

/** 灰色是真实字重，红线是生成结果 */
function sheet(rows: { label: string; box: Box; truth: Ring[]; cells: Ring[][] }[], cols: string[], path: string) {
  const width = CELL * (cols.length + 1)
  const height = CELL * rows.length + 30
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<rect width="100%" height="100%" fill="#fff"/>`,
    ...cols.map((c, j) => `<text x="${(j + 1.5) * CELL}" y="20" font-size="14" text-anchor="middle" font-family="sans-serif">${c}</text>`),
  ]
  rows.forEach((row, i) => {
    const y = 30 + i * CELL
    svg.push(`<text x="8" y="${y + CELL / 2}" font-size="12" font-family="sans-serif">${row.label}</text>`)
    row.cells.forEach((rings, j) => {
      const s = CELL / row.box.size
      svg.push(`<g transform="translate(${(j + 1) * CELL} ${y}) scale(${s}) translate(${-row.box.x} ${-row.box.y})">`)
      svg.push(`<path d="${toPath(row.truth)}" fill="#bbb"/>`)
      svg.push(`<path d="${toPath(rings)}" fill="none" stroke="#d22" stroke-width="${1.6 / s}"/>`)
      svg.push('</g>')
    })
  })
  svg.push('</svg>')
  writeFileSync(path, new Resvg(svg.join('\n')).render().asPng())
}

function main() {
  const samples = load()
  const fonts = [...new Set(samples.map((s) => s.font))]
  const methods = ['unchanged', 'tuned', 'grid', 'ridge', 'gbdt', 'oracle'] as const
  type M = (typeof methods)[number]
  const table: Record<number, Record<string, Record<M, Score>>> = {}
  const importanceByWeight: Record<number, string> = {}
  for (const w of TARGETS) {
    table[w] = {}
    IMPORTANCE = []
    const sheetRows: Parameters<typeof sheet>[0] = []
    for (const font of fonts) {
      const test = samples.filter((s) => s.font === font)
      const train = samples.filter((s) => s.font !== font)
      const { X, y } = trainingSet(train, w)
      const models = { ridge: ridge(X, y), gbdt: gbdt(X, y) }
      let bestGrid = TUNED
      let bestIou = -1
      for (const t of GRID) {
        const v = test.reduce((a, s) => a + iou(rasterize(formula(s, w, t), s.box, R), s.truth[w]!.mask), 0)
        if (v > bestIou) {
          bestIou = v
          bestGrid = t
        }
      }
      const acc = Object.fromEntries(methods.map((m) => [m, { iou: 0, x: 0 }])) as Record<M, Score>
      for (const s of test) {
        const res: Record<M, Score> = {
          unchanged: { iou: iou(s.base, s.truth[w]!.mask), x: 0 },
          tuned: score(s, w, formula(s, w, TUNED)),
          grid: score(s, w, formula(s, w, bestGrid)),
          ridge: score(s, w, offsetEdges(s.medial, toEdgeDs(s, models.ridge))),
          gbdt: score(s, w, offsetEdges(s.medial, toEdgeDs(s, models.gbdt))),
          oracle: score(s, w, oracleRings(s, w)),
        }
        for (const m of methods) {
          acc[m].iou += res[m].iou / test.length
          acc[m].x += res[m].x
        }
        if (SHEET_FONTS.includes(font) && SHEET_CHARS.includes(s.ch))
          sheetRows.push({
            label: `${font.slice(0, 9)} ${s.ch}`,
            box: s.box,
            truth: s.truth[w]!.rings,
            cells: [
              s.medial.contours.map((r) => r.map((q) => q.p)),
              formula(s, w, TUNED),
              formula(s, w, bestGrid),
              offsetEdges(s.medial, toEdgeDs(s, models.gbdt)),
              oracleRings(s, w),
            ],
          })
      }
      table[w]![font] = acc
      console.error(
        `${FROM}->${w} ${font.padEnd(22)} ` +
          methods.map((m) => `${m} ${acc[m].iou.toFixed(3)}`).join('  ') +
          `  grid=${JSON.stringify(bestGrid)}`,
      )
    }
    importanceByWeight[w] = IMPORTANCE.map((v, j) => ({ name: FEATURE_NAMES[j]!, v: v / fonts.length }))
      .sort((a, b) => b.v - a.v)
      .slice(0, 8)
      .map((e) => `${e.name} ${(e.v * 100).toFixed(0)}%`)
      .join('，')
    sheet(sheetRows, ['unchanged', 'tuned', 'grid', 'gbdt', 'oracle'], join(OUT, `sheet-${FROM}-${w}.png`))
  }
  let md = '# 提升空间实验\n\n'
  for (const w of TARGETS) {
    md += `## ${FROM} → ${w}（平均 IoU，括号内是自交点总数）\n\n| 字体 | ${methods.join(' | ')} |\n|---|${methods.map(() => '---').join('|')}|\n`
    const avg = Object.fromEntries(methods.map((m) => [m, 0])) as Record<M, number>
    for (const font of fonts) {
      const r = table[w]![font]!
      md += `| ${font} | ${methods.map((m) => `${r[m].iou.toFixed(3)}${m === 'unchanged' ? '' : ` (${r[m].x})`}`).join(' | ')} |\n`
      for (const m of methods) avg[m] += r[m].iou / fonts.length
    }
    md += `| **平均** | ${methods.map((m) => `**${avg[m].toFixed(3)}**`).join(' | ')} |\n\n`
    md += `gbdt 特征重要度（分裂增益占比，各折平均）：${importanceByWeight[w]}\n\n`
  }
  writeFileSync(join(OUT, 'RESEARCH.md'), md)
  console.log(md)
}

main()
