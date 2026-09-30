import type { Ring } from '../src/types.js'

export type Box = { x: number; y: number; size: number }
export type Mask = { w: number; data: Uint8Array }

/** 按非零环绕规则栅格化，每个像素取中心采样。 */
export function rasterize(rings: Ring[], box: Box, w: number, rule: 'nonzero' | 'evenodd' = 'nonzero'): Mask {
  const data = new Uint8Array(w * w)
  const px = box.size / w
  for (let row = 0; row < w; row++) {
    const y = box.y + (row + 0.5) * px
    const hits: { x: number; dir: number }[] = []
    for (const r of rings) {
      for (let i = 0; i < r.length; i++) {
        const a = r[i]!
        const b = r[(i + 1) % r.length]!
        if (a.y > y === b.y > y) continue
        hits.push({ x: a.x + ((y - a.y) * (b.x - a.x)) / (b.y - a.y), dir: b.y > a.y ? 1 : -1 })
      }
    }
    hits.sort((p, q) => p.x - q.x)
    let wind = 0
    for (let k = 0; k < hits.length - 1; k++) {
      wind = rule === 'nonzero' ? wind + hits[k]!.dir : wind ^ 1
      if (wind === 0) continue
      const c0 = Math.max(0, Math.ceil((hits[k]!.x - box.x) / px - 0.5))
      const c1 = Math.min(w - 1, Math.floor((hits[k + 1]!.x - box.x) / px - 0.5))
      for (let c = c0; c <= c1; c++) data[row * w + c] = 1
    }
  }
  return { w, data }
}

export function inkArea(m: Mask): number {
  let s = 0
  for (const v of m.data) s += v
  return s
}

export function iou(a: Mask, b: Mask): number {
  let inter = 0
  let union = 0
  for (let i = 0; i < a.data.length; i++) {
    inter += a.data[i]! & b.data[i]!
    union += a.data[i]! | b.data[i]!
  }
  return union ? inter / union : 1
}
