# 文字变形实验

从任意字体取出轮廓，自动分析出每一笔的末端和骨架，再按一份 JSON 配方逐步改造字形：拉长卷起末端、改末端形状、用单线笔或扁笔尖重描、把点换成圆、倒圆角、切开、几何化、加内刻线，最后排版加装饰，输出 PNG、SVG 和 flexlayer 的 `.layer`。不需要逐笔数据。

![总览](examples/gallery.png)

`lab/recipes` 里每份配方对应一种风格，`npm run lab:gallery` 把它们全部渲染后拼成上面这张图。

这里的代码只是实验，不属于 `anyfontweight` 的公开接口。

## 流程

1. **取字**：[flexlayer](https://github.com/ruochi/flexlayer) 的 `glyph()` 给出单字的 SVG 路径，展开成折线。
2. **字重和对比**（可选）：`synthWeight` 用本库的 `anyFontWeight` 合成字重，比如寒蝉端黑体只有 300 的轮廓，可以合成到 800。`contrast` 让竖画、横画分别加粗或变细。
3. **分析**，两套互相补充：
   - **末端**：沿轮廓找约 180° 的凸转弯，要求两侧边近似平行，开口宽度和 `computeMedial` 量出的笔画宽度对得上。逐笔重叠的字体先按外轮廓分组再量，藏在别的笔画里的末端会被去掉。
   - **骨架**：把字栅格化，做距离变换和细化，得到中心线图。图里有端点、交叉点和边；在交叉点把走势最顺的两条边接成一笔，再按长度、角度、转折分成横、竖、撇、捺、点、提、折。独立的小块记为「点」。
4. **逐字操作**：配方里的 `steps` 依次作用在每个字上。末端类操作改轮廓的局部，骨架类操作按中心线重新生成轮廓，形状类操作用 [Clipper](http://www.angusj.com/delphi/clipper.php) 做布尔运算和偏移。
5. **排版**：按配方分行、错位、倾斜。
6. **整段操作**：`post` 里的操作作用在排好的整段文字上，比如一刀切过所有字。
7. **装饰和输出**：加星星、环线、拼音、线条，交给 flexlayer 渲染。

## 用法

```bash
npm install
# 1. 先分析，得到带编号的末端图、骨架图和清单
npm run lab:analyze -- lab/recipes/遥不可及的爱.json
# 2. 写配方，再渲染
npm run lab:render -- lab/recipes/遥不可及的爱.json
# 3. 全部配方拼一张总览
npm run lab:gallery
```

结果在 `lab/out/`。也可以直接分析一段文字：`npm run lab:analyze -- 春风十里 ChillDuanSans 300 800`（文字、字体、字重、合成字重）。`lab:render` 的第三个参数是缩放，默认 0.5。

分析会输出三份文件：

- `.terminals.png`：末端编号。粉色的末端前方开阔，适合夸张；蓝色的末端很快会撞到本字其它笔画。
- `.skeleton.png`：骨架。颜色是笔画类型，标签是「类型+编号」，白点是交叉点，虚线圈是识别出的点。
- `.analysis.json`：给模型读的清单，`terminals` 和 `strokes` 两部分。

![末端编号](examples/遥不可及的爱.terminals.png)

![骨架](examples/高级动物海棠未雨.skeleton.png)

末端清单里每个末端有：

| 字段 | 含义 |
| --- | --- |
| `id` | 配方里引用它的名字，如 `爱.13` |
| `dir`、`angle` | 末端朝向，`右` 是 0°，顺时针为正 |
| `at` | 末端在字身盒子里的位置，0 到 1 |
| `width` | 笔画宽度（em） |
| `run` | 末端后面笔画保持顺直的长度（em），越长越像一笔长画 |
| `free` | 顺着末端方向到本字其它墨迹的距离（em），`null` 表示一路开阔 |

笔画清单里每一笔有 `id`（如 `雨.s3`）、`type`、`length`、`angle`，以及起止点 `from`、`to`；`dots` 是识别出的点的位置。

前面的操作会改变轮廓，末端编号也跟着变。分析配方时会先执行到第一个按编号点名末端的步骤之前，清单里的编号就是那一步看到的编号，清单的 `stoppedBefore` 记着停在哪一步。

## 配方

长度单位都是 em，角度是度。屏幕坐标 y 向下，0° 朝右，90° 朝下。

| 字段 | 含义 |
| --- | --- |
| `lines` | 每行的文字 |
| `font`、`weight` | flexlayer 的字体名和字重。可变字体只能取默认字重 |
| `synthWeight` | 用 `anyFontWeight` 合成的字重 |
| `contrast` | `{ vertical, horizontal }`，竖画、横画各自加粗多少，负数变细 |
| `tracking`、`leading`、`indent` | 字距、行距、每行缩进 |
| `glyphs` | 单字微调 `{ dx, dy, scale, rotate }`，键是字序号或字本身 |
| `skew` | 整体倾斜，正数向右倒 |
| `steps` | 逐字操作，见下文 |
| `post` | 排版后对整段文字的操作，写法同 `steps` |
| `swashes` | 旧写法，等于排在最前面的 `{ "op": "swash", "items": [...] }` |
| `fill`、`glow`、`background` | 字色、发光、背景（可以写 `linear-gradient(...)`、`radial-gradient(...)`） |
| `attrs` | 原样写到字形上的 flexlayer 效果，如 `{ "inner-shadow": "0 -10 14 #0006", "shadow": "0 14 0 #b23a1f" }` |
| `decor` | 装饰，见下文。坐标以第一行字身左上角为原点 |
| `padding` | 画面四周留白 |

### 操作

每一步写成 `{ "op": "名字", ...参数 }`。加上 `"glyphs": [0, "爱"]` 只作用于部分字，数字是全文字序号，字符串是字本身。

| `op` | 参数 | 作用 |
| --- | --- | --- |
| `swash` | `items: [{ target, ...飘带参数 }]`，或 `select` 加飘带参数 | 末端长出飘带，见下表 |
| `cap` | `style`: `round`、`point`、`cut`、`ball`；`angle`（斜切角，默认 35）；`size`；`select` | 改末端形状 |
| `restroke` | 见下表 | 按骨架用单线笔或扁笔尖重描 |
| `dots` | `shape`、`size` 或 `scale`、`maxSize`（默认 0.2）、`angle` | 把独立的小块换成图形 |
| `round` | `convex`、`concave`（圆角半径） | 凸角、凹角倒圆。凹角半径太大会填死窄字腔 |
| `offset` | `delta`、`join`（`round`、`miter`、`square`） | 整体外扩或内缩。比 `synthWeight` 稳，但字腔会同样变窄 |
| `contrast` | `vertical`、`horizontal` | 同配方里的 `contrast`，可以放在别的操作之后 |
| `outline` | `width` | 只留一圈边，变成空心字 |
| `inline` | `width`、`inset` | 在笔画里离边 `inset` 处刻一道宽 `width` 的线 |
| `slice` | `angle`、`gap`、`at`（0–1，可以是数组）、`shift` | 用直线切开；`shift` 让切线一侧沿切线错开 |
| `geometrize` | `tolerance`、`snap` | 简化轮廓，再把每条边吸附到 `snap` 度的整数倍 |

`restroke` 的参数：

| 参数 | 默认 | 含义 |
| --- | --- | --- |
| `width` | | 笔宽 |
| `widthByType` | | 各类笔画单独的笔宽，如 `{ "竖": 0.05, "横": 0.02 }` |
| `pen` | `round` | `nib` 是扁笔尖，笔尖长 `width`、厚 `width·nibThin`，与水平成 `nibAngle` 度 |
| `nibAngle`、`nibThin` | -40、0.25 | |
| `cap`、`join` | `round`、`round` | 笔头和拐角 |
| `smooth` | 0 | 中心线再平滑多少 |
| `simplify` | 0.002 | 中心线简化容差，大一点更硬朗 |
| `snap` | | 线段方向吸附到多少度的整数倍 |
| `gap` | 0 | 止于别的笔画的一端留缝，像镂空模板字 |
| `fit` | `true` | 自由末端回缩半个笔宽，圆头不超出原字身 |
| `dots` | | `{ shape, size 或 scale, angle }`，点画换成图形 |

图形 `shape` 可选 `circle`、`ring`、`square`、`diamond`、`triangle`、`sparkle`、`drop`。

### 选末端

`swash` 和 `cap` 的 `select`：

| 字段 | 含义 |
| --- | --- |
| `ids` | 末端编号（从 1 起），配合 `glyphs` |
| `dir` | 朝向列表，用 右、右下、下、左下、左、左上、上、右上 |
| `free` | `open` 前方空旷，`blocked` 前方不远处有别的墨迹 |
| `minRun`、`minWidth`、`maxWidth` | 按笔画顺直长度和宽度筛 |
| `region` | 末端落在字身盒子里的范围 `[x0, y0, x1, y1]`，0–1；`post` 里是整段文字的包围盒 |

不写 `select` 就是全部末端。

### 飘带参数

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

### 装饰

| `type` | 参数 |
| --- | --- |
| `sparkle`、`dot` | `at`、`size`、`color` |
| `orbit` | `center`、`rx`、`ry`、`rotate`、`from`、`to`、`width`、`color` |
| `line` | `points`、`width`、`dash`（[实, 虚]）、`cap`、`color` |
| `text` | `text`、`at`（文字块中心）、`size`、`font`、`weight`、`letterSpacing`、`vertical`、`rotate`、`color` |

拼音带声调时用 `Inter` 字体，NotoSans 里没有这些字母。NotoSans 的字身高约 1.45 em，墨迹大致在 y 0.32–1.23 em 之间，摆装饰时可以参考。

## 风格配方

| 配方 | 做法 |
| --- | --- |
| 遥不可及的爱、春风十里 | 选几个开阔的末端长出飘带卷起，加横竖对比和倾斜 |
| 高级动物-细 | 单线圆头重描 |
| 海棠未雨 | 单线方头重描，点换成圆，宽字距，英文副标题和竖排拼音 |
| 高级动物-粗 | 外扩加粗，向下的开阔末端斜切，倾斜 |
| 超能力 | 外扩加粗，排版后整段斜切一刀并错开，渐变加发光 |
| 月光倾城 | 扁笔尖重描，出书写感的粗细变化 |
| 生僻字 | 合成粗字重，大圆角，内阴影加实心投影 |
| 猪事皆闹 | 粗方头重描，交叉处断开，方向吸附到 45° |
| 来日方长 | 外扩，几何化吸附 45°，内刻线 |

![海棠未雨](examples/海棠未雨.png)

![猪事皆闹](examples/猪事皆闹.png)

![月光倾城](examples/月光倾城.png)

## 让模型来做

模型不用读写路径坐标，只做三件事：

1. 看分析图和 `.analysis.json`，决定改哪里。末端类效果挑 `free` 为 `null`、`run` 较长、朝向画面空白处的末端，每行一两处就够；批量效果用 `select` 按朝向、区域筛。骨架类效果看 `strokes` 的类型和点的位置。
2. 写 `steps`、`post` 和排版参数。
3. 看渲染出的 PNG，调参数再渲染。

## 已知限制

- 黑体类字体效果最好。宋体、楷体的衬线和尖头末端检出率低。
- 骨架在笔画交叉很密的字上（如「母」里的两点）会接出短斜线；挨得很近的两个交叉点会被并成一个。
- 只有独立成块的点会被 `dots` 换掉，粘在别的笔画上的点不会。
- `synthWeight` 合成到很粗时，笔画重叠处会出小尖刺，`offset` 更干净。
- `round` 的凹角半径和 `offset` 都会让窄字腔变窄甚至填死。
- 延长段只和原字形取并集，不会自动避让别的字，撞上了要改 `bend` 或 `length`。
- `contrast` 偏移量太大时字腔会变形，大约 0.015 em 以内比较稳。
- 输出是折线，没有拟合回贝塞尔曲线。
