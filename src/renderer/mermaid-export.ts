import { markdownLanguage } from '@codemirror/lang-markdown'
import type { SyntaxNode } from '@lezer/common'
import { withLightTheme } from './mermaid.js'

/**
 * PDF 导出时把 ```mermaid 换成真图。
 *
 * 为什么需要单独一个文件：渲染层里那些图只活在 CM6 的 widget 缓存里
 * （`mermaid.ts` 的 `cache`，键是代码内容），导出走的是另一条路 ——
 * `markdownToHtml()` 产出一份静态 HTML，然后交给隐藏窗口 printToPDF。
 * 那条路上没有任何 widget，所以以前 PDF 里的 mermaid 就是一段代码块。
 *
 * 做法：先找出文档里所有 ```mermaid 块的**原文**，逐个渲染成 SVG 字符串，
 * 然后按顺序把 HTML 里对应的 `<pre class="jd-code-block"><code class="language-mermaid">…`
 * 换掉。渲染复用 mermaid.ts 的那一份实现（同一套 initialize / 同一个缓存键），
 * 保证纸面和屏幕上的图长得一样。
 *
 * 失败时**保留代码块**（不吞内容）：图和原文都在 PDF 里，至少能读到。
 */

/** 与 mermaid.ts 的 MermaidWidget 同一个 class，主题的 .jd-mermaid 规则能直接套上 */
const WRAP_CLASS = 'jd-mermaid'

/** 从 Lezer 树上按顺序摘出所有 mermaid 代码块的内容（与编辑器同一棵解析树） */
function collectMermaidBlocks(src: string): string[] {
  const parser = markdownLanguage.parser
  const tree = parser.parse(src)
  const out: string[] = []

  const visit = (node: SyntaxNode): void => {
    if (node.name === 'FencedCode') {
      // CodeInfo 只覆盖语言名本身
      let info: SyntaxNode | null = node.firstChild
      while (info && info.name !== 'CodeInfo') info = info.nextSibling
      const lang = info ? src.slice(info.from, info.to).trim().toLowerCase() : ''
      if (lang === 'mermaid') {
        const raw = src.slice(node.from, node.to)
        const firstNl = raw.indexOf('\n')
        let body = firstNl >= 0 ? raw.slice(firstNl + 1) : ''
        // 去掉收尾围栏
        body = body.replace(/\n?[ \t]*(```+|~~~+)[ \t]*\s*$/, '')
        if (body.trim()) out.push(body.trim())
      }
      return
    }
    let c = node.firstChild
    while (c) {
      visit(c)
      c = c.nextSibling
    }
  }

  visit(tree.topNode)
  return out
}

/** 渲染单个 mermaid 源码为 SVG（失败返回 null，调用方保留代码块） */
async function renderOne(code: string): Promise<string | null> {
  try {
    const mod = await import('mermaid')
    const mermaid = mod.default
    // 配色由调用方用 withLightTheme 切好（导出页统一白底，浅色才不别扭）。
    // 这里**不能再 initialize** —— 那会把全局配置改掉且不还原，
    // 导出完编辑器里的图就跟着变浅色了。
    const { svg } = await mermaid.render(`jd-pdf-mermaid-${Math.random().toString(36).slice(2, 8)}`, code)
    return svg
  } catch (err) {
    console.warn('[简牍] PDF 里的 mermaid 渲染失败，保留代码块', err)
    return null
  }
}

/**
 * 把 HTML 里的 mermaid 代码块替换成图。
 *
 * 按**出现顺序**替换（第 i 个 mermaid 块 → 第 i 张图），而不是按文本匹配：
 * 同一段 mermaid 源码在文档里出现两次时，按文本替换会把两处都换成同一张图，
 * 顺序匹配才不会错位。数量不一致（解析树和 HTML 不一致）时退化为「只换能对上的」。
 *
 * 整段包在 `withLightTheme` 里：导出页是白底，图也得用浅色档；
 * 而 `mermaid.initialize` 是全局的，不还原的话导出一次 PDF
 * 就会把编辑器里的图也换成浅色档。
 */
export async function inlineMermaidSvgs(html: string, src: string): Promise<string> {
  const codes = collectMermaidBlocks(src)
  if (codes.length === 0) return html

  const svgs: (string | null)[] = []
  await withLightTheme(async () => {
    for (const code of codes) {
      // 串行渲染：mermaid.render 并发会互相干扰（和 mermaid.ts 的 scanAndRender 一致）
      svgs.push(await renderOne(code))
    }
  })

  let i = 0
  // 语言名大小写不敏感：```Mermaid 在 markdown-html 里会写成 language-Mermaid，
  // 而 collectMermaidBlocks 已经统一 lowerCase 过了，这里不跟着放宽就会漏换
  return html.replace(
    /<pre class="jd-code-block"><code class="language-mermaid">[\s\S]*?<\/code><\/pre>/gi,
    (whole) => {
      const svg = svgs[i++]
      if (!svg) return whole
      return `<div class="${WRAP_CLASS}">${svg}</div>`
    }
  )
}
