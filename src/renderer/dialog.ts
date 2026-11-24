/**
 * 自绘模态框（4.8.0）：输入框 / 确认 / 属性。
 *
 * 为什么不用 `window.prompt` / `window.confirm`：
 *   - 它们是**阻塞式原生框**，样式不可改（白底系统框贴在深色界面上很突兀），
 *     而且 `prompt` 在 Electron 里表现不稳定（有些平台直接返回 null）；
 *   - 阻塞期间渲染层完全停摆，截图与自动化都会卡住（这个项目在 `confirm` 上
 *     踩过一次，见 README 的坑表）。
 *
 * 三个入口共用同一套挂载 / 关闭逻辑：`openPrompt`、`openConfirm`、`openInfo`。
 * **关闭只走 `closeModal()` 一条路** —— 快捷键的恢复写在 teardown 里，
 * 多一条关闭路径就会漏掉恢复，表现为「关掉对话框后快捷键全失灵」。
 */

import { isKeymapPaused, setKeymapPaused } from './keybindings.js'

let root: HTMLElement | null = null
let teardown: (() => void) | null = null

/** 关掉当前模态框（没有就什么都不做） */
export function closeModal(): void {
  if (teardown) {
    const fn = teardown
    teardown = null
    fn()
  }
  if (root) {
    root.remove()
    root = null
  }
}

/** 当前是否开着（调用方用来避免叠两层） */
export function isModalOpen(): boolean {
  return root !== null
}

interface MountOptions {
  title: string
  body: HTMLElement
  footer: HTMLElement
  /** 打开后第一件要做的事（聚焦输入框 / 全选） */
  initialFocus?: () => void
  /** 关掉之后要做的事（不论怎么关的） */
  onClose?: () => void
}

function mount(opts: MountOptions): void {
  closeModal()

  const mask = document.createElement('div')
  mask.className = 'jd-modal-mask'

  const box = document.createElement('div')
  box.className = 'jd-modal'
  box.setAttribute('role', 'dialog')
  box.setAttribute('aria-modal', 'true')

  const title = document.createElement('div')
  title.className = 'jd-modal-title'
  title.textContent = opts.title

  const foot = document.createElement('div')
  foot.className = 'jd-modal-foot'
  foot.append(opts.footer)

  box.append(title, opts.body, foot)
  mask.append(box)
  document.body.append(mask)
  root = mask

  // 对话框期间暂停快捷键：否则在输入框里按 Ctrl+S 会真的保存一次笔记、
  // 按 Ctrl+F 会把焦点抢到编辑器搜索框 —— 用户只是想输个文件名。
  const wasPaused = isKeymapPaused()
  setKeymapPaused(true)

  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Escape') return
    ev.preventDefault()
    // 别让 Esc 冒泡到全局（那里的 Esc 是"收起恢复条 / 关面板"）
    ev.stopPropagation()
    closeModal()
  }

  const onMaskDown = (ev: MouseEvent): void => {
    if (ev.target === mask) closeModal()
  }

  mask.addEventListener('mousedown', onMaskDown)
  window.addEventListener('keydown', onKey, true)

  teardown = (): void => {
    mask.removeEventListener('mousedown', onMaskDown)
    window.removeEventListener('keydown', onKey, true)
    if (!wasPaused) setKeymapPaused(false)
    opts.onClose?.()
  }

  requestAnimationFrame(() => {
    if (opts.initialFocus) opts.initialFocus()
    else box.querySelector<HTMLElement>('button.jd-modal-ok')?.focus()
  })
}

function makeButton(label: string, kind: 'ok' | 'cancel'): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.className = kind === 'ok' ? 'jd-modal-ok' : 'jd-modal-cancel'
  btn.textContent = label
  return btn
}

export interface PromptOptions {
  title: string
  /** 输入框上方的说明（比如「在 备忘录 里新建文件」） */
  label?: string
  value?: string
  placeholder?: string
  okText?: string
  /** 返回错误文字 → 不关闭，就地红字提示；返回 null 表示通过 */
  validate?: (value: string) => string | null
  onOk: (value: string) => void | Promise<void>
}

/** 单行输入对话框（新建文件 / 新建文件夹 / 重命名） */
export function openPrompt(opts: PromptOptions): void {
  const body = document.createElement('div')
  body.className = 'jd-modal-body'

  if (opts.label) {
    const label = document.createElement('div')
    label.className = 'jd-modal-label'
    label.textContent = opts.label
    body.append(label)
  }

  const input = document.createElement('input')
  input.type = 'text'
  input.className = 'jd-modal-input'
  input.value = opts.value ?? ''
  if (opts.placeholder) input.placeholder = opts.placeholder
  input.spellcheck = false
  input.autocomplete = 'off'
  body.append(input)

  const error = document.createElement('div')
  error.className = 'jd-modal-error'
  body.append(error)

  const cancel = makeButton('取消', 'cancel')
  const ok = makeButton(opts.okText ?? '确定', 'ok')
  const actions = document.createElement('div')
  actions.className = 'jd-modal-actions'
  actions.append(cancel, ok)

  const submit = async (): Promise<void> => {
    const value = input.value
    const bad = opts.validate ? opts.validate(value) : null
    if (bad) {
      error.textContent = bad
      input.focus()
      return
    }
    error.textContent = ''
    ok.disabled = true
    cancel.disabled = true
    try {
      await opts.onOk(value)
      closeModal()
    } catch (err) {
      ok.disabled = false
      cancel.disabled = false
      error.textContent = err instanceof Error ? err.message : String(err)
    }
  }

  ok.addEventListener('click', () => void submit())
  cancel.addEventListener('click', () => closeModal())
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault()
      void submit()
    }
  })
  // 输入即清错，别让红字一直挂着
  input.addEventListener('input', () => {
    if (error.textContent) error.textContent = ''
  })

  mount({
    title: opts.title,
    body,
    footer: actions,
    // 全选：重命名时用户最想做的就是直接敲新名字
    initialFocus: () => {
      input.focus()
      input.select()
    },
  })
}

export interface ConfirmOptions {
  title: string
  message: string
  /** 补充说明（小字，比如"文件会移到系统回收站"） */
  detail?: string
  okText?: string
  danger?: boolean
  onOk: () => void | Promise<void>
}

/** 确认对话框（删除这类不可轻率的动作） */
export function openConfirm(opts: ConfirmOptions): void {
  const body = document.createElement('div')
  body.className = 'jd-modal-body'

  const msg = document.createElement('div')
  msg.className = 'jd-modal-message'
  msg.textContent = opts.message
  body.append(msg)

  if (opts.detail) {
    const detail = document.createElement('div')
    detail.className = 'jd-modal-detail'
    detail.textContent = opts.detail
    body.append(detail)
  }

  const error = document.createElement('div')
  error.className = 'jd-modal-error'
  body.append(error)

  const cancel = makeButton('取消', 'cancel')
  const ok = makeButton(opts.okText ?? '确定', 'ok')
  if (opts.danger) ok.classList.add('is-danger')

  const actions = document.createElement('div')
  actions.className = 'jd-modal-actions'
  actions.append(cancel, ok)

  const submit = async (): Promise<void> => {
    ok.disabled = true
    cancel.disabled = true
    try {
      await opts.onOk()
      closeModal()
    } catch (err) {
      ok.disabled = false
      cancel.disabled = false
      error.textContent = err instanceof Error ? err.message : String(err)
    }
  }

  ok.addEventListener('click', () => void submit())
  cancel.addEventListener('click', () => closeModal())

  mount({
    title: opts.title,
    body,
    footer: actions,
    initialFocus: () => ok.focus(),
  })
}

export interface InfoRow {
  label: string
  value: string
  /** 值用等宽字体显示（路径、时间戳） */
  mono?: boolean
}

export interface InfoOptions {
  title: string
  rows: InfoRow[]
  /** 值可复制时的按钮文字（不传就不显示） */
  copyText?: string
  onCopy?: () => void
}

/** 只读信息面板（右键「属性」） */
export function openInfo(opts: InfoOptions): void {
  const body = document.createElement('div')
  body.className = 'jd-modal-body'

  const table = document.createElement('div')
  table.className = 'jd-modal-props'
  for (const row of opts.rows) {
    const k = document.createElement('div')
    k.className = 'jd-modal-prop-key'
    k.textContent = row.label
    const v = document.createElement('div')
    v.className = 'jd-modal-prop-val' + (row.mono ? ' is-mono' : '')
    v.textContent = row.value
    // 路径这种长值要能选中复制（不是 input，所以要显式开 user-select）
    v.title = row.value
    table.append(k, v)
  }
  body.append(table)

  const actions = document.createElement('div')
  actions.className = 'jd-modal-actions'

  if (opts.copyText && opts.onCopy) {
    const copy = makeButton(opts.copyText, 'cancel')
    const onCopy = opts.onCopy
    copy.addEventListener('click', () => onCopy())
    actions.append(copy)
  }

  const ok = makeButton('关闭', 'ok')
  ok.addEventListener('click', () => closeModal())
  actions.append(ok)

  mount({
    title: opts.title,
    body,
    footer: actions,
    initialFocus: () => ok.focus(),
  })
}
