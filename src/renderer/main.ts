import type { FileNode, NoteDoc } from '../shared/types.js'
import { renderTree, setActive } from './tree.js'
import { createEditor, insertAtCursor, wrapSelection, setHeading, openSearch, type EditorHandle } from './editor.js'
import { applyTheme, reloadTheme, currentThemeReport } from './theme.js'

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
const elRecover = $('jd-recover')
const elRecoverText = $('jd-recover-text')
const elRecoverYes = $<HTMLButtonElement>('jd-recover-yes')
const elRecoverNo = $<HTMLButtonElement>('jd-recover-no')
const elSidebar = $('jd-sidebar')
const elSidebarResize = $('jd-sidebar-resize')

// ------------------------------------------------------------------ 状态

let libRoot = ''
let current: NoteDoc | null = null
let dirty = false
let saving = false
let saveTimer: number | null = null
let editor: EditorHandle | null = null
let draftTimer: number | null = null

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

// ------------------------------------------------------------------ 编辑器

function ensureEditor(): EditorHandle {
  if (editor) return editor
  editor = createEditor(elEditorHost, {
    onChange: () => {
      setDirty(true)
      setSaveStatus('未保存', 'is-dirty')
      scheduleSave()
      scheduleDraft()
    },
    onSaveRequest: () => void doSave(),
    onPasteImage: (file) => void handleImage(file),
    onDropImage: (file) => void handleImage(file),
  })
  return editor
}

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
  for (const t of themes) {
    const o = document.createElement('option')
    o.value = t
    o.textContent = t.replace(/\.css$/i, '')
    elTheme.append(o)
  }
  if (selected && themes.includes(selected)) elTheme.value = selected
}

/** 主题切换：翻译 → 注入 → 状态栏报账 */
async function switchTheme(name: string): Promise<void> {
  if (!name) {
    await applyTheme('')
    setMetaStatus('已切回内置样式（无主题）')
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
  if (!name) return
  void (async () => {
    try {
      await reloadTheme(name)
      setMetaStatus(`主题 ${name.replace(/\.css$/i, '')} 已热重载`)
    } catch (err) {
      setMetaStatus(`主题热重载失败：${(err as Error).message}`)
    }
  })()
})

// ------------------------------------------------------------------ 菜单命令

window.api.onMenu((cmd) => {
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
  }
})

// ------------------------------------------------------------------ 启动

void (async () => {
  setupSidebarResize()
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
      if (last && last.startsWith(root)) {
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
