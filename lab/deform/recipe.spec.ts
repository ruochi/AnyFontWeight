import { describe, expect, it } from 'vitest'
import { ensureFont, EXTRA_FONTS } from './fonts.js'
import { icon, ICON_NAMES, type IconName } from './icons.js'
import { pathToRings, ringsBounds } from './outline.js'
import { compose, toDocuments, type Recipe } from './recipe.js'

const em = 400

describe('图标', () => {
  it('每个图标都放进给定宽度的方框里', () => {
    for (const name of ICON_NAMES) {
      const b = ringsBounds(icon(name, { x: 100, y: 100 }, 50))
      expect(b.minX).toBeGreaterThanOrEqual(74)
      expect(b.maxX).toBeLessThanOrEqual(126)
      expect(b.maxY - b.minY).toBeGreaterThan(10)
    }
  })

  it('没有这个名字就报错', () => {
    expect(() => icon('rocket' as IconName, { x: 0, y: 0 }, 10)).toThrow(/没有叫「rocket」的图标/)
  })
})

describe('描边和装饰', () => {
  const base: Recipe = { lines: ['一'], font: 'NotoSans', size: em }

  it('字的描边比字本身大一圈', async () => {
    const c = await compose({ ...base, outline: { width: 0.05 } })
    const inner = ringsBounds(c.rings)
    const outer = ringsBounds(c.outline!)
    expect(inner.minX - outer.minX).toBeCloseTo(0.05 * em, 0)
    expect(outer.maxY - inner.maxY).toBeCloseTo(0.05 * em, 0)
  })

  it('each 时逐字描边，按 z 从小到大叠放', async () => {
    const r: Recipe = { ...base, lines: ['一二'], outline: { width: 0.04, each: true }, glyphs: { '0': { z: 1 } } }
    const c = await compose(r)
    expect(c.outline).toBeUndefined()
    expect(c.stack).toHaveLength(2)
    const [first, second] = c.stack!.map((g) => ringsBounds(g.rings).minX)
    expect(first).toBeGreaterThan(second!)
    for (const g of c.stack!) expect(ringsBounds(g.outline).minX).toBeCloseTo(ringsBounds(g.rings).minX - 0.04 * em, 0)
    const { layer } = toDocuments(r, c)
    expect(layer.match(/fill="#000000"/g)).toHaveLength(2)
  })

  it('收尖的线两头是尖的，中间是满宽', async () => {
    const c = await compose({
      ...base,
      decor: [{ type: 'line', points: [[0, 2], [1, 2]], width: 0.1, taper: 0.5 }],
    })
    const pts = pathToRings(/d="([^"]+)"/.exec(c.decor[0]!.layer)![1]!).flat()
    const halfAt = (x: number) => Math.max(...pts.filter((p) => Math.abs(p.x - x) < 0.02 * em).map((p) => Math.abs(p.y - 2 * em)))
    expect(halfAt(0)).toBeLessThan(0.006 * em)
    expect(halfAt(em)).toBeLessThan(0.006 * em)
    expect(halfAt(0.5 * em)).toBeCloseTo(0.05 * em, 0)
  })

  it('above 的装饰画在字上面，描边紧挨着画在它下面', async () => {
    const r: Recipe = {
      ...base,
      outline: { width: 0.03, color: '#111111' },
      decor: [
        { type: 'dot', at: [0.5, 0.2], size: 0.1, color: '#ff0000' },
        { type: 'icon', name: 'spark', at: [0.5, 0.5], size: 0.2, color: '#00ff00', outline: 0.02, outlineColor: '#0000ff', above: true },
      ],
    }
    const { layer, svg } = toDocuments(r, await compose(r))
    for (const doc of [layer, svg]) {
      const at = (s: string) => doc.indexOf(s)
      expect(at('#ff0000')).toBeLessThan(at('#111111'))
      expect(at('#111111')).toBeLessThan(at('#0000ff'))
      expect(at('#0000ff')).toBeLessThan(at('#00ff00'))
    }
  })
})

describe('额外字体', () => {
  it('不在清单里的名字原样交给 flexlayer', async () => {
    await expect(ensureFont('NotoSans')).resolves.toBeUndefined()
    await expect(ensureFont(undefined)).resolves.toBeUndefined()
  })

  it('清单里每个字体都有文件名和地址', () => {
    for (const [name, f] of Object.entries(EXTRA_FONTS)) {
      expect(f.url, name).toMatch(/^https:\/\/.+\.(ttf|otf)$/)
      expect(f.url.endsWith(f.file), name).toBe(true)
    }
  })
})
