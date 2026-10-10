import type { BrushParams } from './skelops.js'

/** 毛笔按笔画类型的压感。数组沿一笔均匀分布，1 是基准笔宽。 */
const KAI_PRESSURE: NonNullable<BrushParams['pressureByType']> = {
  横: [1.3, 0.85, 0.8, 0.85, 1.25, 0.95],
  竖: [1.3, 0.95, 0.9, 0.9, 0.95, 0.85],
  撇: [1.2, 1, 0.75, 0.45, 0.2],
  捺: [0.35, 0.65, 0.95, 1.35, 1.2],
  点: [0.55, 1.3, 1.15],
  提: [1.35, 0.85, 0.35],
  折: [1.25, 0.85, 0.85, 1.15, 0.95, 0.8],
}

const KAI_TAPER: NonNullable<BrushParams['taperByType']> = {
  撇: [0, 0.14],
  捺: [0.05, 0.09],
  提: [0, 0.1],
  点: [0.03, 0],
  竖: [0, 0.04],
}

/**
 * 笔刷预设。配方里写 `{ "op": "brush", "preset": "毛笔" }`，再写别的参数可以覆盖。
 * `width` 都是 em，按 NotoSans 400 左右的笔画宽度定。
 */
export const BRUSHES: Record<string, BrushParams & { note: string }> = {
  单线: { note: '等宽圆头细线', width: 0.028, cap: 'round' },
  圆体: { note: '等宽圆头粗线', width: 0.085, cap: 'round' },
  方头: { note: '等宽平头，折角是尖的', width: 0.065, cap: 'butt', join: 'miter' },
  楷意: { note: '沿用开源数据里楷体的逐点笔宽', width: 'source' },
  毛笔: {
    note: '斜椭圆笔尖加按笔画类型的压感：横细竖粗，起收有顿笔，撇和提出锋，捺先轻后重再出锋，折笔每段各算',
    width: 0.085,
    pressureByType: KAI_PRESSURE,
    taperByType: KAI_TAPER,
    tip: { angle: -25, thin: 0.55 },
  },
  飞白: {
    note: '毛笔加飞白：笔毛越往后、越靠边越容易断开',
    width: 0.085,
    pressureByType: KAI_PRESSURE,
    taperByType: KAI_TAPER,
    bristles: { count: 9, dry: 0.65 },
  },
  平笔: { note: '扁笔尖斜 35°，方向不同粗细不同', width: 0.1, pen: 'nib', nibAngle: -35, nibThin: 0.18 },
  马克笔: { note: '宽扁笔头，粗细变化小', width: 0.08, pen: 'nib', nibAngle: -15, nibThin: 0.6 },
  横细竖粗: {
    note: '按笔画类型定宽，像宋体、黑体的粗细对比',
    width: 0.05,
    widthByType: { 横: 0.022, 提: 0.03, 竖: 0.075, 撇: 0.06, 捺: 0.07, 点: 0.07, 折: 0.045 },
    cap: 'butt',
    join: 'miter',
  },
  勾线: { note: '两头尖、中间略粗的细线，像钢笔勾线', width: 0.032, pressure: [0.4, 1, 1, 0.4], taper: [0.05, 0.05] },
  空心: { note: '粗圆头描成空心双线', width: 0.11, cap: 'round', hollow: 0.016 },
  点阵: { note: '沿笔画等距排圆点', width: 0.042, stamp: { shape: 'circle', spacing: 0.06, scale: 1 } },
}
