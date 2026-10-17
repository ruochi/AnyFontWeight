import type { Point, Ring } from '../../src/types.js'
import { circle } from './bool.js'

export type ShapeName = 'circle' | 'ring' | 'square' | 'diamond' | 'triangle' | 'sparkle' | 'drop'

function poly(c: Point, r: number, sides: number, rot: number): Ring {
  return Array.from({ length: sides }, (_, i) => {
    const a = rot + (i / sides) * Math.PI * 2
    return { x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r }
  })
}

/** 以 c 为中心、外接尺寸约为 size 的图形。`angle` 是图形朝向（度），水滴和三角形会用到。 */
export function shape(name: ShapeName, c: Point, size: number, angle = -90): Ring[] {
  const r = size / 2
  const rot = (angle * Math.PI) / 180
  switch (name) {
    case 'circle':
      return [circle(c, r)]
    case 'ring':
      return [circle(c, r), circle(c, r * 0.55).reverse()]
    case 'square':
      return [poly(c, r * Math.SQRT2 * 0.9, 4, Math.PI / 4)]
    case 'diamond':
      return [poly(c, r, 4, 0)]
    case 'triangle':
      return [poly(c, r, 3, rot)]
    case 'sparkle': {
      const pts: Point[] = []
      for (let i = 0; i < 64; i++) {
        const a = (i / 64) * Math.PI * 2
        // 星芒形：|cos|^k 让四个尖角变细
        const k = Math.pow(Math.abs(Math.cos(2 * a)), 6)
        const rr = r * (0.18 + 0.82 * k)
        pts.push({ x: c.x + Math.cos(a) * rr, y: c.y + Math.sin(a) * rr })
      }
      return [pts]
    }
    case 'drop': {
      const pts: Point[] = []
      for (let i = 0; i < 48; i++) {
        const t = (i / 48) * Math.PI * 2
        // 水滴：尖头朝 angle 方向
        const x = Math.cos(t) * r * 0.7
        const y = Math.sin(t) * r * 0.7 * Math.pow(Math.sin(t / 2), 0.9)
        const px = -x + r * 0.15
        pts.push({ x: c.x + px * Math.cos(rot) - y * Math.sin(rot), y: c.y + px * Math.sin(rot) + y * Math.cos(rot) })
      }
      return [pts]
    }
  }
}
