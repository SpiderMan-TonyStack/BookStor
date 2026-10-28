import {
  Decoration,
  EditorView,
  GutterMarker,
  gutter,
  type DecorationSet,
} from '@codemirror/view'
import {
  RangeSet,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type EditorState,
  type Text,
} from '@codemirror/state'
import { createFenceState, stepFence } from './fence.js'
import { parseHeading } from './heading.js'

/**
 * 折叠（策划案 M5）：标题与代码块可收起。
 *
 * 三个不能绕的约束：
 *
 * 1. **内容不能用 CSS `display:none` 藏。** CM6 的高度模型不知道被 CSS 隐藏的行，
 *    隐藏之后滚动位置、点击落点、光标定位会全部偏移 —— 和「行级 margin 不在高度模型里」
 *    是同一个坑（见 README「已知的坑」）。只能用 `Decoration.replace({ block: true })`
 *    把整段行从**布局**里换掉，CM6 才知道这些行不存在了。
 * 2. **block 装饰只能由 StateField 提供**（ViewPlugin 会抛 `RangeError`），和 table.ts 同理。
 * 3. **折叠区间不能与表格的 block replace 重叠。** 一张表本身就是一个 block replace，
 *    如果它落在被折叠的章节里，两个 replace 覆盖同一段 → CM6 直接抛错。
 *    所以扫描时把「范围内含表格行」的块判为不可折叠（gutter 上不显示三角）。
 *
 * 折叠状态存的是**行首位置**而不是行号：编辑会让行号漂移，位置可以由
 * `tr.changes.mapPos()` 跟着走。位置失效（标题被删）时匹配不到块，自动无害忽略。
 */

interface FoldBlock {
  startLine: number
  endLine: number
  kind: 'heading' | 'code'
}

/** 表格行判定，必须与 table.ts 的 TABLE_LINE 一致（那边不区分代码块内外的 `|`） */
const TABLE_LINE = /^[ \t]{0,3}\|/

const blockCache = new WeakMap<Text, FoldBlock[]>()
const startCache = new WeakMap<Text, Set<number>>()

/** 可折叠块，按 startLine 升序。同一个 doc 只扫一次（Text 不可变，可以直接当 key） */
export function foldBlocks(doc: Text): FoldBlock[] {
  const hit = blockCache.get(doc)
  if (hit) return hit
  const out = scan(doc)
  blockCache.set(doc, out)
  startCache.set(doc, new Set(out.map((b) => b.startLine)))
  return out
}

function foldStartLines(doc: Text): Set<number> {
  foldBlocks(doc)
  return startCache.get(doc) ?? new Set()
}

function scan(doc: Text): FoldBlock[] {
  const blocks: FoldBlock[] = []
  const heads: { line: number; level: number }[] = []
  const tableLines = new Set<number>()
  const fence = createFenceState()
  let fenceOpenAt = 0

  for (let n = 1; n <= doc.lines; n++) {
    const text = doc.line(n).text
    // 先记表格行：哪怕它在代码块里也算，因为 table.ts 那边不区分（见文件头约束 3）
    if (TABLE_LINE.test(text)) tableLines.add(n)

    const wasIn = fence.in
    const step = stepFence(fence, text)

    if (step.isMarker) {
      if (!wasIn) {
        fenceOpenAt = n
      } else if (fenceOpenAt > 0) {
        // 至少要有内容行才值得折叠（``` 紧跟 ``` 是空块）
        if (n > fenceOpenAt + 1) {
          blocks.push({ startLine: fenceOpenAt, endLine: n, kind: 'code' })
        }
        fenceOpenAt = 0
      }
      continue
    }

    // 代码块内部不认标题（`#include` 那类行首井号不算标题）
    if (fence.in) continue

    const h = parseHeading(text)
    if (h) heads.push({ line: n, level: h.level })
  }

  // 标题折叠范围 = 到下一个「同级或更高级」标题之前。用栈一趟扫完（O(n)）：
  // 遇到不比自己浅的标题，就把比它深的那些一次性关掉。
  const stack: { line: number; level: number }[] = []
  for (const h of heads) {
    while (stack.length > 0 && stack[stack.length - 1]!.level >= h.level) {
      const top = stack.pop()!
      const end = h.line - 1
      if (end > top.line) blocks.push({ startLine: top.line, endLine: end, kind: 'heading' })
    }
    stack.push(h)
  }
  while (stack.length > 0) {
    const top = stack.pop()!
    if (doc.lines > top.line) blocks.push({ startLine: top.line, endLine: doc.lines, kind: 'heading' })
  }

  const safe = blocks.filter((b) => {
    for (let n = b.startLine + 1; n <= b.endLine; n++) {
      if (tableLines.has(n)) return false
    }
    return true
  })
  safe.sort((a, b) => a.startLine - b.startLine)
  return safe
}

// ------------------------------------------------------------------ 状态

/** 切换折叠：value 是块起始行的行首位置 */
export const toggleFoldEffect = StateEffect.define<number>()

const foldedField = StateField.define<number[]>({
  create: () => [],
  update(list, tr) {
    let next = list
    if (tr.docChanged) {
      next = next.map((p) => tr.changes.mapPos(p, -1))
      next = next.filter((p, i) => next.indexOf(p) === i)
    }
    for (const e of tr.effects) {
      if (!e.is(toggleFoldEffect)) continue
      const pos = e.value
      next = next.includes(pos) ? next.filter((p) => p !== pos) : [...next, pos]
    }
    return next
  },
})

/** 折叠状态，给 UI（状态栏/统计）读 */
export function foldedCount(state: EditorState): number {
  return (state.field(foldedField, false) ?? []).length
}

// ------------------------------------------------------------------ 装饰

function buildFoldDecorations(state: EditorState): DecorationSet {
  const doc = state.doc
  const folded = state.field(foldedField, false) ?? []
  const blocks = foldBlocks(doc)
  const builder = new RangeSetBuilder<Decoration>()

  // 已被外层折叠覆盖到的最后一行。内层块（比如章节里的代码块）要整块跳过：
  // 它的行装饰会落在 replace 内部，CM6 不接受。
  let coveredTo = 0

  for (const b of blocks) {
    if (coveredTo > 0 && b.startLine <= coveredTo) continue

    const start = doc.line(b.startLine)
    const isFolded = folded.includes(start.from)
    builder.add(
      start.from,
      start.from,
      Decoration.line({ class: isFolded ? 'jd-folded' : 'jd-foldable' })
    )

    if (!isFolded) continue

    const from = doc.line(b.startLine + 1).from
    const to = doc.line(b.endLine).to
    if (to > from) {
      builder.add(from, to, Decoration.replace({ block: true }))
      coveredTo = b.endLine
    }
  }

  return builder.finish()
}

const foldDecorations = StateField.define<DecorationSet>({
  create: (state) => buildFoldDecorations(state),
  update(deco, tr) {
    // 只有文档变了、或者有人点了折叠，才需要重算（换光标不影响折叠）
    if (tr.docChanged || tr.effects.some((e) => e.is(toggleFoldEffect))) {
      return buildFoldDecorations(tr.state)
    }
    return deco.map(tr.changes)
  },
  provide: (f) => EditorView.decorations.from(f),
})

// ------------------------------------------------------------------ 折叠把手

class FoldMarker extends GutterMarker {
  constructor(readonly folded: boolean) {
    super()
  }
  override eq(other: FoldMarker) {
    return other.folded === this.folded
  }
  override toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = this.folded ? 'jd-fold-toggle is-folded' : 'jd-fold-toggle'
    el.setAttribute('aria-hidden', 'true')
    return el
  }
}

/**
 * 折叠把手放 gutter 里，而不是塞进行内 widget：
 * 行内 widget 会占一个字符位的宽度，把正文整体推右，主题的排版就偏了。
 * gutter 在编辑器盒子内部、`#write` 的内边距之外，对正文宽度的影响只有这一条窄栏。
 */
export const foldGutter = gutter({
  class: 'jd-fold-gutter',
  lineMarker(view, line) {
    const doc = view.state.doc
    const num = doc.lineAt(line.from).number
    if (!foldStartLines(doc).has(num)) return null
    const folded = (view.state.field(foldedField, false) ?? []).includes(line.from)
    return new FoldMarker(folded)
  },
  initialSpacer: () => new FoldMarker(false),
  domEventHandlers: {
    mousedown(view, line) {
      toggleFold(view, line.from)
      return true
    },
  },
})

/** 切换某一行所属块的折叠状态 */
export function toggleFold(view: EditorView, from: number): void {
  const state = view.state
  const block = foldBlocks(state.doc).find((b) => state.doc.line(b.startLine).from === from)
  if (!block) return

  const folded = state.field(foldedField, false) ?? []
  const willFold = !folded.includes(from)

  // 折叠前把光标挪到标题行：否则它会留在被 replace 掉的区域里 ——
  // 看不见光标，但打字确实会写进去，这是最难排查的一类 bug。
  const sel = state.selection.main
  const rangeEnd = state.doc.line(block.endLine).to
  const needsMove = willFold && sel.head > from && sel.head <= rangeEnd

  view.dispatch({
    effects: toggleFoldEffect.of(from),
    ...(needsMove ? { selection: { anchor: from } } : {}),
  })
}

/**
 * 折叠区间对光标是**原子**的：方向键、点击、Ctrl+Home 都不能把光标停在被收起的内容里。
 *
 * 没有这一条会发生什么：光标落在 replace 区间内部 —— 那一行没有 DOM，光标画在块边界上，
 * 看着像"光标消失了"；而打字确实会写进去，是极难排查的一类问题。
 * `atomicRanges` 只影响光标/选区的落点，不参与绘制，所以不会和上面的 block replace 打架。
 */
const foldAtomicRanges = EditorView.atomicRanges.of((view) => {
  const state = view.state
  const folded = state.field(foldedField, false)
  if (!folded || folded.length === 0) return RangeSet.empty
  const doc = state.doc
  const ranges = []
  for (const b of foldBlocks(doc)) {
    if (!folded.includes(doc.line(b.startLine).from)) continue
    const from = doc.line(b.startLine + 1).from
    const to = doc.line(b.endLine).to
    if (to > from) ranges.push(Decoration.replace({}).range(from, to))
  }
  return ranges.length > 0 ? RangeSet.of(ranges) : RangeSet.empty
})

/** 四个扩展打包：折叠状态 / 块装饰 / 把手 / 光标原子性 */
export const foldExtensions = [foldedField, foldDecorations, foldGutter, foldAtomicRanges]
