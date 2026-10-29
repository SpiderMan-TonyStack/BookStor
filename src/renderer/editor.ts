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
    EditorState.allowMultipleSelections.of(true),
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
export function insertCodeBlock(view: EditorView): void {
  const { from, to } = view.state.selection.main
  const doc = view.state.doc

  if (from !== to) {
    const start = doc.lineAt(from).from
    const end = doc.lineAt(to).to
    const body = view.state.sliceDoc(start, end)
    view.dispatch({
      changes: { from: start, to: end, insert: '```\n' + body + '\n```' },
      // 光标放到块内正文开头（` ``` ` + 换行 = 4）
      selection: { anchor: start + 4 },
      scrollIntoView: true,
    })
    view.focus()
    return
  }

  const line = doc.lineAt(from)
  if (line.text.trim() === '') {
    // 空行：就地把这一行变成「``` + 空行 + ```」
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: '```\n\n```' },
      selection: { anchor: line.from + 4 },
      scrollIntoView: true,
    })
  } else {
    // 非空行：从光标处断开，另起一个块（前后各留一个换行）
    view.dispatch({
      changes: { from, to, insert: '\n```\n\n```\n' },
      selection: { anchor: from + 5 },
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
  const prefix = level === 0 ? '' : `${'#'.repeat(level)} `
  const insert = indent + prefix + rest
  view.dispatch({
    changes: { from: line.from, to: line.to, insert },
    selection: { anchor: line.from + indent.length + prefix.length },
    scrollIntoView: true,
  })
  view.focus()
}
