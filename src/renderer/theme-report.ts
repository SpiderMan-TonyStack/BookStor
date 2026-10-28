import { currentThemeReport } from './theme.js'
import { isSettingsOpen, closeSettings } from './settings.js'

/**
 * 主题兼容度报告面板（策划案 §3.2 最后一项）。
 *
 * 翻译管线每次都会产出一份 `ThemeReport`：应用了多少条规则、丢弃了多少、哪些规则
 * 被改名、有哪些警告。这些以前只能 `console.info` 去看，而"主题某个地方不对劲"
 * 恰恰是最需要这些证据的时候 —— 所以给一个能直接看的窗口。
 *
 * 面板本身只读：它不改任何东西，只是把 report 排版出来。
 * 底部「复制报告」把同一份内容转成纯文本，方便贴给别人排查。
 */

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

let overlay: HTMLElement | null = null
let bodyEl: HTMLElement | null = null
let titleEl: HTMLElement | null = null
let report: ReturnType<typeof currentThemeReport> = null

export function isThemeReportOpen(): boolean {
  ensureRefs()
  return !!overlay && !overlay.classList.contains('hidden')
}

export function openThemeReport(): void {
  ensureRefs()
  if (!overlay) return
  // 两个面板不能同时开：设置面板会暂停快捷键分发，叠在一起容易互相打架
  if (isSettingsOpen()) closeSettings()
  overlay.classList.remove('hidden')
  report = currentThemeReport()
  render()
}

export function closeThemeReport(): void {
  ensureRefs()
  overlay?.classList.add('hidden')
}

function ensureRefs(): void {
  if (overlay) return
  overlay = $('jd-theme-report')
  bodyEl = $('jd-tr-body')
  titleEl = $('jd-tr-title')
  $('jd-tr-close').addEventListener('click', () => closeThemeReport())
  $('jd-tr-copy').addEventListener('click', () => void copyReport())
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) closeThemeReport()
  })
  window.addEventListener(
    'keydown',
    (e) => {
      if (!isThemeReportOpen()) return
      if (e.key !== 'Escape') return
      e.preventDefault()
      e.stopPropagation()
      closeThemeReport()
    },
    true
  )
}

function el(tag: string, cls: string, text?: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = cls
  if (text !== undefined) node.textContent = text
  return node
}

function statGrid(): HTMLElement {
  const grid = el('div', 'jd-tr-stats')
  const r = report!
  const items: [string, number][] = [
    ['应用规则', r.kept],
    ['丢弃规则', r.dropped],
    ['@font-face', r.fontFaces],
    ['@keyframes', r.keyframes],
    ['内联 @import', r.imports],
    ['重写 url()', r.urls],
    ['内联文件', r.sources.length],
    ['输出行数', r.outLines],
  ]
  for (const [label, value] of items) {
    const box = el('div', 'jd-tr-stat')
    box.append(el('div', 'jd-tr-stat-num', String(value)), el('div', 'jd-tr-stat-label', label))
    grid.append(box)
  }
  return grid
}

function section(title: string, lines: string[], hint?: string): HTMLElement {
  const wrap = el('div', 'jd-tr-section')
  wrap.append(el('div', 'jd-tr-section-title', `${title}（${lines.length}）`))
  if (hint) wrap.append(el('div', 'jd-tr-hint', hint))
  const list = el('div', 'jd-tr-list')
  if (lines.length === 0) {
    list.append(el('div', 'jd-tr-empty', '（无）'))
  } else {
    // 太多了没人看：样例本来就是"看个大概"，完整内容靠复制报告
    for (const line of lines.slice(0, 30)) list.append(el('div', 'jd-tr-line', line))
    if (lines.length > 30) list.append(el('div', 'jd-tr-empty', `…另有 ${lines.length - 30} 条`))
  }
  wrap.append(list)
  return wrap
}

function render(): void {
  if (!bodyEl) return
  bodyEl.textContent = ''

  if (!report) {
    if (titleEl) titleEl.textContent = '主题兼容度报告'
    bodyEl.append(
      el(
        'div',
        'jd-tr-empty-big',
        '当前用的是内置样式（没选 Typora 主题），没有可报告的翻译结果。\n在左下角「主题」里选一个主题再看。'
      )
    )
    return
  }

  const file = report.sources[0]?.split(/[\\/]/).pop() ?? report.file.split(/[\\/]/).pop() ?? ''
  if (titleEl) titleEl.textContent = `主题兼容度报告 · ${file.replace(/\.css$/i, '')}`

  bodyEl.append(
    el('div', 'jd-tr-path', report.file),
    statGrid()
  )

  // 丢弃的整条规则：多半是 Typora 应用外壳（侧栏/菜单/导出页），我们没有对应 DOM
  bodyEl.append(
    section('被丢弃的规则', report.droppedSamples, '通常是 Typora 外壳（侧栏 / 菜单 / 导出页），我们没有对应 DOM')
  )
  bodyEl.append(section('被改名的选择器', report.renamedSamples, '左边是主题里写的，右边是翻译后落到我们 DOM 上的'))
  bodyEl.append(section('警告', report.warnings, '不影响加载，但解释了"某处为什么和 Typora 不一样"'))
}

/** 把报告转成纯文本（贴给谁都看得懂，比截图强） */
function reportToText(): string {
  if (!report) return '当前没有应用任何 Typora 主题（内置样式）。'
  const r = report
  const lines = [
    `主题：${r.file}`,
    `内联文件 ${r.sources.length} 个：`,
    ...r.sources.map((s) => `  - ${s}`),
    `行数：${r.rawLines} → ${r.outLines}`,
    `应用 ${r.kept} 条 / 丢弃 ${r.dropped} 条`,
    `@font-face ${r.fontFaces} / @keyframes ${r.keyframes} / @import ${r.imports} / url() 重写 ${r.urls}`,
    '',
    `被丢弃的规则（${r.droppedSamples.length}）：`,
    ...r.droppedSamples.map((s) => `  - ${s}`),
    '',
    `被改名的选择器（${r.renamedSamples.length}）：`,
    ...r.renamedSamples.map((s) => `  - ${s}`),
    '',
    `警告（${r.warnings.length}）：`,
    ...r.warnings.map((s) => `  - ${s}`),
  ]
  return lines.join('\n')
}

async function copyReport(): Promise<void> {
  const text = reportToText()
  const btn = $('jd-tr-copy')
  try {
    await navigator.clipboard.writeText(text)
    btn.textContent = '已复制'
  } catch {
    // 剪贴板被拒时退回选中文本，让用户自己 Ctrl+C
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.append(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
    btn.textContent = '已复制'
  }
  window.setTimeout(() => {
    btn.textContent = '复制报告'
  }, 1500)
}
