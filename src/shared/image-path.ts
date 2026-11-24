/**
 * 图片路径的解析规则 —— 主进程（裂图检测）与渲染层（图片 widget）**共用同一份**。
 *
 * 为什么要抽出来：这两处原本各写了一份「去掉 title、去掉 `<>` 包裹」的代码，
 * 只要一处改、另一处没跟上，就会出现「正文里图片显示得出来，裂图检测却说文件不存在」
 * 这种自相矛盾，而且不报错、不崩，只能靠人肉发现。
 *
 * 注意这里**只做语法层面的清理**，不碰文件系统：
 * 相对路径怎么解析成绝对路径，由各自的调用方决定（主进程用 path.resolve，
 * 渲染层要生成 file:// URL）。
 */

/** `[文字](目标)` / `![alt](目标)` 的共同形式 —— 扫描时用 */
export const RE_BRACKET = /^\[([^\]]*)\]\(([^)]*)\)/

/**
 * 从 `![alt](target)` 的括号内容里取出干净路径。
 *
 * 要处理两种 Typora 写法：
 *   1. `![x](a.png "标题")` —— 标题有双引号 / 单引号 / 括号三种写法
 *   2. `![x](<带 空格.png>)` —— 空格等字符用尖括号包起来
 */
export function cleanImageTarget(target: string): string {
  let clean = target.trim()
  const titleMatch = clean.match(/^(.+?)\s+("[^"]*"|'[^']*'|\([^)]*\))$/)
  if (titleMatch?.[1]) clean = titleMatch[1].trim()
  if (clean.startsWith('<') && clean.endsWith('>')) clean = clean.slice(1, -1)
  return clean
}
