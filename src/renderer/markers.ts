import { EditorView, Decoration, type DecorationSet, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view'
import { RangeSetBuilder, StateEffect, StateField } from '@codemirror/state'
import { createFenceState, splitQuote, stepFence } from './fence.js'
import { parseHeading } from './heading.js'
import { isSourceMode, setSourceMode } from './viewmode.js'
import { TocWidget, tocEntries, tocKey } from './toc.js'
import { openLangPicker } from './lang-picker.js'
// 改语言不放在 editor.ts：markers 已经 import 了 editor（双向依赖），
// 而这条逻辑本来就属于"围栏语言的读写"，放 code-lang.ts 正好避开循环。
import { setCodeLang } from './code-lang.js'
// 取图路径的清理规则与主进程的裂图检测共用同一份，别再各写一套
import { RE_BRACKET, cleanImageTarget } from '../shared/image-path.js'

/**
 * M2：语法标记显隐。
 *
 * 原则（策划案 §5.2 与红线）：
 * - **只在渲染层动手**。文本一个字都不改，`getDoc()` 拿到的永远是原始 markdown。
 * - 标记用 `font-size:0` 的 mark 装饰隐藏，**不用 replace 装饰**：
 *   replace 会把字符从布局里挖掉，光标能落进去却看不见，删字时会跳；
 *   `font-size:0` 只是让它零宽，字符仍在文档里，选中复制拿到的还是完整 markdown。
 * - 光标所在行（以及选区覆盖到的行）**一律显示原文**，否则改标题时连 `##` 都找不到。
 * - 代码围栏内部不处理：那里 `*` `_` `#` 都是代码，动了就是错的（策划案里
 *   `GHLog.cpp.md` 有 32 处 `==` 被误判的教训）。
 */

const HIDDEN = 'jd-md0'

/** 列表项前面的圆点 / 任务框，替代被藏掉的 `-` `1.` `- [ ]` */
class MarkerWidget extends WidgetType {
  constructor(readonly kind: 'bullet' | 'ordered' | 'task-done' | 'task-todo', readonly label: string) {
    super()
  }
  override eq(other: MarkerWidget) {
    return other.kind === this.kind && other.label === this.label
  }
  override toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = `jd-bullet jd-bullet-${this.kind}`
    el.textContent = this.label
    el.setAttribute('aria-hidden', 'true')
    return el
  }
  override ignoreEvent() {
    return true
  }
}

/**
 * 代码块右下角的语言徽章（4.5.0）。
 *
 * Typora 也有：代码块右下角一个小标签，点开选语言。我们的实现要点：
 *   - 插在**闭合围栏行**的末尾，再用绝对定位贴到该行的右下角
 *     （绝对定位不进 CM6 的高度模型，所以不会把行撑高、不会引起光标错位）
 *   - 只读地显示当前语言，点击弹出语言列表（`lang-picker.ts`）
 *   - `ignoreEvent()` 返回 true 并自己接管 mousedown：否则点它会移动光标、
 *     整块变成"活动块"（活动时围栏行显示原文，徽章会跟着消失，手感很怪）
 *
 * `openFrom` 是**开启围栏行**的位置：真正要改的是那一行（` ```cpp ` → ` ```python `），
 * 而徽章挂在闭合围栏上。位置会随编辑漂移，所以它必须进 `eq()`（否则 DOM 不重建、
 * 点下去改的是别处的行）。
 */
class LangBadgeWidget extends WidgetType {
  constructor(
    readonly lang: string,
    readonly openFrom: number,
    readonly view: EditorView
  ) {
    super()
  }
  override eq(other: LangBadgeWidget) {
    return other.lang === this.lang && other.openFrom === this.openFrom
  }
  override toDOM(): HTMLElement {
    const btn = document.createElement('button')
    btn.className = 'jd-lang-badge' + (this.lang ? '' : ' is-empty')
    btn.textContent = this.lang || '语言'
    btn.title = '切换代码块语言'
    btn.setAttribute('aria-label', '切换代码块语言')
    btn.addEventListener('mousedown', (ev) => {
      // preventDefault：别让点击穿透到编辑器 —— 一旦光标移到这一行，
      // 这一行变成活动行，徽章立刻消失，浮层就失去了锚点
      ev.preventDefault()
      ev.stopPropagation()
      openLangPicker({
        anchor: btn.getBoundingClientRect(),
        current: this.lang,
        onPick: (lang) => setCodeLang(this.view, this.openFrom, this.lang, lang),
      })
    })
    return btn
  }
  override ignoreEvent() {
    return true
  }
}

// 标题判断统一走 heading.ts（同时认行首 `## x` 和列表项里的 `- ## x`）
const RE_QUOTE = /^([ \t]{0,3}>[ \t]?)/
const RE_TASK = /^([ \t]{0,8})([-*+])([ \t]+)\[([ xX])\]([ \t]+)/
const RE_LIST = /^([ \t]{0,8})([-*+]|\d+[.)])([ \t]+)/
// 围栏判断统一走 fence.ts 的状态机（与 lineclasses.ts 共用同一份逻辑）：
// 列表项内 4–8 空格缩进的围栏要能识别，块内更深缩进的 ``` 不能把块提前关掉。
const RE_HR = /^[ \t]{0,3}([-*_])([ \t]*\1){2,}[ \t]*$/
/** 公式块围栏：整行只有 `$$`（`$$x$$` 那种行内公式不算，见 lineclasses.ts） */
const RE_MATH_FENCE = /^[ \t]{0,3}\$\$[ \t]*$/
/**
 * 警告框标题行 `> [!NOTE]`，**后面可以带标题文字**（GitHub / Typora 都支持
 * `> [!NOTE] 小标题`）。只藏 `[!NOTE]` 这一段，标题文字照常显示、照常扫行内语法。
 */
const RE_ADM_TITLE = /^\[!([A-Za-z]+)\]([ \t]*)(.*)$/
/** 目录占位行 `[TOC]`（大小写都认） */
const RE_TOC = /^[ \t]{0,3}\[TOC\][ \t]*$/i
/** 脚注定义行 `[^1]: 内容` —— 只藏 `[^1]:` 这个标记，内容照常显示 */
const RE_FOOTNOTE_DEF = /^([ \t]{0,3}\[\^[^\]]+\]:)([ \t]*)/

/** 当前笔记所在目录 —— 相对图片路径要靠它才能变成 file:// 绝对地址 */
export const setDocBase = StateEffect.define<string>()

export const docBaseField = StateField.define<string>({
  create: () => '',
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setDocBase)) return e.value
    return v
  },
})

/**
 * 相对图片路径 → 绝对路径（正斜杠）。
 *
 * 远程地址（http/https/data）和已经是 file: 的返回空串 —— 它们没有"本地位置"
 * 可以打开，右键菜单据此把那一条置灰。反斜杠是 Windows 写法，浏览器不认，
 * 只在这里归一，绝不回写文本。
 */
function toImageAbs(raw: string, base: string): string {
  if (/^(https?:|data:|file:)/i.test(raw)) return ''
  let p = raw.replace(/\\/g, '/')
  // 已经是百分号编码的别再编一次
  try {
    p = decodeURI(p)
  } catch {
    /* 保持原样 */
  }
  return p.startsWith('/') ? p : `${base.replace(/\\/g, '/').replace(/\/+$/, '')}/${p.replace(/^\.\//, '')}`
}

/** 把 markdown 里的图片路径变成浏览器能加载的地址 */
function toImageSrc(raw: string, base: string): string {
  if (/^(https?:|data:|file:)/i.test(raw)) return raw
  const abs = toImageAbs(raw, base)
  // 空格等字符必须编码，否则 file:// 取不到
  return `file:///${abs.split('/').map((s) => encodeURIComponent(s)).join('/')}`
}

/**
 * 图片。`![](path)` 换成真的 `<img>`，这就是 Typora 的样子。
 *
 * 加载失败时**不显示空白**：主题和策划案 §5.7 都要求裂图显式化（灰色虚线小框 +
 * 截断文件名 + hover 看全路径），所以这里自己画占位框，而不是让浏览器画裂图图标。
 * 库里本来就有 94 处裂图（Typora 打开也是裂的），不能靠"看不见"来掩盖。
 */
class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly raw: string,
    /** 解析后的本地绝对路径；http/data 这类没有本地位置的为空串 */
    readonly abs: string,
    /** 这段 `![](…)` 语法在文档里的起止 —— 点击图片时要整段选中，删除才是一次删干净 */
    readonly from: number,
    readonly to: number
  ) {
    super()
  }
  override eq(other: ImageWidget) {
    return (
      other.src === this.src &&
      other.alt === this.alt &&
      other.abs === this.abs &&
      // 必须带上位置：DOM 上挂着 data-jd-from/to，编辑后位置变了却不重建，
      // 选中和删除就会作用到错误的区间上
      other.from === this.from &&
      other.to === this.to
    )
  }
  override toDOM(): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'jd-img-box'
    // 右键菜单要「打开图片所在位置」，主进程需要绝对路径。
    // 从 `src` 反解 file:// 要处理百分号编码，不如在构造时算好挂在这里。
    if (this.abs) wrap.dataset['jdAbs'] = this.abs
    wrap.dataset['jdFrom'] = String(this.from)
    wrap.dataset['jdTo'] = String(this.to)
    const img = document.createElement('img')
    // 类挂在 <img> 本身上：mapping.json 把主题的 `img` 选择器映射成 `.jd-img`，
    // 挂在外层包裹上主题的 `img{...}`（如 dyzj-dark 的 `img{filter:brightness(80%)}`）
    // 就匹配不到真正要改的元素了。
    img.className = 'jd-img'
    img.src = this.src
    img.alt = this.alt
    img.loading = 'lazy'
    img.draggable = false
    const box = document.createElement('span')
    box.className = 'jd-img-broken'
    const name = this.raw.split(/[/\\]/).pop() ?? this.raw
    box.textContent = name
    box.title = this.raw
    img.addEventListener('error', () => {
      wrap.classList.add('jd-img-failed')
    })
    img.addEventListener('load', () => {
      wrap.classList.remove('jd-img-failed')
    })
    wrap.append(img, box)
    return wrap
  }
  override ignoreEvent() {
    return true
  }
}

function markerDeco(cls: string) {
  return Decoration.mark({ class: cls })
}
const HIDE = markerDeco(HIDDEN)

/**
 * 行内代码的内容部分。
 * 主题里行内代码的样式是写在 `code` 元素上的（dyzj.css:758 `#write code{...}`），
 * 而 CM6 不产生 `<code>` 元素、只有带 class 的 span。
 * 所以 mapping.json 把 `code` 这个标签映射成 `.jd-code-inline`，
 * 我们就得在渲染层把这个 class 挂到行内代码的内容上，主题规则才有东西可匹配。
 */
const INLINE_CODE = markerDeco('jd-code-inline')

/**
 * 高亮 `==文字==`。
 *
 * class 名选 `jd-mark` 是为了对上 `mapping.json` 里 `mark → jd-mark` 的映射 ——
 * 主题里的 `#write mark{...}` 翻译后正好是 `#write .jd-mark`，于是高亮颜色
 * **由主题决定**（rider-dark 给的是蓝底白字），不用我们在渲染层写死。
 */
const HIGHLIGHT = markerDeco('jd-mark')

/** 下划线 `<u>文字</u>`。主题基本没有 `u` 规则，退化成 theme-base 里的一条 text-decoration */
const UNDERLINE = markerDeco('jd-underline')

/**
 * 加粗 / 斜体 / 删除线的**内容**部分（4.7.1）。
 *
 * 以前这里只把 `**` 藏掉、内容不做任何处理 —— 结果是"星号没了，加粗也没了"，
 * 看起来跟 Typora 差得远（用户原话：去掉星号后语义不能丢）。现在把内容挂上
 * class，主题里 `#write strong{}` / `em{}` / `del{}` 经 mapping.json 翻译后
 * 正好落到 `#write .jd-strong` 等，颜色与字重仍然由主题决定。
 */
const STRONG = markerDeco('jd-strong')
const EM = markerDeco('jd-em')
/** `***文字***`：又粗又斜，一个 mark 挂两个 class（不用叠两层 mark） */
const STRONG_EM = markerDeco('jd-strong jd-em')
const STRIKE = markerDeco('jd-del')

/**
 * `[文字](目标)` / `![alt](目标)` 共同的形式。
 *
 * 抽成常量是因为现在有两处要认它：普通的行内扫描，和活动行上「只认图片」的那一遍。
 * 各写一份正则迟早漂 —— 比如一处支持 `<>` 包裹、另一处不支持。
 */
/**
 * 光标所在行上的图片。
 *
 * 普通行内标记在光标行要露出原文（方便改 `**`、`~~`），图片不是这个逻辑 ——
 * 它更接近块级元素：露出 `![](./.xxx.assets/image-2026....png)` 这样一整串路径，
 * 只会让人以为「图片根本没插进来」（2026-11-10 用户实测反馈，粘贴完光标正停在这行）。
 *
 * 例外只有一种：光标真的落进某个图片语法内部 —— 那说明用户正在改路径，
 * 这一段才还原成源码。光标一移出去，装饰重算，图片又变回图片。
 */
function scanImagesOnActiveLine(
  text: string,
  base: number,
  emit: (from: number, to: number, deco?: Decoration) => void,
  imageAt: (pos: number, alt: string, target: string, end: number) => void,
  selFrom: number,
  selTo: number
): void {
  let i = 0
  while (i < text.length) {
    const c = text[i]

    if (c === '\\') {
      i += 2
      continue
    }

    // 行内代码里的 `![](x)` 是字面量，不是图片
    if (c === '`') {
      let n = 1
      while (text[i + n] === '`') n++
      const fence = '`'.repeat(n)
      const close = text.indexOf(fence, i + n)
      i = close > i + n ? close + n : i + n
      continue
    }

    if (c === '!' && text[i + 1] === '[') {
      const m = RE_BRACKET.exec(text.slice(i + 1))
      if (m) {
        const from = base + i
        const to = from + 1 + m[0].length
        // 光标在这段语法里 → 显示原文，让路径可读可改
        const editing = selTo > from && selFrom < to
        if (!editing) {
          emit(from, to)
          imageAt(from, m[1] ?? '', cleanImageTarget(m[2] ?? ''), to)
        }
        i = to - base
        continue
      }
    }

    i++
  }
}

/**
 * 行内标记扫描。只处理斜体/加粗/删除线/行内代码/链接这五类，
 * 遇到反斜杠转义直接跳过两个字符。
 */
function scanInline(
  text: string,
  base: number,
  emit: (from: number, to: number, deco?: Decoration) => void,
  imageAt: (pos: number, alt: string, target: string, end: number) => void = () => {}
): void {
  let i = 0
  while (i < text.length) {
    const c = text[i]

    if (c === '\\') {
      i += 2
      continue
    }

    if (c === '`') {
      let n = 1
      while (text[i + n] === '`') n++
      const fence = '`'.repeat(n)
      const close = text.indexOf(fence, i + n)
      if (close > i + n) {
        emit(base + i, base + i + n)
        // 内容挂 .jd-code-inline，让主题的 `#write code{...}`（映射后是
        // `#write .jd-code-inline`）能给行内代码上底色 —— 反引号已被藏掉，
        // 没有这个 class 的话行内代码看起来就和普通文字一样。
        emit(base + i + n, base + close, INLINE_CODE)
        emit(base + close, base + close + n)
        i = close + n
        continue
      }
      i += n
      continue
    }

    if (c === '*' || c === '_' || c === '~') {
      let n = 1
      while (text[i + n] === c) n++
      // 单个 `~` 不是 markdown（`1~2~3` 里的波浪号是普通字符），不当标记
      if (c === '~' && n < 2) {
        i += n
        continue
      }
      const marker = c.repeat(n)
      const close = text.indexOf(marker, i + n)
      if (close > i + n) {
        // 内容不能以空格开头（`* 不是斜体` 这种不是语法）
        if (text[i + n] !== ' ' && text[close - 1] !== ' ') {
          const body = c === '~' ? STRIKE : n >= 3 ? STRONG_EM : n === 2 ? STRONG : EM
          emit(base + i, base + i + n)
          // 内容按语义加样式：星号藏掉之后，"加粗"必须真的变粗，否则就是丢语义
          emit(base + i + n, base + close, body)
          // 内容里还可能嵌着别的行内语法（`**粗 *斜* 粗**`），递归处理一遍。
          // 递归的输入严格更短（不含外层标记），不会无限下去。
          scanInline(text.slice(i + n, close), base + i + n, emit, imageAt)
          emit(base + close, base + close + n)
          i = close + n
          continue
        }
      }
      i += n
      continue
    }

    if (c === '[' || (c === '!' && text[i + 1] === '[')) {
      const isImage = c === '!'
      const bracketAt = isImage ? i + 1 : i
      const m = RE_BRACKET.exec(text.slice(bracketAt))
      if (m) {
        const inner = m[1] ?? ''
        const target = m[2] ?? ''
        if (isImage) {
          // ![alt](path) → 显示图片本身（Typora 的样子）。
          // 整段语法藏掉，在同一位置插一个 ImageWidget。
          // 活动行不走这里 —— 那条路径由 scanImagesOnActiveLine 处理（见上）。
          const from = base + i
          const to = base + bracketAt + m[0].length
          emit(from, to)
          imageAt(from, inner, cleanImageTarget(target), to)
        } else if (inner.length > 0) {
          // [文字](链接) → 只留“文字”
          emit(base + i, base + i + 1)
          emit(base + i + 1 + inner.length, base + i + m[0].length)
        } else {
          // [](链接) 没有可留的文字，整段藏掉
          emit(base + i, base + i + m[0].length)
        }
        i = bracketAt + m[0].length
        continue
      }
      i++
      continue
    }

    // ==高亮==（Typora 语法）。
    // 必须要求「开标记后面不是空格、闭标记前面不是空格」，否则正文里的
    // `a == b`、`x == y == z` 这种比较写法会被当成高亮。
    if (c === '=' && text[i + 1] === '=') {
      const close = text.indexOf('==', i + 2)
      if (close > i + 2 && text[i + 2] !== ' ' && text[close - 1] !== ' ') {
        emit(base + i, base + i + 2)
        emit(base + i + 2, base + close, HIGHLIGHT)
        emit(base + close, base + close + 2)
        i = close + 2
        continue
      }
      i += 2
      continue
    }

    // <u>下划线</u>：标签藏掉、内文挂 .jd-underline
    if (c === '<' && /^<u>/i.test(text.slice(i))) {
      const close = text.toLowerCase().indexOf('</u>', i + 3)
      if (close > i + 3) {
        emit(base + i, base + i + 3)
        emit(base + i + 3, base + close, UNDERLINE)
        emit(base + close, base + close + 4)
        i = close + 4
        continue
      }
      i++
      continue
    }

    // <!-- 注释 -->：整段不显示（Typora 的行为）
    if (c === '<' && text.startsWith('<!--', i)) {
      const close = text.indexOf('-->', i + 4)
      if (close >= 0) {
        emit(base + i, base + close + 3)
        i = close + 3
        continue
      }
      i++
      continue
    }

    i++
  }
}

function buildDecorations(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  const state = view.state

  // 源码模式：一个装饰都不给 —— 标记全部露出来，图片也回到 `![](path)` 原文
  if (isSourceMode(state)) return Decoration.none

  // 光标/选区所在行 → 显示原文
  const activeLines = new Set<number>()
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number
    const b = state.doc.lineAt(r.to).number
    for (let n = a; n <= b; n++) activeLines.add(n)
  }

  interface Item {
    from: number
    to: number
    deco: Decoration
  }
  const items: Item[] = []
  const push = (from: number, to: number, deco?: Decoration) => {
    if (to > from) items.push({ from, to, deco: deco ?? HIDE })
  }

  const docBase = state.field(docBaseField, false) ?? ''
  const imageAt = (pos: number, alt: string, target: string, end: number) => {
    if (!target) return
    items.push({
      from: pos,
      to: pos,
      deco: Decoration.widget({
        widget: new ImageWidget(
          toImageSrc(target, docBase),
          alt,
          target,
          toImageAbs(target, docBase),
          pos,
          end
        ),
        side: 1,
      }),
    })
  }

  // 视口之前先把围栏状态推出来
  const firstVisible = view.visibleRanges.length > 0 ? view.visibleRanges[0]!.from : 0
  const scanTo = state.doc.lineAt(firstVisible).number - 1
  const fenceState = createFenceState()
  // 公式块的开/关也要回溯：光看视口内不知道这行在不在 `$$` 里
  let mathOpen = false
  // 语言徽章要挂在**闭合**围栏上，但要改的是**开启**围栏 —— 所以一路记着开块那一行。
  // 视口可能从长代码块的中间开始，回溯这一遍必须一起记录。
  let openLang = ''
  let openFrom = 0
  for (let n = 1; n <= scanTo; n++) {
    const text = state.doc.line(n).text
    const wasIn = fenceState.in
    const step = stepFence(fenceState, text)
    // 代码块里的 `$$` 是代码，不参与公式块的开关（和 lineclasses.ts 一致）
    if (!step.inside && !step.isMarker && RE_MATH_FENCE.test(text)) mathOpen = !mathOpen
    if (step.isMarker && !wasIn) {
      openLang = step.lang
      openFrom = state.doc.line(n).from
    }
  }

  for (const range of view.visibleRanges) {
    const startLine = state.doc.lineAt(range.from).number
    const endLine = state.doc.lineAt(range.to).number
    for (let n = startLine; n <= endLine; n++) {
      const line = state.doc.line(n)
      const text = line.text
      const isActive = activeLines.has(n)

      // 围栏标记行：永远处理（藏 ``` 和语言名）
      const wasIn = fenceState.in
      const fenceStep = stepFence(fenceState, text)
      if (fenceStep.isMarker) {
        if (!wasIn) {
          // 开启围栏：记下语言与位置，等块尾挂徽章时用
          openLang = fenceStep.lang
          openFrom = line.from
        }
        if (!isActive) {
          const q = splitQuote(text)
          // 引用标记（`> `）总是藏掉 —— 它只是容器，不是内容
          if (q.depth > 0) push(line.from, line.from + q.prefix)
          const at = line.from + fenceStep.indent
          // 引用前缀与反引号之间如果只剩空白（缩进），也一起收掉
          if (/^[ \t]*$/.test(text.slice(q.prefix, fenceStep.indent))) push(line.from + q.prefix, at)
          // 但**列表项**上的围栏（`- ```cpp`）保留 `- `：那是它的归属信息，
          // 藏了就看不出这段代码属于哪个列表项。
          push(at, at + fenceStep.ticks)
          // 语言名保留但淡化（theme-fix 的 .jd-code-fence 已处理），藏在行尾更干净
          if (fenceStep.lang) push(at + fenceStep.ticks, line.to)
        }
        continue
      }

      if (fenceStep.inside) {
        // 代码内部一个字都不动 —— 但引用块里的代码（`> code`）要把每行开头的 `> `
        // 收掉，否则整块代码每行都顶着两个字符，看着像没渲染好。
        // 只藏引用标记本身，代码内容一个字符不碰；光标行保留原文（要能改）。
        if (!isActive) {
          const q = splitQuote(text)
          if (q.depth > 0) push(line.from, line.from + q.prefix)
        }

        // 语言徽章挂在**最后一行代码**上（下一行就是闭合围栏）。
        //
        // 为什么不挂闭合围栏那一行：围栏行被刻意压到 35% 亮度（`.jd-code-fence`），
        // 徽章的颜色是 currentColor 派生的，挂在那儿会跟着变灰、几乎看不见。
        // 挂在正文代码行上，颜色就是正常的代码色。
        //
        // 向前看一行是安全的：只对可见的代码行做一次 `stepFence`（拷贝状态，不影响主状态机），
        // 块跨出视口时最后一行的下一行还没渲染 —— 那就不显示，等滚到底自然会出来。
        const nextNo = n + 1
        if (nextNo <= state.doc.lines) {
          const probe = { ...fenceState }
          const peek = stepFence(probe, state.doc.line(nextNo).text)
          if (peek.isMarker && !probe.in) {
            items.push({
              from: line.to,
              to: line.to,
              deco: Decoration.widget({
                widget: new LangBadgeWidget(openLang, openFrom, view),
                side: 1,
              }),
            })
          }
        }
        continue
      }

      // 公式块。围栏 `$$` 在非活动行藏掉（和 ``` 一样），内容行**不扫任何行内语法** ——
      // 公式里的 `*` `_` `~` 是乘号、下标、约等号，按 markdown 处理就是错的；
      // `a^2 * b` 被吃成斜体之后源码看着像坏了。
      const isMathFence = RE_MATH_FENCE.test(text)
      if (isMathFence) {
        if (!isActive) push(line.from, line.to)
        mathOpen = !mathOpen
        continue
      }
      if (mathOpen) continue

      // [TOC] → 真正的目录块（标题从当前文档算，随改随变）
      if (RE_TOC.test(text)) {
        if (!isActive) {
          push(line.from, line.to)
          const entries = tocEntries(view)
          items.push({
            from: line.from,
            to: line.from,
            deco: Decoration.widget({
              widget: new TocWidget(entries, view, tocKey(entries)),
              side: 1,
            }),
          })
        }
        continue
      }

      // 脚注定义 `[^1]: 内容`：标记藏掉、内容照常扫行内语法。
      // **光标行不藏**（和标题/列表的规则一致）—— 藏了就没法改编号，光标还会停进
      // 一个零宽 span 里，看着像"这行开头点不动"。
      const fnDef = !isActive ? RE_FOOTNOTE_DEF.exec(text) : null
      if (fnDef) {
        const cut = line.from + (fnDef[1] ?? '').length + (fnDef[2] ?? '').length
        push(line.from, cut)
        scanInline(text.slice(cut - line.from), cut, push, imageAt)
        continue
      }

      if (isActive) {
        // 光标行通常显示原文，但图片例外：粘贴完光标就停在这一行，
        // 只露出 `![](路径)` 会让人以为没插进去（见 scanImagesOnActiveLine）
        const selMain = state.selection.main
        const overlaps = selMain.to > line.from && selMain.from < line.to
        scanImagesOnActiveLine(
          text,
          line.from,
          push,
          imageAt,
          overlaps ? selMain.from : -1,
          overlaps ? selMain.to : -1
        )
        continue
      }

      // 分隔线：整行 --- 藏掉，只留 CSS 画的那条线
      if (RE_HR.test(text)) {
        push(line.from, line.to)
        continue
      }

      // 标题（含列表项里的 `- ## x`）：把 `-`、`#`、空格整段藏掉，只留标题文字
      const h = parseHeading(text)
      if (h) {
        push(line.from, line.from + h.markEnd)
        scanInline(text.slice(h.markEnd), line.from + h.markEnd, push, imageAt)
        continue
      }

      // 引用
      const q = RE_QUOTE.exec(text)
      if (q && !RE_TASK.test(text)) {
        const pre = q[1] ?? ''
        push(line.from, line.from + pre.length)
        const rest = text.slice(pre.length)
        // 警告框的标题行 `[!NOTE]`：标记本身藏掉（标签由 CSS 的 ::before 按类型画，
        // 见 theme-base.css 的 `.jd-adm-note::before{content:"备注"}`），
        // 但**冒号后面的标题文字要留下** —— `> [!WARNING] 别删库` 里的"别删库"是正文。
        const adm = RE_ADM_TITLE.exec(rest)
        if (adm) {
          const markStart = line.from + pre.length
          const markLen = `[!${adm[1]}]`.length
          push(markStart, markStart + markLen)
          const bodyStart = markStart + markLen + (adm[2] ?? '').length
          scanInline(text.slice(bodyStart - line.from), bodyStart, push, imageAt)
          continue
        }
        scanInline(rest, line.from + pre.length, push, imageAt)
        continue
      }

      // 任务列表
      const task = RE_TASK.exec(text)
      if (task) {
        const lead = (task[1] ?? '').length
        const bullet = (task[2] ?? '').length
        const sp1 = (task[3] ?? '').length
        const box = task[4] ?? ' '
        const sp2 = (task[5] ?? '').length
        const start = line.from + lead
        const end = line.from + lead + bullet + sp1 + 3 + sp2
        push(start, end)
        items.push({
          from: start,
          to: start,
          deco: Decoration.widget({
            widget: new MarkerWidget(box.trim() ? 'task-done' : 'task-todo', box.trim() ? '☑' : '☐'),
            side: 1,
          }),
        })
        scanInline(text.slice(end - line.from), end, push, imageAt)
        continue
      }

      // 普通列表
      const li = RE_LIST.exec(text)
      if (li) {
        const lead = (li[1] ?? '').length
        const mark = li[2] ?? ''
        const sp = (li[3] ?? '').length
        const start = line.from + lead
        const end = line.from + lead + mark.length + sp
        const ordered = /^\d/.test(mark)
        push(start, end)
        items.push({
          from: start,
          to: start,
          deco: Decoration.widget({
            widget: ordered
              ? new MarkerWidget('ordered', mark.includes('.') ? `${mark.replace(/[.)]$/, '')}.` : `${mark.replace(/[.)]$/, '')})`)
              : new MarkerWidget('bullet', BULLET),
            side: 1,
          }),
        })
        scanInline(text.slice(end - line.from), end, push, imageAt)
        continue
      }

      // 其余行只扫行内标记
      scanInline(text, line.from, push, imageAt)
    }
  }

  // RangeSetBuilder 只接受按 (from, to) 升序的 add；否则抛 "Ranges must be added sorted"。
  // 同起点的点装饰 to == from，自然排在同起点的 mark（to > from）之前。
  items.sort((a, b) => a.from - b.from || a.to - b.to)
  for (const it of items) builder.add(it.from, it.to, it.deco)
  return builder.finish()
}

/**
 * 无序列表的项目符号。
 *
 * 原实现叫 `bulletChar(mark)`，注释写着「三级实心点、二级空心圈、一级方块」，
 * 但函数体直接 `return '•'`、参数根本没用 —— 注释承诺的层级区分从来没实现。
 *
 * 现在保持统一实心点，并把话说清楚：我们的列表是**逐行的 class**，不是真实的
 * 嵌套 `<ul>`，层级只能靠行首缩进猜。缩进风格在库里并不统一（2/4 空格混用），
 * 猜错会出现「同级列表符号不一样」，比不区分更难看。
 * 真要做，得先有可靠的列表栈（按列表项缩进对齐），那是另一件事。
 */
const BULLET = '•'

export const markdownMarksPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(readonly view: EditorView) {
      this.decorations = buildDecorations(view)
      // 图片不是真正的文字，点它时 CM6 只能按坐标猜一个位置，而**右键根本不动光标** ——
      // 于是「右键图片 → Delete」删的是原来的光标处，用户会以为图片删不掉（实际删掉了别的字）。
      // 这里统一把整段 `![](…)` 选起来：点一下 = 选中这张图，Delete/Backspace 一次删干净。
      view.dom.addEventListener('mousedown', this.onMouseDown, true)
    }

    private onMouseDown = (e: MouseEvent): void => {
      // 只接管左键。右键在这里改选区会让 widget 立刻变成源码（活动行规则），
      // 原来的 <img> 节点被移除，紧随其后的 mouseup / contextmenu 就落到别的
      // 目标上 —— 右键菜单会莫名其妙弹不出来。右键交给 format-bar 的菜单处理，
      // 想删就从菜单里删。
      if (e.button !== 0) return
      const box = (e.target as HTMLElement | null)?.closest<HTMLElement>('.jd-img-box')
      if (!box) return
      const from = Number(box.dataset['jdFrom'])
      const to = Number(box.dataset['jdTo'])
      if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return
      // 拦掉 CM6 按坐标猜位置的默认行为：图片宽 300px，猜出来的位置和语法区间的
      // 关系纯属巧合（点在图片中间往往落到别处）。
      e.preventDefault()
      this.view.dispatch({ selection: { anchor: from, head: to } })
      this.view.focus()
    }

    update(u: ViewUpdate) {
      // 切源码模式不会改动文档、也可能不动光标，得单独听这个 effect，
      // 否则按了 Ctrl+/ 要等下一次输入才刷新。
      const modeChanged = u.transactions.some((tr) => tr.effects.some((e) => e.is(setSourceMode)))
      // 换笔记时 `setDoc()` 先 `setState()`（此刻 docBase 还是空串，图片已按空 base 建好），
      // **再** dispatch `setDocBase` —— 那条 transaction 既不改文档也不动光标，
      // 上面几个判据一条都不命中 → 图片停在 `/img.png` 这种半截路径上，裂图。
      // 日常多半被随后的滚动（viewportChanged）掩盖，所以只在「短到不滚动」的笔记里露头。
      const baseChanged = u.transactions.some((tr) => tr.effects.some((e) => e.is(setDocBase)))
      if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || modeChanged || baseChanged) {
        this.decorations = buildDecorations(u.view)
      }
    }

    destroy(): void {
      this.view.dom.removeEventListener('mousedown', this.onMouseDown, true)
    }
  },
  { decorations: (v) => v.decorations }
)
