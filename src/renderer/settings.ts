/**
 * 快捷键设置面板。
 *
 * 交互设计：点按键框 → 进入录制 → 按下组合键 → **立刻生效**（没有「应用」按钮）。
 * 失败原因（只按修饰键 / 没修饰键 / 已被占用）当场写在底部，并保持录制状态，
 * 不用重新点一次框。
 *
 * 两个必须小心的地方：
 *
 * ① 录制期间要让主进程把菜单的 accelerator 全摘掉（setCaptureMode(true)）。
 *    Electron 是在**主进程**处理菜单快捷键的，按键到不了渲染层 ——
 *    想把已经绑给「保存」的 Ctrl+S 改走，一按就触发保存，录制框什么都收不到。
 *
 * ② 监听必须挂在 window 的 **capture 阶段**并 stopPropagation。
 *    否则 CM6 会先吃掉这个 keydown（它自己绑了一堆键），表现同样是「按了没反应」。
 */

import {
  COMMANDS,
  keyOf,
  isCustomized,
  prettyKey,
  accelFromKey,
  sameAccel,
  type CommandDef,
  type Keymap,
} from '../shared/commands.js'

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T

let overlay: HTMLElement | null = null
let listEl: HTMLElement | null = null
let msgEl: HTMLElement | null = null

let keymap: Keymap = {}
let commands: CommandDef[] = COMMANDS
/** 正在录制哪条命令；null = 没在录 */
let capturing: string | null = null
let msgTimer: number | null = null

export function isSettingsOpen(): boolean {
  ensureRefs()
  return !!overlay && !overlay.classList.contains('hidden')
}

export async function openSettings(): Promise<void> {
  ensureRefs()
  if (!overlay) return
  overlay.classList.remove('hidden')
  const data = await window.api.getKeymap()
  keymap = data.keymap ?? {}
  commands = data.commands && data.commands.length > 0 ? data.commands : COMMANDS
  render()
  showMsg('')
}

export function closeSettings(): void {
  ensureRefs()
  if (!overlay) return
  stopCapture()
  overlay.classList.add('hidden')
  showMsg('')
}

function ensureRefs(): void {
  if (overlay) return
  overlay = $('jd-settings')
  listEl = $('jd-settings-list')
  msgEl = $('jd-settings-msg')
  $('jd-settings-close').addEventListener('click', () => closeSettings())
  $('jd-settings-reset').addEventListener('click', () => void resetAll())
  // 点遮罩空白处关闭（点面板内部不关）
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) closeSettings()
  })
  // capture 阶段：抢在 CM6 之前拿到按键
  window.addEventListener('keydown', onKeydown, true)
}

function render(): void {
  if (!listEl) return
  listEl.textContent = ''

  let group = ''
  for (const cmd of commands) {
    if (cmd.group !== group) {
      group = cmd.group
      const g = document.createElement('div')
      g.className = 'jd-key-group'
      g.textContent = group
      listEl.append(g)
    }

    const row = document.createElement('div')
    row.className = 'jd-key-row'

    const label = document.createElement('span')
    label.className = 'jd-key-label'
    label.textContent = cmd.label

    const btn = document.createElement('button')
    btn.className = 'jd-key-btn'
    btn.dataset['cmd'] = cmd.cmd
    if (capturing === cmd.cmd) {
      btn.classList.add('is-capturing')
      btn.textContent = '按下组合键…'
    } else {
      if (isCustomized(cmd.cmd, keymap)) btn.classList.add('is-custom')
      btn.textContent = prettyKey(keyOf(cmd.cmd, keymap)) || '（未设置）'
    }
    btn.addEventListener('click', () => toggleCapture(cmd.cmd))

    const clear = document.createElement('button')
    clear.className = 'jd-key-clear'
    clear.title = '恢复这一项的默认快捷键'
    clear.textContent = '↺'
    clear.disabled = !isCustomized(cmd.cmd, keymap)
    clear.addEventListener('click', () => void resetOne(cmd.cmd))

    row.append(label, btn, clear)
    listEl.append(row)
  }
}

function toggleCapture(cmd: string): void {
  if (capturing === cmd) {
    stopCapture()
    render()
    showMsg('已取消')
    return
  }
  if (capturing !== null) {
    // 从 A 直接点到 B：先把上一轮录制的菜单状态恢复干净再开始
    stopCapture()
  }
  capturing = cmd
  window.api.setCaptureMode(true)
  render()
  showMsg(`按下「${labelOf(cmd)}」的新组合键…（Esc 取消，Backspace 清除）`)
  listEl?.querySelector<HTMLButtonElement>(`.jd-key-btn[data-cmd="${cmd}"]`)?.focus()
}

function stopCapture(): void {
  if (capturing === null) return
  capturing = null
  window.api.setCaptureMode(false)
}

function onKeydown(e: KeyboardEvent): void {
  if (!isSettingsOpen()) return

  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    if (capturing !== null) {
      stopCapture()
      render()
      showMsg('已取消')
    } else {
      closeSettings()
    }
    return
  }

  if (capturing === null) return

  // 录制中：所有按键都不许漏给编辑器
  e.preventDefault()
  e.stopPropagation()

  const cmd = capturing

  if (e.key === 'Backspace' || e.key === 'Delete') {
    stopCapture()
    const next = { ...keymap }
    delete next[cmd]
    void persist(next, `「${labelOf(cmd)}」已恢复默认`)
    return
  }

  const res = accelFromKey(e)
  if (!res.accel) {
    showMsg(res.error ?? '这个键不能用作快捷键', true)
    return // 保持录制，让用户直接重按
  }

  const accel = res.accel
  const clash = commands.find((c) => c.cmd !== cmd && sameAccel(keyOf(c.cmd, keymap), accel))
  if (clash) {
    showMsg(`「${prettyKey(accel)}」已经被「${clash.label}」占用`, true)
    return
  }

  stopCapture()
  const next = { ...keymap, [cmd]: accel }
  void persist(next, `「${labelOf(cmd)}」→ ${prettyKey(accel)}`)
}

async function persist(next: Keymap, okText: string): Promise<void> {
  keymap = await window.api.setKeymap(next)
  render()
  showMsg(okText)
}

async function resetOne(cmd: string): Promise<void> {
  if (capturing !== null) stopCapture()
  const next = { ...keymap }
  delete next[cmd]
  await persist(next, `「${labelOf(cmd)}」已恢复默认`)
}

async function resetAll(): Promise<void> {
  if (capturing !== null) stopCapture()
  await persist({}, '已全部恢复默认')
}

function labelOf(cmd: string): string {
  return commands.find((c) => c.cmd === cmd)?.label ?? cmd
}

function showMsg(text: string, isError = false): void {
  if (!msgEl) return
  msgEl.textContent = text
  msgEl.classList.toggle('is-err', isError)
  if (msgTimer !== null) window.clearTimeout(msgTimer)
  msgTimer = text
    ? window.setTimeout(() => {
        if (msgEl) msgEl.textContent = ''
      }, 5000)
    : null
}
