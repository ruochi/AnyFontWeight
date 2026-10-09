import type { Point } from '../../src/types.js'
import type { Terminal } from './terminals.js'

/** 长度都以 em 计，角度以度计。顺时针（屏幕上向右拐）为正。 */
export type SwashParams = {
  /** 延长段的长度 */
  length?: number
  /** 延长段总共拐过的角度 */
  bend?: number
  /** 末尾卷几圈，正负决定卷的方向；0 不卷 */
  curl?: number
  /** 开始卷时的半径 */
  curlRadius?: number
  /** 卷到最后时半径缩到开始的多少倍 */
  curlTighten?: number
  /** 末端宽度相对原笔画的比例，0 是尖头 */
  taper?: number
  /** 中段鼓起的比例，像丝带 */
  swell?: number
  /** 宽度从第几成长度开始收 */
  holdWidth?: number
}

const DEG = Math.PI / 180

type Sample = { p: Point; t: Point; s: number }

/** 按曲率分段积分出中心线。每段曲率从 k0 线性变到 k1（回旋曲线），切线连续。 */
function centerline(start: Point, dir: Point, pieces: Array<{ len: number; k0: number; k1: number }>, ds: number): Sample[] {
  let p = start
  let theta = Math.atan2(dir.y, dir.x)
  let s = 0
  const out: Sample[] = [{ p, t: dir, s }]
  for (const piece of pieces) {
    const steps = Math.max(1, Math.ceil(piece.len / ds))
    const h = piece.len / steps
    for (let i = 0; i < steps; i++) {
      const k = piece.k0 + ((piece.k1 - piece.k0) * (i + 0.5)) / steps
      const mid = theta + (k * h) / 2
      p = { x: p.x + Math.cos(mid) * h, y: p.y + Math.sin(mid) * h }
      theta += k * h
      s += h
      out.push({ p, t: { x: Math.cos(theta), y: Math.sin(theta) }, s })
    }
  }
  return out
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0 || 1)))
  return t * t * (3 - 2 * t)
}

/**
 * 把末端那段转弯换成一条从 A 出发、绕过新末端、回到 B 的折线。
 * 中心线从 A、B 的中点出发，沿末端方向延伸。
 */
export function swashOutline(t: Terminal, params: SwashParams, em: number): Point[] {
  const length = (params.length ?? 0.3) * em
  const bend = (params.bend ?? 0) * DEG
  const curl = params.curl ?? 0
  const taper = params.taper ?? 0.15
  const swell = params.swell ?? 0
  const hold = params.holdWidth ?? 0.25
  const half0 = t.width / 2
  const pieces: Array<{ len: number; k0: number; k1: number }> = []
  if (length > 0) pieces.push({ len: length, k0: 0, k1: (2 * bend) / length })
  let kEnd = length > 0 ? (2 * bend) / length : 0
  if (curl !== 0) {
    const sign = Math.sign(curl)
    const r0 = Math.max((params.curlRadius ?? 0.12) * em, half0 * 1.2)
    const r1 = r0 * (params.curlTighten ?? 0.4)
    const lead = r0 * 0.8
    pieces.push({ len: lead, k0: kEnd, k1: sign / r0 })
    const angle = Math.abs(curl) * 2 * Math.PI
    const len = (2 * angle) / (1 / r0 + 1 / r1)
    pieces.push({ len, k0: sign / r0, k1: sign / r1 })
    kEnd = sign / r1
  }
  const line = centerline(t.base, t.dir, pieces, em * 0.004)
  const total = line[line.length - 1]!.s || 1
  const nA = { x: (t.A.x - t.base.x) / (half0 || 1), y: (t.A.y - t.base.y) / (half0 || 1) }
  const side = Math.sign(-t.dir.y * nA.x + t.dir.x * nA.y) || 1
  const left: Point[] = []
  const right: Point[] = []
  for (const q of line) {
    const u = q.s / total
    const perp = { x: -q.t.y * side, y: q.t.x * side }
    const blend = smoothstep(0, Math.max(t.width, em * 0.02), q.s)
    const rot = rotate(nA, Math.atan2(q.t.y, q.t.x) - Math.atan2(t.dir.y, t.dir.x))
    const nx = rot.x * (1 - blend) + perp.x * blend
    const ny = rot.y * (1 - blend) + perp.y * blend
    const nl = Math.hypot(nx, ny) || 1
    const fade = smoothstep(hold, 1, u)
    const w = half0 * (taper + (1 - taper) * (1 - fade)) * (1 + swell * Math.sin(Math.PI * u))
    const reach = q.s === 0 ? half0 : w
    left.push({ x: q.p.x + (nx / nl) * reach, y: q.p.y + (ny / nl) * reach })
    right.push({ x: q.p.x - (nx / nl) * reach, y: q.p.y - (ny / nl) * reach })
  }
  const end = line[line.length - 1]!
  const wEnd = Math.max(half0 * taper, 0)
  const cap: Point[] = []
  if (wEnd > em * 0.002) {
    const perp = { x: -end.t.y * side, y: end.t.x * side }
    const a0 = Math.atan2(perp.y, perp.x)
    const steps = 10
    for (let i = 1; i < steps; i++) {
      const a = a0 - side * Math.PI * (i / steps)
      cap.push({ x: end.p.x + Math.cos(a) * wEnd, y: end.p.y + Math.sin(a) * wEnd })
    }
  }
  return [...left, ...cap, ...right.reverse()]
}

function rotate(v: Point, a: number): Point {
  const c = Math.cos(a)
  const s = Math.sin(a)
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c }
}

/** 把一个轮廓上若干段末端换成新折线。各段下标区间不能重叠。 */
export function spliceContour(pts: Point[], parts: Array<{ a: number; b: number; with: Point[] }>): Point[] {
  const n = pts.length
  if (parts.length === 0) return pts
  const sorted = parts.slice().sort((p, q) => p.a - q.a)
  const start = (sorted[0]!.b + 1) % n
  const out: Point[] = []
  let i = start
  let guard = 0
  while (guard++ <= n) {
    const part = sorted.find((p) => p.a === i)
    if (part) {
      out.push(...part.with)
      i = (part.b + 1) % n
      if (part === sorted[0]) break
      continue
    }
    out.push(pts[i]!)
    i = (i + 1) % n
    if (i === start) break
  }
  return out
}
