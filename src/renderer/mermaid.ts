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

/**
 * 渲染缓存。
 *
 * 键里**必须带明暗档**（`d|code` / `l|code`）：`mermaid.render` 出来的 SVG
 * 把颜色烤进了 `fill` / `stroke` 属性里，换主题后重新取用旧图就是深色底上的
 * 浅色字（或反过来），改 CSS 也救不回来。之前只按代码内容做键，
 * 症状是「切主题后图还是老配色，必须重开笔记才好」。
 */
const cache = new Map<string, string>()
const inFlight = new Set<string>()
let uid = 0

function cacheKey(code: string, dark: boolean): string {
  return `${dark ? 'd' : 'l'}|${code}`
}

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

/** 当前 mermaid 全局配置处在哪一档（null = 还没 initialize 过） */
let activeTheme: boolean | null = null

/**
 * 把全局 mermaid 配置切到指定明暗档。
 *
 * `mermaid.initialize` 是**全局**的 —— 改的是库里的默认配置，下一次 `render`
 * 才用新配置。所以：
 *   - 切之前先看是不是已经在目标档，避免每次都重设（重复设没坏处但没必要）；
 *   - 切过之后 `activeTheme` 必须跟着更新，否则「以为还在深色、其实已经切浅了」。
 * 已渲染的 SVG 不会因为这次调用而变（颜色烤在属性里），要换配色只能重渲染 ——
 * 所以缓存键带了明暗档（见 cacheKey）。
 */
function applyMermaidTheme(
  mermaid: { initialize: (c: import('mermaid').MermaidConfig) => void },
  dark: boolean
): void {
  if (activeTheme === dark) return
  const config: import('mermaid').MermaidConfig = {
    startOnLoad: false,
    // strict：不执行图里可能夹带的脚本/事件属性，纯本地文档也该守住这条
    securityLevel: 'strict',
    theme: dark ? 'dark' : 'default',
    fontFamily: 'inherit',
  }
  mermaid.initialize(config)
  activeTheme = dark
}

/** 给导出用：临时切到浅色渲染，完了切回来（否则导出一次 PDF 会把编辑器里的图染白） */
export async function withLightTheme<T>(fn: () => Promise<T>): Promise<T> {
  const mod = await import('mermaid')
  const mermaid = mod.default
  const prev = activeTheme
  applyMermaidTheme(mermaid, false)
  try {
    return await fn()
  } finally {
    // prev 为 null 表示之前没初始化过，那就恢复成"未初始化"状态也没意义 ——
    // 直接用编辑器当前的明暗档恢复，比 null 更接近用户看到的
    applyMermaidTheme(mermaid, prev ?? prefersDarkTheme())
  }
}

async function renderSvg(code: string): Promise<string> {
  try {
    const mod = await import('mermaid')
    const mermaid = mod.default
    const dark = prefersDarkTheme()
    applyMermaidTheme(mermaid, dark)
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

  const dark = prefersDarkTheme()
  const sel = state.selection
  const items = []
  for (const b of findMermaidBlocks(state.doc)) {
    // 光标进块就退回源码，否则没法改
    const touched = sel.ranges.some((r) => r.to >= b.from && r.from <= b.to)
    if (touched) continue
    const svg = cache.get(cacheKey(b.code, dark))
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
  const dark = prefersDarkTheme()
  let changed = false

  for (const b of blocks) {
    // 缓存键带明暗档：换主题后旧图不会被当成"已经有了"而跳过重渲染
    const key = cacheKey(b.code, dark)
    if (cache.has(key) || inFlight.has(key)) continue
    inFlight.add(key)
    const svg = await renderSvg(b.code)
    inFlight.delete(key)
    cache.set(key, svg)
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

/**
 * 主题换了之后让所有图重渲染。
 *
 * 缓存的 SVG 把颜色烤进了 `fill` / `stroke`，主题的 `.jd-mermaid` 规则改不了
 * 图内部，所以必须整批丢掉重画。这个函数做两件事：
 *   1. 清缓存（否则 scanAndRender 会认为"已经有了"而跳过）
 *   2. 拿到 view 就立刻重新扫一遍（不等用户打字触发那 500ms 防抖）
 *
 * 只重画装饰，不动文档、不动选区 —— 滚动位置不会跳。
 */
export function invalidateMermaidCache(view?: EditorView): void {
  cache.clear()
  if (view && view.dom.isConnected) {
    void scanAndRender(view)
  }
}

export const mermaidExtensions = [mermaidDecoField, mermaidScanPlugin]
