import type { Point, Ring } from '../../src/types.js'
import { circle, union } from './bool.js'
import { pathToRings } from './outline.js'

/**
 * 装饰用的小图标，都画在 100×100 的方框里，y 向下，中心是 (50, 50)。
 * 配方里写 `{ "type": "icon", "name": "paper-plane", "at": [x, y], "size": 0.5 }`。
 */
export type IconName = 'paper-plane' | 'sun' | 'wave' | 'plane' | 'mountain' | 'spark'

const fromPath = (d: string): Ring[] => pathToRings(d, 0.4)

function ray(c: Point, angle: number, r0: number, r1: number, w0: number, w1: number): Ring {
  const a = (angle * Math.PI) / 180
  const t = { x: Math.cos(a), y: Math.sin(a) }
  const nrm = { x: -t.y, y: t.x }
  const at = (r: number, w: number, side: number) => ({ x: c.x + t.x * r + nrm.x * w * side, y: c.y + t.y * r + nrm.y * w * side })
  return [at(r0, w0 / 2, 1), at(r1, w1 / 2, 1), at(r1 + w1 * 0.35, 0, 1), at(r1, w1 / 2, -1), at(r0, w0 / 2, -1)]
}

const ICONS: Record<IconName, () => Ring[]> = {
  /** 纸飞机：三块之间留细缝，像折痕 */
  'paper-plane': () =>
    fromPath(
      [
        'M97 5 L3 41 L33 55 Z',
        'M97 5 L38 59 L43 93 L56 70 Z',
        'M97 5 L61 73 L85 84 Z',
      ].join(''),
    ),
  /** 升起的太阳：半圆加七道光芒 */
  sun: () => {
    const c = { x: 50, y: 74 }
    const dome = fromPath('M24 74 C24 59.6 35.6 48 50 48 C64.4 48 76 59.6 76 74 Z')
    const rays = [-165, -138, -112, -90, -68, -42, -15].map((a, i) => ray(c, a, 33, i === 3 ? 52 : 47, 3, 6.5))
    return union([...dome, ...rays])
  },
  /** 卷起的浪头，浪尖朝左，底下一条浪身 */
  wave: () =>
    union([
      ...fromPath(
        'M2 94 C18 92 26 80 30 64 C35 42 50 24 70 22 C86 21 98 32 97 47 C96 60 84 66 75 60 C82 55 83 46 77 41 C70 35 59 40 56 52 C52 70 62 86 98 94 Z',
      ),
      circle({ x: 22, y: 30 }, 4.5, 20),
      circle({ x: 12, y: 44 }, 3, 16),
      circle({ x: 32, y: 18 }, 2.6, 16),
    ]),
  /** 客机侧影，机头朝右上 */
  plane: () =>
    fromPath(
      [
        'M92 10 C97 5 99 9 95 14 L68 40 L74 86 L66 90 L52 52 L30 72 L31 84 L25 87 L19 72 L5 64 L9 59 L22 62 L44 42 L10 26 L15 19 L60 28 Z',
      ].join(''),
    ),
  /** 两座山连在一起，左高右低 */
  mountain: () => fromPath('M2 90 L38 22 L52 48 L62 34 L98 90 Z'),
  /** 四角星 */
  spark: () => fromPath('M50 2 C54 38 62 46 98 50 C62 54 54 62 50 98 C46 62 38 54 2 50 C38 46 46 38 50 2 Z'),
}

export const ICON_NAMES = Object.keys(ICONS) as IconName[]

/** 图标放到 `at` 为中心、宽 `size` 的地方，绕中心转 `rotate` 度，`flip` 左右翻转。 */
export function icon(name: IconName, at: Point, size: number, rotate = 0, flip = false): Ring[] {
  const make = ICONS[name]
  if (!make) throw new Error(`没有叫「${name}」的图标，可选：${ICON_NAMES.join('、')}`)
  const k = size / 100
  const a = (rotate * Math.PI) / 180
  const cos = Math.cos(a)
  const sin = Math.sin(a)
  return make().map((r) =>
    r.map((p) => {
      const x = ((flip ? 100 - p.x : p.x) - 50) * k
      const y = (p.y - 50) * k
      return { x: at.x + x * cos - y * sin, y: at.y + x * sin + y * cos }
    }),
  )
}
