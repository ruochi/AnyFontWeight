export type Point = { x: number; y: number }

/** 闭合折线，不重复首点。方向任意。坐标系 y 轴向下，和 Canvas 一致。 */
export type Ring = Point[]

/**
 * 加密后的闭合轮廓。
 * `corner[i]` 为真表示原始顶点在这里拐了超过 25°。
 */
export type Contour = { pts: Point[]; corner: boolean[] }

export type AnyFontWeightOptions = {
  /** 轮廓现在对应的字重，默认 400 */
  from?: number
  /** 目标字重 */
  to: number
  /**
   * 1 em 在当前坐标系里的长度。
   * 不传时用所有点的外框长边估算，字形本身很扁时会偏小，正式使用请传入字号。
   */
  em?: number
}
