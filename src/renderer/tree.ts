import type { FileNode } from '../shared/types.js'

export interface TreeOptions {
  root: FileNode[]
  activePath: string
  onOpen: (path: string) => void
}

/** 折叠状态跨重渲染保留（按路径记） */
const collapsed = new Set<string>()

export function renderTree(container: HTMLElement, opts: TreeOptions): void {
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
  if (!node.isDir && node.path === opts.activePath) row.classList.add('is-active')
  row.style.paddingLeft = `${8 + depth * 14}px`
  row.title = node.path

  if (node.isDir) {
    const caret = document.createElement('span')
    caret.className = 'jd-caret'
    caret.textContent = '▼'
    const isCollapsed = collapsed.has(node.path)
    if (isCollapsed) caret.classList.add('collapsed')
    row.append(caret)
  } else {
    const caret = document.createElement('span')
    caret.className = 'jd-caret'
    caret.textContent = '·'
    row.append(caret)
  }

  const name = document.createElement('span')
  name.className = 'jd-node-name'
  name.textContent = node.name.replace(/\.md$/i, '')
  row.append(name)

  const wrap = document.createElement('div')

  if (node.isDir && node.children && node.children.length > 0) {
    const children = document.createElement('div')
    children.className = 'jd-children'
    if (collapsed.has(node.path)) children.classList.add('hidden')
    for (const child of node.children) children.append(buildNode(child, depth + 1, opts))
    wrap.append(row, children)

    row.addEventListener('click', () => {
      const nowCollapsed = !collapsed.has(node.path)
      if (nowCollapsed) collapsed.add(node.path)
      else collapsed.delete(node.path)
      children.classList.toggle('hidden', nowCollapsed)
      row.querySelector('.jd-caret')?.classList.toggle('collapsed', nowCollapsed)
    })
  } else {
    wrap.append(row)
    if (!node.isDir) {
      row.addEventListener('click', () => opts.onOpen(node.path))
    } else {
      row.style.opacity = '0.55'
      row.style.cursor = 'default'
    }
  }

  return wrap
}

/** 供编辑器保存后刷新高亮 */
export function setActive(container: HTMLElement, path: string): void {
  for (const el of container.querySelectorAll('.jd-node.is-active')) el.classList.remove('is-active')
  for (const el of container.querySelectorAll<HTMLElement>('.jd-node')) {
    if (el.title === path) {
      el.classList.add('is-active')
      break
    }
  }
}
