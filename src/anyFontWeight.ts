import { boundsOf, prepareRings } from './geometry.js'
import { computeMedial } from './medial.js'
import { paramsForWeight, reweight } from './reweight.js'
import type { AnyFontWeightOptions, Ring } from './types.js'

/**
 * 把一组闭合轮廓从 `from` 字重变到 `to` 字重。
 * 先量每个点的笔画半宽和外侧空隙，再沿外法线移动原来的点。
 * 相同字重时返回加密、统一朝向之后的轮廓，形状不变。
 */
export function anyFontWeight(rings: Ring[], options: AnyFontWeightOptions): Ring[] {
  const em = options.em ?? Math.max(boundsOf(rings).width, boundsOf(rings).height, 1)
  const contours = prepareRings(rings, Math.max(em * 0.008, 1e-4))
  if (contours.length === 0) return []
  return reweight(computeMedial(contours, em), paramsForWeight(options.from ?? 400, options.to, em))
}
