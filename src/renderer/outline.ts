/**
 * 大纲（M5-1）：把当前笔记的标题抽出来，在侧栏下方列成一棵树，点一下跳过去。
 *
 * 两个必须踩对的点：
 *
 * ① **代码块里的 `#` 不是标题**。库里 C++ 笔记一大堆，
 *    `#include <stdio.h>`、`#define MAX 32`、`#pragma once` 全是行首井号，
 *    正则一把梭会把它们变成大纲里的假标题 —— 而且往往排在真标题前面，
 *    整棵大纲的第一屏就废了。所以这里复用 fence.ts 的围栏状态机，跳过代码块。
 *
 * ② **不要每次按键都全量重扫**。274KB / 8000 行的文件逐行正则要几毫秒，
 *    放在每次 docChanged 里会让输入发涩。调用方用防抖（见 main.ts）。
 */

import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { createFenceState, stepFence } from './fence.js'

export interface OutlineItem {
  /** 1-based 行号 */
  line: number
  /** 该行行首在文档里的字符偏移，跳转用 */
  from: number
  /** 1–6 */
  level: number
  /** 去掉井号和首尾空白的标题文字 */
  text: string
}

/** ATX 标题：`## 标题`。结尾的 `##`（可选）要去掉，Typora 允许 `## 标题 ##` */
const ATX = /^(#{1,6})[ \t]+(.*)$/

export function computeOutline(state: EditorState): OutlineItem[] {
  const items: OutlineItem[] = []
  const fence = createFenceState()

  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n)
    const step = stepFence(fence, line.text)
    // 围栏标记行和代码块内部一律不看
    if (step.isMarker || step.inside) continue

    const m = ATX.exec(line.text)
    if (!m) continue

    const level = m[1]!.length
    const text = (m[2] ?? '').trim().replace(/[ \t]+#+[ \t]*$/, '')
    if (!text) continue

    items.push({ line: n, from: line.from, level, text })
  }

  return items
}

/**
 * 渲染成一组可点的行。层级用 padding-left 区分，不做嵌套缩进线 ——
 * 侧栏宽度只有 240px 左右，多层缩进很快就把标题文字挤没了。
 */
export function renderOutline(
  container: HTMLElement,
  items: OutlineItem[],
  onJump: (pos: number) => void
): void {
  container.textContent = ''

  if (items.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'jd-outline-empty'
    empty.textContent = '这篇没有标题'
    container.append(empty)
    return
  }

  // 大纲最小层级归一：如果全篇都从 ## 开始，别让它们整体向右缩进一格
  let minLevel = 6
  for (const it of items) if (it.level < minLevel) minLevel = it.level

  for (const it of items) {
    const row = document.createElement('div')
    row.className = `jd-outline-item jd-outline-lv${it.level}`
    row.dataset['pos'] = String(it.from)
    row.dataset['line'] = String(it.line)
    row.style.paddingLeft = `${10 + (it.level - minLevel) * 12}px`
    row.textContent = it.text
    row.title = it.text
    row.addEventListener('click', () => onJump(it.from))
    container.append(row)
  }
}

/**
 * 高亮「光标所在的那一节」：取最后一个 from ≤ 光标位置的标题。
 *
 * 用光标而不是视口顶部，是因为在 CM6 里拿「视口顶部对应哪个字符」要走
 * posAtCoords + 元素坐标，碰到未渲染的行就返回 null；而光标位置永远可靠。
 * 代价是滚动浏览时高亮不动 —— 自用场景下够用，先不做滚动同步。
 */
export function highlightOutline(container: HTMLElement, items: OutlineItem[], cursor: number): void {
  let current: OutlineItem | null = null
  for (const it of items) {
    if (it.from <= cursor) current = it
    else break
  }

  const key = current ? String(current.from) : ''
  for (const row of container.querySelectorAll<HTMLElement>('.jd-outline-item')) {
    row.classList.toggle('is-current', row.dataset['pos'] === key)
  }
}

/**
 * 跳到某个标题：把光标放到行首，并把它滚到视口顶部。
 *
 * **不能只靠 `EditorView.scrollIntoView`。** 它滚的是 CM6 自己的
 * `.cm-scroller`，而这个项目在 style.css 里把 `.cm-scroller` 设成
 * `overflow: visible`（为了让主题的 `#write` 内边距/背景生效），
 * 真正滚动的是外层 `#write`。实测：dispatch 之后光标确实移到了目标行、
 * 大纲高亮也变了，但 `#write.scrollTop` 纹丝不动 —— 看起来就是「点了没反应」。
 *
 * 所以这里手动算一次偏移，分两段：
 *   ① 目标行已渲染 → 用 coordsAtPos 与 #write 的 rect 求差，精确滚
 *   ② 目标行还没渲染（大文件跳得远）→ 先用 heightmap 的估算位置滚过去，
 *      下一帧行渲染出来了再校正一次。估算值在长文档里可能差几百像素，
 *      只靠它会跳歪。
 */
export function jumpTo(view: EditorView, pos: number): void {
  view.dispatch({ selection: { anchor: pos } })
  view.focus()

  const write = view.dom.closest('#write') as HTMLElement | null
  if (!write) return

  const target = (): number => write.getBoundingClientRect().top + 8

  /**
   * 迭代校正，而不是滚一次就完事。
   *
   * 原因一：CM6 的高度表对**没渲染过**的行只是估算，滚过去之后行才真正渲染，
   *        实际高度和估算值不一样，内容重排后位置又偏了（实测单次校正能偏 400px）。
   * 原因二：**不能用 requestAnimationFrame**。窗口不可见时（最小化、被遮挡、
   *        或自动化里没抢到前台）rAF 会被完全暂停 —— 实测 hidden 状态下
   *        600ms 内 rafTicks 为 0，等于这段校正一次都没跑，表现就是「点了没反应」。
   *        setTimeout 在隐藏页面里只是被节流，不会彻底停摆。
   *
   * 递增延迟 30/60/90ms 给 CM6 留出渲染时间，最多 4 轮，误差收到 4px 内就停。
   */
  let tries = 0
  const align = (): void => {
    const coords = view.coordsAtPos(pos)
    if (!coords) {
      // 目标行还没渲染出来，先按高度表估算滚过去，下一轮再看
      write.scrollTop = Math.max(0, view.lineBlockAt(pos).top - 8)
    } else {
      const delta = coords.top - target()
      if (Math.abs(delta) > 4) write.scrollTop += delta
    }
    if (tries++ < 3) setTimeout(align, 30 * (tries + 1))
  }

  align()
}
