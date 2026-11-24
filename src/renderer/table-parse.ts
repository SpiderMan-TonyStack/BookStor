/**
 * 表格行的纯解析 —— 与 CodeMirror 无关，可以单独跑断言。
 *
 * 为什么从 table.ts 抽出来：这两个函数是「一列没切对就整表错位」的地方，
 * 但 table.ts 顶部 import 了 `@codemirror/view`，在 Node 里跑测试会连带拉起整个 CM6。
 * 抽到这里之后 `scripts/test-units.mjs` 能直接 import 它，不需要 DOM、不需要构建。
 *
 * 判断逻辑仍然只有一份：`table.ts` 的 `findTables` 从这里取，不在别处再写一遍
 * （和 fence.ts / heading.ts 的抽法一样）。
 */

export interface Cell {
  text: string
  align: 'left' | 'center' | 'right' | null
}

/**
 * `|a|b|` → ['a','b']。
 *
 * 三条实测出来的容忍度：
 *   - 首尾竖线可以没有（`a | b` 也是合法表格行）
 *   - 单元格里的 `\|` 是**字面竖线**，不能当分隔符切开（`| a \| b |` 是两列，不是三列）
 *   - 结尾恰好是 `\|` 时不能当成"包住整行的竖线"去掉，否则会吞掉一个字面竖线
 */
export function splitRow(text: string): string[] {
  let s = text.trim()
  if (s.startsWith('|')) s = s.slice(1)
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1)
  const out: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\' && s[i + 1] === '|') {
      cur += '|'
      i++
      continue
    }
    if (ch === '|') {
      out.push(cur.trim())
      cur = ''
      continue
    }
    cur += ch
  }
  out.push(cur.trim())
  return out
}

/** 分隔行的单元格：`---` / `:--` / `--:` / `:-:` */
const SEP_CELL = /^:?-{1,}:?$/

/**
 * 分隔行：`| --- | :-: |` —— 决定有哪些列、以及每列的对齐方式。
 *
 * 不是分隔行就返回 null（`findTables` 据此判定「这一串 `|` 开头的行不是表格」，
 * 宁可退回源码也不画一个错的表）。
 */
export function parseAlign(text: string): Cell['align'][] | null {
  const cells = splitRow(text)
  if (cells.length === 0) return null
  const aligns: Cell['align'][] = []
  for (const c of cells) {
    if (!SEP_CELL.test(c.replace(/\s/g, ''))) return null
    const l = c.startsWith(':')
    const r = c.endsWith(':')
    aligns.push(l && r ? 'center' : r ? 'right' : l ? 'left' : null)
  }
  return aligns
}

/**
 * 光标在这一行的第几列（0 起）。
 *
 * 靠**数前面有几个 `|`** 得到，而不是在 splitRow 的结果上做偏移映射 ——
 * 后者遇到转义竖线 `\|` 和「首尾缺竖线」的写法要处理一堆边界，数分隔符更稳。
 *
 * 行首那个 `|` 只是边框，所以带首竖线的行要减一：
 *   `| a | b |` 光标在 a 上 → 数到 1 个 `|`，减一 → 第 0 列
 *   `a | b`     光标在 b 上 → 数到 1 个 `|`，不减 → 第 1 列
 */
export function columnAt(lineText: string, offset: number): number {
  const end = Math.min(Math.max(offset, 0), lineText.length)
  let bars = 0
  for (let i = 0; i < end; i++) {
    if (lineText[i] === '|' && lineText[i - 1] !== '\\') bars++
  }
  return lineText.trimStart().startsWith('|') ? Math.max(0, bars - 1) : bars
}

/**
 * 表格的一行有几列。
 *
 * 必须走 `splitRow`，不能自己 `text.split('|')` —— 单元格里的 `\|` 是**字面竖线**
 * （`| p\|q |` 是一格，不是两格），自己切会把列数算多。库里 `C++教程/初步认识/运算符.md`
 * 就有一张这样的表（表头含 `p\|q`）：按旧实现算成 6 列、实际 5 列，
 * 「在下方插入行」会插出一条 6 格的行，整表被撑出一列空格子。
 *
 * 放在这里而不是 block-edits.ts，是因为它也属于「表格怎么切」这条规则，
 * 而且 block-edits 要能被 `scripts/test-units.mjs` 直接 import（Node 的类型剥离
 * 不做 `.js` → `.ts` 的重写，跨模块 import 会直接报找不到模块）。
 */
export function tableColumnCount(text: string): number {
  if (!text.includes('|')) return 0
  return splitRow(text).length
}

/** 单元格数组拼回一行 markdown（统一 `| a | b |` 风格） */
export function joinRow(cells: string[]): string {
  return `| ${cells.join(' | ')} |`
}

/**
 * 每个单元格在**原始行文本**里的区间（已跳过两侧空白与转义竖线）。
 *
 * 为什么需要它：改对齐只该动那一格里的冒号，不能像 `joinRow` 那样把整行重建成
 * `| a | b |` —— 那等于顺手把用户的 `|---|:--:|---|` 格式化了。纯文本是唯一真源，
 * 不是我们想改的地方就一个字节都不碰。所以这里返回**字符区间**，而不是值数组。
 *
 * 与 `splitRow` 保持同一套切分规则（首尾竖线可缺、`\|` 是字面竖线），
 * 只是多带回位置。两处规则漂了的话，会出现「列数对得上、改错格」这种安静的错误。
 */
export function cellSpans(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = []
  const n = text.length
  const lead = n - text.trimStart().length
  // 行首竖线只是边框，不算格
  let i = text[lead] === '|' ? lead + 1 : lead
  let cellStart = i
  let first = -1
  let last = -1

  const flush = (): void => {
    out.push(first < 0 ? { start: cellStart, end: cellStart } : { start: first, end: last + 1 })
  }

  while (i < n) {
    const ch = text[i]!
    if (ch === '\\' && text[i + 1] === '|') {
      if (first < 0) first = i
      last = i + 1
      i += 2
      continue
    }
    if (ch === '|') {
      // 后面再没有非空白字符 → 这是行尾竖线（边框），到此为止，不多出一个空列
      if (text.slice(i + 1).trim() === '') {
        flush()
        return out
      }
      flush()
      i++
      cellStart = i
      first = -1
      last = -1
      continue
    }
    if (ch !== ' ' && ch !== '\t') {
      if (first < 0) first = i
      last = i
    }
    i++
  }
  flush()
  return out
}

/**
 * 一格的文本 → 改过对齐标记之后的文本。
 *
 * 只增删冒号，**短横线数量原样保留**（`| :---- |` 改成右对齐是 `----:`，
 * 不是 `---:`）。Typora 自己也是只动冒号 —— 表格宽度是用户的排版，不该被我们改写。
 */
export function alignCellText(cell: string, align: Cell['align']): string {
  const dashes = cell.replace(/[:\s]/g, '') || '---'
  if (align === 'left') return `:${dashes}`
  if (align === 'center') return `:${dashes}:`
  if (align === 'right') return `${dashes}:`
  return dashes
}

/**
 * 就地改分隔行第 `col` 格的对齐方式。
 *
 * 返回**新的整行文本**，调用方只替换这一行。下面两种情况返回 null：这行根本不是
 * 分隔行（拿别的行来改会把正文写坏）、`col` 越界。调用方据此提示，而不是硬写。
 */
export function setColumnAlign(text: string, col: number, align: Cell['align']): string | null {
  const aligns = parseAlign(text)
  if (!aligns || col < 0 || col >= aligns.length) return null
  const span = cellSpans(text)[col]
  if (!span) return null
  const cell = text.slice(span.start, span.end)
  const next = alignCellText(cell, align)
  if (next === cell) return text
  return text.slice(0, span.start) + next + text.slice(span.end)
}
