import { renderLayer } from 'flexlayer'

export type Shape = string

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function n(v: number): string {
  const r = Math.round(v * 100) / 100
  return String(Object.is(r, -0) ? 0 : r)
}

export function layerDoc(width: number, height: number, background: string, body: Shape[]): string {
  return `<layer width="${n(width)}" height="${n(height)}" background="${esc(background)}" safe="0">\n${body.join('\n')}\n</layer>\n`
}

/** 文字标签。flexlayer 的文字要包一层 layer 才能定位。 */
export function label(x: number, y: number, text: string, color: string, size: number): Shape {
  return `<layer x="${n(x)}" y="${n(y)}" anchor="center" color="${color}"><p style="font-family:Inter; font-weight:700; font-size:${n(size)}px; white-space:nowrap">${esc(text)}</p></layer>`
}

export async function toPng(doc: string, scale = 1): Promise<Buffer> {
  const { png, report } = await renderLayer(doc, { scale })
  const errors = report.issues.filter((i) => i.level === 'error')
  const fatal = errors.filter((i) => i.code !== 'overflow-canvas')
  if (fatal.length) throw new Error(fatal.map((e) => `${e.path}: ${e.message}`).join('\n'))
  if (errors.length) console.warn(`有 ${errors.length} 处着墨超出画布，已裁掉`)
  return Buffer.from(png)
}
