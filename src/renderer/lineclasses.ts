import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { RangeSetBuilder, type EditorState } from '@codemirror/state'
import { createFenceState, stepFence } from './fence.js'
import { parseHeading } from './heading.js'

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

const QUOTE = /^\s{0,3}>/
const UL = /^[ \t]{0,8}[-*+]\s/
const OL = /^[ \t]{0,8}\d+[.)]\s/
const TASK = /^[ \t]{0,8}[-*+]\s+\[[ xX]\]\s/
const HR = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const TABLE = /^\s{0,3}\|/

// ---- 4.3.0 新增的三种块（「段落」菜单能插，就得能看） ----

/** YAML Front Matter 的分隔符：整行只有三个短横 */
const FM_DELIM = /^---\s*$/
/**
 * 公式块围栏。**只认「整行只有 `$$`」**：
 * `$$x$$` 这种行内公式是一行内的事，把它当块围栏会让后面整篇都被染成公式。
 */
const MATH_FENCE = /^\s{0,3}\$\$\s*$/
/** 警告框标题行 `> [!NOTE]`，后面可以带标题文字（大小写都认，GitHub / Obsidian / Typora 同一套） */
const ADM_TITLE = /^\s{0,3}>[ \t]*\[!([A-Za-z]+)\]/
/** 脚注定义 `[^1]: 内容` */
const FOOTNOTE_DEF = /^\s{0,3}\[\^[^\]]+\]:/

interface LineInfo {
  num: number
  from: number
  classes: string[]
  /** 用于识别块边界 */
  kind: 'code' | 'table' | 'math' | 'fm' | 'other'
  /** 专注模式算「当前段落」时用：这三类都是段落边界 */
  isBlank: boolean
  isHeading: boolean
  isMarker: boolean
  /** 警告框标题行上记下类型（note/tip/…），第二轮据此把整块染同色 */
  admType: string
  /**
   * 代码块内的**逻辑行号**（从 1 开始；非代码行为 0）。
   *
   * 写进行上的 `data-ln` 供 CSS `::before` 显示 —— 行号是显示层，不进文本，
   * 复制代码不会带上它。不能靠 CSS counter：`counter-reset` 只在块首行生效，
   * 而「滚到长代码块中间」时块首行不在视口里，计数器会从 1 重新数。
   */
  codeNo: number
}

function classFor(text: string, inFence: boolean, isFenceMarker: boolean): string {
  if (inFence || isFenceMarker) return 'jd-code-line'
  // 标题（含 `- ## x` 这种列表项里嵌的标题，见 heading.ts）
  const h = parseHeading(text)
  if (h) return `jd-h${h.level}`
  if (TASK.test(text)) return 'jd-li jd-task'
  if (HR.test(text)) return 'jd-hr'
  if (QUOTE.test(text)) return 'jd-quote'
  if (UL.test(text) || OL.test(text)) return 'jd-li'
  if (TABLE.test(text)) return 'jd-table-row'
  if (text.trim() === '') return 'jd-p jd-blank'
  return 'jd-p'
}

/**
 * Front Matter 的范围（第 1 行 `---` 到下一个 `---`）。
 *
 * 只在**文档开头**认 —— 正文中间拿 `---` 开头的一对不能算元数据（那通常就是
 * 分隔线 + 又一条分隔线）。最多往后看 200 行：正常 front matter 就十几行，
 * 没有闭合的时候不能为了它扫完整篇。
 */
function frontMatterRange(state: EditorState): { first: number; last: number } | null {
  const doc = state.doc
  if (doc.lines < 2) return null
  // 首行可能带 BOM（库里 4 篇是这种），`\ufeff---` 也要认
  if (!FM_DELIM.test(doc.line(1).text.replace(/^\ufeff/, ''))) return null
  const limit = Math.min(doc.lines, 200)
  for (let n = 2; n <= limit; n++) {
    if (!FM_DELIM.test(doc.line(n).text)) continue
    // 里面必须真的像 YAML（至少一行 `key:`）。
    // 否则「首行拿 `---` 当分隔线、正文里还有一条 `---`」的普通笔记，
    // 中间整段会被当成元数据卡片（灰底 + 等宽 + 分隔符被隐藏），
    // 而它其实只是正文 —— 宁可不认，退回普通渲染。
    for (let k = 2; k < n; k++) {
      if (/^[A-Za-z_][\w.-]*\s*:/.test(doc.line(k).text)) return { first: 1, last: n }
    }
    return null
  }
  return null
}

function buildDecorations(view: EditorView): DecorationSet {
  const doc = view.state.doc
  const activeLine = doc.lineAt(view.state.selection.main.head).number
  const fm = frontMatterRange(view.state)

  // 围栏状态是文档级的，但只算到视口末尾就够了（视口之前的状态靠回溯一次）。
  // 用 fence.ts 的共享状态机：它按「开启时的缩进」配对，所以列表项里
  // 4–8 空格缩进的围栏能识别，块内更深缩进的 ``` 也不会把块提前关掉。
  const fence = createFenceState()
  const firstVisible = view.visibleRanges[0]
  // 公式块也要回溯：光看视口内不知道 `$$` 是开还是关
  let mathOpen = false
  /**
   * 回溯时同步数一遍代码块行号：块首常常在视口上方，不数的话滚到中间
   * 行号会从 1 重新开始（见 LineInfo.codeNo 的注释）。
   */
  let codeNo = 0
  if (firstVisible) {
    const scanTo = doc.lineAt(firstVisible.from).number
    for (let n = 1; n < scanTo; n++) {
      const text = doc.line(n).text
      const step = stepFence(fence, text)
      // 代码块里的 `$$` 是代码，不参与公式块的开关
      if (!step.inside && !step.isMarker && MATH_FENCE.test(text)) mathOpen = !mathOpen
      if (step.isMarker) codeNo = 0
      else if (step.inside) codeNo++
    }
  }

  const infos: LineInfo[] = []
  // 一次走完「首个可见行 → 末个可见行」，而不是按 visibleRanges 分段落走。
  // 分行走会漏掉两段之间的行：围栏状态机是**顺序**推进的，漏几行之后
  // 后面的代码行号与公式块开关都会错（行号表现为「中间突然重数」）。
  // 多算几行装饰的代价可以忽略（视口量级），正确性换回来是值得的。
  const ranges = view.visibleRanges
  const firstLine = ranges.length > 0 ? doc.lineAt(ranges[0]!.from).number : 1
  const lastLine = ranges.length > 0 ? doc.lineAt(ranges[ranges.length - 1]!.to).number : 0
  for (let lineNo = firstLine; lineNo <= lastLine; lineNo++) {
    const line = doc.line(lineNo)
    const text = line.text
    const step = stepFence(fence, text)
    // 行号只在块内累加；两个围栏行（开 / 关）都归零，所以内容行正好 1..N
    if (step.isMarker) codeNo = 0
    else if (step.inside) codeNo++

    const isFm = !!fm && line.number >= fm.first && line.number <= fm.last
    // 围栏行本身也算公式块的一部分（整块连成一张卡片）
    const isMathFence = !step.inside && !step.isMarker && MATH_FENCE.test(text)
    if (isMathFence) mathOpen = !mathOpen
    const isMath = !isFm && (isMathFence || (mathOpen && !step.inside && !step.isMarker))

    let cls: string
    if (isFm) cls = 'jd-frontmatter'
    else if (isMath) cls = 'jd-math'
    else cls = classFor(text, step.inside, step.isMarker)
    const classes = cls.split(' ')

    const adm = ADM_TITLE.exec(text)
    if (adm) {
      const type = adm[1]!.toLowerCase()
      classes.push('jd-adm', `jd-adm-${type}`)
    }

    let kind: LineInfo['kind'] = 'other'
    if (step.isMarker) {
      classes.push('jd-code-fence', 'jd-code-block')
      kind = 'code'
    } else if (step.inside) {
      classes.push('jd-code-block')
      kind = 'code'
    } else if (isMath) {
      classes.push('jd-math-block')
      kind = 'math'
    } else if (isFm) {
      kind = 'fm'
    } else if (TABLE.test(text)) {
      kind = 'table'
    }

    if (!isFm && !isMath && FOOTNOTE_DEF.test(text)) classes.push('jd-footnote-def')

    if (line.number === activeLine) classes.push('jd-active')
    infos.push({
      num: line.number,
      from: line.from,
      classes,
      kind,
      isBlank: text.trim() === '',
      isHeading: parseHeading(text) !== null,
      isMarker: step.isMarker,
      admType: adm ? adm[1]!.toLowerCase() : '',
      codeNo: step.inside ? codeNo : 0,
    })
  }

  // 第二轮：标块边界。首行 = 上一个可见行的 kind 不同；
  // 末行 = 下一个可见行的 kind 不同（视口边缘保守起见也算末行，宁可多重一条边）。
  for (let i = 0; i < infos.length; i++) {
    const cur = infos[i]!
    if (cur.kind === 'other') continue
    const prev = infos[i - 1]
    const next = infos[i + 1]
    if (!prev || prev.kind !== cur.kind) cur.classes.push(`jd-${cur.kind}-first`)
    if (!next || next.kind !== cur.kind) cur.classes.push(`jd-${cur.kind}-last`)
  }

  // 第二轮补：警告框整块同色。
  //
  // `> [!NOTE]` 只是块的第一行，可是整块要一起变 —— 只给标题行上色的话，
  // 得到的是「一个灰引用块 + 一行彩色标题」，看起来像两段东西。
  // 从标题行往下连着吃 `>` 行，吃到第一行不是引用的为止。
  for (let i = 0; i < infos.length; i++) {
    const head = infos[i]!
    if (!head.admType) continue
    const cls = ['jd-adm', `jd-adm-${head.admType}`]
    head.classes.push('jd-adm-first')
    // 标题行已经带过 jd-adm 了，去个重（class 重复不影响样式，只是脏）
    head.classes = Array.from(new Set(head.classes))
    let j = i + 1
    while (j < infos.length && infos[j]!.admType === '' && infos[j]!.classes.includes('jd-quote')) {
      infos[j]!.classes.push(...cls)
      j++
    }
    const last = infos[j - 1]!
    if (last !== head) last.classes.push('jd-adm-last')
  }


  // 第三轮：专注模式要的「当前段落」。
  //
  // 段落 = 连续的行，遇到空行 / 标题 / 列表项 / 分隔线 / 表格 / 围栏标记就断开；
  // 代码块和公式块内部不设边界（块里的空行不算段落分隔），所以整块算一段。
  // Front Matter 反过来 —— 它是元数据，整块当边界，别让「聚焦当前段落」把它点亮。
  // 只在可见范围内算：光标一定在视口内，够用；为一个视觉效果扫全文不值。
  const activeIdx = infos.findIndex((i) => i.num === activeLine)
  if (activeIdx >= 0) {
    const isBoundary = (i: LineInfo): boolean =>
      i.isMarker ||
      i.isHeading ||
      i.kind === 'table' ||
      i.kind === 'fm' ||
      ((i.kind !== 'code' && i.kind !== 'math') && i.isBlank) ||
      i.classes.includes('jd-li') ||
      i.classes.includes('jd-hr')

    let lo = activeIdx
    let hi = activeIdx
    if (!isBoundary(infos[activeIdx]!)) {
      while (lo - 1 >= 0 && !isBoundary(infos[lo - 1]!)) lo--
      while (hi + 1 < infos.length && !isBoundary(infos[hi + 1]!)) hi++
    }
    for (let i = lo; i <= hi; i++) {
      if (!infos[i]!.classes.includes('jd-active')) infos[i]!.classes.push('jd-active')
    }
  }

  const builder = new RangeSetBuilder<Decoration>()
  for (const info of infos) {
    builder.add(
      info.from,
      info.from,
      Decoration.line({
        class: info.classes.filter(Boolean).join(' '),
        // 行号写进属性而不是文本：CSS 只在开启「显示行号」时才渲染它，
        // 关掉时属性留着也无害（一个字符串，不进高度模型）。
        attributes: info.codeNo > 0 ? { 'data-ln': String(info.codeNo) } : undefined,
      })
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
