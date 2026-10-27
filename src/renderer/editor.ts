import { EditorState, type Extension } from '@codemirror/state'
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
import { tags as t } from '@lezer/highlight'
import { lineClassPlugin } from './lineclasses.js'
import { markdownMarksPlugin, docBaseField, setDocBase } from './markers.js'
import { tableWidgetField } from './table.js'

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
}

export interface EditorCallbacks {
  onChange: (text: string) => void
  onPasteImage: (file: File) => void
  onSaveRequest: () => void
  onDropImage: (file: File) => void
}

export function createEditor(parent: HTMLElement, cb: EditorCallbacks): EditorHandle {
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

    // --- 编辑行为
    EditorView.updateListener.of((u) => {
      if (u.docChanged) cb.onChange(u.state.doc.toString())
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
      indentWithTab,
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap,
    ]),

    placeholder('开始写…'),
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
      view.focus()
    },
    getDoc() {
      return view.state.doc.toString()
    },
    focus() {
      view.focus()
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
