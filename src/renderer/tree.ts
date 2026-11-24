import type { FileNode } from '../shared/types.js'
import type { HitNode } from './file-ops.js'

export interface TreeOptions {
  root: FileNode[]
  activePath: string
  onOpen: (path: string) => void
  /** 展开目录时按需拉取这一层（拿不到就返回空数组） */
  loadChildren?: (path: string) => Promise<FileNode[]>
  /** 右键：`node === null` 表示点在空白处（= 对笔记库根目录操作） */
  onContext?: (node: HitNode | null, x: number, y: number) => void
  /** 笔记库根（拖到空白处 = 移到根目录） */
  rootPath?: string
  /** 拖动放下：把 srcPath 移到 targetDir 里 */
  onMove?: (srcPath: string, targetDir: string) => void | Promise<void>
}

/**
 * 展开状态按路径记（模块级，重渲染时保留）。
 *
 * **默认全部收起**（4.6.0，用户要求「每次打开文件目录都收起」）：只露顶层，
 * 要哪个目录点哪个。不做持久化 —— 要的就是每次启动都收起来。
 *
 * 收起时子节点**根本不建 DOM**（不是 `display:none`）：245 篇的库启动时只画十几行，
 * 建树从 ~35ms 掉到 1ms 级，滚动容器也不会被几百个隐藏行撑出假高度。
 */
const expanded = new Set<string>()

/** 当前活动笔记路径：懒加载出来的子节点也要能带上高亮 */
let activePath = ''

/**
 * 路径比较：正斜杠写法与 Windows 原生分隔符写法指向同一个文件。
 *
 * 树的 title 来自主进程的 `path.join`（反斜杠），而 config 里的 lastFile 是正斜杠 ——
 * 直接 `===` 会让「启动时打开的那篇」在树里**不高亮**，只有在树里点开的才高亮。
 */
function samePath(a: string, b: string): boolean {
  if (!a || !b) return false
  const norm = (p: string): string => p.split('\\').join('/').toLowerCase()
  return norm(a) === norm(b)
}

/**
 * 文件夹 / 文件图标（单色 SVG，颜色由 CSS 按 `data-node-dir` 决定）。
 *
 * 4.9.1 起两者在**形状上刻意不同**（不只是"都画成同一种灰"）：
 *   - 文件夹 = **实心两片**（上面一条"盖"，下面主体，透明度 0.5/1 形成层次），
 *     填充 accent 青、14px —— 像资源管理器里那个"容器"；
 *   - 文件 = **细线描边**（空心），中性灰、12px —— 像一页"内容"。
 * 深色背景下 13px 的尺寸里，光靠轮廓细节分不出这两种，必须靠"实心 vs 空心"。
 */
const ICON_FOLDER =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  // 标准文件夹轮廓（左上带一个斜切的"标签"）。14px 下双色分层会糊成一团，
  // 所以这里是**单色实心**：靠"实心 vs 空心"和文件区分，形状本身就能读成文件夹。
  '<path d="M1.4 4.1c0-.44.36-.8.8-.8h3.05c.27 0 .52.13.68.35l.84 1.1h6.03c.44 0 .8.36.8.8v6.95c0 .44-.36.8-.8.8H2.2a.8.8 0 0 1-.8-.8V4.1z"/>' +
  '</svg>'
const ICON_FILE =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="M4.3 2h4.5l3 3v9c0 .33-.27.6-.6.6H4.3a.6.6 0 0 1-.6-.6V2.6c0-.33.27-.6.6-.6z"/>' +
  '<path d="M8.8 2v3.1h3.1"/>' +
  '</svg>'


export function renderTree(container: HTMLElement, opts: TreeOptions): void {
  activePath = opts.activePath
  bindContextMenu(container, opts)
  bindDrag(container, opts)
  container.textContent = ''

  if (opts.root.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'jd-node'
    empty.style.opacity = '0.5'
    empty.style.cursor = 'default'
    empty.textContent = '（没有找到 .md 文件）'
    container.append(empty)
    return
  }

  const frag = document.createDocumentFragment()
  for (const node of opts.root) frag.append(buildNode(node, 0, opts))
  container.append(frag)
}

function buildNode(node: FileNode, depth: number, opts: TreeOptions): HTMLElement {
  const row = document.createElement('div')
  row.className = 'jd-node'
  if (!node.isDir && samePath(node.path, activePath)) row.classList.add('is-active')
  // 每层 20px：14px 时父子缩进差太小，看着像同一级（Rider 侧栏的层级感更明显）
  // 每级 16px、基准 12px：Typora 文件树量出来是「三角 x=17 / 图标 x=25 / 文字 x=42」，
  // 我们的行是 flex（三角+图标+文字），基准 12 正好落在这三个位置上（原先是 8 + depth*20）
  row.style.paddingLeft = `${12 + depth * 16}px`
  row.title = node.path
  // 右键菜单靠这三个字段还原「点到了哪个节点」—— 从 DOM 反查比给每一行挂闭包省内存，
  // 而且重画之后不会留下指向旧节点的监听器
  row.dataset['nodePath'] = node.path
  row.dataset['nodeName'] = node.name
  row.dataset['nodeDir'] = node.isDir ? '1' : '0'

  const caret = document.createElement('span')
  caret.className = 'jd-caret'
  const isOpen = node.isDir && expanded.has(node.path)
  if (node.isDir) {
    caret.textContent = '▼'
    // 收起时把三角转 -90°（CSS 的 .collapsed）→ 看着是 ▶，视觉上就是「点开」的暗示
    if (!isOpen) caret.classList.add('collapsed')
  } else {
    // 文件行也放一个同宽的占位：否则文件图标比文件夹图标左移 18px，
    // 视觉上「文件比它的父文件夹还靠左」，层级感直接没了。
    caret.textContent = ''
  }
  row.append(caret)

  const icon = document.createElement('span')
  icon.className = 'jd-icon'
  // 单色 SVG，颜色由 CSS 的 currentColor 决定（见 ICON_FOLDER 的注释）
  icon.innerHTML = node.isDir ? ICON_FOLDER : ICON_FILE
  row.append(icon)

  const name = document.createElement('span')
  name.className = 'jd-node-name'
  name.textContent = node.name.replace(/\.md$/i, '')
  row.append(name)

  attachDragSource(row, node, opts)

  const wrap = document.createElement('div')

  if (node.isDir) {
    const children = document.createElement('div')
    children.className = 'jd-children'
    // 缩进引导线的横坐标（父行图标左侧一点）。depth 只有这里知道，
    // 所以由 JS 算好交给 CSS 的 `--jd-guide`，见 style.css 的 .jd-children::before
    children.style.setProperty('--jd-guide', `${24 + depth * 16}px`)
    if (!isOpen) children.classList.add('hidden')
    // 刷新时仍处于展开状态的目录：内存里已有子节点就直接重建，
    // 没有的（这份数据来自 listDir，本来就不带 children）就再要一次
    if (isOpen) {
      if (node.children) fill(children, node, depth, opts)
      else void fillAsync(children, node, depth, opts, caret)
    }
    wrap.append(row, children)

    row.addEventListener('click', () => {
      const nowCollapsed = expanded.has(node.path)
      if (nowCollapsed) {
        expanded.delete(node.path)
        children.classList.add('hidden')
        caret.classList.add('collapsed')
      } else {
        expanded.add(node.path)
        children.classList.remove('hidden')
        caret.classList.remove('collapsed')
        // 第一次展开才去读盘（`children === undefined` = 还没读过）
        if (!children.childElementCount) void fillAsync(children, node, depth, opts, caret)
      }
    })
  } else {
    wrap.append(row)
    row.addEventListener('click', () => opts.onOpen(node.path))
  }

  return wrap
}

/** 用已经拿到的数据填子节点（同步） */
function fill(container: HTMLElement, node: FileNode, depth: number, opts: TreeOptions): void {
  const frag = document.createDocumentFragment()
  for (const child of node.children ?? []) frag.append(buildNode(child, depth + 1, opts))
  container.append(frag)
}

/**
 * 第一次展开：按需拉这一层。
 *
 * 拉回来之后把结果写回 `node.children` —— 收起来再展开就不用再读盘（`children === []`
 * 表示"读过、是空的"，与 `undefined` 的"还没读过"区分开）。
 * 空目录把折角藏掉：否则用户会对着一个永远展不开的三角反复点。
 */
async function fillAsync(
  container: HTMLElement,
  node: FileNode,
  depth: number,
  opts: TreeOptions,
  caret: HTMLElement
): Promise<void> {
  if (node.children) {
    fill(container, node, depth, opts)
    if (node.children.length === 0) caret.style.visibility = 'hidden'
    return
  }
  const load = opts.loadChildren
  if (!load) return
  let kids: FileNode[] = []
  try {
    kids = await load(node.path)
  } catch {
    /* 目录被删/被拔盘：当成空目录，别抛到控制台 */
  }
  node.children = kids
  // 等待期间可能又点了收起 —— 照填不误，容器是隐藏的，下次展开直接可见
  fill(container, node, depth, opts)
  if (kids.length === 0) caret.style.visibility = 'hidden'
}

/** 供编辑器保存后刷新高亮 */
export function setActive(container: HTMLElement, path: string): void {
  activePath = path
  for (const el of container.querySelectorAll('.jd-node.is-active')) el.classList.remove('is-active')
  for (const el of container.querySelectorAll<HTMLElement>('.jd-node')) {
    if (samePath(el.title, path)) {
      el.classList.add('is-active')
      break
    }
  }
}

/**
 * 目录被重命名后，把「展开状态」也搬到新路径上。
 *
 * 不搬的后果：重命名目录后树重画，`expanded` 里还存着旧路径 → 那个目录变回
 * 收起状态 → 正在编辑的笔记（在新路径下）压根不在 DOM 里，`is-active` 无处可挂，
 * 表现是「刚重命名完，树里找不到我正在写的那篇」。
 *
 * 对文件路径调用是空操作（`expanded` 里只有目录），所以调用方不必先判断类型。
 */
export function renameExpanded(oldPath: string, newPath: string): void {
  if (expanded.size === 0) return
  const oldNorm = oldPath.replace(/\\/g, '/').toLowerCase()
  const next = new Set<string>()
  for (const p of expanded) {
    if (samePath(p, oldPath)) {
      next.add(newPath)
      continue
    }
    const norm = p.replace(/\\/g, '/').toLowerCase()
    if (norm.startsWith(`${oldNorm}/`)) next.add(newPath + p.slice(oldPath.length))
    else next.add(p)
  }
  expanded.clear()
  for (const p of next) expanded.add(p)
}

// ------------------------------------------------------------------ 拖拽移动

/** 正在拖的节点（null = 没在拖）。全局一份就够：同一时刻只可能拖一个 */
let dragSrc: { path: string; isDir: boolean } | null = null
/** 当前高亮的放置目标行 */
let dropRow: HTMLElement | null = null

/** 每个容器「最新的」拖拽回调（监听器只绑一次） */
const dragOpts = new WeakMap<HTMLElement, Pick<TreeOptions, 'onMove' | 'rootPath'>>()
const dragBound = new WeakSet<HTMLElement>()

/** 取父目录（正反斜杠都认） */
function dirOf(p: string): string {
  const i = p.replace(/\\/g, '/').lastIndexOf('/')
  return i < 0 ? p : p.slice(0, i)
}

/** 路径归一成小写正斜杠，只用于前缀比较 */
function normForCompare(p: string): string {
  return p.replace(/\\/g, '/').toLowerCase()
}

/** 行作为拖拽源 */
function attachDragSource(
  row: HTMLElement,
  node: { path: string; isDir: boolean },
  opts: Pick<TreeOptions, 'onMove'>
): void {
  row.draggable = true
  row.addEventListener('dragstart', (ev) => {
    if (!opts.onMove) {
      // 没开移动能力时不许拖：半吊子的"能拖但放不下"比不能拖更糟
      ev.preventDefault()
      return
    }
    dragSrc = { path: node.path, isDir: node.isDir }
    row.classList.add('is-dragging')
    const dt = ev.dataTransfer
    if (dt) {
      dt.effectAllowed = 'move'
      // ⚠ 只放纯文本。**绝不能 setData('Files', ...)** —— 那会让 Electron 把这次拖拽
      // 当成"拖出一个真实文件"，拖到资源管理器窗口就绕过我们的校验直接移动/复制文件。
      dt.setData('text/plain', node.path)
    }
  })
  row.addEventListener('dragend', () => {
    dragSrc = null
    clearDragStyles()
  })
}

/** 这次拖拽能不能放到 target 上？能就返回目标目录，不能返回 null */
function resolveDropDir(target: EventTarget | null, rootPath: string): string | null {
  const src = dragSrc
  if (!src) return null
  const el = target instanceof Element ? target.closest<HTMLElement>('.jd-node') : null
  const p = el?.dataset['nodePath']
  // 空白处 → 库根（把文件拖到树下面那片空地方 = 移回根目录）
  if (!p) return rootPath
  if (samePath(p, src.path)) return null

  if (el?.dataset['nodeDir'] === '1') {
    // 不能把目录拖进它自己或它的子孙里（会得到一个打不开的环）
    const srcNorm = normForCompare(src.path)
    if (normForCompare(p).startsWith(`${srcNorm}/`)) return null
    return p
  }
  // 拖到文件上 = 放到那个文件所在的目录（和资源管理器的行为一致）
  return dirOf(p)
}

let hoverExpandTimer: number | null = null
let hoverExpandPath = ''

/**
 * 拖到**收起的目录**上停 0.7 秒 → 自动展开。
 *
 * 没有这一步，想拖进一个收起的目录就必须先松手、再点开、再拖一次 ——
 * 资源管理器和 Typora 都会自动展开，用户的手指会按那个节奏来。
 * 定时器按路径去重：同一次 dragover 每秒能触发几十次，不去重会不断重启计时。
 */
function scheduleHoverExpand(row: HTMLElement | null): void {
  const p = row?.dataset['nodePath'] ?? ''
  const isDir = row?.dataset['nodeDir'] === '1'
  const collapsed = !!row?.querySelector('.jd-caret.collapsed')
  if (!row || !p || !isDir || !collapsed) {
    cancelHoverExpand()
    return
  }
  if (hoverExpandPath === p) return
  cancelHoverExpand()
  hoverExpandPath = p
  hoverExpandTimer = window.setTimeout(() => {
    hoverExpandTimer = null
    hoverExpandPath = ''
    row.click()
  }, 700)
}

function cancelHoverExpand(): void {
  if (hoverExpandTimer !== null) {
    window.clearTimeout(hoverExpandTimer)
    hoverExpandTimer = null
  }
  hoverExpandPath = ''
}

/** 高亮放置目标（同一时刻只亮一行） */
function markDropTarget(target: EventTarget | null): void {
  const el = target instanceof Element ? target.closest<HTMLElement>('.jd-node') : null
  const next = el && el.dataset['nodePath'] ? el : null
  if (next === dropRow) return
  dropRow?.classList.remove('is-drop-target')
  dropRow = next
  dropRow?.classList.add('is-drop-target')
  scheduleHoverExpand(dropRow)
}

function clearDragStyles(): void {
  cancelHoverExpand()
  dropRow?.classList.remove('is-drop-target')
  dropRow = null
  for (const el of document.querySelectorAll('.jd-node.is-dragging')) el.classList.remove('is-dragging')
}

/** 拖到容器上下边缘时自动滚动（dragover 会持续触发，所以每次挪一点就够） */
function autoScroll(container: HTMLElement, clientY: number): void {
  const r = container.getBoundingClientRect()
  const edge = 26
  if (clientY < r.top + edge) container.scrollTop -= 14
  else if (clientY > r.bottom - edge) container.scrollTop += 14
}

/**
 * 拖拽的「放置」侧绑在**容器**上（和右键一样：行会随展开/收起重建）。
 *
 * 用 HTML5 原生拖拽而不是自己跟 mousedown/mousemove：系统的拖影与光标形状
 * 是免费得到的，而且 `dragover` 必须 `preventDefault()` 才允许 drop ——
 * 这个机制天然能表达「这里不能放」（不放行就是禁止符号）。
 */
function bindDrag(container: HTMLElement, opts: Pick<TreeOptions, 'onMove' | 'rootPath'>): void {
  dragOpts.set(container, opts)
  if (dragBound.has(container)) return
  dragBound.add(container)

  container.addEventListener('dragover', (ev) => {
    const o = dragOpts.get(container)
    if (!dragSrc || !o?.onMove || !o.rootPath) return
    const dir = resolveDropDir(ev.target, o.rootPath)
    if (!dir) return
    ev.preventDefault()
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'move'
    markDropTarget(ev.target)
    autoScroll(container, ev.clientY)
  })

  container.addEventListener('dragleave', (ev) => {
    const to = ev.relatedTarget
    if (to instanceof Node && container.contains(to)) return
    cancelHoverExpand()
    dropRow?.classList.remove('is-drop-target')
    dropRow = null
  })

  container.addEventListener('drop', (ev) => {
    const o = dragOpts.get(container)
    const src = dragSrc
    const dir = o?.rootPath ? resolveDropDir(ev.target, o.rootPath) : null
    clearDragStyles()
    dragSrc = null
    if (!o?.onMove || !src || !dir) return
    ev.preventDefault()
    void Promise.resolve(o.onMove(src.path, dir))
  })
}

// ------------------------------------------------------------------ 右键

/** 每个容器「最新的」回调（重画时换 opts，但监听器只绑一次） */
const ctxOpts = new WeakMap<HTMLElement, Pick<TreeOptions, 'onContext'>>()
const ctxBound = new WeakSet<HTMLElement>()

/**
 * 右键监听绑在**容器**上，靠 `closest('.jd-node')` 反查点到了哪一行。
 *
 * 为什么不逐行 `addEventListener`：行会随展开/收起重建（`textContent = ''`），
 * 逐行绑要在每次重建时重挂一遍；绑在容器上只绑一次，行里靠 dataset 带路径。
 * 空白处点右键 → `node = null`（= 对笔记库根目录操作），这是菜单里
 * 「新建文件 / 打开文件位置」在空白处也能用的前提。
 */
function bindContextMenu(container: HTMLElement, opts: Pick<TreeOptions, 'onContext'>): void {
  ctxOpts.set(container, opts)
  if (ctxBound.has(container)) return
  ctxBound.add(container)
  container.addEventListener('contextmenu', (ev) => {
    const o = ctxOpts.get(container)
    if (!o?.onContext) return
    ev.preventDefault()
    const row = (ev.target as HTMLElement | null)?.closest<HTMLElement>('.jd-node')
    const p = row?.dataset['nodePath']
    if (row && p) {
      o.onContext(
        { path: p, name: row.dataset['nodeName'] ?? '', isDir: row.dataset['nodeDir'] === '1' },
        ev.clientX,
        ev.clientY
      )
    } else {
      o.onContext(null, ev.clientX, ev.clientY)
    }
  })
}

// ------------------------------------------------------------------ 文档列表（扁平）

export interface FlatListOptions {
  root: string
  activePath: string
  onOpen: (path: string) => void
  onContext?: (node: HitNode | null, x: number, y: number) => void
  /** 拖动放下（列表里没有目录行，只能"拖到空白 = 移回库根"） */
  onMove?: (srcPath: string, targetDir: string) => void | Promise<void>
}

/**
 * 「文档列表」视图：把库里的笔记**平铺**成一行一个（不显示目录层级）。
 *
 * 与「文档树」的区别只在展示方式：树适合按目录翻，列表适合「我知道文件名、
 * 想从头扫一遍」。Typora 的文件面板也有这两个视图，菜单里带勾切换。
 *
 * 每行末尾用灰字补一段**相对目录**：平铺之后同名文件（很多目录都有
 * `概述.md`）光看文件名分不出来，没这段就会点错。
 */
export function renderFlatList(
  container: HTMLElement,
  files: FileNode[],
  opts: FlatListOptions
): void {
  activePath = opts.activePath
  bindContextMenu(container, opts)
  bindDrag(container, { onMove: opts.onMove, rootPath: opts.root })
  container.textContent = ''

  if (files.length === 0) {
    const empty = document.createElement('div')
    empty.className = 'jd-node'
    empty.style.opacity = '0.5'
    empty.style.cursor = 'default'
    empty.textContent = '（没有匹配的笔记）'
    container.append(empty)
    return
  }

  const rootNorm = opts.root.replace(/\\/g, '/').replace(/\/+$/, '')
  const frag = document.createDocumentFragment()
  for (const node of files) {
    const row = document.createElement('div')
    row.className = 'jd-node jd-flat'
    if (samePath(node.path, activePath)) row.classList.add('is-active')
    row.style.paddingLeft = '12px'
    row.title = node.path
    row.dataset['nodePath'] = node.path
    row.dataset['nodeName'] = node.name
    row.dataset['nodeDir'] = '0'

    // 列表里没有折角，留一个同宽占位，图标才能和树视图对齐
    const caret = document.createElement('span')
    caret.className = 'jd-caret'
    caret.textContent = ''
    row.append(caret)

    const icon = document.createElement('span')
    icon.className = 'jd-icon'
    icon.innerHTML = ICON_FILE
    row.append(icon)

    const name = document.createElement('span')
    name.className = 'jd-node-name'
    name.textContent = node.name.replace(/\.md$/i, '')
    row.append(name)

    // 相对目录：`D:/笔记/子目录/x.md` → `子目录`
    const full = node.path.replace(/\\/g, '/')
    const rel = full.startsWith(`${rootNorm}/`) ? full.slice(rootNorm.length + 1) : full
    const dirPart = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : ''
    if (dirPart) {
      const where = document.createElement('span')
      where.className = 'jd-flat-dir'
      where.textContent = dirPart
      row.append(where)
    }

    attachDragSource(row, node, opts)
    row.addEventListener('click', () => opts.onOpen(node.path))
    frag.append(row)
  }
  container.append(frag)
}
