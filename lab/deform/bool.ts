import ClipperLib from 'clipper-lib'
import type { Point, Ring } from '../../src/types.js'

/** Clipper 只算整数坐标，放大 100 倍，精度 0.01 个单位。 */
const SCALE = 100
const ARC_TOLERANCE = 0.08 * SCALE

type IntPath = ClipperLib.IntPoint[]

const toInt = (r: Point[]): IntPath => r.map((p) => ({ X: Math.round(p.x * SCALE), Y: Math.round(p.y * SCALE) }))
const fromInt = (paths: IntPath[]): Ring[] =>
  paths.filter((p) => p.length >= 3).map((p) => p.map((q) => ({ x: q.X / SCALE, y: q.Y / SCALE })))

function run(type: number, subject: Ring[], clip: Ring[]): Ring[] {
  const c = new ClipperLib.Clipper()
  c.AddPaths(subject.map(toInt), ClipperLib.PolyType.ptSubject, true)
  if (clip.length) c.AddPaths(clip.map(toInt), ClipperLib.PolyType.ptClip, true)
  const out: IntPath[] = []
  c.Execute(type, out, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero)
  return fromInt(out)
}

/** 非零规则下的并集。重叠的笔画、自交的飘带都合成干净的外轮廓和字腔。 */
export function union(rings: Ring[], more: Ring[] = []): Ring[] {
  return run(ClipperLib.ClipType.ctUnion, rings, more)
}

export function difference(rings: Ring[], cut: Ring[]): Ring[] {
  return run(ClipperLib.ClipType.ctDifference, rings, cut)
}

export function intersect(rings: Ring[], mask: Ring[]): Ring[] {
  return run(ClipperLib.ClipType.ctIntersection, rings, mask)
}

export type Join = 'round' | 'miter' | 'square'
export type Cap = 'round' | 'butt' | 'square'

const JOIN = { round: ClipperLib.JoinType.jtRound, miter: ClipperLib.JoinType.jtMiter, square: ClipperLib.JoinType.jtSquare }
const CAP = { round: ClipperLib.EndType.etOpenRound, butt: ClipperLib.EndType.etOpenButt, square: ClipperLib.EndType.etOpenSquare }

/** 闭合轮廓整体外扩（正）或内缩（负）。 */
export function offset(rings: Ring[], delta: number, join: Join = 'round'): Ring[] {
  const o = new ClipperLib.ClipperOffset(4, ARC_TOLERANCE)
  o.AddPaths(union(rings).map(toInt), JOIN[join], ClipperLib.EndType.etClosedPolygon)
  const out: IntPath[] = []
  o.Execute(out, delta * SCALE)
  return fromInt(out)
}

/** 把折线按宽度描成轮廓。`loops` 是首尾相接的闭合中心线。 */
export function strokeLines(lines: Point[][], width: number, cap: Cap = 'round', join: Join = 'round', loops: Point[][] = []): Ring[] {
  const o = new ClipperLib.ClipperOffset(4, ARC_TOLERANCE)
  for (const l of lines) if (l.length >= 2) o.AddPath(toInt(l), JOIN[join], CAP[cap])
  for (const l of loops) if (l.length >= 3) o.AddPath(toInt(l), JOIN[join], ClipperLib.EndType.etClosedLine)
  const out: IntPath[] = []
  o.Execute(out, (width / 2) * SCALE)
  return union(fromInt(out))
}

/** 用一支笔尖形状沿折线扫过，笔尖是 `nib` 多边形（以原点为中心）。 */
export function sweep(lines: Point[][], nib: Ring, loops: Point[][] = []): Ring[] {
  const pattern = toInt(nib)
  const parts: IntPath[] = []
  for (const l of lines) if (l.length >= 2) parts.push(...ClipperLib.Clipper.MinkowskiSum(pattern, toInt(l), false))
  for (const l of loops) if (l.length >= 3) parts.push(...ClipperLib.Clipper.MinkowskiSum(pattern, toInt(l), true))
  for (const l of lines) if (l.length === 1) parts.push(toInt(nib.map((p) => ({ x: p.x + l[0]!.x, y: p.y + l[0]!.y }))))
  return union(fromInt(parts))
}

export function translate(rings: Ring[], dx: number, dy: number): Ring[] {
  return rings.map((r) => r.map((p) => ({ x: p.x + dx, y: p.y + dy })))
}

/** 凸角倒圆是先缩后扩，凹角倒圆是先扩后缩。 */
export function roundCorners(rings: Ring[], convex: number, concave: number): Ring[] {
  let out = union(rings)
  if (concave > 0) out = offset(offset(out, concave), -concave)
  if (convex > 0) out = offset(offset(out, -convex), convex)
  return out
}

export function circle(c: Point, r: number, steps = 48): Ring {
  return Array.from({ length: steps }, (_, i) => {
    const a = (i / steps) * Math.PI * 2
    return { x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r }
  })
}
