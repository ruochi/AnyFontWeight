# anyfontweight

从一份字形轮廓合成其它字重。库只接收闭合折线，返回移动后的折线，不读取字体文件。

中轴每个字形算一次，之后换字重只是沿法线移动原来的点，拐角用斜接保持尖锐。

## 用法

```ts
import { anyFontWeight } from 'anyfontweight'

const regular = [
  [
    { x: 0, y: 40 },
    { x: 100, y: 40 },
    { x: 100, y: 60 },
    { x: 0, y: 60 },
  ],
]

const bold = anyFontWeight(regular, { from: 400, to: 700, em: 100 })
```

`em` 是 1 em 在当前坐标系里的长度，通常就是字号。不传时用外框长边估算。坐标系 y 轴向下。

互相重叠的笔画要先在外面合并成不自交的轮廓。

## 默认位移

每相差 100 字重，轮廓沿外法线移动 0.006 em。横竖笔画一视同仁。加粗量不超过该点外侧空隙的 60%，变细时笔画半宽不低于 0.004 em。

这是保守默认值。横竖比例、按笔画密度加减、外框收缩都留在 `ReweightParams` 里，默认关闭。

## 开发

需要 Node.js 20 或更高版本。

```bash
npm install
npm test
npm run build
```

## 许可

MIT，见 [LICENSE](LICENSE)。
