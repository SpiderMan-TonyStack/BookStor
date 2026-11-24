/**
 * 自绘右键菜单（4.8.0）。
 *
 * 为什么不用 Electron 的 `Menu.popup()`（主进程原生菜单）：
 *   1. 原生菜单由 **主进程** 画，CDP 点不到、自动化验收只能靠肉眼 ——
 *      而这个项目每一条交互都有探针覆盖，弹不出来等于没验过；
 *   2. 样式跟不了主题（Windows 原生菜单只有深/浅两套，跟 rider-dark 的
 *      侧栏配色是两回事，中间会露出一块很突兀的系统灰）；
 *   3. 菜单项要带「文档树」那种**勾选状态**和「删除」的警示色，原生菜单
 *      的 checkbox/颜色能力有限。
 *
 * 代价是要自己处理：定位钳制、点外面关闭、Esc 关闭、键盘上下选择、
 * 滚动/失焦自动收起 —— 这些都在这个文件里，别在调用方重写一遍。
 */

export interface MenuItem {
  /** 分隔线：`{ sep: true }`，其余字段忽略 */
  sep?: boolean
  label?: string
  /** 打勾（「文档树」这种互斥视图切换用） */
  checked?: boolean
  disabled?: boolean
  /** 危险动作（删除）：文字用警示色 */
  danger?: boolean
  /** 右侧灰色提示（快捷键 / 目标名） */
  hint?: string
  onClick?: () => void
}

/** 当前打开着的菜单（同时只允许一个） */
let openBox: HTMLElement | null = null
let detach: (() => void) | null = null

/** 关掉当前菜单（没有就什么都不做） */
export function closeContextMenu(): void {
  if (detach) {
    detach()
    detach = null
  }
  if (openBox) {
    openBox.remove()
    openBox = null
  }
}

/**
 * 在 (x, y) 处弹出菜单。
 *
 * 坐标是**视口坐标**（`clientX/clientY`）：菜单本身是 `position: fixed`，
 * 用 `pageX/pageY` 会在滚动过的文档里偏掉一整屏。
 */
export function showContextMenu(items: MenuItem[], x: number, y: number): void {
  closeContextMenu()
  if (items.length === 0) return

  const box = document.createElement('div')
  box.className = 'jd-menu'
  box.setAttribute('role', 'menu')

  const rows: HTMLElement[] = []
  for (const item of items) {
    if (item.sep) {
      const hr = document.createElement('div')
      hr.className = 'jd-menu-sep'
      box.append(hr)
      continue
    }
    const row = document.createElement('div')
    row.className = 'jd-menu-item'
    if (item.checked) row.classList.add('is-checked')
    if (item.disabled) row.classList.add('is-disabled')
    if (item.danger) row.classList.add('is-danger')
    row.setAttribute('role', 'menuitem')

    const check = document.createElement('span')
    check.className = 'jd-menu-check'
    check.textContent = item.checked ? '✓' : ''
    row.append(check)

    const label = document.createElement('span')
    label.className = 'jd-menu-label'
    label.textContent = item.label ?? ''
    row.append(label)

    if (item.hint) {
      const hint = document.createElement('span')
      hint.className = 'jd-menu-hint'
      hint.textContent = item.hint
      row.append(hint)
    }

    if (!item.disabled && item.onClick) {
      const act = item.onClick
      row.addEventListener('click', (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        closeContextMenu()
        act()
      })
    }
    if (!item.disabled) rows.push(row)
    box.append(row)
  }

  document.body.append(box)

  // 先摆一个不进视口的位置再量：菜单宽度由最长的一项决定，
  // 直接写死 200px 会让「打开文件位置」这类长标签换行
  box.style.left = '0px'
  box.style.top = '0px'
  const rect = box.getBoundingClientRect()
  const W = rect.width
  const H = rect.height
  // 右下角贴边时翻到左/上侧，任何方向都不出窗口（探针会量这个）
  const left = x + W > window.innerWidth - 4 ? Math.max(4, window.innerWidth - W - 4) : Math.max(4, x)
  const top = y + H > window.innerHeight - 4 ? Math.max(4, window.innerHeight - H - 4) : Math.max(4, y)
  box.style.left = `${Math.round(left)}px`
  box.style.top = `${Math.round(top)}px`
  openBox = box

  // ---- 键盘：↑↓ 移动，Enter 执行，Esc 关闭 ----
  let cursor = -1
  const highlight = (next: number): void => {
    if (rows.length === 0) return
    const clamped = ((next % rows.length) + rows.length) % rows.length
    rows[cursor]?.classList.remove('is-current')
    cursor = clamped
    rows[cursor]!.classList.add('is-current')
    rows[cursor]!.scrollIntoView({ block: 'nearest' })
  }
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === 'Escape') {
      // 别让它继续冒泡到全局 Esc（那里是"收起恢复条 / 关面板"）
      ev.preventDefault()
      ev.stopPropagation()
      closeContextMenu()
      return
    }
    if (ev.key === 'ArrowDown') {
      ev.preventDefault()
      ev.stopPropagation()
      highlight(cursor + 1)
      return
    }
    if (ev.key === 'ArrowUp') {
      ev.preventDefault()
      ev.stopPropagation()
      highlight(cursor - 1)
      return
    }
    if (ev.key === 'Enter' && cursor >= 0) {
      ev.preventDefault()
      ev.stopPropagation()
      rows[cursor]!.click()
    }
  }

  // ---- 关闭条件 ----
  // mousedown 而不是 click：菜单项自己用 click，如果用 click 关，
  // 点空白处时菜单先消失、点击又落到下面的文件树上（误触打开别的笔记）
  const onDown = (ev: MouseEvent): void => {
    if (ev.target instanceof Node && box.contains(ev.target)) return
    closeContextMenu()
  }
  const onScroll = (): void => closeContextMenu()
  const onBlur = (): void => closeContextMenu()

  document.addEventListener('mousedown', onDown, true)
  window.addEventListener('keydown', onKey, true)
  // 滚动与失焦都要收：菜单是 fixed 定位，滚走之后它会诡异地贴在半空
  window.addEventListener('scroll', onScroll, true)
  window.addEventListener('blur', onBlur)
  window.addEventListener('resize', onScroll)

  detach = (): void => {
    document.removeEventListener('mousedown', onDown, true)
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('scroll', onScroll, true)
    window.removeEventListener('blur', onBlur)
    window.removeEventListener('resize', onScroll)
  }
}
