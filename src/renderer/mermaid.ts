import {
  Decoration,
  EditorView,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type ViewUpdate,
} from '@codemirror/view'
import { RangeSet, StateEffect, StateField, type EditorState, type Text } from '@codemirror/state'
import { createFenceState, stepFence } from './fence.js'
import { isSourceMode, setSourceMode } from './viewmode.js'

/**
 * Mermaid 代码块渲染（策划案 M5，库里 19 篇用到）。
 *
 * 三个设计选择：
 *
 * 1. **按需加载**。`mermaid` 压缩后三兆多，首屏没人要看图也要背这个包 ——
 *    所以用 `await import('mermaid')` 动态引入，vite 会单独切一个 chunk，
 *    只有文档里真的出现 ```mermaid 才会下载解析。
 * 2. **渲染结果按代码内容缓存**。同一个图在滚动 / 改光标 / 切主题时会被反复要求，
 *    没有缓存就是每次重排都重新跑一遍 d3 布局，长文档会卡死。
 * 3. **异步结果靠 effect 回流**。block 装饰必须由 StateField 提供（ViewPlugin 会抛
 *    RangeError），而 StateField 的 update 是同步的、不能在里面 await。
 *    所以渲染完成后 dispatch 一个空 effect，把"可以重算了"这件事推回 state。
 *
 * 光标进块时退回源码 —— 和表格一致：能看图，也能改。
 */

interface MermaidBlock {
  from: number
  to: number
  code: string
}

/** 渲染成功的 svg / 失败的占位，都以代码内容为键 */
const cache = new Map<string, string>()
const inFlight = new Set<string>()
let uid = 0

/** 已经 initialize 过的主题档（mermaid.initialize 是全局的，重复调没必要） */
const initializedThemes = new Set<string>()

/** 渲染完成 → 通知 StateField 重算装饰 */
const mermaidRendered = StateEffect.define<null>()

function findMermaidBlocks(doc: Text): MermaidBlock[] {
  const out: MermaidBlock[] = []
  const fence = createFenceState()
  let startLine = 0
  let lang = ''

  for (let n = 1; n <= doc.lines; n++) {
    const wasIn = fence.in
    const step = stepFence(fence, doc.line(n).text)
    if (!step.isMarker) continue

    if (!wasIn) {
      startLine = n
      lang = step.lang
    } else if (startLine > 0) {
      if (lang.toLowerCase() === 'mermaid') {
        const from = doc.line(startLine).from
        const to = doc.line(n).to
        const code = doc.sliceString(doc.line(startLine).to, doc.line(n).from).trim()
        if (code) out.push({ from, to, code })
      }
      startLine = 0
      lang = ''
    }
  }
  return out
}

/** 正文背景的感知亮度（BT.601 加权，别用三通道平均 —— 深蓝深红会判错） */
function prefersDarkTheme(): boolean {
  const bg = getComputedStyle(document.body).backgroundColor
  const m = bg.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/)
  if (!m) return true
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])]
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 < 0.5
}

async function renderSvg(code: string): Promise<string> {
  try {
    const mod = await import('mermaid')
    const mermaid = mod.default
    const dark = prefersDarkTheme()
    const key = dark ? 'dark' : 'light'
    if (!initializedThemes.has(key)) {
      mermaid.initialize({
        startOnLoad: false,
        // strict：不执行图里可能夹带的脚本/事件属性，纯本地文档也该守住这条
        securityLevel: 'strict',
        theme: dark ? 'dark' : 'default',
        fontFamily: 'inherit',
      })
      initializedThemes.add(key)
    }
    const { svg } = await mermaid.render(`jd-mermaid-${++uid}`, code)
    return svg
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // 渲染失败不要把整块源码吞掉：给出可见的错误条，原文仍留在文档里
    return `<div class="jd-mermaid-error">Mermaid 渲染失败：${escapeHtml(msg)}</div>`
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

class MermaidWidget extends WidgetType {
  constructor(
    readonly svg: string,
    readonly from: number
  ) {
    super()
  }
  override eq(other: MermaidWidget) {
    return other.svg === this.svg && other.from === this.from
  }
  override toDOM(view: EditorView): HTMLElement {
    const wrap = document.createElement('div')
    wrap.className = 'jd-mermaid'
    wrap.innerHTML = this.svg
    // 图里不需要交互
    wrap.querySelectorAll('svg').forEach((el) => {
      el.setAttribute('aria-hidden', 'true')
      el.style.maxWidth = '100%'
      el.style.height = 'auto'
    })

    // 点一下就把光标放进块里 —— 和表格一样：图能看，也要能改。
    // 不给这一条，用户点上去毫无反应（widget 又设了 ignoreEvent），
    // 会以为这块内容坏了。
    wrap.addEventListener('mousedown', (ev) => {
      ev.preventDefault()
      view.dispatch({ selection: { anchor: Math.min(this.from + 1, view.state.doc.length) } })
      view.focus()
    })
    return wrap
  }
  // 必须返回 false：返回 true 会把 mousedown 整个吞掉，上面的监听也不会生效
  override ignoreEvent() {
    return false
  }
}

function build(state: EditorState): DecorationSet {
  if (isSourceMode(state)) return RangeSet.empty

  const sel = state.selection
  const items = []
  for (const b of findMermaidBlocks(state.doc)) {
    // 光标进块就退回源码，否则没法改
    const touched = sel.ranges.some((r) => r.to >= b.from && r.from <= b.to)
    if (touched) continue
    const svg = cache.get(b.code)
    if (!svg) continue
    items.push(
      Decoration.replace({
        block: true,
        widget: new MermaidWidget(svg, b.from),
      }).range(b.from, b.to)
    )
  }
  return RangeSet.of(items, true)
}

const mermaidDecoField = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update(deco, tr) {
    if (
      tr.docChanged ||
      tr.selection ||
      tr.effects.some((e) => e.is(mermaidRendered) || e.is(setSourceMode))
    ) {
      return build(tr.state)
    }
    return deco.map(tr.changes)
  },
  provide: (f) => EditorView.decorations.from(f),
})

/** 扫描并渲染文档里所有没缓存的 mermaid 块（串行，mermaid.render 并发会互相干扰） */
async function scanAndRender(view: EditorView): Promise<void> {
  const blocks = findMermaidBlocks(view.state.doc)
  let changed = false

  for (const b of blocks) {
    if (cache.has(b.code) || inFlight.has(b.code)) continue
    inFlight.add(b.code)
    const svg = await renderSvg(b.code)
    inFlight.delete(b.code)
    cache.set(b.code, svg)
    changed = true
  }

  if (changed && view.dom.isConnected) {
    view.dispatch({ effects: mermaidRendered.of(null) })
  }
}

const mermaidScanPlugin = ViewPlugin.fromClass(
  class {
    private timer: number | null = null
    constructor(readonly view: EditorView) {
      this.schedule()
    }
    update(u: ViewUpdate) {
      if (u.docChanged) this.schedule()
    }
    private schedule(): void {
      if (this.timer !== null) window.clearTimeout(this.timer)
      // 500ms 防抖：打字时每一帧都去扫全文 + 触发布局不划算
      this.timer = window.setTimeout(() => {
        this.timer = null
        void scanAndRender(this.view)
      }, 500)
    }
    destroy() {
      if (this.timer !== null) window.clearTimeout(this.timer)
    }
  }
)

export const mermaidExtensions = [mermaidDecoField, mermaidScanPlugin]
