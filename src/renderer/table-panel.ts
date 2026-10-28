import type { EditorView } from '@codemirror/view'
import { tableAt, joinRow, type TableHit } from './table.js'
import { splitRow } from './table-parse.js'

/**
 * 表格面板（策划案 M5）：光标在表格里时浮出工具条，能增删行列、改对齐。
 *
 * 为什么是"浮在窗口底部"而不是"贴在表格旁边"：
 * 贴表格要算块首行的屏幕坐标，滚动、折叠、换主题都要重算，还得处理贴近视口边缘的翻转；
 * 而光标在表格里时 table.ts 本来就已经把表格退回源码行，用户视线就在那一块，
 * 底部固定条既够得着又永远不会跑偏。稳定优先。
 *
 * 所有操作都只改**表格那几行**，不碰文档其他地方；改完立刻 refresh，
 * 光标会被 dispatch 带到合理位置（否则面板会因为光标离开表格而自己消失）。
 */

interface Options {
  el: HTMLElement
  getView: () => EditorView | null
  onStatus: (msg: string) => void
}

/** 面板里所有按钮的 action 名 */
type Action =
  | 'row-add'
  | 'row-del'
  | 'col-add'
  | 'col-del'
  | 'align-left'
  | 'align-center'
  | 'align-right'

export function installTablePanel(opts: Options): { refresh: () => void } {
  const { el, getView, onStatus } = opts
  const posEl = el.querySelector<HTMLElement>('#jd-tp-pos')
  let current: TableHit | null = null

  const btn = (act: Action): HTMLButtonElement | null =>
    el.querySelector<HTMLButtonElement>(`button[data-act="${act}"]`)

  function hide(): void {
    current = null
    el.classList.add('hidden')
  }

  function refresh(): void {
    const view = getView()
    if (!view) return hide()

    const hit = tableAt(view.state, view.state.selection.main.head)
    if (!hit) return hide()

    current = hit
    el.classList.remove('hidden')

    const rowLabel =
      hit.rowIndex === 0 ? '表头' : hit.rowIndex === 1 ? '分隔行' : `第 ${hit.rowIndex - 1} 行`
    if (posEl) posEl.textContent = `${rowLabel} · 第 ${hit.colIndex + 1} / ${hit.colCount} 列`

    // 表头和分隔行删不得：删了这张表就不成立了
    const delRow = btn('row-del')
    if (delRow) delRow.disabled = hit.rowIndex < 2
    const delCol = btn('col-del')
    if (delCol) delCol.disabled = hit.colCount <= 1
  }

  // ---------------------------------------------------------------- 操作

  function addRow(hit: TableHit, view: EditorView): void {
    const doc = view.state.doc
    const line = doc.line(hit.block.firstLine + hit.rowIndex)
    const cells = new Array<string>(Math.max(hit.colCount, 1)).fill('')
    const insert = '\n' + joinRow(cells)
    view.dispatch({
      changes: { from: line.to, insert },
      selection: { anchor: line.to + insert.length },
    })
    onStatus('已插入 1 行')
  }

  function delRow(hit: TableHit, view: EditorView): void {
    if (hit.rowIndex < 2) return
    const doc = view.state.doc
    const lineNo = hit.block.firstLine + hit.rowIndex
    const line = doc.line(lineNo)
    const prev = doc.line(lineNo - 1)
    // 从上一行行尾删到本行行尾：连换行一起吃掉，否则会留下一个空行把表格断开
    view.dispatch({
      changes: { from: prev.to, to: line.to },
      selection: { anchor: prev.to },
    })
    onStatus('已删除 1 行')
  }

  function addCol(hit: TableHit, view: EditorView): void {
    const doc = view.state.doc
    const changes = []
    for (let n = hit.block.firstLine; n <= hit.block.lastLine; n++) {
      const line = doc.line(n)
      const cells = splitRow(line.text)
      while (cells.length < hit.colCount) cells.push('')
      const isSep = n === hit.block.firstLine + 1
      cells.splice(hit.colIndex + 1, 0, isSep ? '---' : '')
      changes.push({ from: line.from, to: line.to, insert: joinRow(cells) })
    }
    view.dispatch({ changes })
    onStatus(`已在第 ${hit.colIndex + 2} 列插入 1 列`)
  }

  function delCol(hit: TableHit, view: EditorView): void {
    if (hit.colCount <= 1) return
    const doc = view.state.doc
    const changes = []
    for (let n = hit.block.firstLine; n <= hit.block.lastLine; n++) {
      const line = doc.line(n)
      const cells = splitRow(line.text)
      while (cells.length < hit.colCount) cells.push('')
      cells.splice(hit.colIndex, 1)
      if (cells.length === 0) cells.push('')
      changes.push({ from: line.from, to: line.to, insert: joinRow(cells) })
    }
    view.dispatch({ changes })
    onStatus('已删除 1 列')
  }

  function setAlign(hit: TableHit, view: EditorView, align: 'left' | 'center' | 'right'): void {
    const doc = view.state.doc
    const sep = doc.line(hit.block.firstLine + 1)
    const cells = splitRow(sep.text)
    while (cells.length <= hit.colIndex) cells.push('---')
    cells[hit.colIndex] = align === 'left' ? ':---' : align === 'center' ? ':---:' : '---:'
    view.dispatch({ changes: { from: sep.from, to: sep.to, insert: joinRow(cells) } })
    onStatus(`第 ${hit.colIndex + 1} 列改为${align === 'left' ? '左' : align === 'center' ? '居中' : '右'}对齐`)
  }

  // ---------------------------------------------------------------- 事件

  el.addEventListener('mousedown', (ev) => {
    const target = (ev.target as HTMLElement | null)?.closest('button')
    if (!target || target.disabled) return
    // 关键：不让按钮抢焦点。一旦焦点离开编辑器，selection 就变了，
    // 面板会立刻 hide，用户看着像"点了一下面板就没了"。
    ev.preventDefault()

    const view = getView()
    if (!view || !current) return
    const hit = current

    switch (target.dataset.act as Action | undefined) {
      case 'row-add':
        addRow(hit, view)
        break
      case 'row-del':
        delRow(hit, view)
        break
      case 'col-add':
        addCol(hit, view)
        break
      case 'col-del':
        delCol(hit, view)
        break
      case 'align-left':
        setAlign(hit, view, 'left')
        break
      case 'align-center':
        setAlign(hit, view, 'center')
        break
      case 'align-right':
        setAlign(hit, view, 'right')
        break
      default:
        return
    }
    refresh()
    view.focus()
  })

  return { refresh }
}
