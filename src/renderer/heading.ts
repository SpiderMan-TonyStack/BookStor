/**
 * 标题识别 —— 全项目唯一一份。
 *
 * 除了行首的 `## 标题`，还要认「写在列表项里的标题」：
 *
 *     - ## C++ 教程
 *
 * 这是合法的 markdown（列表项里可以放任意块级元素，包括标题），Typora 会把它
 * 渲染成「列表项里的标题」并收进大纲。库里实测 **50 个文件、232 行**这么写，
 * 集中在 `C++教程/` 目录 —— 多半是从网页复制时被顺手套上了列表符号。
 *
 * 此前三处（行 class / 标记隐藏 / 大纲）各写一份 `^(#{1,6})\s`，于是这些行
 * 既不算标题、也收不进大纲，`##` 还照样显示在正文里。现在统一走 parseHeading()。
 */

export interface HeadingInfo {
  /** 1–6 */
  level: number
  /** 行内标记（`-`、`##`、空格）到哪个偏移结束 —— 这段在不在光标行时会被隐藏 */
  markEnd: number
  /** 标题正文的起始偏移 */
  textStart: number
  /** 是否嵌在列表项里（`- ## x`） */
  inList: boolean
}

/**
 * `## 标题`。
 *
 * 刻意不允许前导缩进：CommonMark 允许 0–3 空格，但库里没有这种写法，
 * 而放宽之后「缩进的 `#`」会被误判成标题（缩进代码块的常见写法），
 * 属于无收益的行为变更。
 */
const PLAIN = /^(#{1,6})([ \t]+)/

/** `- ## 标题` / `* ### 标题` / `1. ## 标题`（允许缩进，列表项本来就会缩进） */
const IN_LIST = /^([ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)(#{1,6})([ \t]+)/

export function parseHeading(text: string): HeadingInfo | null {
  // 先判列表内标题：否则 `- ## x` 会被普通列表分支先吃掉，`##` 一辈子藏不掉
  const l = IN_LIST.exec(text)
  if (l) {
    const markEnd =
      (l[1] ?? '').length + (l[2] ?? '').length + (l[3] ?? '').length +
      (l[4] ?? '').length + (l[5] ?? '').length
    return { level: (l[4] ?? '').length, markEnd, textStart: markEnd, inList: true }
  }

  const p = PLAIN.exec(text)
  if (p) {
    const markEnd = (p[1] ?? '').length + (p[2] ?? '').length
    return { level: (p[1] ?? '').length, markEnd, textStart: markEnd, inList: false }
  }

  return null
}

/** 取标题正文（去掉标记和可选的收尾 `##`），用于大纲 */
export function headingText(text: string): string {
  const info = parseHeading(text)
  if (!info) return ''
  return text.slice(info.textStart).trim().replace(/[ \t]+#+[ \t]*$/, '')
}
