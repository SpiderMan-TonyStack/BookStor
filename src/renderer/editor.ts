import { EditorState, EditorSelection, Compartment, type Extension } from '@codemirror/state'
import {
  EditorView,
  keymap,
  drawSelection,
  dropCursor,
  highlightSpecialChars,
  placeholder,
} from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { languages } from '@codemirror/language-data'
import { syntaxHighlighting, HighlightStyle, indentOnInput } from '@codemirror/language'
import { tags as t, classHighlighter } from '@lezer/highlight'
import { lineClassPlugin } from './lineclasses.js'
import { markdownMarksPlugin, docBaseField, setDocBase } from './markers.js'
import { tableWidgetField } from './table.js'
import { foldExtensions } from './fold.js'
import { sourceModeField } from './viewmode.js'
import { mermaidExtensions } from './mermaid.js'
import { stripInline, findLinkAt } from './inline-marks.js'
import {
  changeHeadingLevel,
  indentList,
  isBlankLine,
  setBlockKind,
  setTaskChecked,
  toggleTaskChecked,
  type BlockKind,
} from './block-edits.js'
import { columnAt, setColumnAlign, tableColumnCount, type Cell } from './table-parse.js'

/**
 * 语法高亮 —— 刻意克制。
 * Typora 主题里那 23 条 `.cm-s-inner` token 配色规则我们丢弃（策划案 §5.3），
 * 所以这里只用最朴素的着色：标题加粗、代码等宽、标记淡化。
 * 真正的颜色交给主题的排版规则，M3 再补。
 */
const jdHighlight = HighlightStyle.define([
  { tag: t.heading1, fontWeight: '700' },
  { tag: t.heading2, fontWeight: '700' },
  { tag: t.heading3, fontWeight: '600' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: '#81d8cf', textDecoration: 'underline' },
  { tag: t.url, color: '#81d8cf' },
  { tag: t.monospace, fontFamily: 'var(--jd-font-mono, Consolas, monospace)' },
  { tag: t.processingInstruction, opacity: '0.4' },
  { tag: t.contentSeparator, opacity: '0.4' },
  // M2：标记字符被 markers.ts 的 font-size:0 收起后，
  // Lezer 仍会把它们标成 processingInstruction；这里不去动它们，
  // 让 CSS 决定宽度，避免两套机制打架。
])

export interface EditorHandle {
  view: EditorView
  setDoc(text: string, baseDir?: string): void
  getDoc(): string
  focus(): void
  destroy(): void
  /**
   * 只读开关。
   *
   * 给「非 UTF-8 文件」用：那种文件读进来必然是乱码，允许编辑再保存就是把原文
   * 永久转码写坏，所以打开时就锁住，用户能看、能复制，但敲不进去字。
   * 用 Compartment 而不是重建 state —— 重建会把撤销历史、选区、滚动位置全丢掉。
   */
  setReadOnly(value: boolean): void
}

export interface EditorCallbacks {
  onChange: (text: string) => void
  onPasteImage: (file: File) => void
  onSaveRequest: () => void
  onDropImage: (file: File) => void
  /** 选区/光标变了（大纲高亮当前章节用） */
  onSelection?: (pos: number) => void
}

/**
 * ↑ / ↓：有选区时，从**光标那一端**上下移一行，而不是塌陷到选区另一头。
 *
 * CM6 的 `cursorByLine` 对非空选区执行的是 `rangeEnd(range, forward)`：
 *   ↑ → 光标直接放到选区的 from（顶部），↓ → 直接放到 to（底部）
 * 塌陷之后**不再移动**。后果是选中一个 20 行的代码块、在底部按一下 ↑，
 * 光标一下子瞬移到块首 —— 看着就像「直接冲到顶部」，而不是「往上一行」。
 *
 * 这里改成从 head（用户最后一次拖到的位置）起步移动一行：
 * 不管选区是向上还是向下拖的，按 ↑ 就是往上走一行，光标不会跳到另一头。
 *
 * 只在「单光标 + 有选区」时接管，其余返回 false 交回 CM6 默认实现 ——
 * 多光标同时塌陷的语义容易出岔子，不值得为它冒险。
 */
function arrowFromCursor(forward: boolean) {
  return (view: EditorView): boolean => {
    const state = view.state
    if (state.selection.ranges.length > 1) return false
    const sel = state.selection.main
    if (sel.empty) return false
    const target = view.moveVertically(EditorSelection.cursor(sel.head), forward)
    view.dispatch({ selection: target, scrollIntoView: true })
    return true
  }
}

export function createEditor(parent: HTMLElement, cb: EditorCallbacks): EditorHandle {
  // 只读开关走 Compartment：改它不需要重建 state（重建会丢撤销历史与选区）
  const readOnlyCompartment = new Compartment()
  /** 当前只读状态。setDoc 重建 state 后要照它补回 Compartment 的值 */
  let readOnly = false

  const extensions: Extension[] = [
    // --- 基础能力（手挑，不用 basicSetup：Typora 没有行号、没有活动行底色）
    highlightSpecialChars(),
    history(),
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    // 多光标**故意不开**（4.4.0 关掉）：Typora 没有多光标，本项目严格对齐它的交互。
    // 开着的时候 Ctrl+点击 会多出一根光标（CM6 的 addsSelectionRange 按 ctrlKey 判定），
    // 而 Ctrl+点击 在 Windows 上又是「打开链接」的肌肉记忆 —— 误触后两根光标同时打字，
    // 很容易把一行删掉一半。要恢复多光标，把下面这行注释放开即可。
    // EditorState.allowMultipleSelections.of(true),
    highlightSelectionMatches(),
    EditorView.lineWrapping,

    // --- Markdown
    markdown({
      base: markdownLanguage,
      codeLanguages: languages,
      addKeymap: true,
    }),
    syntaxHighlighting(jdHighlight),

    // Typora 主题的代码配色写成 `.cm-s-inner .cm-keyword{color:…}`（CodeMirror 5 的
    // token 类）。上面 jdHighlight 只给了最朴素的几个样式，代码块里的关键字/字符串/
    // 注释因此全是一个颜色 —— 观感上「根本不像代码块」。
    //
    // classHighlighter 给每个 token 挂上 `tok-keyword` / `tok-string` / `tok-comment`
    // 这类语义类名；主进程的翻译管线会把主题里的 `.cm-*` 改写成对应的 `tok-*`
    // （见 mapping.json 的 classes 与 theme.ts 的 stripCodeMirrorScope）。
    // 两套高亮器可以共存：它们写的是不同的类名，互不覆盖。
    syntaxHighlighting(classHighlighter),

    // --- 行级语义 class（供 Typora 主题选择器映射用，见 §5.2-B）
    lineClassPlugin,

    // --- 当前笔记所在目录（图片相对路径靠它解析）
    docBaseField,

    // --- 语法标记显隐（M2）：非活动行藏掉 # ** ` > - 1. ![]()
    markdownMarksPlugin,

    // --- 表格渲染：光标不在表内时换成真 <table>（106 篇笔记有表格，T2 要求边框+斑马纹）
    //     注意它必须是 StateField，**不能**用 ViewPlugin —— CM6 禁止插件提供 block 装饰
    //     （`RangeError: Block decorations may not be specified via plugins`），见 table.ts 注释。
    tableWidgetField,

    // --- 折叠（M5）：标题与代码块可收起。
    //     内容必须用 block replace 从布局里换掉，不能用 CSS display:none ——
    //     隐藏的行不在 CM6 的高度模型里，会让滚动/点击/光标全部偏移。
    ...foldExtensions,

    // --- 源码模式（Ctrl+/）：markers / table / fold 三处都读这个 field
    sourceModeField,

    // --- Mermaid 代码块渲染（mermaid 库按需动态加载，见 mermaid.ts）
    ...mermaidExtensions,

    // --- 编辑行为
    EditorView.updateListener.of((u) => {
      if (u.docChanged) cb.onChange(u.state.doc.toString())
      if (u.selectionSet && cb.onSelection) cb.onSelection(u.state.selection.main.head)
    }),

    // --- 粘贴 / 拖入图片
    EditorView.domEventHandlers({
      paste(event, view) {
        const items = event.clipboardData?.items
        if (!items) return false
        for (const item of items) {
          if (item.kind === 'file' && item.type.startsWith('image/')) {
            const file = item.getAsFile()
            if (file) {
              event.preventDefault()
              cb.onPasteImage(file)
              return true
            }
          }
        }
        return false
      },
      drop(event, view) {
        const files = event.dataTransfer?.files
        if (!files || files.length === 0) return false
        const imgs = [...files].filter((f) => f.type.startsWith('image/'))
        if (imgs.length === 0) return false
        event.preventDefault()
        // 让光标落到落点（否则图片会插到文档开头）
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (pos !== null) view.dispatch({ selection: { anchor: pos } })
        for (const f of imgs) cb.onDropImage(f)
        return true
      },
    }),

    keymap.of([
      {
        key: 'Mod-s',
        preventDefault: true,
        run: () => {
          cb.onSaveRequest()
          return true
        },
      },
      // 这两条必须排在 defaultKeymap 前面：CM6 默认的 ↑/↓ 一遇到非空选区就
      // 直接塌陷到选区另一端、不再移动（见下面 arrowFromCursor 的注释）
      { key: 'ArrowUp', run: arrowFromCursor(false) },
      { key: 'ArrowDown', run: arrowFromCursor(true) },
      indentWithTab,
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
    ]),

    placeholder('开始写…'),

    // --- 只读（非 UTF-8 文件打开时置 true，见 setReadOnly）
    //     放在 extensions 里是为了 setDoc 重建 state 后仍能补回当前值
    readOnlyCompartment.of(EditorState.readOnly.of(false)),
  ]

  const view = new EditorView({
    state: EditorState.create({ doc: '', extensions }),
    parent,
  })

  return {
    view,
    setDoc(text: string, baseDir?: string) {
      // 整篇替换：用新 state，避免上一篇的撤销历史污染这一篇
      view.setState(
        EditorState.create({
          doc: text,
          extensions,
        })
      )
      // 相对图片路径要靠笔记所在目录才能变成 file:// 地址，换了笔记就得跟着换
      if (baseDir !== undefined) view.dispatch({ effects: setDocBase.of(baseDir) })
      // setState 会把 Compartment 里的值重置回默认（false），只读状态必须补回来 ——
      // 否则翻到下一篇只读文件时它会突然变成可编辑
      view.dispatch({
        effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly)),
      })
      view.focus()
    },
    getDoc() {
      return view.state.doc.toString()
    },
    focus() {
      view.focus()
    },
    setReadOnly(value: boolean) {
      readOnly = value
      view.dispatch({
        effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(value)),
      })
    },
    destroy() {
      view.destroy()
    },
  }
}

/** 在光标处插入文本，并把光标放到 `selectOffset` 处（相对插入点） */
export function insertAtCursor(
  view: EditorView,
  text: string,
  selectOffset?: number
): void {
  const { from, to } = view.state.selection.main
  const sel = selectOffset === undefined ? from + text.length : from + selectOffset
  view.dispatch({
    changes: { from, to, insert: text },
    selection: { anchor: sel },
    scrollIntoView: true,
  })
  view.focus()
}

/** 给选区包一层标记（加粗/斜体/行内代码）；没选区就插入一对并把光标放中间 */
export function wrapSelection(view: EditorView, marker: string): void {
  const { from, to } = view.state.selection.main
  const selected = view.state.sliceDoc(from, to)

  // 已经包着 → 脱掉
  const before = view.state.sliceDoc(Math.max(0, from - marker.length), from)
  const after = view.state.sliceDoc(to, Math.min(view.state.doc.length, to + marker.length))
  if (before === marker && after === marker) {
    view.dispatch({
      changes: [
        { from: from - marker.length, to: from, insert: '' },
        { from: to, to: to + marker.length, insert: '' },
      ],
      selection: { anchor: from - marker.length, head: to - marker.length },
    })
    return
  }

  if (from === to) {
    view.dispatch({
      changes: { from, to, insert: marker + marker },
      selection: { anchor: from + marker.length },
      scrollIntoView: true,
    })
  } else {
    view.dispatch({
      changes: { from, to, insert: marker + selected + marker },
      selection: { anchor: from + marker.length, head: to + marker.length },
      scrollIntoView: true,
    })
  }
  view.focus()
}

/** 打开 CM6 的搜索面板（Ctrl+F / 菜单「查找」都走这里） */
export function openSearch(view: EditorView): void {
  view.focus()
  openSearchPanel(view)
}

/**
 * 用一对**首尾不同**的标记包住选区（`<u>…</u>`、`<!-- … -->`）。
 *
 * 和上面的 `wrapSelection` 是同一套 toggle 语义（已在里面就脱掉），区别只在于
 * 它只收一个共享的 marker —— 那个只能处理 `**` 这种对称标记。
 *
 * 没有选区时插入 `before + placeholder + after` 并把 placeholder 选中，
 * 这样一敲字就替换掉占位内容，不用先按 Delete。
 */
export function wrapSelectionPair(
  view: EditorView,
  before: string,
  after: string,
  placeholder = ''
): void {
  const { from, to } = view.state.selection.main
  const doc = view.state.doc
  const selected = view.state.sliceDoc(from, to)

  // 已经包着 → 脱掉（光标/选区按去掉两侧标记后的位置重放）
  const pre = view.state.sliceDoc(Math.max(0, from - before.length), from)
  const post = view.state.sliceDoc(to, Math.min(doc.length, to + after.length))
  if (pre === before && post === after) {
    view.dispatch({
      changes: [
        { from: from - before.length, to: from, insert: '' },
        { from: to, to: to + after.length, insert: '' },
      ],
      selection: { anchor: from - before.length, head: from - before.length + selected.length },
    })
    view.focus()
    return
  }

  const inner = from === to ? placeholder : selected
  const insert = before + inner + after
  const innerFrom = from + before.length
  view.dispatch({
    changes: { from, to, insert },
    // 有占位文字就选中它；没有就把光标放在两个标记中间
    selection:
      inner.length > 0
        ? { anchor: innerFrom, head: innerFrom + inner.length }
        : { anchor: innerFrom },
    scrollIntoView: true,
  })
  view.focus()
}

/** 插入链接用的占位文字（没选中任何东西时用） */
const LINK_PLACEHOLDER = '链接文字'
/** 地址占位 —— 插完直接选中它，敲一下就替换 */
const URL_PLACEHOLDER = 'url'

/**
 * 超链接（Ctrl+K）：有选区就用选区当链接文字，否则用「链接文字」占位。
 *
 * 和 `wrapSelectionPair` 不能共用的原因：这里插完要**选中地址部分**而不是文字部分 ——
 * 用户的下一步动作一定是填地址，光标停在文字上要再点一次。
 */
export function insertLink(view: EditorView): void {
  const { from, to } = view.state.selection.main
  const selected = view.state.sliceDoc(from, to)
  const text = selected.length > 0 ? selected : LINK_PLACEHOLDER
  const insert = `[${text}](${URL_PLACEHOLDER})`
  const urlFrom = from + 1 + text.length + 2 // `[` + 文字 + `](`
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: urlFrom, head: urlFrom + URL_PLACEHOLDER.length },
    scrollIntoView: true,
  })
  view.focus()
}

/**
 * 清除样式（Ctrl+\）：把选区里的行内标记脱掉；没有选区就作用于**当前行**。
 *
 * 返回是否真的改了文档 —— 调用方据此决定要不要提示「没什么可清的」。
 * 宁可落到整行也不做成"没选区就不动"：点了菜单却毫无反应，用户会以为坏了。
 */
export function clearInlineMarks(view: EditorView): boolean {
  const sel = view.state.selection.main
  const doc = view.state.doc
  const start = sel.empty ? doc.lineAt(sel.from).from : sel.from
  const end = sel.empty ? doc.lineAt(sel.from).to : sel.to
  const raw = view.state.sliceDoc(start, end)
  const cleaned = stripInline(raw)
  if (cleaned === raw) return false
  view.dispatch({
    changes: { from: start, to: end, insert: cleaned },
    selection: { anchor: start, head: start + cleaned.length },
    scrollIntoView: true,
  })
  view.focus()
  return true
}

/**
 * 光标所在链接（「链接操作」子菜单用）。
 *
 * CM6 把每行渲染成一串文本节点，位置换算很绕；这里只按**当前行**取文本，
 * 用行内偏移去找 `[文字](地址)` —— 链接天然不会跨行，够用。
 */
export function linkAtCursor(
  view: EditorView
): { text: string; url: string; from: number; to: number } | null {
  const pos = view.state.selection.main.head
  const line = view.state.doc.lineAt(pos)
  const hit = findLinkAt(line.text, pos - line.from)
  if (!hit) return null
  return { text: hit.text, url: hit.url, from: line.from + hit.from, to: line.from + hit.to }
}

/** 把光标处的链接还原成纯文字（菜单「链接操作 → 移除链接」） */
export function removeLinkAt(view: EditorView): boolean {
  const hit = linkAtCursor(view)
  if (!hit) return false
  view.dispatch({
    changes: { from: hit.from, to: hit.to, insert: hit.text },
    selection: { anchor: hit.from + hit.text.length },
    scrollIntoView: true,
  })
  view.focus()
  return true
}

/**
 * 插入代码块（三反引号围栏），光标落在块中间，可以直接开始敲代码。
 *
 * 和「行内代码」的区别：行内代码插的是一对单个反引号（`x`），
 * 只能包一行里的一小段；这里是独立成块的围栏，块内可以有任意多行。
 *
 * 两种情形：
 *   - 有选区：把选中的整行包起来（不是只包字符，否则围栏会插在行中间）
 *   - 无选区：光标在空行上就地把空行变成块；否则在光标处另起一个空块
 *     （多退一个换行，免得把当前行的后半句挤进代码块里）
 */
export function insertCodeBlock(view: EditorView, lang = ''): void {
  const { from, to } = view.state.selection.main
  const doc = view.state.doc

  // 语言标记会被**直接拼进围栏**：只取第一段并去掉反引号/换行。
  // 带一个换行进来就等于凭空多插一行，带反引号会把围栏提前关掉。
  const mark = (lang.trim().split(/\s+/)[0] ?? '').replace(/`/g, '')
  const open = '```' + mark
  // 光标落在块内正文开头：围栏 + 换行
  const openLen = open.length + 1

  if (from !== to) {
    const start = doc.lineAt(from).from
    const end = doc.lineAt(to).to
    const body = view.state.sliceDoc(start, end)
    view.dispatch({
      changes: { from: start, to: end, insert: open + '\n' + body + '\n```' },
      selection: { anchor: start + openLen },
      scrollIntoView: true,
    })
    view.focus()
    return
  }

  const line = doc.lineAt(from)
  if (line.text.trim() === '') {
    // 空行：就地把这一行变成「``` + 空行 + ```」
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: open + '\n\n```' },
      selection: { anchor: line.from + openLen },
      scrollIntoView: true,
    })
  } else {
    // 非空行：从光标处断开，另起一个块（前后各留一个换行）
    view.dispatch({
      changes: { from, to, insert: '\n' + open + '\n\n```\n' },
      selection: { anchor: from + 1 + openLen },
      scrollIntoView: true,
    })
  }
  view.focus()
}

/** 把当前行改成 N 级标题（N=0 表示正文），保留缩进之后的内容 */
export function setHeading(view: EditorView, level: number): void {
  const line = view.state.doc.lineAt(view.state.selection.main.from)
  const text = line.text
  const m = text.match(/^(\s*)(#{1,6}\s+|)/)
  if (!m) return
  const indent = m[1] ?? ''
  const rest = text.slice((m[1]?.length ?? 0) + (m[2]?.length ?? 0))
  // `#` 后面的间隔原样保留（可能是两个空格）：库里 732 个标题是双空格写法，
  // 换成单空格只是无意义的字节改动。见 block-edits.ts 的 changeHeadingLevel。
  const gap = (m[2] ?? '').replace(/^#{1,6}/, '') || ' '
  const prefix = level === 0 ? '' : `${'#'.repeat(level)}${gap}`
  const insert = indent + prefix + rest
  view.dispatch({
    changes: { from: line.from, to: line.to, insert },
    selection: { anchor: line.from + indent.length + prefix.length },
    scrollIntoView: true,
  })
  view.focus()
}

/** 选区覆盖的行号范围（无选区时就是光标那一行） */
function selectedLines(view: EditorView): { first: number; last: number } {
  const sel = view.state.selection.main
  const doc = view.state.doc
  return { first: doc.lineAt(sel.from).number, last: doc.lineAt(sel.to).number }
}

/**
 * 把选区覆盖的每一行改成同一种块（引用 / 有序 / 无序 / 任务 / 段落）。
 *
 * 一次 dispatch 提交全部改动：逐行 dispatch 会让撤销历史碎成一堆，
 * 用户按一次 Ctrl+Z 只退掉一行。
 *
 * 多行选区里的**空行跳过**（Typora 也这样）—— 否则选一段带空行的文字转列表，
 * 中间会凭空多出几个 `- `。
 */
export function setBlockKindForSelection(view: EditorView, kind: BlockKind): void {
  const doc = view.state.doc
  const { first, last } = selectedLines(view)
  const changes: { from: number; to: number; insert: string }[] = []
  let ordinal = 1

  for (let n = first; n <= last; n++) {
    const line = doc.line(n)
    if (last > first && isBlankLine(line.text)) continue
    const next = setBlockKind(line.text, kind, ordinal)
    if (kind === 'ol') ordinal++
    if (next !== line.text) changes.push({ from: line.from, to: line.to, insert: next })
  }

  if (changes.length === 0) return
  view.dispatch({ changes, scrollIntoView: true })
  view.focus()
}

/**
 * 提升（delta=-1，H2→H1）/ 降低（delta=+1，H1→H2）标题级别，作用于选中的每一行。
 *
 * 方向别搞反：**提升标题级别 = 让 `#` 变少**（字更大、层级更高）。见 block-edits.ts。
 * 返回 false 表示一行标题都没有（调用方据此提示，而不是静默什么都不做）。
 */
export function changeHeadingLevelForSelection(view: EditorView, delta: number): boolean {
  const doc = view.state.doc
  const { first, last } = selectedLines(view)
  const changes: { from: number; to: number; insert: string }[] = []
  let changed = false

  for (let n = first; n <= last; n++) {
    const line = doc.line(n)
    if (last > first && isBlankLine(line.text)) continue
    const next = changeHeadingLevel(line.text, delta)
    if (next === null) continue
    changed = true
    if (next !== line.text) changes.push({ from: line.from, to: line.to, insert: next })
  }

  if (!changed) return false
  if (changes.length > 0) {
    view.dispatch({ changes, scrollIntoView: true })
    view.focus()
  }
  return true
}

/**
 * 列表缩进加 / 减一级（按 2 空格一步），多行一起走。
 * 返回 false 表示选中的行里没有列表 / 引用块可缩进（调用方据此提示）。
 */
export function indentListForSelection(view: EditorView, delta: number, width = 2): boolean {
  const doc = view.state.doc
  const { first, last } = selectedLines(view)
  const changes: { from: number; to: number; insert: string }[] = []

  for (let n = first; n <= last; n++) {
    const line = doc.line(n)
    if (isBlankLine(line.text)) continue
    const next = indentList(line.text, delta, width)
    if (next === null || next === line.text) continue
    changes.push({ from: line.from, to: line.to, insert: next })
  }

  if (changes.length === 0) return false
  view.dispatch({ changes })
  view.focus()
  return true
}

/** 勾选 / 取消勾选任务项，作用于选中的每个任务行；返回是否命中过任务 */
export function toggleTaskStateForSelection(view: EditorView): boolean {
  const doc = view.state.doc
  const { first, last } = selectedLines(view)
  const changes: { from: number; to: number; insert: string }[] = []
  let hit = false

  for (let n = first; n <= last; n++) {
    const line = doc.line(n)
    const next = toggleTaskChecked(line.text)
    if (next === null) continue
    hit = true
    if (next !== line.text) changes.push({ from: line.from, to: line.to, insert: next })
  }

  if (changes.length > 0) {
    view.dispatch({ changes })
    view.focus()
  }
  return hit
}

/**
 * 在光标处插入一个「整块」内容（公式块 / 表格 / 警告框 / 分隔线 / 目录…）。
 *
 * 两种情况的分界是「当前行是不是空行」：
 *   - 空行 → 就地替换这一行。用户先敲了几个回车占位，就是想要东西落在那儿；
 *   - 非空行 → 从光标处断开，前后各留一个空行。直接把 `---` 塞进句子中间
 *     会把那一行劈成两半，看起来很吓人。
 *
 * `caretOffset` 是相对 block 开头的落点：公式块要落在 `$$\n` 之后、表格要落在
 * 第一个单元格里 —— 不指定的话用户还得自己挪光标。
 */
export function insertBlock(
  view: EditorView,
  block: string,
  caretOffset?: number
): void {
  const sel = view.state.selection.main
  const doc = view.state.doc
  const line = doc.lineAt(sel.from)

  if (line.text.trim() === '') {
    // 空行就地替换 —— 但**前后各留一个空行**。
    //
    // 不留的后果（4.3.0 实测）：连着插两个块时，上一个块末尾的 `\n` 会产生一个
    // 空行，下一块正好替换掉它，于是「表格紧贴着 `> [!NOTE]`」「`[TOC]` 紧贴着
    // `***`」。在我们的逐行渲染里只是难看，可文件是要给别人（Typora / GitHub）
    // 看的：GFM 里表格前面没有空行就不算表格，`---` 紧跟段落还会变成 setext 标题。
    // 所以两个方向都补：前面有内容才补（首行不用），后面还有内容才补（文末不用）。
    const before = line.from > 0 ? '\n' : ''
    const after = line.to < doc.length ? '\n' : ''
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: `${before}${block}${after}` },
      selection: { anchor: line.from + before.length + (caretOffset ?? block.length) },
      scrollIntoView: true,
    })
  } else {
    // 非空行：接到**这一行的行尾**后面，不在光标处劈开句子。
    // 光标停在句子中间时插表格，前半句应该完整留在原来那一行 —— 从光标处断开
    // 会把一句话劈成两半（`这是前` / `半句`），看起来就像文档被弄坏了。
    const at = doc.lineAt(sel.to).to
    view.dispatch({
      changes: { from: at, to: at, insert: `\n\n${block}\n` },
      selection: { anchor: at + 2 + (caretOffset ?? block.length) },
      scrollIntoView: true,
    })
  }
  view.focus()
}

/**
 * 在上方 / 下方插入一个空段落。
 *
 * 判据是「当前行是否为空」：空行上按「下方插入」不该再叠一个空行
 * （否则连按两下就多出两行空白，用户会觉得按钮坏了）。
 */
export function insertSiblingParagraph(view: EditorView, where: 'above' | 'below'): void {
  const sel = view.state.selection.main
  const doc = view.state.doc
  const line = doc.lineAt(sel.from)

  if (where === 'above') {
    view.dispatch({
      changes: { from: line.from, insert: '\n' },
      selection: { anchor: line.from },
      scrollIntoView: true,
    })
  } else {
    // 非空行：在行尾换行，光标落到新行；空行：光标直接移到下一行开头
    if (line.text.trim() === '') {
      view.dispatch({ selection: { anchor: Math.min(doc.length, line.to + 1) }, scrollIntoView: true })
    } else {
      view.dispatch({
        changes: { from: line.to, insert: '\n' },
        selection: { anchor: line.to + 1 },
        scrollIntoView: true,
      })
    }
  }
  view.focus()
}

/** 把选中的任务行明确标成已完成 / 未完成；返回是否命中过任务行 */
export function setTaskStateForSelection(view: EditorView, checked: boolean): boolean {
  const doc = view.state.doc
  const { first, last } = selectedLines(view)
  const changes: { from: number; to: number; insert: string }[] = []
  let hit = false

  for (let n = first; n <= last; n++) {
    const line = doc.line(n)
    const next = setTaskChecked(line.text, checked)
    if (next === null) continue
    hit = true
    if (next !== line.text) changes.push({ from: line.from, to: line.to, insert: next })
  }

  if (changes.length > 0) {
    view.dispatch({ changes })
    view.focus()
  }
  return hit
}

/**
 * 光标所在表格的块范围（连续以 `|` 开头的行）。不在表格里返回 null。
 *
 * 不算表头与分隔行的区别：菜单里的操作都是「整块」级别的（插一行 / 删整块），
 * 分清表头没有意义。真要做「插到表头上方」才需要，那时再细。
 */
export function tableBlockAt(view: EditorView): { first: number; last: number } | null {
  const doc = view.state.doc
  const line = doc.lineAt(view.state.selection.main.head)
  if (!/^\s{0,3}\|/.test(line.text)) return null

  let first = line.number
  let last = line.number
  while (first > 1 && /^\s{0,3}\|/.test(doc.line(first - 1).text)) first--
  while (last < doc.lines && /^\s{0,3}\|/.test(doc.line(last + 1).text)) last++
  return { first, last }
}

/** 在表格最后一行下方插入一个同列数的空行 */
export function insertTableRowBelow(view: EditorView): boolean {
  const block = tableBlockAt(view)
  if (!block) return false
  const doc = view.state.doc
  const cols = Math.max(1, tableColumnCount(doc.line(block.first).text))
  const row = `| ${Array(cols).fill(' ').join(' | ')} |`
  const lastLine = doc.line(block.last)
  view.dispatch({
    changes: { from: lastLine.to, insert: '\n' + row },
    // 光标落在第一格内容处：`| ` 两个字符之后
    selection: { anchor: lastLine.to + 3 },
    scrollIntoView: true,
  })
  view.focus()
  return true
}

/**
 * 表格列对齐（仿 Typora 的「对齐」）。
 *
 * GFM 里列对齐**只有一种表达**：分隔行那一格的首尾冒号。
 * 所以这个命令做的事很小 —— 只改分隔行的目标单元格：
 *   `---` 默认 / `:---` 左 / `:---:` 居中 / `---:` 右
 *
 * 三个约束（都是「纯文本是唯一真源」的直接推论）：
 *   ① **只动那一格的冒号**，短横线数量与整行空格风格原样保留。不重建整行 ——
 *      把 `|---|:--:|---|` 重排成 `| --- | :-: | --- |` 等于顺手格式化了用户的文件。
 *   ② **只改分隔行**，不碰表头和数据行。
 *   ③ 一次 dispatch，一步撤销。
 *
 * 列号取**光标所在行的列**（数 `|` 得到，见 table-parse 的 columnAt）：表格里各行列数
 * 不一致时，用户看到的是"我正指着这一列"，以他的光标为准；分隔行列数不够就直接拒绝。
 */
export function alignTableColumn(view: EditorView, align: Cell['align']): boolean {
  const block = tableBlockAt(view)
  // 至少要有表头 + 分隔行两行才谈得上对齐
  if (!block || block.last - block.first < 1) return false

  const doc = view.state.doc
  const head = view.state.selection.main.head
  const cur = doc.lineAt(head)
  const col = columnAt(cur.text, head - cur.from)

  const sep = doc.line(block.first + 1)
  const next = setColumnAlign(sep.text, col, align)
  if (next === null) return false
  if (next !== sep.text) {
    view.dispatch({ changes: { from: sep.from, to: sep.to, insert: next } })
    view.focus()
  }
  return true
}

/** 删掉整个表格块（只动文本，不碰别的） */
export function removeTableBlock(view: EditorView): boolean {
  const block = tableBlockAt(view)
  if (!block) return false
  const doc = view.state.doc
  const from = doc.line(block.first).from
  const lastLine = doc.line(block.last)
  // 连带吃掉最后一个换行，否则会留一行空白
  const to = lastLine.to < doc.length ? lastLine.to + 1 : lastLine.to
  view.dispatch({
    changes: { from, to, insert: '' },
    selection: { anchor: from },
    scrollIntoView: true,
  })
  view.focus()
  return true
}
