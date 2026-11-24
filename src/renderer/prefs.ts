/**
 * 偏好设置面板（左侧分区 + 右侧内容）。
 *
 * 分区：外观 / 编辑器 / 文件 / 图像 / 导出 —— 对齐 Typora 的偏好设置，
 * 但只保留对简牍成立的选项（没有更新、许可证、上传服务、Pandoc 多格式导出）。
 *
 * 四条刻意的设计：
 *
 * ① **主题选项不在这里造**。选项直接从侧栏那个 `#jd-theme` 克隆，改动写回去再
 *    派发 change —— 走的是 main.ts 里同一条 `switchTheme` 路径（含保存到 config、
 *    翻译报账、mermaid 缓存失效）。两处各维护一份选项列表，迟早漂成
 *    「侧栏有 A 没有 B、设置里有 B 没有 A」。
 *
 * ② **打开面板时暂停快捷键分发**（和快捷键设置面板一致）。面板盖住了编辑器，
 *    此时按 Ctrl+S 去保存一个看不见的文档没有意义，还会在 record 期间抢键。
 *
 * ③ **目录打不开要说出来**。`shell.openPath` 不抛异常、用返回的 error string
 *    报错；吞掉的话用户只觉得「按钮点了没反应」。
 *
 * ④ **布尔/下拉开关即时生效，文本输入防抖 350ms**。没有「应用 / 确定」按钮：
 *    多一个确认步骤就多一个「忘了点」的失败模式；而文本框逐字落盘会让
 *    「输入 120  px」中途先存成 1、12、120 三次。
 */

import { setKeymapPaused } from './keybindings.js'
import { applyTypography } from './typography.js'
import { getPrefs, loadPrefs, savePrefs, PREFS_CHANGED } from './prefs-state.js'
import { IMAGE_TEMPLATE_DEFAULT, type Prefs } from '../shared/prefs.js'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

let overlay: HTMLElement | null = null
let tabButtons: HTMLButtonElement[] = []
let panes: HTMLElement[] = []
let themeSel: HTMLSelectElement | null = null
let dirPathEl: HTMLElement | null = null
let openBtn: HTMLButtonElement | null = null
let msgEl: HTMLElement | null = null
let msgTimer: number | null = null
let fontInput: HTMLInputElement | null = null
let sizeInput: HTMLInputElement | null = null
let fontTimer: number | null = null
let langInput: HTMLInputElement | null = null
let imgTemplateInput: HTMLInputElement | null = null
let textTimer: number | null = null

export function isPrefsOpen(): boolean {
  ensureRefs()
  return !!overlay && !overlay.classList.contains('hidden')
}

export async function openPrefs(): Promise<void> {
  ensureRefs()
  if (!overlay) return
  overlay.classList.remove('hidden')
  setKeymapPaused(true)
  showMsg('')
  syncThemes()
  // 重新读一次：副窗口可能刚改过（多窗口下 savePrefs 只更新改它的那个窗口）
  const p = await loadPrefs()
  syncPrefsControls(p)
  await refreshDir()
  await refreshFont()
}

export function closePrefs(): void {
  ensureRefs()
  if (!overlay) return
  overlay.classList.add('hidden')
  setKeymapPaused(false)
  showMsg('')
}

function ensureRefs(): void {
  if (overlay) return
  overlay = $('jd-prefs')
  themeSel = $<HTMLSelectElement>('jd-prefs-theme')
  dirPathEl = $('jd-prefs-dirpath')
  openBtn = $<HTMLButtonElement>('jd-prefs-opendir')
  msgEl = $('jd-prefs-msg')

  $('jd-prefs-close').addEventListener('click', () => closePrefs())

  // 点遮罩空白处关闭（点面板内部不关）
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) closePrefs()
  })

  // 分区切换：结构上支持多个 pane，现在只有一个也不会报错
  tabButtons = Array.from(overlay.querySelectorAll<HTMLButtonElement>('.jd-prefs-tab'))
  panes = Array.from(overlay.querySelectorAll<HTMLElement>('.jd-prefs-pane'))
  for (const btn of tabButtons) {
    btn.addEventListener('click', () => selectPane(btn.dataset['pane'] ?? ''))
  }

  themeSel.addEventListener('change', () => {
    const side = document.getElementById('jd-theme') as HTMLSelectElement | null
    if (!side) return
    if (side.value === themeSel!.value) return
    side.value = themeSel!.value
    // 复用侧栏那条 change 处理：它会 setCurrentTheme + switchTheme
    side.dispatchEvent(new Event('change'))
  })

  openBtn.addEventListener('click', () => void openThemeDir())

  // 字体 / 字号：边改边生效（防抖 350ms），没有「应用」按钮
  fontInput = $<HTMLInputElement>('jd-prefs-font')
  sizeInput = $<HTMLInputElement>('jd-prefs-size')
  fontInput.addEventListener('input', () => scheduleFontApply())
  sizeInput.addEventListener('input', () => scheduleFontApply())
  $('jd-prefs-font-reset').addEventListener('click', () => void resetFont())

  // ---- 行为偏好（编辑器 / 文件 / 图像 / 导出 / 缩放）----
  //
  // 勾选与下拉**即时生效**：这些开关都是"看得见"的（状态栏、代码行号），
  // 改完立刻能看到结果才是最好的反馈，多一个「应用」按钮反而要解释。
  bindCheck('jd-prefs-statusbar', 'showStatusbar')
  bindCheck('jd-prefs-codeline', 'codeLineNumbers')
  bindCheck('jd-prefs-codewrap', 'codeWrap')
  bindCheck('jd-prefs-firstindent', 'firstLineIndent')
  bindCheck('jd-prefs-autosave', 'autosave')
  bindCheck('jd-prefs-restore', 'restoreLastFile')
  bindCheck('jd-prefs-imgdot', 'imageRelativeDot')
  bindCheck('jd-prefs-exportdir', 'openExportDir')
  bindSelect('jd-prefs-zoom', 'zoom')
  bindSelect('jd-prefs-indent', 'indentWidth')

  langInput = $<HTMLInputElement>('jd-prefs-codelang')
  langInput.addEventListener('input', () => scheduleTextApply())
  imgTemplateInput = $<HTMLInputElement>('jd-prefs-imgtemplate')
  imgTemplateInput.addEventListener('input', () => scheduleTextApply())
  $('jd-prefs-imgreset').addEventListener('click', () => {
    if (imgTemplateInput) imgTemplateInput.value = IMAGE_TEMPLATE_DEFAULT
    void applyTextPrefs()
    showMsg('图片目录已恢复默认')
  })

  // 面板开着时按 Ctrl+滚轮改缩放：下拉要跟着变，否则「明明调过，下拉还是 100%」
  window.addEventListener(PREFS_CHANGED, () => {
    if (!isPrefsOpen()) return
    syncPrefsControls(getPrefs())
  })

  // Esc 关闭：挂在 capture 阶段，赶在 CM6 之前拿到（否则编辑器先吃掉）
  window.addEventListener(
    'keydown',
    (e) => {
      if (!isPrefsOpen()) return
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      closePrefs()
    },
    true
  )
}

function selectPane(name: string): void {
  for (const btn of tabButtons) {
    btn.classList.toggle('is-active', btn.dataset['pane'] === name)
  }
  for (const pane of panes) {
    const on = pane.dataset['pane'] === name
    pane.classList.toggle('hidden', !on)
    // 用属性而不是纯 class：`hidden` 属性对 <section> 是 UA 级 display:none，
    // 不会被主题里的 `section { display: … }` 之类规则改回来
    pane.hidden = !on
  }
}

/** 从侧栏的 #jd-theme 克隆选项 —— 主题列表的真源只有一个 */
function syncThemes(): void {
  if (!themeSel) return
  const side = document.getElementById('jd-theme') as HTMLSelectElement | null
  if (!side) return
  themeSel.textContent = ''
  for (const opt of Array.from(side.options)) {
    const o = document.createElement('option')
    o.value = opt.value
    o.textContent = opt.textContent
    themeSel.append(o)
  }
  themeSel.value = side.value
}

async function refreshDir(): Promise<void> {
  if (!dirPathEl) return
  try {
    const dir = await window.api.getThemeDir()
    dirPathEl.textContent = dir || '—'
    dirPathEl.title = dir || ''
  } catch (err) {
    dirPathEl.textContent = '（读取失败）'
    dirPathEl.title = (err as Error).message
  }
}

/** 读配置里的字体/字号填回输入框（打开面板时调） */
async function refreshFont(): Promise<void> {
  if (!fontInput || !sizeInput) return
  try {
    const f = await window.api.getFont()
    fontInput.value = f.family
    sizeInput.value = f.size > 0 ? String(f.size) : ''
  } catch {
    /* 读不到就保持空白 = 跟随主题 */
  }
}

/** 输入时防抖：一个字一个字地敲字体名不能每次都落盘 + 重排 */
function scheduleFontApply(): void {
  if (fontTimer !== null) window.clearTimeout(fontTimer)
  fontTimer = window.setTimeout(() => void applyFontFromInputs(), 350)
}

async function applyFontFromInputs(): Promise<void> {
  fontTimer = null
  if (!fontInput || !sizeInput) return
  const family = fontInput.value.trim()
  const raw = sizeInput.value.trim()
  const size = raw === '' ? 0 : Number(raw)
  try {
    // 主进程负责夹区间（0–40），回填以它为准 —— 否则输入 999 会和实际生效值不一致
    const saved = await window.api.setFont({ family, size: Number.isFinite(size) ? size : 0 })
    fontInput.value = saved.family
    sizeInput.value = saved.size > 0 ? String(saved.size) : ''
    applyTypography(saved.family, saved.size)
  } catch (err) {
    showMsg(`改字体失败：${(err as Error).message}`, true)
  }
}

async function resetFont(): Promise<void> {
  if (!fontInput || !sizeInput) return
  fontInput.value = ''
  sizeInput.value = ''
  await applyFontFromInputs()
  showMsg('字体与字号已恢复为跟随主题')
}

// ------------------------------------------------------------------ 行为偏好

/** 勾选框 → prefs 里的布尔键（即时落盘） */
function bindCheck(id: string, key: keyof Prefs): void {
  const el = $<HTMLInputElement>(id)
  el.addEventListener('change', () => {
    void savePrefs({ [key]: el.checked } as Partial<Prefs>)
  })
}

/**
 * 下拉 → prefs 里的数值键。
 *
 * 值不在选项列表里时（比如缩放被 Ctrl+滚轮改成了 1.15）**不改写它** ——
 * 面板打开时 syncPrefsControls 会把下拉恢复成空选项，那是可见的"自定义值"状态，
 * 比悄悄吸附到最近的 10% 更诚实。
 */
function bindSelect(id: string, key: 'zoom' | 'indentWidth'): void {
  const el = $<HTMLSelectElement>(id)
  el.addEventListener('change', () => {
    const n = Number(el.value)
    if (!Number.isFinite(n) || n <= 0) return
    void savePrefs({ [key]: n } as Partial<Prefs>)
  })
}

/** 打开面板时把值填回去（以主进程存的为准） */
function syncPrefsControls(p: Prefs): void {
  const setCheck = (id: string, on: boolean): void => {
    const el = document.getElementById(id) as HTMLInputElement | null
    if (el) el.checked = on
  }
  setCheck('jd-prefs-statusbar', p.showStatusbar)
  setCheck('jd-prefs-codeline', p.codeLineNumbers)
  setCheck('jd-prefs-codewrap', p.codeWrap)
  setCheck('jd-prefs-firstindent', p.firstLineIndent)
  setCheck('jd-prefs-autosave', p.autosave)
  setCheck('jd-prefs-restore', p.restoreLastFile)
  setCheck('jd-prefs-imgdot', p.imageRelativeDot)
  setCheck('jd-prefs-exportdir', p.openExportDir)

  const zoom = $<HTMLSelectElement>('jd-prefs-zoom')
  zoom.value = String(p.zoom)
  const indent = $<HTMLSelectElement>('jd-prefs-indent')
  indent.value = String(p.indentWidth)

  if (langInput) langInput.value = p.codeDefaultLang
  if (imgTemplateInput) imgTemplateInput.value = p.imageDirTemplate
}

/** 文本类偏好防抖：逐字落盘会把「1 → 12 → 120」存三遍 */
function scheduleTextApply(): void {
  if (textTimer !== null) window.clearTimeout(textTimer)
  textTimer = window.setTimeout(() => void applyTextPrefs(), 350)
}

async function applyTextPrefs(): Promise<void> {
  textTimer = null
  if (!langInput || !imgTemplateInput) return
  const saved = await savePrefs({
    codeDefaultLang: langInput.value,
    imageDirTemplate: imgTemplateInput.value,
  })
  // 回填以主进程为准：非法语言（`a b`）、空模板都会被夹回旧值/默认值。
  // 不回填的话，面板上显示的是一个磁盘上并不存在的值 —— 下次打开才"自己变了"。
  langInput.value = saved.codeDefaultLang
  imgTemplateInput.value = saved.imageDirTemplate
}

async function openThemeDir(): Promise<void> {
  if (!openBtn) return
  openBtn.disabled = true
  try {
    const err = await window.api.openThemeDir()
    if (err) showMsg(`打不开主题文件夹：${err}`, true)
    else showMsg('已打开主题文件夹')
  } catch (e) {
    showMsg(`打不开主题文件夹：${(e as Error).message}`, true)
  } finally {
    openBtn.disabled = false
  }
}

function showMsg(text: string, isError = false): void {
  if (!msgEl) return
  msgEl.textContent = text
  msgEl.classList.toggle('is-err', isError)
  if (msgTimer !== null) window.clearTimeout(msgTimer)
  msgTimer = text
    ? window.setTimeout(() => {
        if (msgEl) msgEl.textContent = ''
      }, 6000)
    : null
}
