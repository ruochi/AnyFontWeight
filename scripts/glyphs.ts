import ClipperLib from 'clipper-lib'
import * as fontkit from 'fontkit'
import type { Point, Ring } from '../src/types.js'

export type Font = {
  upm: number
  /** 可变字体的默认字重，静态字体的 usWeightClass */
  defaultWeight: number
  /** 只有可变字体才有 */
  axis?: { min: number; max: number }
  has(ch: string): boolean
  at(weight?: number): { rings(ch: string): Ring[] }
}

type Cmd = { command: string; args: number[] }

/** 打开字体。可变字体按 `wght` 取实例，静态字体忽略字重。坐标翻成 y 轴向下。 */
export function openFont(path: string): Font {
  const font = fontkit.openSync(path) as fontkit.Font
  const upm = font.unitsPerEm
  const step = upm * 0.01
  const wght = (font.variationAxes ?? {}).wght
  const charset = new Set(font.characterSet as number[])
  return {
    upm,
    defaultWeight: wght?.default ?? font['OS/2']?.usWeightClass ?? 400,
    axis: wght ? { min: wght.min, max: wght.max } : undefined,
    has(ch) {
      return charset.has(ch.codePointAt(0)!)
    },
    at(weight) {
      const inst = weight !== undefined && wght ? font.getVariation({ wght: weight }) : font
      return {
        rings(ch) {
          const cp = ch.codePointAt(0)!
          if (!charset.has(cp)) return []
          const g = inst.glyphForCodePoint(cp)
          if (!g || g.id === 0) return []
          return union(flatten(g.path.commands as Cmd[], step))
        },
      }
    },
  }
}

function flatten(cmds: Cmd[], step: number): Ring[] {
  const rings: Ring[] = []
  let cur: Point[] = []
  let last: Point = { x: 0, y: 0 }
  const put = (x: number, y: number) => {
    last = { x, y: -y }
    cur.push(last)
  }
  const curve = (ctrl: Point[], end: Point) => {
    const p = [last, ...ctrl.map((c) => ({ x: c.x, y: -c.y })), { x: end.x, y: -end.y }]
    let len = 0
    for (let i = 1; i < p.length; i++) len += Math.hypot(p[i]!.x - p[i - 1]!.x, p[i]!.y - p[i - 1]!.y)
    const n = Math.max(2, Math.ceil(len / step))
    for (let k = 1; k <= n; k++) {
      const q = bezier(p, k / n)
      last = q
      cur.push(q)
    }
  }
  for (const { command, args: a } of cmds) {
    if (command === 'moveTo') {
      if (cur.length) rings.push(cur)
      cur = []
      put(a[0]!, a[1]!)
    } else if (command === 'lineTo') put(a[0]!, a[1]!)
    else if (command === 'quadraticCurveTo') curve([{ x: a[0]!, y: a[1]! }], { x: a[2]!, y: a[3]! })
    else if (command === 'bezierCurveTo') curve([{ x: a[0]!, y: a[1]! }, { x: a[2]!, y: a[3]! }], { x: a[4]!, y: a[5]! })
    else if (command === 'closePath') {
      if (cur.length) rings.push(cur)
      cur = []
    }
  }
  if (cur.length) rings.push(cur)
  return rings.map(dedupe).filter((r) => r.length >= 3)
}

function bezier(p: Point[], t: number): Point {
  let q = p
  while (q.length > 1) {
    const next: Point[] = []
    for (let i = 1; i < q.length; i++) next.push({ x: q[i - 1]!.x + (q[i]!.x - q[i - 1]!.x) * t, y: q[i - 1]!.y + (q[i]!.y - q[i - 1]!.y) * t })
    q = next
  }
  return q[0]!
}

const SCALE = 1000

/** 可变字体通常保留重叠笔画，库要求不自交的轮廓，所以先按非零规则合并。 */
export function union(rings: Ring[]): Ring[] {
  const c = new ClipperLib.Clipper()
  c.AddPaths(
    rings.map((r) => r.map((p) => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }))),
    ClipperLib.PolyType.ptSubject,
    true,
  )
  const out: ClipperLib.Paths = []
  c.Execute(ClipperLib.ClipType.ctUnion, out, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)
  return out.map((path) => path.map((p) => ({ x: p.X / SCALE, y: p.Y / SCALE }))).filter((r) => r.length >= 3)
}

function dedupe(r: Ring): Ring {
  const out = r.filter((p, i) => {
    const q = r[(i + 1) % r.length]!
    return Math.hypot(p.x - q.x, p.y - q.y) > 1e-6
  })
  return out
}
