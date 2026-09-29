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

互相重叠的笔画要先在外面合并成不自交的轮廓。可变字体通常保留重叠，取出来之后先按非零规则求并集。

连续调节字重时用 `variableGlyph`，笔画宽度只量一次：

```ts
import { variableGlyph } from 'anyfontweight'

const at = variableGlyph(regular, { from: 400, em: 100 })
const light = at(300)
const heavy = at(850)
```

各字重的输出点数相同，点和点一一对应。

## 默认位移

每相差 100 字重，轮廓沿外法线移动 0.006 em。横竖笔画一视同仁。加粗量不超过该点外侧空隙的 60%，变细时笔画半宽不低于 0.004 em。

这是保守默认值。可以按字体调整：

| 选项 | 含义 | 默认 | 寒蝉端黑体实测 |
| --- | --- | --- | --- |
| `perHundred` | 每 100 字重每侧移动多少 em | 0.006 | 0.0085 |
| `k` | 横笔画相对竖笔画的加粗比例 | 1 | 0.89 |
| `shrink` | 每 100 字重整字向中心收缩的比例 | 0 | 0.007 |

实测值来自寒蝉端黑体可变字体（300–800，两个母版线性插值）。用 400 生成 700 时，按默认值与真实 700 的重合率是 0.80，按实测值是 0.84，原字不动是 0.59。按笔画密度加减留在 `ReweightParams` 里，默认关闭。

变化幅度很大时（比如一次跨 400 字重以上），一笔以尖头汇入另一笔的地方可能出现自交。

## 开发

需要 Node.js 20 或更高版本。

```bash
npm install
npm test
npm run build
```

用真实字体看效果：

```bash
npm run weights -- <字体文件> --chars 永国圆 --out weights.png
```

静态字体从它自己的字重出发，画出 300–900。可变字体会同时取出每个字重的真实轮廓，叠在一起画，并打印重合率和面积比。`--per100`、`--k`、`--shrink` 对应上面的选项。

测试里用到的真实字重数据从寒蝉端黑体抽取（`npx tsx scripts/fixtures.ts <ChillDuanSansVF.ttf>`），按 SIL OFL 1.1 授权，见 [test/fixtures/ChillDuanSans-OFL.txt](test/fixtures/ChillDuanSans-OFL.txt)。

## 许可

MIT，见 [LICENSE](LICENSE)。
