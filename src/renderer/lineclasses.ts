import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'

/**
 * 行级语义 class —— Typora 主题选择器映射的 DOM 契约（策划案 §5.2-B）。
 *
 * Typora 主题写的是 `#write h1`、`#write p`、`#write blockquote`…
 * 而 CodeMirror 的每一行只能是 `.cm-line`，不可能变成 `<h1>`。
 * 所以我们给每一行打上等价语义的 class，翻译管线再把主题里的 `h1` 改名成 `.jd-h1`。
 *
 * 这里用行文本正则判断而不是解析语法树，理由：
 *   - 只需要"这一行看起来是什么块"，不需要精确的语法模型
 *   - 大文件（库里最大 274KB）用语法树逐行跑代价太高，视口内几十行无所谓
 *   - 未知语法退化成 `.jd-p`，反正也无害
 *
 * 除了类别，还要算"块边界"。Typora 的代码块是一个 <pre>，我们是一串行；
 * 只把每行染成同色会得到一叠断开的框，所以首末行要额外标记（详见 theme-fix.css）。
 */

const HEADING = /^(#{1,6})\s/
const FENCE = /^\s{0,3}(```|~~~)/
const QUOTE = /^\s{0,3}>/
const UL = /^\s{0,3}[-*+]\s/
const OL = /^\s{0,3}\d+[.)]\s/
const TASK = /^\s{0,3}[-*+]\s+\[[ xX]\]\s/
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const TABLE = /^\s{0,3}\|/

interface LineInfo {
  num: number
  from: number
  classes: string[]
  /** 用于识别块边界 */
  kind: 'code' | 'table' | 'other'
}

function classFor(text: string, inFence: boolean): string {
  if (inFence) return 'jd-code-line'
  const h = text.match(HEADING)
  if (h) return `jd-h${h[1]!.length}`
  if (FENCE.test(text)) return 'jd-code-line'
  if (TASK.test(text)) return 'jd-li jd-task'
  if (HR.test(text)) return 'jd-hr'
  if (QUOTE.test(text)) return 'jd-quote'
  if (UL.test(text) || OL.test(text)) return 'jd-li'
  if (TABLE.test(text)) return 'jd-table-row'
  if (text.trim() === '') return 'jd-p jd-blank'
  return 'jd-p'
}

function buildDecorations(view: EditorView): DecorationSet {
  const doc = view.state.doc
  const activeLine = doc.lineAt(view.state.selection.main.head).number

  // 围栏状态是文档级的，但只算到视口末尾就够了（视口之前的状态靠回溯一次）
  let inFence = false
  const firstVisible = view.visibleRanges[0]
  if (firstVisible) {
    const scanTo = doc.lineAt(firstVisible.from).number
    for (let n = 1; n < scanTo; n++) {
      if (FENCE.test(doc.line(n).text)) inFence = !inFence
    }
  }

  const infos: LineInfo[] = []
  for (const { from, to } of view.visibleRanges) {
    let pos = from
    while (pos <= to) {
      const line = doc.lineAt(pos)
      const isFenceMarker = FENCE.test(line.text)
      if (isFenceMarker) inFence = !inFence

      const inner = inFence && !isFenceMarker
      const cls = classFor(line.text, inner)
      const classes = cls.split(' ')

      let kind: LineInfo['kind'] = 'other'
      if (isFenceMarker) {
        classes.push('jd-code-fence', 'jd-code-block')
        kind = 'code'
      } else if (inner) {
        classes.push('jd-code-block')
        kind = 'code'
      } else if (TABLE.test(line.text)) {
        kind = 'table'
      }

      if (line.number === activeLine) classes.push('jd-active')
      infos.push({ num: line.number, from: line.from, classes, kind })

      if (line.to + 1 > to) break
      pos = line.to + 1
    }
  }

  // 第二轮：标块边界。首行 = 上一个可见行的 kind 不同；
  // 末行 = 下一个可见行的 kind 不同（视口边缘保守起见也算末行，宁可多重一条边）。
  for (let i = 0; i < infos.length; i++) {
    const cur = infos[i]!
    if (cur.kind === 'code') {
      const prev = infos[i - 1]
      const next = infos[i + 1]
      if (!prev || prev.kind !== 'code') cur.classes.push('jd-code-first')
      if (!next || next.kind !== 'code') cur.classes.push('jd-code-last')
    } else if (cur.kind === 'table') {
      const prev = infos[i - 1]
      const next = infos[i + 1]
      if (!prev || prev.kind !== 'table') cur.classes.push('jd-table-first')
      if (!next || next.kind !== 'table') cur.classes.push('jd-table-last')
    }
  }

  const builder = new RangeSetBuilder<Decoration>()
  for (const info of infos) {
    builder.add(
      info.from,
      info.from,
      Decoration.line({ class: info.classes.filter(Boolean).join(' ') })
    )
  }
  return builder.finish()
}

export const lineClassPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = buildDecorations(view)
    }
    update(u: ViewUpdate) {
      // 文档变了、视口滚动了、光标换行了 —— 都要重算（活动行变了）
      if (u.docChanged || u.viewportChanged || u.selectionSet) {
        this.decorations = buildDecorations(u.view)
      }
    }
  },
  { decorations: (v) => v.decorations }
)
