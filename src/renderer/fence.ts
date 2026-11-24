/**
 * 围栏（``` / ~~~）状态机 —— lineclasses.ts / markers.ts / fold.ts / outline.ts 共用。
 *
 * 为什么单独抽一个模块：这几处都必须对「这一行是不是围栏、在不在代码块内」
 * 给出**逐行一致**的答案。之前各自写了一份正则 + 各自的布尔翻转，
 * 缩进上限一改就得同时改两处，漏一处就会出现「一层藏标记、另一层不认」的
 * 割裂渲染。判断逻辑只允许有一份。
 *
 * 为什么不能简单把缩进上限从 3 放宽到 8：
 * 列表项里嵌套的围栏确实带 4–8 空格缩进（实测库内 183 行 / 10 个文件），
 * 但代码块**内部**也可能出现深缩进的 ``` （示例代码里就有）。
 * 朴素放宽会让后者把块提前关掉，后面整片正文被误判成代码 ——
 * 实测净减 8206 行。所以改成「按开启时的缩进配对」：
 *   - 不在块内：任何 0–8 缩进的围栏都能开启
 *   - 在块内：只有缩进 ≤ 开启缩进的围栏才算关闭
 * 实测（245 篇）净增 2252 行代码，只有 1 个文件有 278 行被重新归属。
 *
 * 围栏可以出现在三种位置，都要认（都是 Typora / CommonMark 的合法写法）：
 *   ① 裸围栏       ```cpp
 *   ② 列表项里       - ```cpp      （代码块是列表项的第一个子块，库内 37 处）
 *   ③ 引用块里     > ```cpp      （库内 GAS中文文档.md 3 处，其中一处还套了列表项：`> - ```c++`）
 * 只用**开启时的位置**做配对依据：内容行必须仍在同一层引用里，关闭围栏的缩进 ≤ 开启缩进。
 */

/** 围栏上限 8：覆盖列表项 1–2 层的嵌套（实测最深 8 空格） */
const FENCE = /^([ \t]{0,8})(```+|~~~+)(.*)$/

/**
 * 「列表项行上的围栏」：`- ```cpp` / `1. ``` `。
 *
 * 这是 Typora（和 CommonMark）里合法写法 —— 代码块作为列表项的**第一个子块**。
 * 库里 `书籍/ue/gas.md` 一个文件就有 30 处、全库 37 处这么写，
 * 而 `FENCE` 只认「前面全是空白」，于是这些行**开不了块**，可它们的**关闭**行
 * （`        ``` ` 八个空格）却是合法的裸围栏 → 被当成开启 →
 * **整篇里代码与正文成对反转**（实测 gas.md 1099 行里 316 行被归反）。
 *
 * 两个必须的限制：
 *   ① **只在不在块内时**认（关闭围栏必须是裸围栏行，不能是 `- ````）；
 *   ② 反引号后面**不能再出现**反引号 —— `- ```bIWYU``` (说明)` 这种是正文里
 *      顺手用三个反引号包函数的写法，把它当围栏开启会让后面整篇变成代码。
 */
const BULLET_FENCE = /^([ \t]{0,8})(?:[-*+]|\d{1,9}[.)])[ \t]+(```+|~~~+)(.*)$/

export interface FenceState {
  in: boolean
  /** 开启这个代码块时围栏的缩进（**去掉引用前缀之后**的缩进），用于配对关闭围栏 */
  indent: number
  /** 开启时所在的引用层数（`> ` 的个数）；0 = 不在引用里 */
  quote: number
}

export interface FenceStep {
  /** 这一行本身是围栏标记（```cpp / ```） */
  isMarker: boolean
  /** 这一行是围栏**内部**的内容行 */
  inside: boolean
  /** 标记行里**反引号所在列**（相对整行，含引用前缀；非标记行为 0） */
  indent: number
  /** 标记行的围栏字符个数（非标记行为 0） */
  ticks: number
  /** 标记行的语言名（非标记行为空串） */
  lang: string
}

export function createFenceState(): FenceState {
  return { in: false, indent: 0, quote: 0 }
}

/**
 * 拆掉行首的引用标记：`> > x` → depth 2、prefix 4、rest `x`。
 *
 * 引用层与围栏的缩进必须分开算：`> ``` ` 的反引号在**整行**第 2 列，
 * 但配对时比的是「去掉 `> ` 之后」的缩进 —— 否则引用层数一变，
 * 缩进比较就全部错位。
 */
export function splitQuote(text: string): { depth: number; prefix: number; rest: string } {
  let i = 0
  let depth = 0
  for (;;) {
    let j = i
    let sp = 0
    // 每个 `>` 前最多 3 个空格（CommonMark 的缩进上限）
    while (sp < 3 && text[j] === ' ') {
      j++
      sp++
    }
    if (text[j] !== '>') break
    j++
    if (text[j] === ' ') j++
    i = j
    depth++
  }
  return { depth, prefix: i, rest: text.slice(i) }
}

/** 喂一行，更新 state，并返回这一行的角色 */
export function stepFence(state: FenceState, text: string): FenceStep {
  // 第一行可能带 BOM（库里 4 篇是这种，全是整篇 C++ 源码）。U+FEFF 不会被 `^[ \t]*`
  // 匹配，于是「第一行的 ``` 」开不了块、后面的关闭围栏反倒被当成开启 ——
  // 整篇源码就被当正文渲染。这里把 BOM 换成等长的空格：**索引不变**（markers 用它
  // 定位要高亮的字符），只是让它能落在缩进里。
  const scan = text.charCodeAt(0) === 0xfeff ? ` ${text.slice(1)}` : text
  const q = splitQuote(scan)

  // 引用层变浅 = 引用块结束了，里面的代码块跟着结束。
  // 这一行本身按普通正文处理（不当作围栏），否则 `> ``` ` 之后紧跟的裸围栏
  // 会被误判成"关闭"。
  if (state.in && q.depth < state.quote) {
    state.in = false
    state.indent = 0
    state.quote = 0
    return { isMarker: false, inside: false, indent: 0, ticks: 0, lang: '' }
  }

  const sameQuote = q.depth === state.quote
  const m = FENCE.exec(q.rest)
  if (m) {
    const inner = (m[1] ?? '').length
    const indent = q.prefix + inner // 反引号在整行里的列号（markers 靠它隐藏）
    const ticks = (m[2] ?? '').length
    const lang = (m[3] ?? '').trim()

    if (!state.in) {
      state.in = true
      state.indent = inner
      state.quote = q.depth
      return { isMarker: true, inside: false, indent, ticks, lang }
    }
    if (sameQuote && inner <= state.indent) {
      state.in = false
      state.indent = 0
      state.quote = 0
      return { isMarker: true, inside: false, indent, ticks, lang }
    }
    // 同层但更深缩进的 ``` 是内容，不是围栏（跨引用层的裸围栏同理，上面已处理）
    return { isMarker: false, inside: true, indent, ticks: 0, lang: '' }
  }

  // 列表项行上的围栏（可以套在引用里：`> - ```c++`）—— 只能**开启**，不能关闭。
  // 开启后把「内容缩进」记成反引号在去掉引用前缀后的列：这类块的内容与关闭围栏
  // 都在那个缩进上，后面遇到缩进 ≤ 它的裸围栏就正常关闭（配不到就开到文末，
  // 与原来的行为一致）。
  if (!state.in) {
    const b = BULLET_FENCE.exec(q.rest)
    if (b && !/(```+|~~~+)/.test(b[3] ?? '')) {
      const ticks = b[2] ?? ''
      const inner = b[0].indexOf(ticks)
      state.in = true
      state.indent = inner
      state.quote = q.depth
      return {
        isMarker: true,
        inside: false,
        indent: q.prefix + inner,
        ticks: ticks.length,
        lang: (b[3] ?? '').trim(),
      }
    }
  }

  return { isMarker: false, inside: state.in, indent: 0, ticks: 0, lang: '' }
}
