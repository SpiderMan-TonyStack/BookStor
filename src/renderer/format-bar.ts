/**
 * 右键格式条 —— 选中文本后右键，就地改样式（对标 Typora / 常见笔记软件的浮动工具栏）。
 *
 * 三条设计约束：
 *
 * ① **不复刻任何格式化逻辑**。每个按钮最终都调 `runCommand(cmd)` —— 和菜单、
 *    快捷键面板走的是同一条路径。在这里再写一套 `wrapSelection` 的调用，
 *    迟早出现「菜单能加粗、右键不能」这种分叉。
 *
 * ② **点按钮不能丢选区**。按钮的 `mousedown` 一律 `preventDefault()`：
 *    否则焦点离开编辑器，CM6 的选区虽然还在 state 里，但视觉上高亮消失，
 *    用户会以为选区没了。命令内部各自动 `view.focus()` 把焦点还回来。
 *
 * ③ **位置要夹在视口内**。右键点靠近右下角时，按原始坐标弹会顶出屏幕外，
 *    所以先渲染再量尺寸，然后 clamp。滚动/缩放一律关掉 —— 条子是 fixed 定位，
 *    内容一滚动它就和文字错位了。
 */

import type { EditorView } from '@codemirror/view'

/** 一条按钮：命令（走 runCommand）、剪贴板动作，或对图片的定位操作 */
interface BarItem {
  label: string
  title: string
  cmd?: string
  act?: 'cut' | 'copy' | 'paste' | 'reveal' | 'delete-image'
  /** 按钮文字自身的样式（B 要粗、I 要斜、U 要下划线…），写成内联样式 */
  style?: string
  /** reveal 用：图片的本地绝对路径（网络图 / 内联图为空） */
  abs?: string
  /** delete-image 用：要删掉的 `![](…)` 语法区间 */
  range?: { from: number; to: number }
}

/** 按组分，组间画一条竖线 —— 和菜单里的 separator 是同一个意思 */
const GROUPS: BarItem[][] = [
  [
    { label: '剪切', title: '剪切', act: 'cut' },
    { label: '复制', title: '复制', act: 'copy' },
    { label: '粘贴', title: '粘贴', act: 'paste' },
  ],
  [
    { label: 'B', title: '加粗 (Ctrl+B)', cmd: 'bold', style: 'font-weight:700' },
    // 斜体 I 必须给衬线字体：雅黑这类无衬线字体下的斜体大写 I 就是一根斜线，
    // 和 `/` 分不出来（实测截图里 B 和 U 之间看着就是个斜杠）。
    {
      label: 'I',
      title: '斜体 (Ctrl+I)',
      cmd: 'italic',
      style: 'font-family:Georgia,"Times New Roman",serif;font-style:italic;font-weight:600;font-size:13px',
    },
    { label: 'U', title: '下划线 (Ctrl+U)', cmd: 'underline', style: 'text-decoration:underline' },
    {
      label: 'S',
      title: '删除线 (Alt+Shift+5)',
      cmd: 'strikethrough',
      style: 'text-decoration:line-through',
    },
    { label: '高亮', title: '高亮', cmd: 'highlight' },
    { label: '</>', title: '行内代码 (Ctrl+Shift+`)', cmd: 'code', style: 'font-family:var(--jd-font-mono, Consolas, monospace);font-size:11px' },
  ],
  [
    { label: '注释', title: '注释 (Ctrl+Alt+/)', cmd: 'comment' },
    { label: '链接', title: '超链接 (Ctrl+K)', cmd: 'link' },
  ],
  [{ label: '清除', title: '清除样式 (Ctrl+\\)', cmd: 'clear-format' }],
]

/**
 * 右键图片时的条子。和文字格式条共用一个容器和一套样式 —— 只是内容不同。
 *
 * 为什么要有「删除图片」这一项：图片是 widget，点它的时候 CM6 只能按坐标猜一个
 * 位置，右键又根本不动光标 —— 用户按 Delete 删掉的是**原来的光标处**，
 * 看起来就是「图片怎么都删不掉」，实际删掉了别处的字（2026-11-11 实测复现）。
 *
 * 删除只移除 markdown 里的引用，不动磁盘上的图片文件：文件可能被别的笔记引用，
 * 而且误删文件不可恢复。
 */
function imageGroups(abs: string, range: { from: number; to: number } | null): BarItem[][] {
  const items: BarItem[] = [
    {
      label: '打开图片所在位置',
      title: abs ? '在资源管理器里定位这张图' : '这张图没有本地文件（网络图片或内联图片）',
      act: 'reveal',
      abs,
    },
  ]
  if (range) {
    items.push({
      label: '删除图片',
      title: '从笔记里删掉这张图的引用（磁盘上的图片文件保留）',
      act: 'delete-image',
      range,
    })
  }
  return [items]
}

export interface FormatBarDeps {
  /** 当前编辑器视图；没有打开的笔记时返回 null */
  getView: () => EditorView | null
  /** 执行命令 —— 由 main.ts 注入 runCommand，避免循环依赖 */
  run: (cmd: string) => void
  /** 一句话提示（定位失败等），由 main.ts 注入 setMetaStatus */
  notify: (msg: string) => void
}

let deps: FormatBarDeps | null = null
let bar: HTMLElement | null = null

export function installFormatBar(d: FormatBarDeps): void {
  deps = d
  // capture 阶段接管：编辑器内部任何位置右键都归我们处理（含表格 widget）
  document.addEventListener('contextmenu', onContextMenu, true)
  // window 级：点空白处 / 按 Esc / 滚动 / 改窗口大小都要收起来
  window.addEventListener('mousedown', onWindowMouseDown, true)
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Escape' && isOpen()) {
        e.preventDefault()
        e.stopPropagation()
        hide()
      }
    },
    true
  )
  window.addEventListener('scroll', () => hide(), true)
  window.addEventListener('resize', () => hide())
}

function isOpen(): boolean {
  return !!bar && !bar.classList.contains('hidden')
}

function onWindowMouseDown(e: MouseEvent): void {
  if (!isOpen()) return
  if (bar && e.target instanceof Node && bar.contains(e.target)) return
  hide()
}

function onContextMenu(e: MouseEvent): void {
  const target = e.target as HTMLElement | null
  // 只管编辑器正文区域；侧栏、状态栏、弹窗里保持浏览器/系统默认行为
  if (!target || !target.closest('#write')) return
  if (!deps?.getView()) return
  e.preventDefault()

  // 图片有自己的一条菜单（打开所在位置）。图片是 widget，点它的时候
  // 选区往往是空的，弹文字格式条全是灰按钮，等于什么都不能做。
  const box = target.closest<HTMLElement>('.jd-img-box')
  if (box) {
    const from = Number(box.dataset['jdFrom'])
    const to = Number(box.dataset['jdTo'])
    const range = Number.isFinite(from) && Number.isFinite(to) && to > from ? { from, to } : null
    show(e.clientX, e.clientY, imageGroups(box.dataset['jdAbs'] ?? '', range))
    return
  }
  show(e.clientX, e.clientY, GROUPS)
}

function show(x: number, y: number, groups: BarItem[][] = GROUPS): void {
  const el = ensureBar()
  renderBar(groups)
  el.classList.remove('hidden')
  refreshDisabled()
  // 先放一个临时位置量尺寸，再夹到视口内 —— 否则靠右下角右键时会弹到屏幕外
  el.style.left = '0px'
  el.style.top = '0px'
  const rect = el.getBoundingClientRect()
  const pad = 8
  const left = Math.min(Math.max(pad, x), Math.max(pad, window.innerWidth - rect.width - pad))
  const top = Math.min(Math.max(pad, y), Math.max(pad, window.innerHeight - rect.height - pad))
  el.style.left = `${left}px`
  el.style.top = `${top}px`
}

function hide(): void {
  if (bar) bar.classList.add('hidden')
}

/** 没有选区时剪切/复制无意义 —— 置灰而不是隐藏，避免条子宽度来回跳 */
function refreshDisabled(): void {
  const view = deps?.getView()
  const empty = !view || view.state.selection.main.empty
  bar?.querySelectorAll<HTMLButtonElement>('[data-act="cut"],[data-act="copy"]').forEach((b) => {
    b.disabled = empty
  })
  // 没有打开的笔记：粘贴也没地方落
  bar?.querySelectorAll<HTMLButtonElement>('[data-act="paste"]').forEach((b) => {
    b.disabled = !view
  })
  // 网络图片 / 内联图片没有本地文件可定位
  bar?.querySelectorAll<HTMLButtonElement>('[data-act="reveal"]').forEach((b) => {
    b.disabled = !b.dataset['abs']
  })
}

function ensureBar(): HTMLElement {
  if (bar) return bar
  const el = document.createElement('div')
  el.id = 'jd-fmtbar'
  el.className = 'hidden'
  el.setAttribute('role', 'toolbar')
  el.setAttribute('aria-label', '格式')

  // 保住编辑器选区：不 preventDefault 的话焦点会移到按钮上，高亮消失
  el.addEventListener('mousedown', (e) => e.preventDefault())
  // 事件委托：内容是每次右键重建的，不能把监听挂在按钮上
  el.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.jd-fmtbar-btn')
    if (!btn || btn.disabled) return
    void runItem(btn.dataset['cmd'], btn.dataset['act'] as BarItem['act'], btn.dataset)
  })

  document.body.append(el)
  bar = el
  return el
}

/**
 * 按当前场景重建按钮。
 *
 * 不做成"建一次、按场景显示/隐藏两组"是有意的：显隐两组会留下两套并行状态，
 * 以后加第三种右键场景（表格、链接…）就要维护更多组合；重建的成本只是十几个 DOM 节点。
 */
function renderBar(groups: BarItem[][]): void {
  const el = ensureBar()
  el.textContent = ''
  groups.forEach((group, gi) => {
    if (gi > 0) {
      const sep = document.createElement('span')
      sep.className = 'jd-fmtbar-sep'
      el.append(sep)
    }
    for (const item of group) {
      const btn = document.createElement('button')
      btn.className = 'jd-fmtbar-btn'
      btn.textContent = item.label
      btn.title = item.title
      if (item.style) btn.setAttribute('style', item.style)
      if (item.act) btn.dataset['act'] = item.act
      if (item.cmd) btn.dataset['cmd'] = item.cmd
      if (item.abs) btn.dataset['abs'] = item.abs
      if (item.range) {
        btn.dataset['from'] = String(item.range.from)
        btn.dataset['to'] = String(item.range.to)
      }
      el.append(btn)
    }
  })
}

async function runItem(
  cmd?: string,
  act?: BarItem['act'],
  data?: DOMStringMap
): Promise<void> {
  // 定位图片不依赖编辑器视图（光标可能在别处），所以放在最前面
  if (act === 'reveal') {
    hide()
    const abs = data?.['abs']
    if (!abs) return
    try {
      const err = await window.api.revealImage(abs)
      if (err) deps?.notify(err)
    } catch (e) {
      deps?.notify(`打不开图片位置：${(e as Error).message}`)
    }
    return
  }

  if (act === 'delete-image') {
    hide()
    const view = deps?.getView()
    const from = Number(data?.['from'])
    const to = Number(data?.['to'])
    if (!view || !Number.isFinite(from) || !Number.isFinite(to) || to <= from) return
    // 只删引用，不动磁盘文件
    view.dispatch({
      changes: { from, to, insert: '' },
      selection: { anchor: from },
      scrollIntoView: true,
    })
    view.focus()
    return
  }

  const view = deps?.getView()
  if (!view) return

  // 格式化命令：交给 runCommand，和菜单完全同一条路径
  if (cmd) {
    hide()
    deps!.run(cmd)
    return
  }

  const sel = view.state.selection.main
  const selected = view.state.sliceDoc(sel.from, sel.to)

  if (act === 'copy') {
    if (selected) await window.api.writeClipboard(selected)
    hide()
    return
  }

  if (act === 'cut') {
    if (!selected) return
    await window.api.writeClipboard(selected)
    view.dispatch({ changes: { from: sel.from, to: sel.to, insert: '' } })
    view.focus()
    hide()
    return
  }

  if (act === 'paste') {
    const text = await window.api.readClipboard()
    if (text) {
      view.dispatch({
        changes: { from: sel.from, to: sel.to, insert: text },
        selection: { anchor: sel.from + text.length },
        scrollIntoView: true,
      })
    }
    view.focus()
    hide()
  }
}
