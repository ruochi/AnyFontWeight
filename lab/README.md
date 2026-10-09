# 文字变形实验

从任意字体取出轮廓，自动找到每一笔的末端，再按一份 JSON 配方把选中的末端拉长、弯曲、卷起，加上横竖粗细对比和整体倾斜，输出 PNG、SVG 和 flexlayer 的 `.layer`。不需要逐笔数据。

![遥不可及的爱](examples/遥不可及的爱.png)

![春风十里](examples/春风十里.png)

这里的代码只是实验，不属于 `anyfontweight` 的公开接口。

## 流程

1. **取字**：[flexlayer](https://github.com/ruochi/flexlayer) 的 `glyph()` 给出单字的 SVG 路径，展开成折线。
2. **字重和对比**（可选）：`synthWeight` 用本库的 `anyFontWeight` 合成字重，比如寒蝉端黑体只有 300 的轮廓，可以合成到 800。`contrast` 让竖画、横画分别加粗或变细。
3. **找末端**：沿轮廓找约 180° 的凸转弯，要求两侧边近似平行，开口宽度和 `computeMedial` 量出的笔画宽度对得上。逐笔重叠的字体先按外轮廓分组再量，藏在别的笔画里的末端会被去掉。
4. **变形**：把末端那段转弯换成一条从原笔画长出来的飘带。中心线由几段回旋曲线拼成，切线连续；宽度沿长度收细，可以在中段鼓起。
5. **排版和输出**：按配方分行、错位、倾斜，加星星和环线，交给 flexlayer 渲染。

## 用法

```bash
npm install
# 1. 先分析，得到带编号的末端图和清单
npm run lab:analyze -- lab/recipes/遥不可及的爱.json
# 2. 按编号写配方里的 swashes，再渲染
npm run lab:render -- lab/recipes/遥不可及的爱.json
```

结果在 `lab/out/`。也可以直接分析一段文字：`npm run lab:analyze -- 春风十里 ChillDuanSans 300 800`（文字、字体、字重、合成字重）。

分析图里粉色的末端前方开阔，适合夸张；蓝色的末端很快会撞到本字其它笔画。

![末端编号](examples/遥不可及的爱.terminals.png)

`.terminals.json` 里每个末端有：

| 字段 | 含义 |
| --- | --- |
| `id` | 配方里引用它的名字，如 `爱.13` |
| `dir`、`angle` | 末端朝向，`右` 是 0°，顺时针为正 |
| `at` | 末端在字身盒子里的位置，0 到 1 |
| `width` | 笔画宽度（em） |
| `run` | 末端后面笔画保持顺直的长度（em），越长越像一笔长画 |
| `free` | 顺着末端方向到本字其它墨迹的距离（em），`null` 表示一路开阔 |

字重、对比改了之后轮廓会变，编号也可能变，所以分析和渲染用同一份配方。

## 配方

长度单位都是 em，角度是度，顺时针为正。

| 字段 | 含义 |
| --- | --- |
| `lines` | 每行的文字 |
| `font`、`weight` | flexlayer 的字体名和字重。可变字体只能取默认字重 |
| `synthWeight` | 用 `anyFontWeight` 合成的字重 |
| `contrast` | `{ vertical, horizontal }`，竖画、横画各自加粗多少，负数变细 |
| `tracking`、`leading`、`indent` | 字距、行距、每行缩进 |
| `glyphs` | 单字微调 `{ dx, dy, scale, rotate }`，键是字序号或字本身 |
| `skew` | 整体倾斜，正数向右倒 |
| `swashes` | 要变形的末端，见下表 |
| `fill`、`glow`、`background` | 字色、发光、背景（可以写 `linear-gradient(...)`） |
| `decor` | `sparkle`、`dot`、`orbit`，坐标以第一行字身左上角为原点 |

`swashes` 每一项：

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `target` | | 末端编号，同一个字出现多次时写字序号，如 `5.13` |
| `length` | 0.3 | 延长段长度 |
| `bend` | 0 | 延长段总共拐多少度 |
| `curl` | 0 | 末尾卷几圈，正负是方向 |
| `curlRadius` | 0.12 | 开始卷时的半径 |
| `curlTighten` | 0.4 | 卷到最后半径缩到多少倍 |
| `taper` | 0.15 | 末端宽度比例，0 是尖头 |
| `swell` | 0 | 中段鼓起的比例 |
| `holdWidth` | 0.25 | 宽度从第几成长度开始收 |

## 让模型来做

模型不用读写路径坐标，只做三件事：

1. 看 `.terminals.png` 和 `.terminals.json`，挑出要夸张的末端。经验上挑 `free` 为 `null`、`run` 较长、朝向画面空白处的末端，每行一两处就够。
2. 写 `swashes` 和排版参数。
3. 看渲染出的 PNG，调参数再渲染。

## 已知限制

- 黑体类字体效果最好。宋体、楷体的衬线和尖头末端检出率低。
- 延长段只和原字形取并集，不会自动避让别的字，撞上了要改 `bend` 或 `length`。
- `contrast` 偏移量太大时字腔会变形，大约 0.015 em 以内比较稳。
- 输出是折线，没有拟合回贝塞尔曲线。
