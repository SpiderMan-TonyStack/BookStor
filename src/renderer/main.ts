import type { FileNode, NoteDoc } from '../shared/types.js'
import { renderTree, setActive } from './tree.js'
import { createEditor, insertAtCursor, wrapSelection, setHeading, type EditorHandle } from './editor.js'
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

// ------------------------------------------------------------------ 状态

let libRoot = ''
let current: NoteDoc | null = null
let dirty = false
let saving = false
let saveTimer: number | null = null
let editor: EditorHandle | null = null

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
      dirty = true
      setSaveStatus('未保存', 'is-dirty')
      scheduleSave()
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
    dirty = false
    current.mtimeMs = res.mtimeMs
    current.size = res.size
    setSaveStatus('已保存', 'is-saved')
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
  dirty = true
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
  dirty = false

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
      // CM6 searchKeymap 绑定在 Mod-f 上，直接派发键盘事件不可靠，这里用命令
      if (ed) ed.focus()
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
  const saved = await window.api.getCurrentTheme()
  await loadThemes(saved)
  const root = await window.api.getLibrary()
  if (root) await loadLibrary(root)
  else setMetaStatus('未打开笔记库')
  // 重启后恢复上次的主题（默认就用实测定下的 dyzj-dark.css）
  if (elTheme.value) void switchTheme(elTheme.value)
})()

window.addEventListener('beforeunload', () => {
  if (dirty) void doSave()
})
