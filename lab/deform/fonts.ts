import { GlobalFonts } from '@napi-rs/canvas'
import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * flexlayer 目录以外的开源字体（OFL 或 Apache），来自 Google Fonts 和 noto-cjk。
 * 配方里直接写名字，第一次用到时下载到 `~/.cache/anyfontweight-lab/fonts` 并注册。
 */
const GF = 'https://cdn.jsdelivr.net/gh/google/fonts@main'
export const EXTRA_FONTS: Record<string, { file: string; url: string; note: string }> = {
  NotoSansBlack: {
    file: 'NotoSansSC-Black.otf',
    url: 'https://cdn.jsdelivr.net/gh/notofonts/noto-cjk@main/Sans/SubsetOTF/SC/NotoSansSC-Black.otf',
    note: '思源黑体 Black（900），比外扩加粗干净，字腔留得住',
  },
  QingKe: { file: 'ZCOOLQingKeHuangYou-Regular.ttf', url: `${GF}/ofl/zcoolqingkehuangyou/ZCOOLQingKeHuangYou-Regular.ttf`, note: '站酷庆科黄油体，粗壮圆润的标题字' },
  ZhiMangXing: { file: 'ZhiMangXing-Regular.ttf', url: `${GF}/ofl/zhimangxing/ZhiMangXing-Regular.ttf`, note: '钟齐志莽行书' },
  LongCang: { file: 'LongCang-Regular.ttf', url: `${GF}/ofl/longcang/LongCang-Regular.ttf`, note: '龙藏体，手写' },
  Pacifico: { file: 'Pacifico-Regular.ttf', url: `${GF}/ofl/pacifico/Pacifico-Regular.ttf`, note: '圆胖的连写英文' },
  Yellowtail: { file: 'Yellowtail-Regular.ttf', url: `${GF}/apache/yellowtail/Yellowtail-Regular.ttf`, note: '细连写英文' },
  KaushanScript: { file: 'KaushanScript-Regular.ttf', url: `${GF}/ofl/kaushanscript/KaushanScript-Regular.ttf`, note: '笔刷连写英文' },
  PermanentMarker: { file: 'PermanentMarker-Regular.ttf', url: `${GF}/apache/permanentmarker/PermanentMarker-Regular.ttf`, note: '马克笔英文' },
}

const dir = join(homedir(), '.cache/anyfontweight-lab/fonts')
const ready = new Set<string>()

/** 名字在 `EXTRA_FONTS` 里就确保已下载、已注册；别的名字原样交给 flexlayer。 */
export async function ensureFont(name: string | undefined): Promise<void> {
  if (!name || ready.has(name)) return
  const spec = EXTRA_FONTS[name]
  if (!spec) return
  const path = join(dir, spec.file)
  if (!existsSync(path)) {
    const res = await fetch(spec.url)
    if (!res.ok) throw new Error(`下载字体 ${name} 失败：${res.status} ${spec.url}`)
    await mkdir(dir, { recursive: true })
    await writeFile(path, Buffer.from(await res.arrayBuffer()))
  }
  if (!GlobalFonts.has(name)) GlobalFonts.registerFromPath(path, name)
  ready.add(name)
}
