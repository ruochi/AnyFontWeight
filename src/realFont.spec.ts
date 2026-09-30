import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { selfIntersections } from '../scripts/check.js'
import { inkArea, iou, rasterize, type Box } from '../scripts/raster.js'
import { variableGlyph } from './anyFontWeight.js'
import type { Ring } from './types.js'

type Fixture = { upm: number; glyphs: Record<string, Record<string, [number, number][][]>> }

const fixture: Fixture = JSON.parse(readFileSync(new URL('../test/fixtures/chillduansans.json', import.meta.url), 'utf8'))
const rings = (ch: string, w: number): Ring[] => fixture.glyphs[ch]![w]!.map((r) => r.map(([x, y]) => ({ x, y })))
const box: Box = { x: -100, y: -950, size: 1200 }
const R = 400

/** 按寒蝉端黑体 300–800 的实测结果校准 */
const TUNED = { perHundred: 0.0085, k: 0.89, shrink: 0.007 }

describe('对照寒蝉端黑体的真实字重', () => {
  for (const ch of Object.keys(fixture.glyphs)) {
    it(`${ch}：400 生成的 700 比原字更接近真实 700`, () => {
      const src = rings(ch, 400)
      const truth = rasterize(rings(ch, 700), box, R)
      const unchanged = iou(rasterize(src, box, R), truth)

      const byDefault = variableGlyph(src, { from: 400, em: fixture.upm })(700)
      expect(iou(rasterize(byDefault, box, R), truth)).toBeGreaterThan(unchanged + 0.15)

      const tuned = variableGlyph(src, { from: 400, em: fixture.upm, ...TUNED })(700)
      const gen = rasterize(tuned, box, R)
      expect(iou(gen, truth)).toBeGreaterThan(unchanged + 0.2)
      expect(inkArea(gen) / inkArea(truth)).toBeGreaterThan(0.95)
      expect(inkArea(gen) / inkArea(truth)).toBeLessThan(1.05)
    })
  }

  it('加粗和变细都不产生自交的小圈', () => {
    for (const ch of Object.keys(fixture.glyphs)) {
      const at = variableGlyph(rings(ch, 400), { from: 400, em: fixture.upm, ...TUNED })
      for (const w of [300, 800]) {
        for (const ring of at(w)) expect(selfIntersections(ring)).toBe(0)
      }
    }
  })
})
