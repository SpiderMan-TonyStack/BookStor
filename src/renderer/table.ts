import { Decoration, type DecorationSet, EditorView, WidgetType } from '@codemirror/view'
import { type EditorState, RangeSet, StateField } from '@codemirror/state'
import { splitRow, parseAlign, type Cell } from './table-parse.js'

/**
 * 表格渲染：把「一串 `|a|b|` 行」变成真正的 `<table>`。
 *
 * 为什么要单独做（策划案 §1.3）：这个库里 **106 篇（43%）有表格**，是仅次于代码块的第二大语法，
 * T2 保真项里明确要求「表格边框与斑马纹」。只把每行染底色是不够的 —— 竖线还在、
 * 列不会对齐、没有表头，一眼就不是 Typora。
 *
 * 做法与 Typora 一致：**光标不在表内时渲染成真表格，光标进入就退回源码行**。
 * 这样既好看又能改，不用做"表格可视化编辑器"（那是 M5 的事）。
 *
 * 严格不改文本：这是 `replace` 装饰，`view.state.doc` 永远是原始 markdown。
 * 注意这与 markers.ts 里"隐藏标记不用 replace"的原则不冲突 ——
 * 那里藏的是**行内**字符（光标要能落进去），这里换的是**整个块**（光标会整体跳出）。
 */

/** 行解析（`Cell` / `splitRow` / `parseAlign`）在 table-parse.ts —— 纯函数、无 CM6 依赖，可单独测。 */

/** 单元格内的行内语法：只处理最常见的四种，其余原样显示 */
function renderInline(el: HTMLElement, text: string): void {
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]*\]\([^)]*\))/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) el.append(document.createTextNode(text.slice(last, m.index)))
    const token = m[0]
    if (token.startsWith('**')) {
      const s = document.createElement('strong')
      s.textContent = token.slice(2, -2)
      el.append(s)
    } else if (token.startsWith('`')) {
      const s = document.createElement('code')
      s.className = 'jd-code-inline'
      s.textContent = token.slice(1, -1)
      el.append(s)
    } else if (token.startsWith('*')) {
      const s = document.createElement('em')
      s.textContent = token.slice(1, -1)
      el.append(s)
    } else {
      const a = document.createElement('a')
      const label = token.slice(1, token.indexOf(']'))
      a.textContent = label || token
      a.className = 'jd-link'
      // 不设真实 href：点一下就跳走不是笔记软件里想要的行为
      a.title = token.slice(token.indexOf('](') + 2, -1)
      el.append(a)
    }
    last = m.index + token.length
  }
  if (last < text.length) el.append(document.createTextNode(text.slice(last)))
}

class TableWidget extends WidgetType {
  constructor(
    readonly header: string[],
    readonly aligns: Cell['align'][],
    readonly rows: string[][],
    readonly from: number
  ) {
    super()
  }

  override eq(other: TableWidget) {
    if (other.from !== this.from) return false
    if (other.header.join('\u0000') !== this.header.join('\u0000')) return false
    if (other.aligns.join(',') !== this.aligns.join(',')) return false
    if (other.rows.length !== this.rows.length) return false
    for (let i = 0; i < this.rows.length; i++) {
      if (other.rows[i]!.join('\u0000') !== this.rows[i]!.join('\u0000')) return false
    }
    return true
  }

  override toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'jd-table-wrap'

    const table = document.createElement('table')
    table.className = 'jd-table'

    const colCount = Math.max(this.header.length, this.aligns.length, ...this.rows.map((r) => r.length))

    const thead = document.createElement('thead')
    thead.className = 'jd-table-head'
    const htr = document.createElement('tr')
    htr.className = 'jd-table-row'
    for (let c = 0; c < colCount; c++) {
      const th = document.createElement('th')
      // 只挂 th 专属类，**不要**再挂 `jd-table-cell`。
      // 若 th/td 共用一个类名，主题里 `table tr th{background:...}` 会连带命中所有单元格 —— 整表变绿。
      // 单元格的边框/内边距由 theme-base.css 里 `#write table.jd-table th, ... td` 的真实标签选择器兜底。
      th.className = 'jd-table-head-cell'
      if (this.aligns[c]) th.style.textAlign = this.aligns[c]!
      renderInline(th, this.header[c] ?? '')
      htr.append(th)
    }
    thead.append(htr)
    table.append(thead)

    const tbody = document.createElement('tbody')
    tbody.className = 'jd-table-body'
    for (const row of this.rows) {
      const tr = document.createElement('tr')
      tr.className = 'jd-table-row'
      for (let c = 0; c < colCount; c++) {
        const td = document.createElement('td')
        td.className = 'jd-table-cell'
        if (this.aligns[c]) td.style.textAlign = this.aligns[c]!
        renderInline(td, row[c] ?? '')
        tr.append(td)
      }
      tbody.append(tr)
    }
    table.append(tbody)
    wrap.append(table)

    // 点表格 = 把光标放进表格第一行，于是装饰消失、露出源码行开始改
    wrap.addEventListener('mousedown', (ev) => {
      ev.preventDefault()
      view.dispatch({ selection: { anchor: Math.min(this.from + 1, view.state.doc.length) } })
      view.focus()
    })
    return wrap
  }
}

/**
 * 找表格块。一个合法表格至少要三行：表头、分隔行、至少一行数据
 * （只有两行的"表头+分隔行"是空表格，Markdown 也渲染得出来，但没内容可看，
 *  退回源码更诚实）。
 */
interface TableBlock {
  firstLine: number
  lastLine: number
  from: number
  to: number
  header: string[]
  aligns: Cell['align'][]
  rows: string[][]
}

const TABLE_LINE = /^[ \t]{0,3}\|/

function findTables(state: EditorState): TableBlock[] {
  const doc = state.doc
  const blocks: TableBlock[] = []
  const lineText = (ln: number) => doc.line(ln).text

  // 扫全文。StateField 只在 docChanged/selection 变化时重算，滚动不触发，
  // 库里最大 274KB / 约 8000 行，逐行正则实测约 2ms，可接受。
  let n = 1
  while (n <= doc.lines) {
    if (!TABLE_LINE.test(lineText(n))) {
      n++
      continue
    }
    const blockStart = n
    let blockEnd = n
    while (blockEnd + 1 <= doc.lines && TABLE_LINE.test(lineText(blockEnd + 1))) blockEnd++

    if (blockEnd - blockStart >= 2) {
      const aligns = parseAlign(lineText(blockStart + 1))
      if (aligns) {
        const rows: string[][] = []
        for (let i = blockStart + 2; i <= blockEnd; i++) rows.push(splitRow(lineText(i)))
        blocks.push({
          firstLine: blockStart,
          lastLine: blockEnd,
          from: doc.line(blockStart).from,
          to: doc.line(blockEnd).to,
          header: splitRow(lineText(blockStart)),
          aligns,
          rows,
        })
      }
    }
    n = blockEnd + 1
  }
  return blocks
}

function build(state: EditorState): DecorationSet {
  const sel = state.selection
  const items: { from: number; to: number; deco: Decoration }[] = []

  for (const t of findTables(state)) {
    // 光标或选区碰到表格就显示源码（否则光标无处安放）
    const touched = sel.ranges.some((r) => r.to >= t.from && r.from <= t.to)
    if (touched) continue
    items.push({
      from: t.from,
      to: t.to,
      deco: Decoration.replace({
        widget: new TableWidget(t.header, t.aligns, t.rows, t.from),
        block: true,
      }),
    })
  }

  items.sort((a, b) => a.from - b.from)
  // 注意必须带上 `to`：block replace 要覆盖整段行，零宽 range 会被拒绝。
  return RangeSet.of(items.map((i) => i.deco.range(i.from, i.to)), true)
}

/**
 * **必须用 StateField 而不是 ViewPlugin**。
 *
 * CM6 明确禁止插件提供 block decoration：
 *   `RangeError: Block decorations may not be specified via plugins`
 * 因为 block 装饰会改变行高，而 ViewPlugin 的装饰在 measure 阶段才更新，
 * 会引起布局循环。StateField 在 state 层就确定下来，measure 之前就有了。
 *
 * 代价是每次 docChanged / selectionSet 都要重算（StateField 没法感知视口变化），
 * 实测 274KB 文件重算约 2ms，可以接受；换来的是不会崩。
 */
export const tableWidgetField = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update(value, tr) {
    if (tr.docChanged || tr.selection) return build(tr.state)
    return value.map(tr.changes)
  },
  provide: (f) => EditorView.decorations.from(f),
})
