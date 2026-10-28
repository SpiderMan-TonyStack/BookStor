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
