/**
 * 块级编辑的纯函数层（可单测，不碰 DOM / CM6）。
 *
 * 为什么单独抽出来：这些规则全是「一行文本 → 换一种块前缀」的字符串变换，
 * 很容易写出边界 bug（缩进吃掉、`1.` 变 `1.`、标题级别越界、水平线的 `---`
 * 与 YAML 分隔符混淆）。抽成纯函数才能在 `scripts/test-units.mjs` 里锁死。
 *
 * 约定：所有函数都**保留行首缩进**，只动「缩进之后的那截」。列表项里嵌标题
 * （库里 232 行 `- ## x`）就是靠这条约定不被破坏。
 */

/** 块的种类。顺序和菜单一致，`p` 表示「普通段落」（去掉一切块前缀） */
export type BlockKind = 'p' | 'quote' | 'ul' | 'ol' | 'task'


/** 行首缩进 + 其余部分 */
export function splitIndent(text: string): { indent: string; rest: string } {
  const m = /^([ \t]*)(.*)$/s.exec(text)
  return { indent: m?.[1] ?? '', rest: m?.[2] ?? '' }
}

const HEADING = /^(#{1,6})\s+/
/** 引用：允许 `> ` 与 `>`（无空格），Typora 两种都认 */
const QUOTE = /^>\s?/
/** 无序：`- ` / `* ` / `+ `，后面必须跟空格（否则 `-1` 这种不是列表） */
const UL = /^[-*+]\s+/
/** 任务：必须排在 UL 前面判断，否则 `- [ ] x` 会被当成普通无序项 */
const TASK = /^[-*+]\s+\[[ xX]\]\s+/
/** 有序：`1. ` / `1) ` */
const OL = /^\d+[.)]\s+/

/** 这一行当前是什么块（按优先级从具体到宽泛） */
export function blockKindOf(text: string): BlockKind {
  const { rest } = splitIndent(text)
  if (QUOTE.test(rest)) return 'quote'
  if (TASK.test(rest)) return 'task'
  if (UL.test(rest)) return 'ul'
  if (OL.test(rest)) return 'ol'
  return 'p'
}

/** 剥掉已有的块前缀（引用 / 任务 / 无序 / 有序），返回缩进之后的内容 */
export function stripBlockPrefix(text: string): { indent: string; rest: string } {
  const { indent, rest } = splitIndent(text)
  let body = rest
  // 引用可以叠加（`> - a`），这里只剥一层就够 —— 菜单是把「这一行」改成某一种块，
  // 叠层是手写的边缘情况，不替用户猜意图。
  body = body.replace(QUOTE, '')
  body = body.replace(TASK, '')
  body = body.replace(UL, '')
  body = body.replace(OL, '')
  return { indent, rest: body }
}

/**
 * 把一行改成指定块。
 *
 * `ordinal` 只有有序列表用（同一段选区里依次 1. 2. 3.）。
 * 语义是 **toggle**：已经是这一类就退回段落 —— 和 Typora 点列表按钮的行为一致，
 * 否则用户没有「取消列表」的入口（只能手动删前缀）。
 */
export function setBlockKind(text: string, kind: BlockKind, ordinal = 1): string {
  const current = blockKindOf(text)
  const { indent, rest } = stripBlockPrefix(text)
  const next: BlockKind = current === kind ? 'p' : kind

  switch (next) {
    case 'p':
      return indent + rest
    case 'quote':
      return `${indent}> ${rest}`
    case 'ul':
      return `${indent}- ${rest}`
    case 'task':
      return `${indent}- [ ] ${rest}`
    case 'ol':
      return `${indent}${ordinal}. ${rest}`
  }
}

/**
 * 提升 / 降低标题级别。
 *
 * `delta` 是**标题级别的变化量**：`-1` = 提升（H2 → H1，字更大、层级更高），
 * `+1` = 降低（H1 → H2）。别把方向搞反 —— 「提升」是把数字变小，
 * 这是这条函数最容易写错的地方，所以这里把话说死。
 *
 * 不是标题时两边都**原样不动**（返回 null，让调用方提示「这里没有标题」）。
 * 不给「段落 → 一级标题」这种便利：选中混排的多行时，那种便利会把正文行
 * 一起变成标题，用户完全没打算这么干。要设标题有 Ctrl+1~6。
 */
export function changeHeadingLevel(text: string, delta: number): string | null {
  const { indent, rest } = splitIndent(text)
  const m = HEADING.exec(rest)
  if (!m) return null
  const level = m[1]!.length
  // `#` 与标题文字之间那一段**原样保留**（可能是两个空格，也可能是 tab）。
  // 重新拼一个空格会把 `###  流程概述` 改成 `#### 流程概述` —— 级别没变错，
  // 但多改了一个字节；库里 4440 个标题里有 732 个是双空格写法（实测），
  // 一提升级别就整篇出现无意义的 diff。纯文本是唯一真源，不是该动的地方就不碰。
  const gap = rest.slice(m[1]!.length, m[0].length)
  const next = Math.min(6, Math.max(1, level + delta))
  // 已经在边界上（1 级再提、6 级再降）→ 不动内容，但也算处理过了
  return `${indent}${'#'.repeat(next)}${gap}${rest.slice(m[0].length)}`
}

/** 当前标题级别（0 = 不是标题），菜单打勾用 */
export function headingLevelOf(text: string): number {
  const { rest } = splitIndent(text)
  const m = HEADING.exec(rest)
  return m ? m[1]!.length : 0
}

/**
 * 列表缩进：每级 width 个空格（默认 2，Typora 默认；可在偏好设置里改 4），返回新文本。
 *
 * **只对列表行生效**（无序 / 有序 / 任务）。两种情况返回 null：
 *   - 普通段落：加空格在 markdown 里没有任何语义（既不是缩进段落也不是代码），
 *     只会在文件里留下看不见的空白差异；Typora 的「列表缩进」同样不碰正文。
 *   - **引用行**：`> 引用` 缩进到 4 个空格就变成「缩进代码块」，引用块直接降级成代码
 *     —— 这是个把文档改坏的路径（连按三次「增加缩进」即可复现），所以一律不动。
 * 想缩进代码请用围栏或四个空格（那是代码块，不是这条命令的事）。
 */
export function indentList(text: string, delta: number, width = 2): string | null {
  const kind = blockKindOf(text)
  if (kind !== 'ul' && kind !== 'ol' && kind !== 'task') return null
  const { indent, rest } = splitIndent(text)
  // 只认 2 / 4：传别的值（面板手改配置、旧版本）一律按 2 处理 —— 缩进宽度
  // 变成 3 会让用户库里已有的 2 空格层级对不齐，而这条命令只增不减地叠加。
  const w = width === 4 ? 4 : 2
  let n = indent.length + delta * w
  if (n < 0) n = 0
  return ' '.repeat(n) + rest
}

/**
 * 任务勾选状态：`- [ ]` ↔ `- [x]`。
 * 不是任务项返回 null（调用方据此提示）。
 */
export function toggleTaskChecked(text: string): string | null {
  const { indent, rest } = splitIndent(text)
  const m = /^([-*+]\s+)\[([ xX])\](.*)$/.exec(rest)
  if (!m) return null
  const mark = m[2] === ' ' ? 'x' : ' '
  return `${indent}${m[1]}[${mark}]${m[3]}`
}

/**
 * 明确设成「已完成 / 未完成」（菜单「任务状态」用，不是 toggle）。
 * 已经是目标状态就原样返回；不是任务项返回 null。
 */
export function setTaskChecked(text: string, checked: boolean): string | null {
  const { indent, rest } = splitIndent(text)
  const m = /^([-*+]\s+)\[([ xX])\](.*)$/.exec(rest)
  if (!m) return null
  return `${indent}${m[1]}[${checked ? 'x' : ' '}]${m[3]}`
}

/** 这行是不是空行（只有空白） */
export function isBlankLine(text: string): boolean {
  return text.trim() === ''
}

/**
 * 有序列表的起始序号：选中多行时按顺序往下排。
 * 单独抽出来是为了让 editor 那边只关心「第几行」。
 */
export function ordinalFor(ordinal: number): number {
  return Number.isFinite(ordinal) && ordinal > 0 ? ordinal : 1
}
