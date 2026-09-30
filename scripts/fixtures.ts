/**
 * 从寒蝉端黑体可变字体抽几个字的真实字重，存成测试数据。
 *
 *   npx tsx scripts/fixtures.ts <ChillDuanSansVF.ttf>
 *
 * 字体来自 https://github.com/Warren2060/ChillDuanSans ，SIL OFL 1.1。
 */
import { writeFileSync } from 'node:fs'
import { openFont } from './glyphs.js'

const path = process.argv[2]
if (!path) {
  console.error('用法: npx tsx scripts/fixtures.ts <ChillDuanSansVF.ttf>')
  process.exit(1)
}
const font = openFont(path)
const chars = '国圆永'
const weights = [400, 700]
const round = (v: number) => Math.round(v * 10) / 10
const data = {
  source: 'ChillDuanSansVF.ttf v1.300, SIL OFL 1.1',
  upm: font.upm,
  glyphs: Object.fromEntries(
    [...chars].map((ch) => [
      ch,
      Object.fromEntries(
        weights.map((w) => [w, font.at(w).rings(ch).map((r) => r.map((p) => [round(p.x), round(p.y)]))]),
      ),
    ]),
  ),
}
const out = 'test/fixtures/chillduansans.json'
writeFileSync(out, JSON.stringify(data))
console.log(`已写入 ${out}`)
