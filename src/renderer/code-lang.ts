/**
 * 代码块语言的解析与改写 —— 纯函数，可单测。
 *
 * 「在代码块右下角选语言」的全部逻辑就是两问：
 *   ① 这一行的围栏里，语言标记在哪几个字符上（` ```cpp ` → 第 3–6 个字符）
 *   ② 换成另一个语言时，**除了那几个字符之外一个字节都不动**（` ```cpp title="x" `
 *      里的 `title="x"` 是 GitHub 的写法，不能被顺手抹掉）
 * 其余都是 UI。所以这两个函数单独拿出来，跟 fence.ts 一样不依赖 DOM。
 */

import type { EditorView } from '@codemirror/view'

export interface FenceLang {
  /** 语言标记在**行内**的起止（不含前后空格；没有语言时 from === to） */
  from: number
  to: number
  /** 当前语言，没有则为空串 */
  lang: string
}

/**
 * 找出围栏行里的语言标记。
 *
 * 认三种写法（位置规则与 fence.ts 一致）：
 *   ```cpp           裸围栏
 *   > ```cpp         引用块里
 *   - ```cpp         列表项里
 * 只取「第一段非空白」，后面的 `title="..."` 之类原样留在原地。
 * 这一行根本没有反引号（不是围栏行）时返回 null。
 */
export function fenceLang(text: string): FenceLang | null {
  // 取最后一段连续的 ``` / ~~~：前缀（缩进、`> `、`- `）不影响结果
  const m = /(```+|~~~+)([^\n]*)$/.exec(text)
  if (!m) return null
  const ticks = m[1] ?? ''
  const rest = m[2] ?? ''
  const lead = rest.length - rest.trimStart().length
  const token = rest.trim().split(/\s+/)[0] ?? ''
  const from = m.index + ticks.length + lead
  return { from, to: from + token.length, lang: token }
}

/**
 * 把围栏行的语言换成 `lang`（空串 = 去掉语言）。
 *
 * 只替换语言那一段，其余字节原样。去掉语言时顺手吃掉后面多余的空格，
 * 免得留下 ` ```  title="x" ` 这种两个空格。
 */
export function withLang(text: string, lang: string): string | null {
  const r = fenceLang(text)
  if (!r) return null
  const head = text.slice(0, r.from)
  const tail = text.slice(r.to)
  if (lang) return head + lang + tail
  // 去掉语言：后面还有内容就留一个空格，没有就把语言前的空白一起收掉
  const rest = tail.replace(/^[ \t]+/, '')
  const trimmed = head.replace(/[ \t]+$/, '')
  return rest ? `${trimmed} ${rest}` : trimmed
}

/**
 * 把某个代码块的语言换成 `lang`（只改**开启围栏**那一行）。
 *
 * `expectLang` 是调用方记录下的"当前语言"：位置可能已经漂了（切了文件、上面插了行），
 * 所以改之前先核一遍 —— 对不上就不动。宁可不改，也不能把别的行改成 `` ```python ``。
 * 一次 dispatch，一步撤销。
 */
export function setCodeLang(
  view: EditorView,
  openFrom: number,
  expectLang: string,
  lang: string
): boolean {
  const doc = view.state.doc
  if (openFrom < 0 || openFrom > doc.length) return false
  const line = doc.lineAt(openFrom)
  const cur = fenceLang(line.text)
  if (!cur || cur.lang !== expectLang) return false
  const next = withLang(line.text, lang)
  if (next === null || next === line.text) return false
  view.dispatch({ changes: { from: line.from, to: line.to, insert: next } })
  view.focus()
  return true
}
