import type { Point } from '../../src/types.js'

export type Oriented = { p: Point; t: Point }

export type CpdOptions = {
  /** 位移场的平滑半径，越大越接近整体平移 */
  beta: number
  /** 平滑项的权重 */
  lambda: number
  /** 离群点的比例 */
  outliers?: number
  iterations?: number
  /** 方向相差超过这个角度（度）的点对几乎不配 */
  maxAngle?: number
}

/**
 * 非刚性的 Coherent Point Drift（Myronenko & Song 2010），概率里乘上方向相似度。
 * 把源点 `ys` 当作高斯混合的中心，拉向目标点 `xs`，返回一个平滑的位移场。
 * 每个目标点都要有源点来解释，所以没人认领的笔画会把最近的那一笔拉过去，
 * 两笔挤在同一条线上的情况比逐笔找最近点少。
 */
export function cpd(ys: Oriented[], xs: Oriented[], o: CpdOptions): (p: Point) => Point {
  const M = ys.length
  const N = xs.length
  const identity = (p: Point) => p
  if (M < 3 || N < 3) return identity
  const beta2 = 2 * o.beta * o.beta
  const G = ys.map((a) => ys.map((b) => Math.exp(-((a.p.x - b.p.x) ** 2 + (a.p.y - b.p.y) ** 2) / beta2)))
  const cosMin = Math.cos(((o.maxAngle ?? 40) * Math.PI) / 180)
  const A = ys.map((y) =>
    xs.map((x) => {
      const c = Math.abs(y.t.x * x.t.x + y.t.y * x.t.y)
      return c >= cosMin ? 1 : 0.02
    }),
  )
  const W = ys.map(() => ({ x: 0, y: 0 }))
  let T = ys.map((y) => ({ ...y.p }))
  let s2 = 0
  for (const x of xs) for (const y of ys) s2 += (x.p.x - y.p.x) ** 2 + (x.p.y - y.p.y) ** 2
  s2 /= 2 * M * N
  const w = o.outliers ?? 0.1
  const P = ys.map(() => new Float64Array(N))
  for (let it = 0; it < (o.iterations ?? 50); it++) {
    const c = ((2 * Math.PI * s2) * w * M) / ((1 - w) * N)
    for (let n = 0; n < N; n++) {
      let sum = c
      for (let m = 0; m < M; m++) {
        const d = (xs[n]!.p.x - T[m]!.x) ** 2 + (xs[n]!.p.y - T[m]!.y) ** 2
        const v = Math.exp(-d / (2 * s2)) * A[m]![n]!
        P[m]![n] = v
        sum += v
      }
      for (let m = 0; m < M; m++) P[m]![n]! /= sum
    }
    const P1 = new Float64Array(M)
    const PX = ys.map(() => ({ x: 0, y: 0 }))
    let Np = 0
    const Pt1 = new Float64Array(N)
    for (let m = 0; m < M; m++)
      for (let n = 0; n < N; n++) {
        const v = P[m]![n]!
        P1[m]! += v
        Pt1[n]! += v
        PX[m]!.x += v * xs[n]!.p.x
        PX[m]!.y += v * xs[n]!.p.y
      }
    for (let m = 0; m < M; m++) Np += P1[m]!
    if (Np < 1e-6) break
    // (diag(P1)·G + λσ²I)·W = PX − diag(P1)·Y
    const L = ys.map((_, i) => ys.map((__, j) => P1[i]! * G[i]![j]! + (i === j ? o.lambda * s2 : 0)))
    const rhs = ys.map((y, i) => ({ x: PX[i]!.x - P1[i]! * y.p.x, y: PX[i]!.y - P1[i]! * y.p.y }))
    const sol = solve(L, rhs)
    if (!sol) break
    for (let i = 0; i < M; i++) W[i] = sol[i]!
    T = ys.map((y, i) => {
      let dx = 0
      let dy = 0
      for (let j = 0; j < M; j++) {
        dx += G[i]![j]! * W[j]!.x
        dy += G[i]![j]! * W[j]!.y
      }
      return { x: y.p.x + dx, y: y.p.y + dy }
    })
    let a = 0
    for (let n = 0; n < N; n++) a += Pt1[n]! * (xs[n]!.p.x ** 2 + xs[n]!.p.y ** 2)
    let b = 0
    let cc = 0
    for (let m = 0; m < M; m++) {
      b += PX[m]!.x * T[m]!.x + PX[m]!.y * T[m]!.y
      cc += P1[m]! * (T[m]!.x ** 2 + T[m]!.y ** 2)
    }
    const next = Math.max((a - 2 * b + cc) / (2 * Np), 1e-8)
    if (Math.abs(s2 - next) < 1e-10) break
    s2 = next
  }
  return (p: Point) => {
    let dx = 0
    let dy = 0
    for (let j = 0; j < M; j++) {
      const g = Math.exp(-((p.x - ys[j]!.p.x) ** 2 + (p.y - ys[j]!.p.y) ** 2) / beta2)
      dx += g * W[j]!.x
      dy += g * W[j]!.y
    }
    return { x: p.x + dx, y: p.y + dy }
  }
}

/** 高斯消元，右边是二维向量。 */
function solve(A: number[][], b: Point[]): Point[] | null {
  const n = A.length
  const M = A.map((row, i) => [...row, b[i]!.x, b[i]!.y])
  for (let col = 0; col < n; col++) {
    let piv = col
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r
    if (Math.abs(M[piv]![col]!) < 1e-12) return null
    ;[M[col], M[piv]] = [M[piv]!, M[col]!]
    const pr = M[col]!
    for (let r = col + 1; r < n; r++) {
      const row = M[r]!
      const f = row[col]! / pr[col]!
      if (f === 0) continue
      for (let j = col; j < n + 2; j++) row[j]! -= f * pr[j]!
    }
  }
  const out: Point[] = Array.from({ length: n }, () => ({ x: 0, y: 0 }))
  for (let i = n - 1; i >= 0; i--) {
    let sx = M[i]![n]!
    let sy = M[i]![n + 1]!
    for (let j = i + 1; j < n; j++) {
      sx -= M[i]![j]! * out[j]!.x
      sy -= M[i]![j]! * out[j]!.y
    }
    out[i] = { x: sx / M[i]![i]!, y: sy / M[i]![i]! }
  }
  return out
}
