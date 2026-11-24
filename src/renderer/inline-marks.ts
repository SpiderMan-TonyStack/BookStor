/**
 * 行内标记的纯函数部分 —— **不依赖 CM6**，所以能在 `scripts/test-units.mjs`
 * 里直接断言（同 `table-parse.ts` 的思路：能把逻辑抽出来测，就别藏在编辑器里）。
 *
 * 只做字符串层面的事：脱标记、找光标处的链接。改哪一段、选区放哪儿由调用方决定。
 */

/** 成对/自闭合的行内标记：**加粗**、*斜体*、~~删除线~~、==高亮==、`代码` */
const PAIRED_MARKS = /(\*\*\*|\*\*|\*|~~|==|`)/g

/**
 * 清除一段文本里的行内样式标记，返回脱掉标记后的文字。
 *
 * 顺序有讲究：
 *   1. 先处理图片/链接 —— 它们自带方括号和圆括号，先拆掉才能让后面的
 *      星号清理作用到里面的文字上；
 *   2. 再删注释 —— `<!-- -->` 里的内容按渲染层的语义是**不显示**的，整段丢掉；
 *   3. 最后才剥成对标记，否则 `**` 被星号规则先拆一个，会留下半截。
 */
export function stripInline(text: string): string {
  let out = text
  // 图片 → 只留 alt 文字
  out = out.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
  // 链接 → 只留文字
  out = out.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
  // 注释整段去掉（渲染层本来就不显示）
  out = out.replace(/<!--[\s\S]*?-->/g, '')
  // 下划线标签
  out = out.replace(/<\/?u>/gi, '')
  // 成对标记（保留文字，剥掉符号）
  out = out.replace(PAIRED_MARKS, '')
  return out
}

export interface LinkHit {
  /** 方括号里的文字 */
  text: string
  /** 圆括号里的地址（已 trim） */
  url: string
  /** 在**本行文本**里的起止下标（含首尾括号） */
  from: number
  to: number
}

/**
 * 找光标处的链接。`lineText` 是整行文本，`offset` 是光标相对行首的下标。
 *
 * 光标只要落在 `[文字](地址)` 的区间内（含两端）就算命中 —— 用「包含」而不是
 * 「严格在内部」，是因为用户常常把光标停在右括号后面就想点「复制链接地址」。
 *
 * `![alt](path)` 会先被排除：那是图片，不是可点击的链接。
 */
export function findLinkAt(lineText: string, offset: number): LinkHit | null {
  const re = /\[([^\]]*)\]\(([^)]*)\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(lineText)) !== null) {
    const from = m.index
    const to = from + m[0].length
    // 前面紧邻 `!` → 图片，跳过
    const isImage = from > 0 && lineText[from - 1] === '!'
    if (!isImage && offset >= from && offset <= to) {
      return { text: m[1] ?? '', url: (m[2] ?? '').trim(), from, to }
    }
    if (from > offset) break
  }
  return null
}
