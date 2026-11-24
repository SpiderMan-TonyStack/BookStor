import { languages } from '@codemirror/language-data'

/**
 * 代码块语言选择浮层。
 *
 * 语言列表**直接用 `@codemirror/language-data` 的 `languages`**，不另抄一份：
 * 那份表就是编辑器用来做语法高亮的同一份（`markdown({codeLanguages: languages})`），
 * 自己维护一份迟早漂 —— 列表里有、点了却没高亮，或者反过来。
 *
 * 只读 `name`/`alias`，**不触发任何 language 模块的加载**（support 是动态 import，
 * 悬停在列表上不该拉 20 个语言包）。
 *
 * 交互照抄编辑器里的命令面板习惯：
 *   - 打开即聚焦搜索框，输入即过滤（匹配 name 或 alias）
 *   - ↑/↓ 移动、Enter 选中、Esc / 点外面关掉
 *   - 打开前先记住选区，关闭时把焦点还给编辑器
 */

export interface LangEntry {
  /** 给人看的名字（`C++` / `Python`） */
  name: string
  alias: readonly string[]
  /** 写进围栏的标记：**优先用别名**（`cpp` / `python`），没有就用小写名字。
   *  为什么不直接用 name：围栏里写 ` ```C++ ` 虽然 CodeMirror 认（它的大小写无关匹配
   *  覆盖 name 与 alias），但 Typora / GitHub 的惯例是小写短名，看着也更像那么回事。 */
  token: string
}

/** 「不指定语言」—— 选它等于把围栏后面那截清掉 */
const CLEAR: LangEntry = { name: '纯文本（不指定语言）', alias: [], token: '' }

/** 供 UI 用的精简表（name + alias + 写进围栏的 token），按名字排序 */
const ENTRIES: LangEntry[] = languages
  .map((l) => {
    const alias = (l.alias ?? []) as readonly string[]
    return { name: l.name, alias, token: alias[0] ?? l.name.toLowerCase() }
  })
  .sort((a, b) => a.name.localeCompare(b.name))

let active: { close: () => void } | null = null

/** 关掉当前浮层（切文件、切主题、失焦时调用） */
export function closeLangPicker(): void {
  active?.close()
}

/**
 * 打开语言浮层。
 *
 * `anchor` 是那个小徽章的矩形（用它的右上角定位），`current` 用来打勾，
 * `onPick` 收到语言名（空串表示"纯文本 / 去掉语言"）。
 */
export function openLangPicker(opts: {
  anchor: DOMRect
  current: string
  onPick: (lang: string) => void
}): void {
  closeLangPicker()

  const box = document.createElement('div')
  box.className = 'jd-langpick'

  const search = document.createElement('input')
  search.className = 'jd-langpick-search'
  search.type = 'text'
  search.placeholder = '搜索语言…'
  search.spellcheck = false

  const list = document.createElement('div')
  list.className = 'jd-langpick-list'
  list.setAttribute('role', 'listbox')

  box.append(search, list)
  document.body.append(box)

  // 先摆位置再量尺寸：宽度固定，高度随候选数变化，放不下就往上翻
  const W = 240
  const maxH = 320
  let left = Math.min(Math.max(8, opts.anchor.right - W), window.innerWidth - W - 8)
  let top = opts.anchor.bottom + 6
  if (top + maxH > window.innerHeight - 8) top = Math.max(8, opts.anchor.top - maxH - 6)
  box.style.left = `${Math.round(left)}px`
  box.style.top = `${Math.round(top)}px`
  box.style.width = `${W}px`

  let items: LangEntry[] = []
  let cursor = 0

  const render = (): void => {
    list.textContent = ''
    const shown = items.slice(0, 200)
    shown.forEach((it, i) => {
      const row = document.createElement('div')
      row.className = 'jd-langpick-item' + (i === cursor ? ' is-current' : '')
      row.dataset['token'] = it.token
      // 名字要用 span 包起来才收得住：裸文本节点吃不到 flex 的 min-width:0，
      // 长名字（Angular Template）会把别名挤出浮层、逼出一条横向滚动条
      const name = document.createElement('span')
      name.className = 'jd-langpick-name'
      name.textContent = it.name
      row.append(name)
      if (it.alias.length) {
        const alias = document.createElement('span')
        alias.className = 'jd-langpick-alias'
        alias.textContent = it.alias.slice(0, 3).join(' ')
        row.append(alias)
      }
      if (it.token === opts.current || it.name === opts.current) row.classList.add('is-selected')
      list.append(row)
    })
    const cur = list.children[cursor] as HTMLElement | undefined
    if (cur) cur.scrollIntoView({ block: 'nearest' })
  }

  const filter = (): void => {
    const q = search.value.trim().toLowerCase()
    items = q
      ? ENTRIES.filter(
          (e) =>
            e.name.toLowerCase().includes(q) ||
            e.token.includes(q) ||
            e.alias.some((a) => a.toLowerCase().includes(q))
        )
      : [CLEAR, ...ENTRIES]
    // 精确命中当前值/常见别名时不必滚动 —— 直接把光标放在第一条
    cursor = 0
    render()
  }

  const close = (): void => {
    box.remove()
    document.removeEventListener('mousedown', onOutside, true)
    window.removeEventListener('keydown', onKey, true)
    if (active?.close === close) active = null
  }

  const onOutside = (ev: MouseEvent): void => {
    if (!box.contains(ev.target as Node)) close()
  }

  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      ev.preventDefault()
      ev.stopPropagation()
      close()
      return
    }
    if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') {
      ev.preventDefault()
      ev.stopPropagation()
      if (items.length === 0) return
      cursor = (cursor + (ev.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length
      render()
      return
    }
    if (ev.key === 'Enter') {
      ev.preventDefault()
      ev.stopPropagation()
      const pick = items[cursor]
      if (pick) {
        close()
        opts.onPick(pick.token)
      }
      return
    }
    // 其它按键留给输入框
  }

  search.addEventListener('input', filter)
  // 浮层里的 mousedown 不要冒泡到编辑器，否则选区被清、编辑器失焦
  box.addEventListener('mousedown', (ev) => ev.stopPropagation())
  list.addEventListener('mousedown', (ev) => {
    const row = (ev.target as HTMLElement | null)?.closest<HTMLElement>('.jd-langpick-item')
    if (!row) return
    ev.preventDefault()
    const token = row.dataset['token'] ?? ''
    close()
    opts.onPick(token)
  })

  document.addEventListener('mousedown', onOutside, true)
  window.addEventListener('keydown', onKey, true)

  filter()
  search.focus()
  active = { close }
}
