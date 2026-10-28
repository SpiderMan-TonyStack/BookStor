import { EditorView, Decoration, type DecorationSet, ViewPlugin, type ViewUpdate, WidgetType } from '@codemirror/view'
import { RangeSetBuilder, StateEffect, StateField } from '@codemirror/state'
import { createFenceState, stepFence } from './fence.js'
import { parseHeading } from './heading.js'
import { isSourceMode, setSourceMode } from './viewmode.js'

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

// 标题判断统一走 heading.ts（同时认行首 `## x` 和列表项里的 `- ## x`）
const RE_QUOTE = /^([ \t]{0,3}>[ \t]?)/
const RE_TASK = /^([ \t]*)([-*+])([ \t]+)\[([ xX])\]([ \t]+)/
const RE_LIST = /^([ \t]*)([-*+]|\d+[.)])([ \t]+)/
// 围栏判断统一走 fence.ts 的状态机（与 lineclasses.ts 共用同一份逻辑）：
// 列表项内 4–8 空格缩进的围栏要能识别，块内更深缩进的 ``` 不能把块提前关掉。
const RE_HR = /^[ \t]{0,3}([-*_])([ \t]*\1){2,}[ \t]*$/

/** 当前笔记所在目录 —— 相对图片路径要靠它才能变成 file:// 绝对地址 */
export const setDocBase = StateEffect.define<string>()

export const docBaseField = StateField.define<string>({
  create: () => '',
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setDocBase)) return e.value
    return v
  },
})

/** 把 markdown 里的图片路径变成浏览器能加载的地址 */
function toImageSrc(raw: string, base: string): string {
  if (/^(https?:|data:|file:)/i.test(raw)) return raw
  // 反斜杠是 Windows 写法，浏览器不认；只在渲染层归一，绝不回写文本。
  let p = raw.replace(/\\/g, '/')
  // 已经是百分号编码的别再编一次
  try {
    p = decodeURI(p)
  } catch {
    /* 保持原样 */
  }
  const abs = p.startsWith('/') ? p : `${base.replace(/\\/g, '/').replace(/\/+$/, '')}/${p.replace(/^\.\//, '')}`
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
  constructor(readonly src: string, readonly alt: string, readonly raw: string) {
    super()
  }
  override eq(other: ImageWidget) {
    return other.src === this.src && other.alt === this.alt
  }
  override toDOM(): HTMLElement {
    const wrap = document.createElement('span')
    wrap.className = 'jd-img-box'
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
 * 行内标记扫描。只处理斜体/加粗/删除线/行内代码/链接这五类，
 * 遇到反斜杠转义直接跳过两个字符。
 */
function scanInline(
  text: string,
  base: number,
  emit: (from: number, to: number, deco?: Decoration) => void,
  imageAt: (pos: number, alt: string, target: string) => void = () => {}
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
      const marker = c.repeat(n)
      const close = text.indexOf(marker, i + n)
      if (close > i + n) {
        // 内容不能以空格开头（`* 不是斜体` 这种不是语法）
        if (text[i + n] !== ' ' && text[close - 1] !== ' ') {
          emit(base + i, base + i + n)
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
      const m = /^\[([^\]]*)\]\(([^)]*)\)/.exec(text.slice(bracketAt))
      if (m) {
        const inner = m[1] ?? ''
        const target = m[2] ?? ''
        if (isImage) {
          // ![alt](path) → 显示图片本身（Typora 的样子）。
          // 整段语法藏掉，在同一位置插一个 ImageWidget。
          // 只有光标的行不会走到这里（活动行前面已经 continue，显示原文）。
          const from = base + i
          const to = base + bracketAt + m[0].length
          emit(from, to)
          // ![alt](path "title") —— 去掉可选 title，与 files.ts 的取图逻辑一致
          let clean = target.trim()
          const titleMatch = clean.match(/^(.+?)\s+("[^"]*"|'[^']*'|\([^)]*\))$/)
          if (titleMatch?.[1]) clean = titleMatch[1].trim()
          if (clean.startsWith('<') && clean.endsWith('>')) clean = clean.slice(1, -1)
          imageAt(from, inner, clean)
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
  const imageAt = (pos: number, alt: string, target: string) => {
    if (!target) return
    items.push({
      from: pos,
      to: pos,
      deco: Decoration.widget({
        widget: new ImageWidget(toImageSrc(target, docBase), alt, target),
        side: 1,
      }),
    })
  }

  // 视口之前先把围栏状态推出来
  const firstVisible = view.visibleRanges.length > 0 ? view.visibleRanges[0]!.from : 0
  const scanTo = state.doc.lineAt(firstVisible).number - 1
  const fenceState = createFenceState()
  for (let n = 1; n <= scanTo; n++) {
    stepFence(fenceState, state.doc.line(n).text)
  }

  for (const range of view.visibleRanges) {
    const startLine = state.doc.lineAt(range.from).number
    const endLine = state.doc.lineAt(range.to).number
    for (let n = startLine; n <= endLine; n++) {
      const line = state.doc.line(n)
      const text = line.text
      const isActive = activeLines.has(n)

      // 围栏标记行：永远处理（藏 ``` 和语言名）
      const fenceStep = stepFence(fenceState, text)
      if (fenceStep.isMarker) {
        if (!isActive) {
          const at = line.from + fenceStep.indent
          push(at, at + fenceStep.ticks)
          // 语言名保留但淡化（theme-fix 的 .jd-code-fence 已处理），藏在行尾更干净
          if (fenceStep.lang) push(at + fenceStep.ticks, line.to)
        }
        continue
      }

      if (fenceStep.inside) continue // 代码内部一个字都不动

      if (isActive) continue

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
        scanInline(text.slice(pre.length), line.from + pre.length, push, imageAt)
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
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }
    update(u: ViewUpdate) {
      // 切源码模式不会改动文档、也可能不动光标，得单独听这个 effect，
      // 否则按了 Ctrl+/ 要等下一次输入才刷新。
      const modeChanged = u.transactions.some((tr) => tr.effects.some((e) => e.is(setSourceMode)))
      if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged || modeChanged) {
        this.decorations = buildDecorations(u.view)
      }
    }
  },
  { decorations: (v) => v.decorations }
)
