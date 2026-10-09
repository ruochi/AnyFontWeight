import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Point, Ring } from '../../src/types.js'
import { pathToRings } from './outline.js'

/**
 * Make Me a Hanzi 的逐笔数据（经 hanzi-writer-data 分发，Arphic Public License）。
 * 每个字给出按笔顺排列的笔画轮廓和中心线。原始坐标在 1024 的方框里、y 向上、基线在 0、
 * 顶在 900；这里统一翻成 y 向下：y' = 900 - y。
 */
export type HanziData = { char: string; strokes: Ring[][]; medians: Point[][] }

const CDN = 'https://cdn.jsdelivr.net/npm/hanzi-writer-data@2.0'
const CACHE = join(homedir(), '.cache', 'anyfontweight-lab', 'hanzi')
const memo = new Map<string, HanziData | null>()

const flip = (p: Point): Point => ({ x: p.x, y: 900 - p.y })

export async function loadHanzi(char: string): Promise<HanziData | null> {
  if (memo.has(char)) return memo.get(char)!
  const file = join(CACHE, `${char.codePointAt(0)!.toString(16)}.json`)
  let raw: string | null = null
  try {
    raw = await readFile(file, 'utf8')
  } catch {
    try {
      const res = await fetch(`${CDN}/${encodeURIComponent(char)}.json`)
      raw = res.ok ? await res.text() : 'null'
    } catch {
      raw = null
    }
    if (raw != null) {
      await mkdir(CACHE, { recursive: true })
      await writeFile(file, raw)
    }
  }
  const json = raw ? (JSON.parse(raw) as { strokes: string[]; medians: Array<Array<[number, number]>> } | null) : null
  const data = json
    ? {
        char,
        strokes: json.strokes.map((d) => pathToRings(d, 2).map((r) => r.map(flip))),
        medians: json.medians.map((m) => m.map(([x, y]) => flip({ x, y }))),
      }
    : null
  memo.set(char, data)
  return data
}
