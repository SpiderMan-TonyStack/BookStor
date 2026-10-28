import type { ThemePayload } from '../shared/types.js'
// 以字符串方式引入，运行时按固定顺序注入 —— 见下方注释
import fixCss from './theme-fix.css?inline'
import guardCss from './shell-guard.css?inline'

/**
 * 主题挂载（策划案 §5.3 最后一环）。
 *
 * 为什么不用 <link> 排顺序：
 * Vite 会把渲染层所有的 <link>/import 合成**一个**产物 CSS，并把运行时注入的
 * <style> 留在它前面 —— 结果外壳的 `body{font-family:'Microsoft YaHei'}` 反过来
 * 压住主题的 `body{font-family:var(--body-font)}`（实测 bodyFont 是雅黑而不是
 * Source Sans Pro）。所以主题层不能靠 HTML 里的位置，必须在运行时追加到 head 末尾。
 *
 * 顺序（后者覆盖前者）：
 *   产物 CSS（style.css 外壳 + theme-base.css 骨架）
 *   → <style id="jd-typora-theme">   翻译后的主题本体
 *   → <style id="jd-theme-fix">      结构修正（代码块拼回一个框）
 *   → <style id="jd-shell-guard">    外壳保护（ID 选择器，必须最后）
 *
 * 不用 @layer：CodeMirror 6 运行时注入的是**未分层**样式，未分层规则永远压过
 * 分层规则，一分层就会让 CM6 的默认值反噬主题。
 */

let payload: ThemePayload | null = null

function ensureStyle(id: string, css = ''): HTMLStyleElement {
  let el = document.getElementById(id) as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = id
    document.head.append(el)
  }
  if (css) el.textContent = css
  return el
}

/** 把三层按顺序挂到 head 末尾。幂等：已存在则只补内容、不重排。 */
function mountLayers(): void {
  ensureStyle('jd-typora-theme')
  ensureStyle('jd-theme-fix', fixCss)
  ensureStyle('jd-shell-guard', guardCss)
}

export function currentThemeReport(): ThemePayload['report'] | null {
  return payload?.report ?? null
}

export function currentThemeVars(): Record<string, string> {
  return payload?.vars ?? {}
}

/** 翻译后的主题 CSS 原文（PDF 导出要把它原样塞进打印页，保证版式和屏幕上一致） */
export function currentThemeCss(): string {
  return payload?.css ?? ''
}

/**
 * 判断当前主题是深是浅，让 Windows 原生标题栏跟着切。
 *
 * 依据是**实际渲染出来的 body 背景色**，不是主题声明的 `--bg-color` ——
 * 有的主题压根不定义那个变量，直接在 body 上写 background，取计算值最稳。
 * getComputedStyle 会强制 flush 样式，所以刚挂上的主题也能立刻读到新值。
 *
 * 亮度用 ITU-R BT.601 的加权（人眼对绿最敏感、红线权最低）。
 * 直接拿 RGB 三通道平均会在深蓝、深红这类色上判错 —— 比如 #2b2b2b 平均下来
 * 离阈值很远，但 #1e3a5f 这种深海军蓝按平均算是"亮"，看着却是深色。
 */
function syncTitleBarTheme(): void {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(getComputedStyle(document.body).backgroundColor)
  if (!m) return
  const lum =
    (0.299 * Number(m[1]) + 0.587 * Number(m[2]) + 0.114 * Number(m[3])) / 255
  window.api.setTitleBarTheme(lum < 0.5 ? 'dark' : 'light')
}

export async function applyTheme(name: string): Promise<ThemePayload | null> {
  mountLayers()
  const el = ensureStyle('jd-typora-theme')

  if (!name) {
    el.textContent = ''
    payload = null
    delete document.documentElement.dataset.theme
    delete document.documentElement.dataset.themeFonts
    syncTitleBarTheme()
    return null
  }

  const result = await window.api.translateTheme(name)
  el.textContent = result.css
  payload = result
  document.documentElement.dataset.theme = name
  // 主题自带 @font-face 时，字体在 file:// 下要等加载完才生效。
  // 把数量挂到 html 上，排查「字体没生效」时能立刻区分「没声明」和「路径错」。
  document.documentElement.dataset.themeFonts = String(result.report.fontFaces)
  syncTitleBarTheme()
  return result
}

/** 主题文件被改（热重载）：重跑翻译 */
export async function reloadTheme(name: string): Promise<ThemePayload | null> {
  return applyTheme(name)
}
