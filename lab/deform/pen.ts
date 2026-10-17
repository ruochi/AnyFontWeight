import type { Point, Ring } from '../../src/types.js'
import type { StrokeType } from './skeleton.js'

/**
 * 端点附近笔尖怎么变：从端点往里 `length` 开始，越靠近端点变得越多，到端点时
 * 转过 `turn` 度、尺寸乘 `scale`、往走向左侧挪 `shift`（em，负数往右）。
 * 收笔时变大再往一侧挪，扫出来就是顿笔的三角；转笔就是笔尖转过一个角度。
 */
export type PenMove = {
  /** em；`all` 是整段 */
  length: number | 'all'
  turn?: number
  /** 一个数是等比，`[x, y]` 是笔尖自己的两个方向 */
  scale?: number | [number, number]
  shift?: number
  /** 1 是线性，越大越集中在端点 */
  ease?: number
  /**
   * 最重的地方离端点多远，占 `length` 的比例；过了这里往端点回落到 `release`。
   * 顿笔是按下去再提起来，三角的尖在前、斜边朝外，就靠这一下。默认 0，到端点最重
   */
  peak?: number
  release?: number
}

export type PenTypeRule = { start?: PenMove | null; end?: PenMove | null }

/**
 * 形状笔尖：一个圆、方块或矩形沿中线走，逐点盖印，相邻两印取凸包。
 * `size` 是笔尖自己的 `[x, y]` 两个方向的长度（em），`angle` 是笔尖转了多少度。
 * `follow` 时笔尖跟着走向转，`angle` 相对走向；否则笔尖方向不变。
 */
export type Footprint = {
  shape: 'circle' | 'rect'
  size: [number, number]
  angle?: number
  follow?: boolean
  start?: PenMove
  end?: PenMove
  /** 按段的走向（横、竖、撇、捺、点、提）各用各的起笔、收笔，`null` 是不做 */
  byType?: Partial<Record<StrokeType, PenTypeRule>>
  /** 折笔的转角处做不做上一段的收笔动作，默认做 */
  turns?: boolean
}

type PenState = { angle: number; sx: number; sy: number; shift: number }

const rad = (deg: number) => (deg * Math.PI) / 180

/** 按走向给一段起名。末尾短的一段是钩，算提。 */
export function segmentType(from: Point, to: Point, len: number, last: boolean, multi: boolean, em: number): StrokeType {
  const ang = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI
  if (last && multi && len < em * 0.1) return '提'
  if (Math.abs(ang) < 30) return '横'
  if (ang >= 60 && ang <= 120) return '竖'
  if (ang > 120) return '撇'
  if (ang < -30) return '提'
  return ang > 0 ? '捺' : '横'
}

function hull(points: Point[]): Ring {
  const ps = points.slice().sort((a, b) => a.x - b.x || a.y - b.y)
  const cross = (o: Point, a: Point, b: Point) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: Point[] = []
  for (const p of ps) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop()
    lower.push(p)
  }
  const upper: Point[] = []
  for (const p of ps.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop()
    upper.push(p)
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

function print(fp: Footprint, c: Point, dir: Point, st: PenState, k: number, em: number): Point[] {
  const base = fp.follow ? Math.atan2(dir.y, dir.x) : 0
  const a = base + rad(st.angle)
  const hx = (fp.size[0] * st.sx * k * em) / 2
  const hy = (fp.size[1] * st.sy * k * em) / 2
  const left = { x: dir.y, y: -dir.x }
  const o = { x: c.x + left.x * st.shift * em, y: c.y + left.y * st.shift * em }
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  const local =
    fp.shape === 'circle'
      ? Array.from({ length: 16 }, (_, i) => ({ x: Math.cos((i / 16) * Math.PI * 2) * hx, y: Math.sin((i / 16) * Math.PI * 2) * hy }))
      : [
          { x: -hx, y: -hy },
          { x: hx, y: -hy },
          { x: hx, y: hy },
          { x: -hx, y: hy },
        ]
  return local.map((q) => ({ x: o.x + q.x * cos - q.y * sin, y: o.y + q.x * sin + q.y * cos }))
}

function blend(st: PenState, m: PenMove | null | undefined, d: number, segLen: number, em: number) {
  if (!m) return
  const L = m.length === 'all' ? segLen : Math.min(segLen, m.length * em)
  if (L <= 0 || d > L) return
  const peak = (m.peak ?? 0) * L
  const release = m.release ?? 0
  const u = d >= peak ? ((L - d) / (L - peak || 1)) ** (m.ease ?? 1) : release + (1 - release) * (d / peak)
  const [mx, my] = typeof m.scale === 'number' ? [m.scale, m.scale] : (m.scale ?? [1, 1])
  st.angle += (m.turn ?? 0) * u
  st.sx *= 1 + (mx - 1) * u
  st.sy *= 1 + (my - 1) * u
  st.shift += (m.shift ?? 0) * u
}

/**
 * 用形状笔尖画一笔。`cuts` 是转角处的点序号，笔画在那里分段，每段按走向找起笔、收笔规则；
 * 一笔只有一段时用这一笔自己的类型。`ks` 是逐点的粗细倍数（压感、牵丝）。
 */
export function footprintStroke(
  pts: Point[],
  ks: number[],
  type: StrokeType,
  cuts: number[],
  fp: Footprint,
  em: number,
  plain = false,
  free: { start: boolean; end: boolean } = { start: true, end: true },
): Ring[] {
  const prints = footprintPrints(pts, ks, type, cuts, fp, em, plain, free)
  if (prints.length === 1) return [hull(prints[0]!)]
  const out: Ring[] = []
  for (let i = 1; i < prints.length; i++) out.push(hull([...prints[i - 1]!, ...prints[i]!]))
  return out
}

/**
 * 逐点的笔尖印。笔尖跟着走向转时，转角处从上一段的方向一点点转到下一段，外角是圆的，不会缺一块。
 * 起笔、收笔动作只在自由端做，接在别的笔画上的一头不转笔也不顿笔，否则接头处会斜出一角或缺一块。
 */
export function footprintPrints(
  pts: Point[],
  ks: number[],
  type: StrokeType,
  cuts: number[],
  fp: Footprint,
  em: number,
  plain = false,
  free: { start: boolean; end: boolean } = { start: true, end: true },
): Point[][] {
  if (pts.length === 0) return []
  const arc: number[] = [0]
  for (let i = 1; i < pts.length; i++) arc.push(arc[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y))
  const bounds = [0, ...cuts.filter((c) => c > 0 && c < pts.length - 1), pts.length - 1]
  const prints: Point[][] = []
  let prevDir: Point | null = null
  // 方向取前后约 0.03 em 的弦；只看相邻两点时，中线上一点小折就会让宽笔尖的两角探出去
  const step = pts.length > 1 ? arc[arc.length - 1]! / (pts.length - 1) : 1
  const reach = Math.max(2, Math.round((em * 0.03) / (step || 1)))
  for (let s = 1; s < bounds.length; s++) {
    const a = bounds[s - 1]!
    const b = bounds[s]!
    if (b <= a) continue
    const first = s === 1
    const last = s === bounds.length - 1
    const multi = bounds.length > 2
    const segLen = arc[b]! - arc[a]!
    const t = multi ? segmentType(pts[a]!, pts[b]!, segLen, last, multi, em) : type
    const rule = fp.byType?.[t]
    const startMove = rule && 'start' in rule ? rule.start : fp.start
    const endMove = rule && 'end' in rule ? rule.end : fp.end
    const doStart = first && !plain && free.start
    const doEnd = !plain && (last ? free.end : (fp.turns ?? true))
    const chord = { x: pts[b]!.x - pts[a]!.x, y: pts[b]!.y - pts[a]!.y }
    const cl = Math.hypot(chord.x, chord.y) || 1
    for (let i = a; i <= b; i++) {
      const p = pts[Math.max(a, i - reach)]!
      const q = pts[Math.min(b, i + reach)]!
      const l = Math.hypot(q.x - p.x, q.y - p.y)
      const dir = l > 1e-6 ? { x: (q.x - p.x) / l, y: (q.y - p.y) / l } : { x: chord.x / cl, y: chord.y / cl }
      const st: PenState = { angle: fp.angle ?? 0, sx: 1, sy: 1, shift: 0 }
      if (doStart) blend(st, startMove, arc[i]! - arc[a]!, segLen, em)
      if (doEnd) blend(st, endMove, arc[b]! - arc[i]!, segLen, em)
      if (i === a && prevDir && fp.follow) {
        const from = Math.atan2(prevDir.y, prevDir.x)
        let delta = Math.atan2(dir.y, dir.x) - from
        if (delta > Math.PI) delta -= Math.PI * 2
        if (delta < -Math.PI) delta += Math.PI * 2
        const steps = Math.ceil(Math.abs(delta) / rad(10))
        for (let k = 1; k < steps; k++) {
          const ang = from + (delta * k) / steps
          prints.push(print(fp, pts[i]!, { x: Math.cos(ang), y: Math.sin(ang) }, st, ks[i] ?? 1, em))
        }
      }
      prints.push(print(fp, pts[i]!, dir, st, ks[i] ?? 1, em))
      if (i === b) prevDir = dir
    }
  }
  return prints
}
