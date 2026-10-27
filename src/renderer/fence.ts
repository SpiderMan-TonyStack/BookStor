/**
 * 围栏（``` / ~~~）状态机 —— lineclasses.ts 与 markers.ts 共用。
 *
 * 为什么单独抽一个模块：这两处都必须对「这一行是不是围栏、在不在代码块内」
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
 */

/** 围栏上限 8：覆盖列表项 1–2 层的嵌套（实测最深 8 空格） */
const FENCE = /^([ \t]{0,8})(```+|~~~+)(.*)$/

export interface FenceState {
  in: boolean
  /** 开启这个代码块时围栏的缩进，用于配对关闭围栏 */
  indent: number
}

export interface FenceStep {
  /** 这一行本身是围栏标记（```cpp / ```） */
  isMarker: boolean
  /** 这一行是围栏**内部**的内容行 */
  inside: boolean
  /** 标记行的缩进长度（非标记行为 0） */
  indent: number
  /** 标记行的围栏字符个数（非标记行为 0） */
  ticks: number
  /** 标记行的语言名（非标记行为空串） */
  lang: string
}

export function createFenceState(): FenceState {
  return { in: false, indent: 0 }
}

/** 喂一行，更新 state，并返回这一行的角色 */
export function stepFence(state: FenceState, text: string): FenceStep {
  const m = FENCE.exec(text)
  if (m) {
    const indent = (m[1] ?? '').length
    const ticks = (m[2] ?? '').length
    const lang = (m[3] ?? '').trim()

    if (!state.in) {
      state.in = true
      state.indent = indent
      return { isMarker: true, inside: false, indent, ticks, lang }
    }
    if (indent <= state.indent) {
      state.in = false
      state.indent = 0
      return { isMarker: true, inside: false, indent, ticks, lang }
    }
    // 块内更深缩进的 ``` 是内容，不是围栏 —— 状态保持不变
    return { isMarker: false, inside: true, indent, ticks: 0, lang: '' }
  }

  return { isMarker: false, inside: state.in, indent: 0, ticks: 0, lang: '' }
}
