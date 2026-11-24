import { EditorView, WidgetType } from '@codemirror/view'
import { computeOutline, jumpTo } from './outline.js'

/**
 * `[TOC]` → 真正的目录块（4.3.0）。
 *
 * 为什么做成「行内 widget」而不是 block replace：
 * `[TOC]` 这几行本身就是普通文本行，把它整行 replace 掉会连行带句柄一起消失，
 * 光标能落进去却看不见（fold.ts 踩过这个坑，见 MEMORY 的折叠一条）。
 * 现在的做法和图片一样 —— 文本用 `font-size:0` 藏掉、原位插 widget，
 * 想改/删这行时把光标移上去，源码就回来了。
 *
 * 目录内容**随文档实时变**：每次装饰重算都会重新算一遍标题，`eq()` 拿条目
 * 拼出来的 key 比对，标题没变就不重建 DOM（滚动时不至于每次重排）。
 *
 * 代价是每次重算都要扫全篇找标题（computeOutline 是逐行正则）。
 * 一篇 274KB 的笔记大约几毫秒，而且只有**视口里存在 `[TOC]` 行**时才会走到，
 * 所以没有为它单独加缓存 —— 缓存还得处理失效，坏了更难查。
 */

export interface TocEntry {
  level: number
  text: string
  from: number
}

export class TocWidget extends WidgetType {
  constructor(
    readonly entries: TocEntry[],
    /** 点击条目要滚到对应标题，`jumpTo` 需要 view */
    readonly view: EditorView,
    /** 内容指纹：只有它变了才重建 DOM */
    readonly key: string
  ) {
    super()
  }

  override eq(other: TocWidget): boolean {
    return other.key === this.key
  }

  override toDOM(): HTMLElement {
    const nav = document.createElement('nav')
    nav.className = 'jd-toc'
    nav.setAttribute('aria-label', '目录')

    const title = document.createElement('div')
    title.className = 'jd-toc-title'
    title.textContent = '目录'
    nav.append(title)

    if (this.entries.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'jd-toc-empty'
      empty.textContent = '这篇还没有标题'
      nav.append(empty)
      return nav
    }

    // 全篇都从 ## 开始时别整体缩进一格（大纲侧栏同款处理）
    let minLevel = 6
    for (const e of this.entries) if (e.level < minLevel) minLevel = e.level

    for (const e of this.entries) {
      const item = document.createElement('div')
      item.className = `jd-toc-item jd-toc-lv${e.level}`
      item.style.paddingLeft = `${(e.level - minLevel) * 1.1}em`
      item.textContent = e.text
      item.title = e.text
      item.addEventListener('mousedown', (ev) => {
        // mousedown 而不是 click：click 要先经过 CM6 的选区逻辑（widget 的
        // ignoreEvent() 返回 true，本来就不会被它接管，但 mousedown 更早、更稳）
        ev.preventDefault()
        ev.stopPropagation()
        jumpTo(this.view, e.from)
      })
      nav.append(item)
    }
    return nav
  }

  override ignoreEvent(): boolean {
    // 返回 true = 让 CM6 别管这个 widget 里的事件，否则点击会被当成「点到某一行」
    return true
  }
}

/** 算出当前文档的目录条目（供 markers.ts 建 widget 用） */
export function tocEntries(view: EditorView): TocEntry[] {
  return computeOutline(view.state).map((it) => ({ level: it.level, text: it.text, from: it.from }))
}

/** 内容指纹 */
export function tocKey(entries: TocEntry[]): string {
  return entries.map((e) => `${e.level}:${e.from}:${e.text}`).join('\u0000')
}
