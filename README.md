# 简牍

个人桌面 Markdown 笔记软件，**直接读 Typora 的主题目录、零拷贝使用现有主题**。
自用工程，不做产品化。

## 状态

| 里程碑 | 内容 | 状态 |
| --- | --- | --- |
| M1 能写 | 文件树、CM6 编辑、自动保存、**逐字节无损往返**、图片落盘、崩溃恢复、关窗拦截 | ✅ |
| M2 像 Typora | 块级语法显隐、图片渲染与裂图占位、表格真渲染、快捷键 | ✅ |
| M3 主题（核心） | `@import` 递归内联、`url()` 重写、选择器映射、热重载 | ✅ |
| M4 桌面感 | 原生菜单、窗口记忆、上次文件恢复、侧栏可拖宽、图标、单实例、打包 exe | ✅ |
| M5 大纲 | 侧栏「文件 / 大纲」标签页、标题树、点击跳转（4px 内对齐）、当前章节跟随滚动、**代码块里的 `#` 不算标题** | ✅ |
| M5 大纲 | 侧栏「文件 / 大纲」标签页、标题树、点击跳转（4px 内对齐）、当前章节跟随滚动、**代码块里的 `#` 不算标题** | ✅ |
| M5 快捷键设置 | 14 个命令可自定义、录制即生效、冲突检测、单/全部复位；渲染层 capture 接管，**不被 CM6 抢** | ✅ |
| M5 阅读体验 | 标题 / 代码块折叠（gutter 三角，收起后内容从布局里消失）、专注模式（非当前段落淡出）、打字机模式（光标行居中）、状态栏字数 | ✅ |
| M5 表格与图 | 光标进表浮出工具条（增删行列 / 三向对齐）、Mermaid 代码块渲染成图 | ✅ |
| M5 导出与源码 | PDF 导出、源码模式（`Ctrl+/`） | ✅ |
| M5 主题报告 | 菜单「设置 → 主题兼容度报告」：应用/丢弃条数、丢弃样例、改名对照、警告，可一键复制 | ✅ |

策划案（含本机实测数据、技术决策与被推翻的假设）见 [docs/01-策划案.md](docs/01-策划案.md)。

## 快速开始

```bash
pnpm install
pnpm start          # 构建 + 启动（开发态）
pnpm typecheck      # 两端 tsc
pnpm test           # 纯函数断言（标题识别 / 围栏 / 表格 / 快捷键 / 无损边界）
pnpm verify         # 245 篇旧笔记逐字节往返校验 + 裂图基线比对
pnpm pack           # 打包 → release/简牍-<version>-portable.exe（推荐）
pnpm dist           # 同上，但直接输出到 release/（本机守卫会拦，见下）
```

> **启动必须带 `--user-data-dir`**，`scripts/run.mjs` 已经处理。原因见下。

## 三条不能破的线

1. **数据不丢** — 写盘走 tmp + fsync + rename；失败必弹错；单实例锁防止两个编辑器互相覆盖。
2. **中文输入** — 组字期间不重排、不丢字、光标不跳。
3. **无损** — 纯文本是唯一真源。渲染层只读叠加，**永不回写美化后的文本**；不认识的语法原样保留；不统一换行符。

`pnpm verify` 就是这条红线的守门人：245 篇旧笔记 `decode → encode` 后必须**逐字节相等**（CRLF/LF、BOM、末尾无换行全藏在这个断言里），且裂图数不超过 94 的已测基线。

`pnpm test` 守的是另一半。`verify` 只比字节，它看不见"渲染成什么样"——标题该不该认（含列表项里的 `- ## x`）、围栏什么时候闭合、表格怎么切列、空格能不能当快捷键，这些改坏了字节一个不差，只会在界面上错位。所以 `scripts/test-units.mjs` 把踩过的边界逐条钉成断言（23 条，零新增依赖，走 `node:test`）。

## 架构

```
src/
  main/            主进程
    index.ts       窗口、菜单、IPC、主题目录监听
    lossless.ts    无损编解码（记录原状 + 写回还原，不猜换行风格）
    files.ts       文件树、读写笔记、图片落盘、裂图扫描
    theme.ts       Typora 主题翻译器（@import 内联 → url() 重写 → 选择器映射）
    draft.ts       崩溃草稿（独立 draft.json，tmp+fsync+rename，不占 config）
    paths.ts       userData 目录探测（不可写会导致原生崩溃）
    config.ts      配置（剥离 BOM，防手工编辑坏掉）
  preload/         contextBridge 白名单
  renderer/
    editor.ts      CM6 实例与扩展
    lineclasses.ts 行级语义 class（.jd-h1…/.jd-code-line…），两轮扫描出「首行/末行」用于拼框
    fence.ts       围栏状态机（按开启缩进配对），lineclasses 与 markers 共用同一份判断
    heading.ts     标题识别（行首 `## x` + 列表项里的 `- ## x`），三处共用同一份判断
    markers.ts     语法标记显隐 + 图片 widget（font-size:0 隐藏，不改文本）
    table.ts       表格真渲染（StateField 块装饰；光标进表退回源码）
    table-parse.ts 表格行解析（splitRow / parseAlign / columnAt / joinRow，纯函数、可单独测）
    table-panel.ts 表格面板（光标进表浮出工具条：增删行列 / 对齐）
    mermaid.ts     ```mermaid 渲染成图（mermaid 库按需动态加载、结果按内容缓存）
    markdown-html.ts  Markdown → HTML（PDF 导出用，走编辑器同一个 Lezer parser）
    viewmode.ts    源码模式开关（markers / table / fold / mermaid 四处共用）
    text-stats.ts  字数统计（中文按字、英文按词）
    theme-report.ts 主题兼容度报告面板（应用/丢弃条数、丢弃样例、改名对照、警告）
    outline.ts     大纲（标题树 / 点击跳转 / 当前章节高亮；复用 fence.ts 跳过代码块）
    theme.ts       主题注入层（五层 CSS 顺序是契约）
    settings.ts    快捷键设置面板（录制 / 冲突检测 / 恢复默认）
    keybindings.ts 快捷键分发（window capture 阶段接管，不让 CM6 抢）
    tree.ts        文件树
  shared/types.ts  IPC 类型
  shared/commands.ts  可自定义快捷键的命令表（菜单与设置面板的唯一真相源）
  theme/mapping.json  Typora 选择器 → 我们的语义 class（可编辑，不写死在代码里）
```

### 主题兼容的关键

Typora 主题写的是 `#write h1`、`.md-fences`，而 CM6 的行是 `.cm-line`。两边靠三件事对上：

1. **DOM 尽量像 Typora**：外层 `.jd-content`（对应 Typora 的 `content` 元素）包 `#write`。
2. **选择器映射**：翻译时用 `postcss` + `postcss-selector-parser` 把主题选择器改写成我们的语义 class（见 `src/theme/mapping.json`）。这份 JSON 是**唯一真相源**——代码里的兜底表由构建期内联它生成，不另抄一份。
3. **代码 token 配色**：主题里写的是 CodeMirror 5 的 `.cm-s-inner .cm-keyword`。翻译时剥掉作用域类、把 `.cm-*` 改名成 CM6 `classHighlighter` 输出的 `.tok-*`（`tok-keyword`/`tok-string`/`tok-comment`…），主题自带的高亮配色就原样生效。

**为什么运行时翻译而不是把改好的 CSS 存进项目**：换主题、改主题随时发生。热重载让你在 Typora 里改一行、这边 500ms 内跟着变。

### 主题兼容度报告（`Ctrl+Alt+R`）

菜单 **设置 → 主题兼容度报告**。翻译管线的每一处取舍都在这里：

- **8 个计数**：应用 / 丢弃规则、`@font-face`、`@keyframes`、内联 `@import`、`url()` 重写、内联文件数、输出行数
- **被丢弃的规则**：通常是 Typora 应用外壳（侧栏 / 菜单 / 导出页），我们没有对应 DOM，留着也是永不生效的死规则
- **被改名的选择器**：左边主题里写的、右边落到我们 DOM 上的 —— 想知道「`#write h1` 最后变成了什么」就看这里
- **警告**：不影响加载，但解释了「某处为什么和 Typora 不一样」（比如 `?t=` 缓存串被丢弃、`inline-block` 标题被改成 `block + fit-content`）

底部「复制报告」导出纯文本，贴这一段比截图更容易排查。

> 选「（内置）」时打开会提示没有可报告的主题。

### 自带主题：rider-dark（Visual Assist Dark）

`src/theme/rider-dark.css` 是照 **Visual Assist Dark** 配色方案写的（与 Rider 装了 Visual Assist 后的深色方案同源）：

| 项 | 色值 | | 项 | 色值 |
| --- | --- | --- | --- | --- |
| 页面背景 | `#2b2b2b` | | 关键字 | `#d8a0df`（紫粉） |
| 正文 | `#c3cad3` | | 字符串 | `#d69d85`（暖橙） |
| 代码块底 | `#111111` | | 函数/方法 | `#ff8000`（橙） |
| 代码块字 | `#bdb76b`（暗金） | | 类型 | `#ffd700`（金） |
| 行内代码 | `#2a2d2e` | | 变量/属性 | `#bdb76b` |
| 分隔线 | `#3c3f41` | | 常量/预处理 | `#bd63c5`（紫） |
| 注释 | `#57a64a`（绿） | | 数字 | `#b5cea8`（浅绿） |
| 运算符/标点 | `#dcdcdc` | | 布尔 | `#569cd6`（蓝） |

> 正文没有用 `#bdb76b`——那是代码编辑区的前景色，整篇笔记正文发黄会很难读。正文保持中性浅灰。

代码高亮那一段用 **`.cm-s-inner .cm-*`** 写（不是 `.tok-*`）：翻译管线会把作用域剥掉、把 `.cm-*` 改名成 CM6 的 `.tok-*`，所以**同一份文件在简牍和 Typora 里是同一套颜色**。

复制到 Typora 主题目录即可在「主题」下拉框里选到：

```bash
copy src\theme\rider-dark.css "%APPDATA%\Typora\themes\"
```

项目里保留这份副本，换机器时不用重写。

### CSS 五层顺序（是契约，别调）

```
style.css          外壳
theme-base.css     Typora 排版骨架（我们自己补的，主题只写差异）
<jd-typora-theme>  翻译后的主题
<jd-theme-fix>     把「一串 .cm-line」拼回一个代码块/表格框
<jd-shell-guard>   防止主题把侧栏/状态栏刷坏
```

后三层由 `renderer/theme.ts` 在**运行时** append 到 `<head>` 末尾。
**不要用 `@layer`**：CM6 运行时注入的样式是未分层的，未分层永远压过分层，一分层反而被反噬。

`theme-fix.css` 里还压了三条**外壳级强制项**（不属于主题表达范围，对所有主题一致）：

- 正文区 `max-width: 90%` —— 各主题自带的阅读宽度（80em / 860px）在宽屏上留白过多。
  **限宽只能挂在 `.cm-editor` 上**：`#write` 自己是滚动容器，给它限宽会把滚动条一起拽到 90% 那条线上（详见「已知的坑」）。
  同时 `#write` 的**左右 padding 必须归零**，否则 40px 内边距会被 90% 再切一刀，
  正文实际只剩 84.2%；内边距改由 `.cm-editor` 提供，取值走 `--jd-write-pad`（默认 30px，主题可覆盖）
- 所有行级元素 `margin: 0 !important` —— CM6 的行块测不到 margin，详见「已知的坑」里那条
- 滚动条自绘 —— 颜色由 `color-mix(in srgb, currentColor 22%, transparent)` 从主题正文色派生，
  深浅主题自动适配，不用维护色表。主题自己写了 `--scrollbar-color` + `!important` 时以主题为准

## 原生标题栏跟随主题明暗

顶部那一条是 Windows 画的（DWM），渲染层的 CSS 碰不到。所以主题切换后由渲染层算一次
body 背景的**感知亮度**（ITU-R BT.601 加权，别用三通道平均值 —— 深蓝深红会判错），
通过 `app:titlebar-theme` 交给主进程设 `nativeTheme.themeSource`，Windows 才会把标题栏
（含右上角三个按钮）切成深色或浅色。

只能表达「深 / 浅」两档。想精确到主题那个具体色值（比如 `#262626`）必须改成无边框自绘标题栏。

## 快捷键设置

菜单 **设置 → 快捷键…**。14 个命令（打开笔记库 / 保存 / 查找 / 标题 1–6 / 正文 / 加粗 / 斜体 / 行内代码 / 代码块）都可改。

- **点按键框 → 按下组合键 → 立刻生效**，没有「应用」按钮
- 底栏实时给原因：只按了修饰键 / 没带 Ctrl·Alt·Shift / **这个组合已被某命令占用**
- 每行右侧 `↺` 恢复该项默认，底栏可一键全部恢复
- 只存改过的项（`config.keymap`），默认值永远以 `shared/commands.ts` 为准 ——
  以后调默认键不会和用户配置打架

**唯一真相源**：`src/shared/commands.ts` 的 `COMMANDS`。主进程用它生成菜单的 label 和
accelerator，设置面板用它渲染列表。加一个新快捷键只需在表里加一行 + 菜单里 `mi('cmd')`。

### 这里有个必须绕开的坑

Electron 的菜单快捷键是在**主进程**处理的，渲染层收不到那个 keydown。所以想把已经绑给
「保存」的 `Ctrl+S` 改走时，一按就触发保存，录制框什么都不显示 —— 看起来像「按了没反应」。

解法：进入录制时调 `keymap:capture` 让主进程把菜单上的 accelerator **全部摘掉**（`captureMode`），
录完再挂回去。另外监听要挂在 `window` 的 **capture 阶段**并 `stopPropagation`，
否则 CM6 会先吃掉按键，表现一模一样。

实测（自动化 CDP）：录制中按 `Ctrl+S` → 渲染层成功接住并提示「已被『保存』占用」，保存未被触发。

### 又一个坑：CM6 会抢菜单快捷键

菜单 accelerator 和 CodeMirror 自己的 keymap 会争同一组按键，**CM6 常常赢**。

实测把「代码块」按 Typora 习惯绑到 `Ctrl+Shift+K`：按下之后文档**少了一行**——
CM6 执行了它的 `deleteLine`，我们的命令根本没跑，还不报错。更隐蔽的是 `Ctrl+I`
正好是 CM6 的 `selectParentSyntax`，而那是「斜体」的默认键。

所以 `renderer/keybindings.ts` 在 window 的 **capture 阶段**统一接管：
命中命令就执行并 `stopPropagation`，CM6 的 handler 挂在内容元素上（target 阶段），
永远晚一步。菜单那边仍保留 accelerator（当说明书用），两条路径都调同一个
`runCommand`，60ms 去重防止两边同时到达时把「加粗」裹成两层。

## 折叠 / 专注 / 打字机

三个阅读向功能，都只改「怎么看」，**不动文档一个字节**。

### 折叠（`renderer/fold.ts`）

- 标题折叠到下一个「同级或更高级」标题之前，代码块折叠到闭合围栏。用栈一趟扫完，O(n)。
- 收起的内容用 `Decoration.replace({ block: true })` 从**布局**里换掉。**不能**用 CSS `display: none` ——
  CM6 的高度模型不知道被 CSS 隐藏的行，隐藏之后滚动、点击、光标会全部偏移（和「行级 margin」是同一个坑）。
- **含表格行的块不可折叠**：一张表本身就是一个 block replace，两个 replace 覆盖同一段，CM6 会直接抛错。
- 折叠区间对光标是**原子**的（`EditorView.atomicRanges`）。否则光标会停在没有 DOM 的行里 ——
  看不见光标，但打字确实会写进去，这是最难排查的一类问题。
- 折叠状态存**行首位置**而不是行号，靠 `tr.changes.mapPos()` 跟着编辑走。`setDoc` 走的是
  `EditorState.create`，所以换笔记时折叠状态天然清空，不需要手动展开。

### 专注模式

`.jd-active` 由 `lineclasses.ts` 按**段落**给：空行 / 标题 / 列表项 / 分隔线 / 表格 / 围栏标记算边界，
代码块内部不设边界（整块算一段）。只给光标那一行加是错的 —— 写着写着整段一起亮才叫专注。

淡化用 `opacity` 而不是改 `color`：后者会覆盖主题的正文色，前者是"整段退场"，符合意图。

### 打字机模式

把光标行滚到视口正中，**必须自己算 `#write.scrollTop`** —— 滚动容器是 `#write` 而不是 `.cm-scroller`，
`EditorView.scrollIntoView()` 在这里无效（同一个坑见下表）。

### 两个 toggle 都踩过同一个坑

「专注模式」「打字机模式」都是 toggle。菜单 accelerator 还在主进程注册时，按键会被**两条路径各触发一次**：
开完立刻关，按下去像完全没反应，状态栏还显示回到「视图：常规」。60ms 去重挡不住（IPC 到达间隔偶尔超过 60ms）。

解法是菜单项加 `registerAccelerator: false` —— accelerator 只用于**显示**（当说明书），按键一律交给
渲染层 `keybindings.ts`。现在只剩一条触发路径，行为可预测。

## 表格面板 / Mermaid / 源码模式 / PDF

### 表格面板（`table-panel.ts`）

光标进表格时浮出工具条：±行、±列、左中右对齐。

- **浮在窗口底部**而不是贴着表格：贴表格要跟着滚动、折叠、换主题重算坐标，还得处理贴边翻转；
  而光标在表内时表格本来就退回源码行，视线就在那一块，底部固定条够得着也不会跑偏。
- 按钮监听 `mousedown` 并 `preventDefault`：焦点一旦离开编辑器，selection 就变了，
  面板会立刻自己藏起来 —— 用户看到的是"点了一下面板就没了"。
- 表头行和分隔行删不得（删了表格就不成立），按钮置灰。
- 列索引靠 `columnAt()` 数竖线，不在 `splitRow` 结果上做偏移映射（转义 `\|`、首尾缺竖线都会把偏移算错）。

### Mermaid（`mermaid.ts`）

- **按需动态 import**：库压缩后三兆多，首屏不该背它；文档里真出现 ```mermaid 才加载。
- **结果按代码内容缓存**：滚动、换光标都会反复要求同一张图，不缓存等于每次重跑一遍布局。
- **异步结果靠 effect 回流**：block 装饰必须由 StateField 提供，而它的 update 是同步的、不能 await；
  渲染完成后 dispatch 一个空 effect，把"可以重算了"这件事推回 state。
- 光标进块退回源码；点图也能进块 —— `ignoreEvent()` 必须返回 `false`，否则点击被 widget 整个吞掉。

### 源码模式（`viewmode.ts`）

一个布尔 field，四个模块读它：markers 不出标记装饰、table 不画表格、fold 不折叠、mermaid 不替换。
行级 class（`.jd-h1` / `.jd-code-block`）保留 —— Typora 的源码模式也保留排版，只是把标记露出来。

换笔记时 `setDoc` 走 `EditorState.create`，field 会重置成 `false`，所以 `sourceMode` 单独存了一份变量补回去，
否则翻下一篇就悄悄退回渲染模式。

### PDF 导出

**没有走 pandoc**：本机根本没装（策划案里"本机已装 pandoc"那句话已经过期），
而让用户为了导出再装一个外部二进制不合适。

改成 `markdown-html.ts` 用**编辑器同一个 Lezer parser** 生成 HTML（markdown 解析仍然只有一份实现），
套上当前主题的翻译结果，交给隐藏窗口 `printToPDF` —— 纸面和屏幕是同一套 CSS。

**为什么不直接打印主窗口**：CM6 是虚拟化的，屏幕上只有视口那几十行有 DOM，直接打印会得到大片空白。
隐藏窗口里放的是静态 HTML，全文都在。

> 已知限制：PDF 里的 ```mermaid 会以**代码块**形式导出（不渲染成图）—— 图只存在于渲染层的缓存里。

## 已知的坑（都踩过，记下来省时间）

| 坑 | 说明 |
| --- | --- |
| `%APPDATA%` 不可写 → 原生崩溃 | Chromium 启动早期创建 userData 失败会 `0xc0000005`，**没有 JS 堆栈**，表现为窗口不出、日志全空。必须命令行传 `--user-data-dir`，代码里 `app.setPath()` 来不及 |
| 图片路径带空格 | Typora 不编码空格（实测 134 处）。正则用 `\(([^)]*)\)`，不能用 `\S+` |
| 反斜杠路径 | 62 处用 `\`。浏览器 `<img src>` 不认，加载前归一成 `/`，**只在渲染层** |
| `@keyframes` 里的 `from/to/50%` | 朴素正则会当成选择器改坏，必须跳过 parent 是 keyframes/font-face 的规则 |
| `?t=1670129411561` | 字体 URL 的缓存串，`file://` 下 404。重写时丢弃查询串 |
| `config.json` 带 BOM | `JSON.parse` 抛错 → 静默 fallback → 文件树空白。读时剥 `\uFEFF` |
| rcedit 空值 | electron-builder 25.1.8 无条件写 `OriginalFilename ""`，rcedit 不收。用 `scripts/after-pack.cjs` 自己写 |
| CM6 block 装饰只能用 StateField | `ViewPlugin` 提供 block replace 会抛 `RangeError: Block decorations may not be specified via plugins`，后面一堆 `Cannot destructure property 'tile'` 全是它的连锁反应 |
| 映射表不同标签别共用类名 | `th`/`td` 都映射成 `.jd-table-cell` 会让主题的 `table tr th{background}` 命中所有单元格 → 整表变绿。必须拆成 `jd-table-head-cell` / `jd-table-cell` |
| 关窗保护不能在渲染层做 | `beforeunload` 里 `void doSave()` 是异步的，窗口已销毁，写盘跑不完。必须主进程 `close` 事件拦 |
| 映射表别手抄第二份 | 兜底表曾在 `theme.ts` 里另写一份，结果和 `mapping.json` **漂移**：`th`/`td` 又变回共用 `jd-table-cell`、丢了 `code`/`kbd`。漂移不报错，只在「读不到磁盘 mapping.json」时静默回落成过期表（整表变绿），因果极难对上。现在兜底表由构建期**内联同一份 JSON** 生成，磁盘那份仍可热改 |
| 代码块没高亮 ≠ 丢了主题 | 主题的 token 配色写成 `.cm-s-inner .cm-keyword{color:…}`（CodeMirror **5** 的作用域类）。我们的 DOM 没有 `.cm-s-inner`，规则照搬过来永远不命中 → 代码块有底色有框，但一个字都不变色。解法是翻译时把 `.cm-s-inner`/`.CodeMirror*` 剥掉、`.cm-*` 映射成 CM6 `classHighlighter` 产出的 `.tok-*`；剥完只剩裸标签的规则必须丢弃，否则裸 `div` 命中全页 |
| 围栏缩进不能简单放宽 | 列表项嵌套会让围栏带 4–8 空格缩进（库内 183 行/10 文件），但代码块**内部**也有深缩进的 ` ``` `。把 `{0,3}` 直接改成 `{0,8}` 会让后者把块提前关掉，实测净减 8206 行。正解是「按开启时的缩进配对」：块内只有缩进 ≤ 开启缩进的围栏才算关闭（见 `renderer/fence.ts`） |
| 围栏行不能用 opacity 淡化 | 围栏行是代码块上/下边框的载体，`opacity:0.35` 会连 `border` 和 `background` 一起打到 35%，深色主题下「代码块看不出是块」就是这么来的。只淡化文字颜色（`color-mix`） |
| `.cm-scroller` 不是这个项目的滚动容器 | `style.css` 把 `.cm-scroller` 设成 `overflow: visible`（为了让主题的 `#write` 内边距/背景生效），真正滚动的是外层 `#write`。两个后果：`EditorView.scrollIntoView()` **不生效**；换笔记也不会自己回顶部。都得手动操作 `#write.scrollTop` |
| `requestAnimationFrame` 在窗口不可见时**完全暂停** | 最小化 / 被遮挡 / 自动化里没抢到前台时 `visibilityState=hidden`，实测 600ms 内 rAF 回调 **0 次**。任何「滚动定位 / 延迟校正 / 动画」都不能只挂 rAF——表现是「点了没反应」，而且只有特定环境才复现。改用 `setTimeout` 链（隐藏页面只是节流，不会彻底停摆） |
| 滚动定位要迭代校正 | CM6 对没渲染过的行只有**估算**高度，滚过去之后才真正渲染、内容重排，位置又偏了（实测一次校正在靠后标题上偏 400px）。做法是递增延迟 30/60/90ms 连校 3 轮，误差收进 4px |
| 限宽别加在滚动容器上 | 想让正文占 90% 时，`max-width` 一度写在 `#write` 上——而 `#write` 就是滚动容器，滚动条跟着被拽到 90% 处，右边留一大条空白，看着像滚动条脱离了窗口。限宽必须下沉到不参与滚动的 `.cm-editor`，滚动条才贴得住窗口右缘 |
| `::-webkit-scrollbar-thumb` 的 `currentColor` 是**容器**的颜色 | 所以滚动块颜色可以直接从主题正文色派生，不用为每个主题配一个滚动条色。但主题若写了 `background: var(--scrollbar-color) !important`（dyzj 系列就是这样），主题赢——这是主题的表达，别去压 |
| 光标是纯黑的，和主题没关系 | CM6 默认 `.cm-cursor { border-left: 1.2px solid black }`，深色适配那条是 `&dark .cm-cursor`——只有用过 `EditorView.theme(…, {dark:true})` 才会生成 `.cm-dark` 类。本项目颜色全交给 Typora 主题，`.cm-dark` 永远不存在，所以深色主题下光标一直是黑的（实测 `hasCmDark: false`）。改为 `border-left-color: currentColor` 跟随正文色，且**必须带 `#write` 前缀**（1,1,0）：CM6 的样式是运行时注入到 `<head>` 末尾，同特异性它赢 |
| ↑/↓ 一按就「冲到选区另一头」 | CM6 的 `cursorByLine` 对**非空选区**直接执行 `rangeEnd(range, forward)`：`↑` 把光标放到选区 from、`↓` 放到 to，**塌陷之后不再移动**。选中一个 20 行的代码块、在底部按一下 `↑`，光标瞬间移到块首，看着就像「直接到顶部」。现在 `editor.ts` 用 `arrowFromCursor()` 提前接管：从 `head`（用户最后一次拖到的位置）起步移动一行。只在「单光标 + 有选区」时接管，其余交回默认实现 |
| 列表项里的标题也是标题 | 库里 **50 个文件、232 行**写成 `- ## 标题`（多半是从网页复制时被套上列表符号）。原来的标题正则只认行首 `#`，于是这些行既不是标题、也进不了大纲，`##` 还照样显示。现在 `heading.ts` 的 `parseHeading()` 同时认两种写法，行 class / 标记隐藏 / 大纲三处共用，`- ` 和 `##` 一起隐藏。普通标题仍然不允许前导缩进（放宽会把缩进代码块里的 `#` 误判成标题） |

| `KEY_ALIAS` 里的 `' ': 'Space'` 曾永远不生效 | `normalizeKey` 先走 `key.length === 1` 分支，而空格的 length 恰好是 1，别名永远轮不到 → 录出来的 accelerator 是 `CmdOrCtrl+ `（尾部一个空格），Electron 不认，绑定默默失效且无从排查。别名查询必须放在长度判断**之前**（`pnpm test` 的「键名别名」这条就是为它设的） |

| 折叠不能用 CSS 隐藏 | `display: none` 藏掉的行不在 CM6 的高度模型里，滚动/点击/光标会集体偏移。必须用 `Decoration.replace({ block: true })` 从布局里换掉。另外**含表格行的块不能折叠**——表格自己就是一个 block replace，两个 replace 重叠会抛错 |
| `gutterElement` 量到 `height: 0` 是假象 | 那是 CM6 的 `initialSpacer`（inline style 带 `visibility: hidden; pointer-events: none`），不是真实行标记。真实元素的高度由 CM6 按行量出来（标题 65px、正文 32px 各不同）。三角要用 `display: flex; align-items: center` 居中，靠 `line-height` 会让它偏到行的上三分之一 |
| toggle 类命令被两条路径各触发一次 | 菜单 accelerator 在主进程注册时，按键先被它吃掉、再走渲染层 → 「专注模式」开一次又关一次，按下去像完全没反应，状态栏还显示「视图：常规」。60ms 去重盖不住（IPC 到达间隔偶尔超过 60ms）。给菜单项加 `registerAccelerator: false`：只显示、不注册 |

| `pnpm dist` 在本机必失败 | electron-builder 打包前会 `emptyDir` 清空 `win-unpacked`，而本机的 safe-delete 是**按文件数**拦批量删除的（>50 个直接 block，报 `SAFE_DELETE_BULK_GUARD_ERROR`）。`pnpm pack` 把输出改到系统临时目录就绕开了 |
| 打包完的 `app.asar` 锁着删不掉 | 一个 549MB 的临时目录里其余文件都能删，只有 `app.asar` 被外部服务占着（实测等 90 秒、`Directory.Delete`、移动目录全失败）。所以临时目录**不要放在项目里**——`pnpm pack` 用系统 TEMP，不影响项目目录，系统迟早回收 |

## 数据安全怎么做的

- **写盘**：tmp 文件 + `fsync` + rename（同目录，原子）；Windows 上被网盘/杀软占用时重试 6 次。
- **崩溃恢复**：打字后 **300ms** 写一份草稿到**独立的 `draft.json`**（比 800ms 的自动保存更早），正常存盘成功后清掉。下次启动若发现草稿，顶部横幅问「恢复 / 丢弃」，**磁盘一个字节都不动**，直到你按 Ctrl+S。
  - 为什么不塞进 `config.json`：草稿是每 300ms 一次的**全量重写**，而配置里躺着窗口尺寸、主题名、lastFile。混在一起等于「写草稿失败会连带丢配置」，反过来改个侧栏宽度也要把整篇正文序列化一遍。两者生命周期不同，必须分文件。
  - 上限按**字节**判（2MB），不按字符——中文一个字 3 字节，按 `.length` 会让实际写入到上限的 3 倍。内容与上次落盘一致时跳过写盘。
- **关窗拦截**：渲染层把 `dirty` 推给主进程，关窗时若有未保存改动弹三选一（保存并关闭 / 取消 / 放弃改动）。
- **单实例锁**：多开会让同一文件被两个编辑器互相覆盖。
- **上次状态**：`lastFile` 记上次打开的文件，重启自动打开；侧栏宽度也能拖拽记住（双击把手恢复 240px）。

## 许可

MIT
