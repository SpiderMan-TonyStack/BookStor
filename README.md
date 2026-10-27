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
| M5 加料 | 表格面板、大纲、折叠、专注模式、Mermaid、PDF | ⬜ |

策划案（含本机实测数据、技术决策与被推翻的假设）见 [docs/01-策划案.md](docs/01-策划案.md)。

## 快速开始

```bash
pnpm install
pnpm start          # 构建 + 启动（开发态）
pnpm typecheck      # 两端 tsc
pnpm verify         # 245 篇旧笔记逐字节往返校验 + 裂图基线比对
pnpm dist           # 打包 → release/简牍-<version>-portable.exe
```

> **启动必须带 `--user-data-dir`**，`scripts/run.mjs` 已经处理。原因见下。

## 三条不能破的线

1. **数据不丢** — 写盘走 tmp + fsync + rename；失败必弹错；单实例锁防止两个编辑器互相覆盖。
2. **中文输入** — 组字期间不重排、不丢字、光标不跳。
3. **无损** — 纯文本是唯一真源。渲染层只读叠加，**永不回写美化后的文本**；不认识的语法原样保留；不统一换行符。

`pnpm verify` 就是这条红线的守门人：245 篇旧笔记 `decode → encode` 后必须**逐字节相等**（CRLF/LF、BOM、末尾无换行全藏在这个断言里），且裂图数不超过 94 的已测基线。

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
    markers.ts     语法标记显隐 + 图片 widget（font-size:0 隐藏，不改文本）
    table.ts       表格真渲染（StateField 块装饰；光标进表退回源码）
    theme.ts       主题注入层（五层 CSS 顺序是契约）
    tree.ts        文件树
  shared/types.ts  IPC 类型
  theme/mapping.json  Typora 选择器 → 我们的语义 class（可编辑，不写死在代码里）
```

### 主题兼容的关键

Typora 主题写的是 `#write h1`、`.md-fences`，而 CM6 的行是 `.cm-line`。两边靠三件事对上：

1. **DOM 尽量像 Typora**：外层 `.jd-content`（对应 Typora 的 `content` 元素）包 `#write`。
2. **选择器映射**：翻译时用 `postcss` + `postcss-selector-parser` 把主题选择器改写成我们的语义 class（见 `src/theme/mapping.json`）。这份 JSON 是**唯一真相源**——代码里的兜底表由构建期内联它生成，不另抄一份。
3. **代码 token 配色**：主题里写的是 CodeMirror 5 的 `.cm-s-inner .cm-keyword`。翻译时剥掉作用域类、把 `.cm-*` 改名成 CM6 `classHighlighter` 输出的 `.tok-*`（`tok-keyword`/`tok-string`/`tok-comment`…），主题自带的高亮配色就原样生效。

**为什么运行时翻译而不是把改好的 CSS 存进项目**：换主题、改主题随时发生。热重载让你在 Typora 里改一行、这边 500ms 内跟着变。

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
