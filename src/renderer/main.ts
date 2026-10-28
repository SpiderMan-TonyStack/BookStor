import type { FileNode, NoteDoc } from '../shared/types.js'
import { renderTree, setActive } from './tree.js'
import { createEditor, insertAtCursor, wrapSelection, setHeading, openSearch, insertCodeBlock, type EditorHandle } from './editor.js'
import {
  applyTheme,
  reloadTheme,
  currentThemeReport,
  currentThemeCss,
  BUILTIN_DARK,
} from './theme.js'
import { computeOutline, renderOutline, highlightOutline, jumpTo, type OutlineItem } from './outline.js'
import { openSettings } from './settings.js'
import { installKeybindings } from './keybindings.js'
import { countWords } from './text-stats.js'
import { setSourceMode } from './viewmode.js'
import { installTablePanel } from './table-panel.js'
import { openThemeReport } from './theme-report.js'
import { markdownToHtml } from './markdown-html.js'

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`缺元素 #${id}`)
  return el as T
}

const elTree = $('jd-tree')
const elLibName = $('jd-lib-name')
const elOpenLib = $('jd-open-lib')
const elTheme = $<HTMLSelectElement>('jd-theme')
const elEditorHost = $('jd-editor')
const elEmpty = $('jd-empty')
const elStatusPath = $('jd-status-path')
const elStatusSave = $('jd-status-save')
const elStatusMeta = $('jd-status-meta')
const elStatusCount = $('jd-status-count')
const elRecover = $('jd-recover')
const elRecoverText = $('jd-recover-text')
const elRecoverYes = $<HTMLButtonElement>('jd-recover-yes')
const elRecoverNo = $<HTMLButtonElement>('jd-recover-no')
const elSidebar = $('jd-sidebar')
const elSidebarResize = $('jd-sidebar-resize')
const elOutlineWrap = $('jd-outline-wrap')
const elOutline = $('jd-outline')
const elTabFiles = $('jd-tab-files')
const elTabOutline = $('jd-tab-outline')
const elWrite = $('write')

// ------------------------------------------------------------------ 状态

let libRoot = ''
let current: NoteDoc | null = null
let dirty = false
let saving = false
let saveTimer: number | null = null
let editor: EditorHandle | null = null
let draftTimer: number | null = null
let outlineItems: OutlineItem[] = []
let outlineTimer: number | null = null
let statsTimer: number | null = null
let tablePanel: { refresh: () => void } | null = null
/** 视图模式（只在本次会话有效，不写 config） */
let focusMode = false
let typewriterMode = false
/**
 * 源码模式。这里存一份是为了**换笔记后能恢复** ——
 * `setDoc` 走的是 `EditorState.create`，field 会重建成默认值 false，
 * 不补一次的话，翻下一篇就悄悄退回渲染模式了。
 */
let sourceMode = false

/**
 * dirty 的唯一写入口。
 * 顺手把状态推给主进程 —— 关窗拦截靠它，不能只留在渲染层。
 */
function setDirty(value: boolean): void {
  dirty = value
  window.api.setDirty(value)
}

const setSaveStatus = (text: string, cls = ''): void => {
  elStatusSave.textContent = text
  elStatusSave.className = cls
}

const setMetaStatus = (text: string): void => {
  elStatusMeta.textContent = text
}

// ------------------------------------------------------------------ 字数统计

function renderWordCount(): void {
  if (!editor || !current) {
    elStatusCount.textContent = ''
    return
  }
  const { chars, words } = countWords(editor.getDoc())
  elStatusCount.textContent = `${words.toLocaleString('zh-CN')} 字`
  elStatusCount.title = `${words.toLocaleString('zh-CN')} 字 · ${chars.toLocaleString('zh-CN')} 个字符`
}

/** 300ms 防抖：每敲一个字都遍历全文不值当，字数晚半拍也没人会察觉 */
function scheduleWordCount(): void {
  if (statsTimer !== null) window.clearTimeout(statsTimer)
  statsTimer = window.setTimeout(() => {
    statsTimer = null
    renderWordCount()
  }, 300)
}

// ------------------------------------------------------------------ 专注 / 打字机

/**
 * 两个模式都只改「怎么看」，不动文档一个字节。
 *
 * 专注模式里非当前段落的行淡出。`.jd-active` 由 lineclasses.ts 按**段落**给，
 * 不是光标所在的那一行：写着写着整段一起亮才叫专注，只亮一行反而要一直找光标。
 */
function setViewModes(next: { focus?: boolean; typewriter?: boolean }): void {
  if (next.focus !== undefined) focusMode = next.focus
  if (next.typewriter !== undefined) typewriterMode = next.typewriter

  elWrite.classList.toggle('jd-focus', focusMode)
  // 打字机本身不需要样式，但要有这个 class 才能从 DOM 判断"现在开着没有"
  // （状态栏文字会被主题翻译报告覆盖，不能当状态用）
  elWrite.classList.toggle('jd-typewriter', typewriterMode)

  const on: string[] = []
  if (focusMode) on.push('专注')
  if (typewriterMode) on.push('打字机')
  setMetaStatus(on.length > 0 ? `视图：${on.join(' + ')}` : '视图：常规')

  if (typewriterMode) typewriterScroll()
}

/**
 * 把光标行滚到视口垂直居中。
 *
 * 滚动容器是 `#write`，不是 `.cm-scroller`（后者被设成 overflow:visible），
 * 所以 `EditorView.scrollIntoView()` 在这里无效 —— 自己算：
 * 光标相对容器顶部的位移，减去半个视口高度，就是需要追加的滚动量。
 */
function typewriterScroll(): void {
  if (!typewriterMode || !editor) return
  const coords = editor.view.coordsAtPos(editor.view.state.selection.main.head)
  if (!coords) return
  const box = elWrite.getBoundingClientRect()
  elWrite.scrollTop += coords.top - box.top - elWrite.clientHeight / 2
}

function scheduleTypewriter(): void {
  if (!typewriterMode) return
  // 光标移动后 DOM 可能还没重排完，等一拍再量。
  // 用 setTimeout 而不是 rAF：窗口不可见时 rAF 会被完全暂停（实测 600ms 0 回调）。
  window.setTimeout(typewriterScroll, 0)
}

// ------------------------------------------------------------------ 源码模式

/**
 * 渲染模式 ↔ 源码模式。
 *
 * 只丢一个布尔进编辑器 state，markers / table / fold 三处各自决定要不要出装饰：
 * 源码模式下标记全露、图片回 `![](path)`、表格回 `| a | b |`、折叠也停掉。
 * 行级 class（`.jd-h1` / `.jd-code-block`）保留 —— Typora 的源码模式同样保留排版。
 */
function toggleSourceMode(): void {
  sourceMode = !sourceMode
  if (editor) {
    editor.view.dispatch({ effects: setSourceMode.of(sourceMode) })
    editor.view.focus()
  }
  setMetaStatus(sourceMode ? '源码模式：markdown 标记全部显示' : '已回到渲染模式')
}

// ------------------------------------------------------------------ 编辑器

function ensureEditor(): EditorHandle {
  if (editor) return editor
  editor = createEditor(elEditorHost, {
    onChange: () => {
      setDirty(true)
      setSaveStatus('未保存', 'is-dirty')
      scheduleSave()
      scheduleDraft()
      scheduleOutline()
      scheduleWordCount()
      scheduleTypewriter()
      tablePanel?.refresh()
    },
    onSaveRequest: () => void doSave(),
    onPasteImage: (file) => void handleImage(file),
    onDropImage: (file) => void handleImage(file),
    onSelection: (pos) => {
      highlightOutline(elOutline, outlineItems, pos)
      scheduleTypewriter()
      tablePanel?.refresh()
    },
  })
  return editor
}

// ------------------------------------------------------------------ 大纲（M5-1）

/** 重建大纲：打开笔记后、文档改动后调用 */
function rebuildOutline(): void {
  if (!editor) {
    outlineItems = []
    elOutline.textContent = ''
    return
  }
  outlineItems = computeOutline(editor.view.state)
  renderOutline(elOutline, outlineItems, (pos) => {
    if (editor) jumpTo(editor.view, pos)
  })
  syncOutlineToViewport()
}

/**
 * 大纲高亮 = **视口顶部所在的章节**，不是光标所在的章节。
 *
 * 一开始用的是光标，结果是：用滚轮往下翻，大纲高亮纹丝不动地停在原处，
 * 看起来就是「选中和内容对不上」。翻文档时不一定会点一下让光标过去，
 * 所以必须以视口为准。（点正文时 onSelection 也会调一次，两者通常一致。）
 *
 * 取视口顶部往下 24px（跳过 #write 的 padding-top）的中点坐标反查字符位置；
 * 反查失败（内容还没布局）就退回光标位置，至少不会整排都没高亮。
 */
function syncOutlineToViewport(): void {
  if (!editor || outlineItems.length === 0) return
  const rect = elWrite.getBoundingClientRect()
  const pos = editor.view.posAtCoords({ x: rect.left + rect.width / 2, y: rect.top + 24 })
  highlightOutline(elOutline, outlineItems, pos ?? editor.view.state.selection.main.head)
}

/**
 * 文档改动后重建大纲，防抖 150ms。
 * 逐行正则在中位数笔记上是微秒级，但 274KB / 8000 行的大文件要几毫秒，
 * 挂在每次 docChanged 上会让输入发涩；而大纲晚 150ms 更新没人会察觉。
 */
function scheduleOutline(): void {
  if (outlineTimer !== null) window.clearTimeout(outlineTimer)
  outlineTimer = window.setTimeout(() => {
    outlineTimer = null
    rebuildOutline()
  }, 150)
}

// ------------------------------------------------------------------ 侧栏标签页（文件 / 大纲）

/**
 * 两个标签页共用侧栏的整块高度，而不是上下挤在一起 ——
 * 文件树本身就有 17 个顶层目录，再分一半给大纲，两边都难用。
 * 显示与否只由标签页决定；大纲没有标题时由 renderOutline 自己显示
 * 「这篇没有标题」，不再靠隐藏整块来"假装没这个功能"。
 */
function setSidebarTab(name: 'files' | 'outline'): void {
  elTabFiles.classList.toggle('is-active', name === 'files')
  elTabOutline.classList.toggle('is-active', name === 'outline')
  elTree.classList.toggle('hidden', name !== 'files')
  elOutlineWrap.classList.toggle('hidden', name !== 'outline')
}

elTabFiles.addEventListener('click', () => setSidebarTab('files'))
elTabOutline.addEventListener('click', () => setSidebarTab('outline'))

// 滚动时同步大纲高亮。节流 80ms：滚动事件一次能连发几十个，
// 每个都去 posAtCoords + 遍历大纲项没必要。
let outlineScrollTimer: number | null = null
elWrite.addEventListener(
  'scroll',
  () => {
    if (outlineScrollTimer !== null) return
    outlineScrollTimer = window.setTimeout(() => {
      outlineScrollTimer = null
      syncOutlineToViewport()
    }, 80)
  },
  { passive: true }
)

function scheduleSave(): void {
  if (saveTimer !== null) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => void doSave(), 800)
}

/**
 * 崩溃草稿：比自动保存更早、更频繁地落一份快照。
 * 自动保存失败（磁盘满、文件被独占）时，这仍是唯一能救回内容的东西，
 * 所以它和 doSave 是两个独立的定时器，不能合并。
 */
function scheduleDraft(): void {
  if (!current) return
  if (draftTimer !== null) window.clearTimeout(draftTimer)
  draftTimer = window.setTimeout(() => {
    if (!current || !editor || !dirty) return
    void window.api.saveDraft(current.path, editor.getDoc())
  }, 300)
}

/**
 * 上次没走完正常流程？有草稿就在顶部显示恢复条。
 * 不用 window.confirm：原生对话框会阻塞渲染进程、无法样式化、
 * 而且在自动化环境里会被直接判为取消（实测把草稿静默扔掉了）。
 */
async function offerCrashRecovery(): Promise<void> {
  const draft = await window.api.getDraft()
  if (!draft) return

  const when = new Date(draft.at).toLocaleString('zh-CN')
  const name = draft.path.split(/[\\/]/).pop() ?? draft.path
  elRecoverText.textContent = `上次退出时「${name}」还有 ${draft.text.length} 字没保存（${when}）`
  elRecover.classList.remove('hidden')

  return new Promise<void>((resolve) => {
    const cleanup = (): void => {
      elRecover.classList.add('hidden')
      elRecoverYes.removeEventListener('click', onYes)
      elRecoverNo.removeEventListener('click', onNo)
    }

    const onYes = (): void => {
      cleanup()
      void (async () => {
        try {
          const disk = await window.api.readNote(draft.path)
          current = { ...disk, text: draft.text }
          setDirty(true)
          elEmpty.classList.add('hidden')
          const ed = ensureEditor()
          ed.setDoc(draft.text, dirNameOf(draft.path))
          setActive(elTree, draft.path)
          elStatusPath.textContent = draft.path
          elStatusPath.title = draft.path
          elStatusSave.textContent = '已恢复草稿（未保存）'
          elStatusSave.className = 'is-dirty'
          setMetaStatus(`已恢复 ${when} 的草稿，检查无误后按 Ctrl+S 写盘`)
          rebuildOutline()
        } catch (err) {
          setMetaStatus(`草稿恢复失败：${(err as Error).message}`)
          await window.api.clearDraft()
        }
        resolve()
      })()
    }

    const onNo = (): void => {
      cleanup()
      void (async () => {
        // 丢弃草稿，但磁盘上的文件一个字都不动
        await window.api.clearDraft()
        setMetaStatus('已丢弃上次的草稿')
        resolve()
      })()
    }

    elRecoverYes.addEventListener('click', onYes)
    elRecoverNo.addEventListener('click', onNo)
  })
}

async function doSave(): Promise<void> {
  if (!current || !editor || saving) return
  if (!dirty) return
  saving = true
  setSaveStatus('保存中…')

  const text = editor.getDoc()
  const res = await window.api.writeNote(current.path, text, {
    eolStyle: current.eolStyle,
    eolMap: current.eolMap,
    bom: current.bom,
    endsWithNewline: current.endsWithNewline,
  })

  saving = false

  if (res.ok) {
    // 写盘期间用户可能又敲了字：只有内容确实还是刚写下去的那份才算「干净」
    const stillSame = editor.getDoc() === text
    setDirty(!stillSame)
    if (!stillSame) scheduleSave()
    current.mtimeMs = res.mtimeMs
    current.size = res.size
    setSaveStatus('已保存', 'is-saved')
    // 写盘成功且内容未再变 → 草稿没用了，清掉（否则下次启动会误以为崩溃过）
    if (stillSame) await window.api.clearDraft()
    window.setTimeout(() => {
      if (!dirty) setSaveStatus('')
    }, 1600)
  } else {
    // 写盘失败必须显式弹错（策划案 §7 红线）
    setSaveStatus('保存失败', 'is-error')
    window.alert(`保存失败：\n${res.error ?? '未知错误'}\n\n文件：${current.path}`)
  }
}

// ------------------------------------------------------------------ 图片

async function handleImage(file: File): Promise<void> {
  if (!current || !editor) return
  const maxBytes = 40 * 1024 * 1024
  if (file.size > maxBytes) {
    window.alert(`图片太大（${(file.size / 1024 / 1024).toFixed(1)}MB），上限 40MB。`)
    return
  }
  const buf = await file.arrayBuffer()
  const base64 = arrayBufferToBase64(buf)
  const ext = (file.name.split('.').pop() ?? 'png').toLowerCase()
  const rel = await window.api.saveImage(current.path, base64, ext)
  insertAtCursor(editor.view, `![](${rel})`)
  setDirty(true)
  scheduleSave()
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

// ------------------------------------------------------------------ 打开笔记

async function openNote(filePath: string): Promise<void> {
  if (current && dirty) await doSave()

  const doc = await window.api.readNote(filePath)
  current = doc
  setDirty(false)
  // 换文件前先把上一篇的草稿清掉，否则重启会提示恢复错误的内容
  if (draftTimer !== null) {
    window.clearTimeout(draftTimer)
    draftTimer = null
  }
  void window.api.clearDraft()
  void window.api.setLastFile(filePath)

  elEmpty.classList.add('hidden')
  const ed = ensureEditor()
  // 第二个参数是笔记所在目录，图片的相对路径要靠它解析成 file:// 地址
  ed.setDoc(doc.text, dirNameOf(filePath))
  ed.focus()
  // setDoc 重建了 state，源码模式要跟着补回来（否则翻下一篇就悄悄退回渲染模式）
  if (sourceMode) ed.view.dispatch({ effects: setSourceMode.of(true) })

  // 换笔记要回到顶部。滚动容器是外层的 #write，不是 CM6 的 .cm-scroller
  // （后者是 overflow:visible，见 outline.ts 的注释），所以不能指望 CM6 自己重置。
  // 用 setTimeout 而不是 requestAnimationFrame：窗口不可见时 rAF 会被完全暂停
  // （实测 hidden 状态下 600ms 内一次都不跑），而换笔记这件事在后台也可能发生。
  // 两次是为了等 setDoc 之后的重新排版稳定下来。
  setTimeout(() => {
    elWrite.scrollTop = 0
  }, 0)
  setTimeout(() => {
    elWrite.scrollTop = 0
  }, 80)

  setActive(elTree, filePath)
  elStatusPath.textContent = filePath
  elStatusPath.title = filePath
  setSaveStatus('')

  const eolLabel = doc.eolStyle === 'crlf' ? 'CRLF' : doc.eolStyle === 'lf' ? 'LF' : '混合换行'
  const bits = [eolLabel, fmtSize(doc.size)]
  if (doc.bom) bits.push('BOM')
  if (!doc.endsWithNewline) bits.push('末尾无换行')
  setMetaStatus(bits.join(' · '))

  // 裂图提示：有就明说，不静默
  const broken = await window.api.brokenImagesOf(filePath)
  if (broken.length > 0) {
    setMetaStatus(`${bits.join(' · ')} · ⚠ 裂图 ${broken.length}`)
  }

  // 新笔记的大纲：标题全变了，必须整棵重建
  rebuildOutline()
  renderWordCount()
  tablePanel?.refresh()
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 取路径里的目录部分（图片相对路径的解析基准） */
function dirNameOf(filePath: string): string {
  const i = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'))
  return i > 0 ? filePath.slice(0, i) : ''
}

/**
 * 归一化路径后再比较。
 *
 * Windows 下 `D:/a` 和 `D:\a` 是同一个位置，但不是同一个字符串 ——
 * 直接 `startsWith` 会静默失败，现象是「重启后回到文件树、不打开上次那篇」，
 * 而且**不报任何错**。正反斜杠混用是常态：用户手改过 config、别的工具写过面板、
 * 或者任何一处用了 `path.posix` 都会留下正斜杠。
 */
function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

// ------------------------------------------------------------------ 侧栏宽度

/**
 * 拖拽改宽。宽度写进 config.sidebarWidth，下次启动恢复。
 * 用 pointer 事件而不是 mousedown/mousemove：拖到窗口外也能继续跟着走，
 * 鼠标松开的事件不会丢（mousemove 方案在快速甩出窗口时会卡住）。
 */
function setupSidebarResize(): void {
  let dragging = false

  elSidebarResize.addEventListener('pointerdown', (ev) => {
    ev.preventDefault()
    dragging = true
    elSidebarResize.classList.add('is-dragging')
    elSidebarResize.setPointerCapture(ev.pointerId)
  })

  elSidebarResize.addEventListener('pointermove', (ev) => {
    if (!dragging) return
    const left = elSidebar.getBoundingClientRect().left
    const w = Math.round(ev.clientX - left)
    const clamped = Math.max(160, Math.min(480, w))
    document.documentElement.style.setProperty('--jd-sidebar-w', `${clamped}px`)
  })

  const finish = (ev: PointerEvent): void => {
    if (!dragging) return
    dragging = false
    elSidebarResize.classList.remove('is-dragging')
    try {
      elSidebarResize.releasePointerCapture(ev.pointerId)
    } catch {
      /* 指针已经没了，忽略 */
    }
    const w = Math.round(elSidebar.getBoundingClientRect().width)
    void window.api.saveSidebarWidth(w)
  }

  elSidebarResize.addEventListener('pointerup', finish)
  elSidebarResize.addEventListener('pointercancel', finish)

  // 双击恢复默认宽度
  elSidebarResize.addEventListener('dblclick', () => {
    document.documentElement.style.setProperty('--jd-sidebar-w', '240px')
    void window.api.saveSidebarWidth(240)
  })
}

async function restoreSidebarWidth(): Promise<void> {
  const w = await window.api.getSidebarWidth()
  if (w >= 160 && w <= 480) {
    document.documentElement.style.setProperty('--jd-sidebar-w', `${w}px`)
  }
}

// ------------------------------------------------------------------ 笔记库

async function loadLibrary(root: string): Promise<void> {
  libRoot = root
  elLibName.textContent = root.split(/[\\/]/).filter(Boolean).pop() ?? root
  elLibName.title = root

  const nodes = await window.api.listTree(root)
  renderTree(elTree, {
    root: nodes,
    activePath: current?.path ?? '',
    onOpen: (p) => void openNote(p),
  })
}

elOpenLib.addEventListener('click', () => {
  void (async () => {
    const root = await window.api.openLibrary()
    if (root) await loadLibrary(root)
  })()
})

// ------------------------------------------------------------------ 主题

async function loadThemes(selected?: string): Promise<void> {
  const themes = await window.api.getThemes()
  elTheme.textContent = ''
  const builtin = document.createElement('option')
  builtin.value = ''
  builtin.textContent = '（内置）'
  elTheme.append(builtin)
  // 内置的深色档：策划案 §3.1-6 的「亮/暗两套兜底」。它不是主题文件，
  // 值也取自 config 里一直留着却没实现的那个 'builtin-dark'
  const builtinDark = document.createElement('option')
  builtinDark.value = BUILTIN_DARK
  builtinDark.textContent = '（内置 · 深色）'
  elTheme.append(builtinDark)
  for (const t of themes) {
    const o = document.createElement('option')
    o.value = t
    o.textContent = t.replace(/\.css$/i, '')
    elTheme.append(o)
  }
  if (selected === BUILTIN_DARK) elTheme.value = BUILTIN_DARK
  else if (selected && themes.includes(selected)) elTheme.value = selected
}

/** 主题切换：翻译 → 注入 → 状态栏报账 */
async function switchTheme(name: string): Promise<void> {
  if (!name || name === BUILTIN_DARK) {
    await applyTheme(name)
    setMetaStatus(name === BUILTIN_DARK ? '内置样式 · 深色' : '内置样式 · 浅色')
    return
  }
  setMetaStatus(`正在翻译主题 ${name} …`)
  try {
    const result = await applyTheme(name)
    if (!result) return
    const r = currentThemeReport()
    const bits = [
      `应用 ${r?.kept ?? 0} 条`,
      `丢弃 ${r?.dropped ?? 0} 条`,
      `字体 ${r?.fontFaces ?? 0}`,
      `内联 ${r?.sources.length ?? 0} 文件`,
    ]
    if (r && r.warnings.length > 0) bits.push(`警告 ${r.warnings.length}`)
    setMetaStatus(`主题 ${name.replace(/\.css$/i, '')} · ${bits.join(' · ')}`)
    // 报告明细留给控制台，排查时看这里
    console.info('[简牍] 主题翻译报告', r)
  } catch (err) {
    setMetaStatus(`主题翻译失败：${(err as Error).message}`)
    console.error('[简牍] 主题翻译失败', err)
  }
}

elTheme.addEventListener('change', () => {
  const name = elTheme.value
  void window.api.setCurrentTheme(name)
  void switchTheme(name)
})

// 主题文件在 Typora 里被改了一行 → 这里自动重翻译（400ms 防抖在主进程做）
window.api.onThemeChanged(() => {
  const name = elTheme.value
  // 两个内置档没有主题文件，没有「被改」这回事
  if (!name || name === BUILTIN_DARK) return
  void (async () => {
    try {
      await reloadTheme(name)
      setMetaStatus(`主题 ${name.replace(/\.css$/i, '')} 已热重载`)
    } catch (err) {
      setMetaStatus(`主题热重载失败：${(err as Error).message}`)
    }
  })()
})

// ------------------------------------------------------------------ PDF 导出

/** Windows 绝对路径 → file:// URL（盘符那一段不能编码，否则 `E:` 会变成 `E%3A`） */
function toFileUrl(absPath: string): string {
  const parts = absPath.replace(/\\/g, '/').split('/')
  return 'file:///' + parts.map((s, i) => (i === 0 ? s : encodeURIComponent(s))).join('/')
}

/** 把 `<img src="相对路径">` 换成绝对 file://：打印页在临时目录里，相对路径找不到图 */
function absolutizeImages(html: string, baseDir: string): string {
  const dir = baseDir.replace(/\\/g, '/').replace(/\/+$/, '')
  return html.replace(
    /(<img\b[^>]*\bsrc=")([^"]*)(")/g,
    (whole, pre: string, src: string, post: string) => {
      if (!src || /^(https?:|data:|file:)/i.test(src)) return whole
      let decoded = src
      try {
        decoded = decodeURIComponent(src)
      } catch {
        /* 路径里有裸 % 之类，按原样用 */
      }
      const abs =
        /^[a-zA-Z]:/.test(decoded) || decoded.startsWith('/')
          ? decoded
          : `${dir}/${decoded.replace(/^\.\//, '')}`
      return pre + toFileUrl(abs) + post
    }
  )
}

function escapeForHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * 导出 PDF。
 *
 * **不走 pandoc**：本机根本没装（策划案里"本机已装 pandoc"那句话已经过期），
 * 而让用户为了导出去装一个外部二进制不合适。
 * 改成 `markdownToHtml()` 用**编辑器同一个 Lezer parser** 生成 HTML，
 * 套上当前主题的翻译结果，交给隐藏窗口 `printToPDF` —— 纸面和屏幕是同一套样式。
 */
async function exportPdf(): Promise<void> {
  if (!current || !editor) return
  setMetaStatus('正在生成 PDF…')
  try {
    const body = absolutizeImages(markdownToHtml(editor.getDoc()), dirNameOf(current.path))
    const title = escapeForHtml(current.path.split(/[\\/]/).pop() ?? '导出')
    const css = currentThemeCss()
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${title}</title>
<style>${css}</style>
<style>
  html { background: #fff; }
  body { margin: 0; }
  /* 打印时不要屏幕那套「限宽 90% + 居中」，纸面宽度交给 @page */
  #write { max-width: none !important; width: auto !important; margin: 0 !important; padding: 0 !important; }
  .jd-h1, .jd-h2, .jd-h3, .jd-h4, .jd-h5, .jd-h6 { break-after: avoid; }
  pre, table, blockquote, .jd-mermaid, img { break-inside: avoid; }
  @page { margin: 16mm 14mm; }
</style></head>
<body class="jd-content"><div id="write">${body}</div></body></html>`

    const res = await window.api.exportPdf(html, current.path.replace(/\.md$/i, '') + '.pdf')
    if (res.canceled) {
      setMetaStatus('已取消导出')
      return
    }
    setMetaStatus(res.ok ? 'PDF 已导出' : `导出失败：${res.error ?? '未知错误'}`)
    if (!res.ok) window.alert(`导出 PDF 失败：\n${res.error ?? '未知错误'}`)
  } catch (err) {
    const msg = (err as Error).message
    setMetaStatus(`导出失败：${msg}`)
    window.alert(`导出 PDF 失败：\n${msg}`)
  }
}

// ------------------------------------------------------------------ 菜单命令

/**
 * 执行一条命令。
 *
 * 有两个入口会调它：菜单（含菜单 accelerator 触发）和渲染层的快捷键监听
 * （keybindings.ts）。同一命令两条路径都指向这里，行为不会分叉。
 *
 * 60ms 去重：这两条路径谁先谁后取决于 Electron 内部时机，个别组合可能两边都
 * 收到。不拦一下的话「加粗」会把选区裹两层 `****`。人手不可能 60ms 内按两次同一个键。
 */
const lastRun = new Map<string, number>()

export function runCommand(cmd: string): void {
  const now = performance.now()
  if (now - (lastRun.get(cmd) ?? 0) < 60) return
  lastRun.set(cmd, now)

  const ed = editor
  switch (cmd) {
    case 'open-library':
      elOpenLib.click()
      return
    case 'save':
      void doSave()
      return
    case 'find':
      // CM6 的搜索面板必须用命令打开（openSearchPanel），
      // 光 focus 编辑器什么都不会发生 —— 之前这里就是空操作。
      if (ed) openSearch(ed.view)
      return
    case 'save-then-quit':
      void (async () => {
        await doSave()
        if (!dirty) window.api.quitNow()
      })()
      return
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      if (ed) setHeading(ed.view, Number(cmd.slice(1)))
      return
    case 'p':
      if (ed) setHeading(ed.view, 0)
      return
    case 'bold':
      if (ed) wrapSelection(ed.view, '**')
      return
    case 'italic':
      if (ed) wrapSelection(ed.view, '*')
      return
    case 'code':
      if (ed) wrapSelection(ed.view, '`')
      return
    case 'codeblock':
      if (ed) insertCodeBlock(ed.view)
      return
    case 'focus-mode':
      setViewModes({ focus: !focusMode })
      return
    case 'typewriter-mode':
      setViewModes({ typewriter: !typewriterMode })
      return
    case 'source-mode':
      toggleSourceMode()
      return
    case 'export-pdf':
      void exportPdf()
      return
    case 'settings':
      void openSettings()
      return
    case 'theme-report':
      openThemeReport()
      return
  }
}

window.api.onMenu(runCommand)

// 渲染层自己的快捷键分发：菜单 accelerator 会被 CM6 抢，见 keybindings.ts 的说明
installKeybindings(runCommand)

// ------------------------------------------------------------------ 启动

void (async () => {
  setupSidebarResize()
  tablePanel = installTablePanel({
    el: $('jd-table-panel'),
    getView: () => editor?.view ?? null,
    onStatus: setMetaStatus,
  })
  await restoreSidebarWidth()
  const saved = await window.api.getCurrentTheme()
  await loadThemes(saved)
  const root = await window.api.getLibrary()
  if (root) {
    await loadLibrary(root)
    // 上次在看哪篇：先问草稿，没有草稿再回到 lastFile
    await offerCrashRecovery()
    if (!current) {
      const last = await window.api.getLastFile()
      // 用 normPath 比较分隔符与大小写，别直接 startsWith（见 normPath 的注释）
      if (last && normPath(last).startsWith(normPath(root))) {
        try {
          await openNote(last)
        } catch {
          // 文件可能被删/改名了，静默忽略，停在文件树
        }
      }
    }
  } else {
    setMetaStatus('未打开笔记库')
  }
  // 重启后恢复上次的主题（默认就用实测定下的 dyzj-dark.css）
  if (elTheme.value) void switchTheme(elTheme.value)
})()

// 兜底：正常关窗路径走主进程的「保存并关闭」，这里只处理页面级刷新。
// 注意不能在这里 await 写盘 —— 页面卸载时异步操作跑不完，等于没保护。
window.addEventListener('beforeunload', () => {
  if (!dirty) return
  // 只来得及把草稿塞进同步路径；真正的保护在主进程 close 事件里
  if (current && editor) void window.api.saveDraft(current.path, editor.getDoc())
})

/**
 * 自动化钩子：让 CDP / DevTools 能直接打开设置面板。
 *
 * 系统菜单是主进程画的，CDP 点不到「设置 → 快捷键…」那一项；
 * 没有这个入口，设置面板的整条链路（读配置 → 渲染 → 录制 → 写回）
 * 就只能在测试里靠人工点。挂出来的只是「打开面板」这一个动作，没有额外权限。
 */
;(window as unknown as Record<string, unknown>)['__jdOpenSettings'] = openSettings
