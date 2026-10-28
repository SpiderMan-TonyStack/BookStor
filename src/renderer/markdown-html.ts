import { markdownLanguage } from '@codemirror/lang-markdown'
import type { SyntaxNode } from '@lezer/common'

/**
 * Markdown → HTML（PDF 导出用）。
 *
 * **为什么自己写，不用 pandoc**：本机根本没有 pandoc（策划案里"已装"那句已经过期），
 * 而引一个外部二进制意味着用户换台机器就得先装它。
 *
 * **为什么这不算"第二套 markdown 解析"**：解析器用的是 `markdownLanguage.parser` ——
 * 就是编辑器里跑的那一个（`editor.ts` 的 `markdown({base: markdownLanguage})`）。
 * 这里只负责把**同一棵树**输出成 HTML，换行、围栏配对、表格识别这些判断都没有第二份实现。
 * 真正的判断（`stepFence` / `parseHeading`）仍然只在 fence.ts / heading.ts 里。
 *
 * 输出的 class 名直接沿用 `theme/mapping.json` 的语义类（`jd-h1` / `jd-table` / `jd-code-block`…），
 * 这样套上同一个主题 CSS，PDF 和屏幕上是同一套样式。
 */

/** 纯语法标记：渲染时跳过（内容由父节点按位置补齐） */
const SKIP = new Set([
  'HeaderMark',
  'EmphasisMark',
  'CodeMark',
  'LinkMark',
  'QuoteMark',
  'ListMark',
  'TableDelimiter',
  'CodeInfo',
])

const HEADING: Record<string, number> = {
  ATXHeading1: 1,
  ATXHeading2: 2,
  ATXHeading3: 3,
  ATXHeading4: 4,
  ATXHeading5: 5,
  ATXHeading6: 6,
  SetextHeading1: 1,
  SetextHeading2: 2,
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;')
}

/** 渲染一个节点：子节点之间的空隙按原文补齐（Lezer 的纯文本没有独立节点） */
function renderRange(node: SyntaxNode, src: string): string {
  let out = ''
  let pos = node.from
  let child = node.firstChild
  while (child) {
    if (child.from > pos) out += escapeHtml(src.slice(pos, child.from))
    out += renderNode(child, src)
    pos = child.to
    child = child.nextSibling
  }
  if (pos < node.to) out += escapeHtml(src.slice(pos, node.to))
  return out
}

function childOf(node: SyntaxNode, name: string): SyntaxNode | null {
  let c = node.firstChild
  while (c) {
    if (c.name === name) return c
    c = c.nextSibling
  }
  return null
}

/**
 * 渲染 `[from, to)` 这一段（含其中的子节点）。
 * 链接/图片的可见文本要用它：那部分没有独立的父节点，只能按范围取。
 */
function renderSlice(parent: SyntaxNode, from: number, to: number, src: string): string {
  let out = ''
  let pos = from
  let child = parent.firstChild
  while (child) {
    if (child.to <= from) {
      child = child.nextSibling
      continue
    }
    if (child.from >= to) break
    if (child.from > pos) out += escapeHtml(src.slice(pos, child.from))
    out += renderNode(child, src)
    pos = Math.max(pos, child.to)
    child = child.nextSibling
  }
  if (pos < to) out += escapeHtml(src.slice(pos, to))
  return out
}

/** 链接/图片的可见文本：第一个 `[` 之后到 `]` 之前的那些子节点 */
function linkLabel(node: SyntaxNode, src: string): string {
  const marks: SyntaxNode[] = []
  let c = node.firstChild
  while (c) {
    if (c.name === 'LinkMark') marks.push(c)
    c = c.nextSibling
  }
  if (marks.length < 2) return ''
  return renderSlice(node, marks[0]!.to, marks[1]!.from, src)
}

/** 从 `[a](b)` 里取 b */
function linkTarget(node: SyntaxNode, src: string): string {
  const url = childOf(node, 'URL')
  if (url) return src.slice(url.from, url.to)
  // 尖括号形式 <http://…>
  let c = node.firstChild
  while (c) {
    if (c.name === 'LinkMark' && src.slice(c.from, c.to) === '(') {
      const next = c.nextSibling
      if (next) return src.slice(next.from, next.to)
    }
    c = c.nextSibling
  }
  return ''
}

/** 表格每列的对齐，来自分隔行 `| :-- | :-: | --: |` */
function tableAligns(table: SyntaxNode, src: string): (string | null)[] {
  const delim = childOf(table, 'TableDelimiter')
  if (!delim) return []
  return src
    .slice(delim.from, delim.to)
    .split('|')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && /^:?-+:?$/.test(s))
    .map((s) => (s.startsWith(':') && s.endsWith(':') ? 'center' : s.endsWith(':') ? 'right' : s.startsWith(':') ? 'left' : null))
}

function renderTable(table: SyntaxNode, src: string): string {
  const aligns = tableAligns(table, src)
  const cellStyle = (i: number): string => {
    const a = aligns[i]
    return a ? ` style="text-align:${a}"` : ''
  }

  let head = ''
  const bodyRows: string[] = []

  let c = table.firstChild
  while (c) {
    if (c.name === 'TableHeader') {
      const cells: string[] = []
      // TableHeader 直接包着 TableCell（不是 TableRow），一开始按三层取，结果表头是空的
      let cell = c.firstChild
      while (cell) {
        if (cell.name === 'TableCell') cells.push(renderRange(cell, src).trim())
        cell = cell.nextSibling
      }
      head = `<thead><tr>${cells.map((t, i) => `<th class="jd-table-head-cell"${cellStyle(i)}>${t}</th>`).join('')}</tr></thead>`
    } else if (c.name === 'TableRow') {
      const cells: string[] = []
      let cell = c.firstChild
      while (cell) {
        if (cell.name === 'TableCell') cells.push(renderRange(cell, src).trim())
        cell = cell.nextSibling
      }
      bodyRows.push(
        `<tr>${cells.map((t, i) => `<td class="jd-table-cell"${cellStyle(i)}>${t}</td>`).join('')}</tr>`
      )
    }
    c = c.nextSibling
  }

  const body = bodyRows.length > 0 ? `<tbody>${bodyRows.join('')}</tbody>` : ''
  return `<table class="jd-table">${head}${body}</table>`
}

function renderCodeBlock(node: SyntaxNode, src: string): string {
  const raw = src.slice(node.from, node.to)
  const info = childOf(node, 'CodeInfo')
  // CodeInfo 只覆盖语言名本身（不含反引号）
  const lang = info ? src.slice(info.from, info.to).trim() : ''

  // 去掉首行围栏和末行围栏，中间才是代码
  const firstNl = raw.indexOf('\n')
  let bodyRaw = firstNl >= 0 ? raw.slice(firstNl + 1) : ''
  if (node.name === 'FencedCode') {
    bodyRaw = bodyRaw.replace(/\n?[ \t]*(```+|~~~+)[ \t]*\s*$/, '')
  }
  const cls = lang ? ` class="language-${escapeAttr(lang)}"` : ''
  return `<pre class="jd-code-block"><code${cls}>${escapeHtml(bodyRaw)}</code></pre>`
}

function renderNode(node: SyntaxNode, src: string): string {
  const name = node.name

  if (SKIP.has(name)) return ''

  const heading = HEADING[name]
  if (heading) {
    return `<h${heading} class="jd-h${heading}">${renderRange(node, src).trim()}</h${heading}>`
  }

  switch (name) {
    case 'Document':
      return renderRange(node, src)
    case 'Paragraph':
      return `<p class="jd-p">${renderRange(node, src)}</p>`
    case 'Blockquote':
      return `<blockquote class="jd-quote">${renderRange(node, src)}</blockquote>`
    case 'BulletList':
      return `<ul class="jd-list">${renderRange(node, src)}</ul>`
    case 'OrderedList':
      return `<ol class="jd-list-ordered">${renderRange(node, src)}</ol>`
    case 'ListItem': {
      // tight list 的项里只有一个 Paragraph，别再包一层 <p>（HTML 里那样会多出段落间距）。
      // 注意 ListItem 的第一个子节点是 ListMark（`- ` 那个标记），所以要先把标记滤掉再数。
      const kids: SyntaxNode[] = []
      let k = node.firstChild
      while (k) {
        if (!SKIP.has(k.name)) kids.push(k)
        k = k.nextSibling
      }
      if (kids.length === 1 && kids[0]!.name === 'Paragraph') {
        return `<li class="jd-li">${renderRange(kids[0]!, src)}</li>`
      }
      return `<li class="jd-li">${renderRange(node, src)}</li>`
    }
    case 'HorizontalRule':
      return '<hr class="jd-hr" />'
    case 'FencedCode':
    case 'CodeBlock':
      return renderCodeBlock(node, src)
    case 'CodeText':
      return escapeHtml(src.slice(node.from, node.to))
    case 'StrongEmphasis':
      return `<strong>${renderRange(node, src)}</strong>`
    case 'Emphasis':
      return `<em>${renderRange(node, src)}</em>`
    case 'Strikethrough':
      return `<del>${renderRange(node, src)}</del>`
    case 'InlineCode':
      return `<code class="jd-code-inline">${escapeHtml(
        src.slice(node.from, node.to).replace(/^`+|`+$/g, '')
      )}</code>`
    case 'HardBreak':
      return '<br />'
    case 'Link': {
      const href = linkTarget(node, src)
      const label = linkLabel(node, src) || escapeHtml(href)
      return `<a class="jd-link" href="${escapeAttr(href)}">${label}</a>`
    }
    case 'Image': {
      const srcUrl = linkTarget(node, src)
      const alt = linkLabel(node, src).replace(/<[^>]*>/g, '')
      return `<img class="jd-img" src="${escapeAttr(srcUrl)}" alt="${escapeAttr(alt)}" />`
    }
    case 'Table':
      return renderTable(node, src)
    case 'Task':
    case 'TaskMarker':
      return escapeHtml(src.slice(node.from, node.to))
    default:
      return renderRange(node, src)
  }
}

/**
 * 整篇转 HTML（**片段**，不含 `<html>` 外壳 —— 外壳由调用方按需要包）。
 * 图片相对路径请由调用方转成绝对 `file://`，这里保持原样。
 */
export function markdownToHtml(src: string): string {
  const tree = markdownLanguage.parser.parse(src)
  return renderNode(tree.topNode, src).trim()
}
