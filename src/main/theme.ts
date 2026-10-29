import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import postcss, { type Root, type Rule, type AtRule, type Declaration } from 'postcss'
import selectorParser from 'postcss-selector-parser'
// 兜底映射表的唯一真相源：与运行时可编辑的那份是同一个文件（见 DEFAULT_MAPPING 注释）
import mappingFile from '../theme/mapping.json'

/**
 * Typora 主题翻译管线（策划案 §5.3）。
 *
 * 四步：
 *   1. 递归内联 @import —— dyzj-dark 是 4 层 5 文件，只读主文件等于没装主题
 *   2. 改写 url() 为 file:// 绝对路径 —— 字体和背景图全靠这个
 *   3. 用 postcss-selector-parser 把 Typora 选择器改名成我方 DOM 的
 *      （不能上正则：@keyframes 里的 from/to/50% 会被正则当成选择器）
 *   4. 丢弃外壳专属规则并记账
 */

// ------------------------------------------------------------------ 类型

export interface Mapping {
  tags?: Record<string, string>
  classes?: Record<string, string>
  ids?: Record<string, string>
}

export interface ThemeReport {
  file: string
  /** 内联进来的文件（顶层在前） */
  sources: string[]
  rawLines: number
  outLines: number
  kept: number
  dropped: number
  urls: number
  fontFaces: number
  imports: number
  keyframes: number
  droppedSamples: string[]
  renamedSamples: string[]
  warnings: string[]
}

export interface ThemeResult {
  css: string
  report: ThemeReport
  /** 主题声明的 :root 变量，给外壳配色参考 */
  vars: Record<string, string>
}

// ------------------------------------------------------------------ 外壳专属黑名单

/**
 * 指向 Typora 应用外壳（侧栏、快速打开、菜单、导出页）的选择器。我们没有对应 DOM，
 * 留着只是永不生效的死规则。用子串匹配，因为写法五花八门：
 * `#typora-sidebar`、`#typora-sidebar:hover`、`body.on-focus-mode #typora-sidebar`…
 */
const SHELL_BLOCKLIST = [
  'typora-sidebar',
  'typora-quick-open',
  'top-titlebar',
  'file-library',
  'footer-word-count',
  'megamenu',
  'typora-export',
  'toggle-sourceview',
  'pin-outline',
  'md-notification',
  'md-close',
  'context-menu',
  'dropdown-menu',
  'outline-content',
  'outline-item',
  'modal-dialog',
  'modal-content',
  '#w-title',
  '#w-pin',
  '#md-searchpanel',
  '.typora-menu',
  '#info-panel',
]

/**
 * `body:not(.typora-sourceview-on) content { background: var(--bgimg-url) … }` 这类
 * 规则的前缀是在判断"当前是不是源码模式"。我们在渲染模式，条件恒成立 →
 * 把前缀剥掉，让 `content` 那条背景图规则能落下来（策划案 §5.2-E 实测必需）。
 */
function stripSourceviewPrefix(sel: string): string {
  let s = sel.trim()
  s = s.replace(/^body\s*:not\(\s*\.typora-sourceview-on\s*\)\s*/i, '')
  s = s.replace(/^body\.typora-sourceview-on\s+/i, '')
  s = s.replace(/^\.typora-sourceview-on\s+/i, '')
  if (!s.trim()) return sel
  return s
}

// ------------------------------------------------------------------ 默认映射（单一真相源）

/**
 * 兜底映射表**直接从 src/theme/mapping.json 内联**，不再手写第二份。
 *
 * 之前这里手抄过一份 DEFAULT_MAPPING，结果和 mapping.json 漂移了：
 *   - `th`/`td` 都写成 jd-table-cell（mapping.json 已拆成 jd-table-head-cell/cell）
 *   - 少了 `code → jd-code-inline`、`kbd → jd-kbd`（行内代码底色靠这个类）
 * 这类漂移**不会立刻报错**，只会在「读不到磁盘 mapping.json」时静默回落成过期表，
 * 表现为整表变绿 / 行内代码没有底色 —— 排查起来极难对上因果。
 *
 * 现在：构建期由 rollup 把 JSON 转成对象内联进 main bundle，与磁盘那份**同源**；
 * 运行时仍然优先读磁盘文件（见 loadMapping），磁盘那份可以热改；
 * 内联这份只在读不到时兜底，且不存在漂移的可能。
 */
const MAPPING_SRC = mappingFile as unknown as Mapping

export const DEFAULT_MAPPING: Required<Mapping> = {
  tags: { ...(MAPPING_SRC.tags ?? {}) },
  classes: { ...(MAPPING_SRC.classes ?? {}) },
  ids: { ...(MAPPING_SRC.ids ?? {}) },
}

// ------------------------------------------------------------------ 1. 内联 @import

interface InlineCtx {
  sources: string[]
  imports: number
  warnings: string[]
  depthMax: number
}

function parseImportTarget(params: string): { target: string; media: string } | null {
  const p = params.trim()
  let target = ''
  let rest = ''
  const urlMatch = p.match(/^url\(\s*(['"]?)([^'")]+)\1\s*\)/i)
  if (urlMatch) {
    target = urlMatch[2] ?? ''
    rest = p.slice(urlMatch[0].length)
  } else {
    const quoteMatch = p.match(/^(['"])([^'"]+)\1/)
    if (quoteMatch) {
      target = quoteMatch[2] ?? ''
      rest = p.slice(quoteMatch[0].length)
    }
  }
  target = target.trim()
  if (!target) return null
  if (/^(https?:)?\/\//i.test(target)) return null
  return { target, media: rest.trim() }
}

async function inlineFile(file: string, ctx: InlineCtx, stack: string[]): Promise<Root | null> {
  if (stack.length > ctx.depthMax) {
    ctx.warnings.push(`@import 超过 ${ctx.depthMax} 层，已截断：${file}`)
    return null
  }
  if (stack.includes(file)) {
    ctx.warnings.push(`@import 环形引用，已跳过：${file}`)
    return null
  }

  let raw: string
  try {
    raw = await fs.readFile(file, 'utf8')
  } catch (err) {
    ctx.warnings.push(`读不到 ${file}：${(err as Error).message}`)
    return null
  }
  if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)

  if (!ctx.sources.includes(file)) ctx.sources.push(file)

  let root: Root
  try {
    root = postcss.parse(raw, { from: file })
  } catch (err) {
    ctx.warnings.push(`解析失败 ${file}：${(err as Error).message}`)
    return null
  }

  const imports: AtRule[] = []
  root.walkAtRules('import', (at) => {
    imports.push(at)
  })

  for (const at of imports) {
    const parsed = parseImportTarget(at.params)
    if (!parsed) {
      ctx.warnings.push(`跳过远程/无地址 @import：${at.params}`)
      at.remove()
      continue
    }
    const childFile = path.resolve(path.dirname(file), parsed.target)
    ctx.imports++
    const child = await inlineFile(childFile, ctx, [...stack, file])
    if (child) {
      if (parsed.media) {
        ctx.warnings.push(`@import 带媒体条件已丢弃：${parsed.media}（${parsed.target}）`)
      }
      at.replaceWith(child.nodes ?? [])
    } else {
      at.remove()
    }
  }

  return root
}

// ------------------------------------------------------------------ 2. url() 改写

interface UrlCtx {
  urls: number
  warnings: string[]
}

/**
 * url() 里的相对路径 → file:// 绝对路径，基准是**声明它那个文件所在目录**。
 *
 * 两个实测坑：
 *  - `iconfont.woff2?t=1670129411561` 这类缓存串在 file:// 下 404 → 剥掉查询串
 *  - `local(...)` 是字体名不是路径，绝不碰；`url(data:...)` 原样保留
 */
function rewriteUrls(root: Root, ctx: UrlCtx): void {
  root.walkDecls((decl: Declaration) => {
    // 大小写不敏感地找 `url(`：CSS 里 `URL(...)`、`Url(...)` 都合法，
    // 之前这里是 `decl.value.includes('url(')`，大写写法整条声明被跳过 ——
    // 表现为「这张图的背景色/这个字体突然不生效」，而报告里连一条警告都没有。
    if (!/url\(/i.test(decl.value)) return

    const file = decl.source?.input.file
    const dir = file ? path.dirname(file) : ''
    let changed = false

    const next = decl.value.replace(
      /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi,
      (whole, _q, inner: string): string => {
        const spec = String(inner).trim()
        if (!spec) return whole
        if (/^(data:|https?:|file:|\/\/|blob:|#)/i.test(spec)) return whole

        const m = spec.match(/^([^?#]*)([?#].*)?$/)
        const cleanPath = (m?.[1] ?? spec).trim()
        const suffix = m?.[2] ?? ''
        if (!cleanPath) return whole

        const abs = path.resolve(dir, cleanPath)
        if (suffix) {
          ctx.warnings.push(`丢弃 url 查询串 ${suffix}（file:// 下会 404）：${cleanPath}`)
        }
        changed = true
        return `url("${pathToFileURL(abs).href}")`
      }
    )

    if (changed) {
      decl.value = next
      ctx.urls++
    }
  })
}

// ------------------------------------------------------------------ 3. 选择器翻译

interface TranslateCtx {
  mapping: Required<Mapping>
  droppedSamples: string[]
  renamedSamples: string[]
  kept: number
  dropped: number
  warnings: string[]
  keyframes: number
}

function isShellSelector(sel: string): boolean {
  const lower = sel.toLowerCase()
  return SHELL_BLOCKLIST.some((bad) => lower.includes(bad))
}

/**
 * `.cm-s-inner` / `.CodeMirror*` 是 Typora 里 CodeMirror 5 实例的作用域类。
 * 我们的 DOM 没有这些元素，规则照搬过来永远不会命中 —— 这正是
 * 「代码块有底色、有边框，但一个字都不变色」的根因：
 * dyzj-dark 里 20 条 token 配色全部写成 `.cm-s-inner .cm-keyword { color: … }`。
 *
 * 做法：把这些作用域类剥掉，剩下的 `.cm-keyword` 再经 mapping.json 改名成
 * CM6 的 `.tok-keyword`（见 editor.ts 的 classHighlighter），主题配色就能落地。
 *
 * 剥离后若只剩裸标签（`div`、`span`），说明这条规则本来就是靠 .CodeMirror 定位
 * 外壳的（如 `.cm-s-inner.CodeMirror{background:…}`），直接丢弃 ——
 * 否则一个裸 `div` 会命中页面上所有 div，后果比不生效严重得多。
 */
function stripCodeMirrorScope(sel: string): string | null {
  if (!/\.(cm-s-inner|CodeMirror)/i.test(sel)) return sel

  const stripped = sel
    .replace(/\.cm-s-inner\b/gi, '')
    .replace(/\.CodeMirror(-[a-z0-9]+)?\b/gi, '')
    .trim()

  if (!stripped) return null
  // 没有类 / id / 属性 / 伪类了 → 退化成裸标签选择器，丢弃
  if (!/\.|#|\[|:/.test(stripped)) return null
  return stripped
}

function translateSelector(
  sel: string,
  mapping: Required<Mapping>,
  ctx: TranslateCtx
): string | null {
  if (isShellSelector(sel)) return null

  const scoped = stripCodeMirrorScope(sel)
  if (scoped === null) return null

  const normalized = stripSourceviewPrefix(scoped)

  let touched = false
  const processor = selectorParser((selectors) => {
    selectors.walkTags((node) => {
      const name = node.value.toLowerCase()
      const to = mapping.tags[name]
      if (to) {
        node.replaceWith(selectorParser.className({ value: to }))
        touched = true
      }
      // 其余标签（div/span/code…）原样留着
    })
    selectors.walkClasses((node) => {
      const to = mapping.classes[node.value]
      if (to) {
        node.value = to
        touched = true
      }
    })
    selectors.walkIds((node) => {
      const to = mapping.ids[node.value]
      if (to) {
        node.value = to
        touched = true
      }
    })
  })

  let out: string
  try {
    out = processor.processSync(normalized)
  } catch {
    ctx.warnings.push(`选择器解析失败，原样保留：${sel}`)
    return sel
  }
  if (touched) {
    if (ctx.renamedSamples.length < 40) ctx.renamedSamples.push(`${sel}  →  ${out}`)
  }
  return out
}

function translateRoot(root: Root, mapping: Required<Mapping>, ctx: TranslateCtx): void {
  root.walkAtRules((at: AtRule) => {
    if (at.name.toLowerCase().endsWith('keyframes')) ctx.keyframes++
  })

  root.walkRules((rule: Rule) => {
    // @keyframes 里的 from/to/50% 也是 rule，必须跳过（否则会被改成 .jd-xxx）
    const parent = rule.parent
    if (parent && parent.type === 'atrule') {
      const atName = (parent as AtRule).name.toLowerCase()
      if (atName.endsWith('keyframes') || atName === 'font-face') return
    }

    const sels = rule.selectors
    const keptSels: string[] = []
    let droppedHere = 0
    for (const s of sels) {
      const t = translateSelector(s, mapping, ctx)
      if (t === null) droppedHere++
      else keptSels.push(t)
    }
    if (keptSels.length === 0) {
      if (ctx.droppedSamples.length < 40) ctx.droppedSamples.push(sels.join(', '))
      rule.remove()
      ctx.dropped++
      return
    }
    if (droppedHere > 0) ctx.dropped += droppedHere
    rule.selectors = keptSels
    ctx.kept++

    shrinkInlineBlockHeading(rule, ctx)
  })
}

/**
 * CM6 强制 `.cm-line { display: block }`（cm-line 是逐行渲染的，一行一个元素）。
 *
 * 但部分 Typora 主题给标题写 `display: inline-block` 来让标题框只包住文字：
 *   dyzj.css:384 `h4 { display:inline-block; border:1px solid var(--titlebefore-color) }`
 *   chocolate-box.css:71 `h1 {...}`、redrail.css:222 `h2 {...}`、redrail.css:257 `h4 {...}`
 * 实测（diag3）：`.jd-h4` 的 display 被 CM6 压回 block，标题框因此拉满 947px 全宽，
 * 而主题本意是 78px 的紧凑小框 —— 观感上完全不同。
 *
 * 不能直接把 display 改回 inline-block：那会让所有标题行变成行内元素、彼此挤在一行。
 * 等价做法是保留 block，用 `width: fit-content` 让盒子收缩到内容宽度，盒子行为一致。
 */
function shrinkInlineBlockHeading(rule: Rule, ctx: TranslateCtx): void {
  // 只认标题元素本身（`.jd-h2`、`#write .jd-h2`），**不能**带伪元素。
  // 踩过的坑：`h2:before{display:inline-block}`（dyzj.css:348，风车图标）曾被我
  // 用 `(::?[a-z-]+)?` 一起匹配到，图标伪元素被改成 display:block，
  // 结果图标从行首跑到上一行、标题被撑高 88px。
  const isHeadingLine = rule.selectors.every((s) => /^(#write\s+)?\.jd-h[1-6]$/i.test(s.trim()))
  if (!isHeadingLine) return

  let hit = false
  rule.walkDecls((d: Declaration) => {
    if (d.prop.toLowerCase() !== 'display') return
    if (d.value.trim().toLowerCase() !== 'inline-block') return
    d.value = 'block'
    hit = true
  })
  if (!hit) return

  // 已经有 width/max-width 的主题规则不覆盖，只补缺的那一半
  let hasWidth = false
  rule.walkDecls((d: Declaration) => {
    const p = d.prop.toLowerCase()
    if (p === 'width' || p === 'max-width') hasWidth = true
  })
  if (!hasWidth) rule.append({ prop: 'width', value: 'fit-content' })

  if (ctx.warnings.length < 40) {
    ctx.warnings.push(`inline-block 标题改为 block + width:fit-content（CM6 行模型限制）：${rule.selector}`)
  }
}

// ------------------------------------------------------------------ 4. 变量抽取

function collectVars(root: Root): Record<string, string> {
  const out: Record<string, string> = {}
  root.walkRules((rule) => {
    if (!rule.selectors.some((s) => s.trim() === ':root')) return
    rule.walkDecls((d) => {
      if (d.prop.startsWith('--')) out[d.prop] = d.value
    })
  })
  return out
}

// ------------------------------------------------------------------ 主入口

export async function translateTheme(themeFile: string, mapping: Required<Mapping>): Promise<ThemeResult> {
  const inlineCtx: InlineCtx = { sources: [], imports: 0, warnings: [], depthMax: 8 }
  const root = await inlineFile(themeFile, inlineCtx, [])
  if (!root) throw new Error(`主题解析失败：${themeFile}`)

  const rawLines = root.toString().split('\n').length

  const urlCtx: UrlCtx = { urls: 0, warnings: [] }
  rewriteUrls(root, urlCtx)

  const trCtx: TranslateCtx = {
    mapping,
    droppedSamples: [],
    renamedSamples: [],
    kept: 0,
    dropped: 0,
    warnings: [],
    keyframes: 0,
  }
  translateRoot(root, mapping, trCtx)

  const vars = collectVars(root)

  let fontFaces = 0
  root.walkAtRules('font-face', () => {
    fontFaces++
  })

  // 注意：不在这里"修正"主题的 bug（比如 bg-dark.gif 的错路径），目标是和 Typora 一样。
  //
  // 不包 @layer：CodeMirror 6 会在运行时注入**未分层**的样式，而未分层规则永远压过
  // 分层规则 —— 一旦把主题分层，CM6 的 .cm-content padding 之类就会反过来盖掉主题。
  // 层级顺序改由渲染层在插入位置上保证（见 src/renderer/theme.ts）。
  const body = root.toString()
  const css = `${body}\n/*# 简牍主题：${inlineCtx.sources
    .map((s) => path.basename(s))
    .join(' + ')} */\n`

  const report: ThemeReport = {
    file: themeFile,
    sources: inlineCtx.sources,
    rawLines,
    outLines: css.split('\n').length,
    kept: trCtx.kept,
    dropped: trCtx.dropped,
    urls: urlCtx.urls,
    fontFaces,
    imports: inlineCtx.imports,
    keyframes: trCtx.keyframes,
    droppedSamples: trCtx.droppedSamples,
    renamedSamples: trCtx.renamedSamples,
    warnings: [...inlineCtx.warnings, ...urlCtx.warnings, ...trCtx.warnings].slice(0, 60),
  }

  return { css, report, vars }
}

// ------------------------------------------------------------------ 映射表加载

/**
 * 映射表优先从磁盘读，改 mapping.json 不用重新构建。
 * 打包后没有源码目录就退回内置默认值。
 */
export async function loadMapping(candidates: string[]): Promise<Required<Mapping>> {
  for (const c of candidates) {
    try {
      const raw = await fs.readFile(c, 'utf8')
      const parsed = JSON.parse(raw) as Mapping
      return {
        tags: { ...DEFAULT_MAPPING.tags, ...parsed.tags },
        classes: { ...DEFAULT_MAPPING.classes, ...parsed.classes },
        ids: { ...DEFAULT_MAPPING.ids, ...parsed.ids },
      }
    } catch {
      /* 试下一个 */
    }
  }
  return DEFAULT_MAPPING
}
