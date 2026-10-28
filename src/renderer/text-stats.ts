/**
 * 字数统计 —— 纯函数，单独放一个文件是为了能直接跑断言
 * （`scripts/test-units.mjs` 里有它的用例）。
 */

export interface TextStats {
  /** JS 字符数（UTF-16 码元） */
  chars: number
  /** 中文按字 + 英文按词 */
  words: number
}

/**
 * 中文按**字**、英文按**词**数 —— 和 Typora 状态栏的口径一致。
 *
 * 不能直接报 `text.length`：中文一个字长度是 1，英文一个单词是五六个字符，
 * 中英混排的笔记报 length 会得到一个既不是字也不是词的数，没有参考意义。
 *
 * 覆盖的区间：
 *   - `\u3400-\u4dbf` 扩展 A、`\u4e00-\u9fff` 基本区、`\uf900-\ufaff` 兼容区
 *   - 英文单词允许中间的撇号/连字符（`don't`、`well-known` 算一个词）
 */
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g
// 撇号用转义写，避免直引号 / 弯引号在源码里看起来一模一样却编码不同
const LATIN = /[A-Za-z0-9]+(?:['\u2019-][A-Za-z0-9]+)*/g

export function countWords(text: string): TextStats {
  const cjk = text.match(CJK)?.length ?? 0
  const latin = text.match(LATIN)?.length ?? 0
  return { chars: text.length, words: cjk + latin }
}
