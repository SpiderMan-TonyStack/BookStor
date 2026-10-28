/**
 * 可自定义快捷键的命令表 —— **唯一真相源**。
 *
 * 主进程用它生成菜单（label 和 accelerator 都从这里取），
 * 渲染层的设置面板也用它渲染列表。两边读同一份，
 * 就不会出现「设置里改了、菜单没变」这种漂移。
 *
 * 加新快捷键的步骤：在这里加一行 → 菜单里用 mi('cmd') 生成该项。
 */

export interface CommandDef {
  /** 发给渲染层的菜单命令名，同时是 keymap 里的 key */
  cmd: string
  label: string
  group: string
  /** Electron accelerator 格式；设置里改过就用 keymap 覆盖 */
  defaultKey: string
}

export const COMMANDS: CommandDef[] = [
  { cmd: 'open-library', label: '打开笔记库…', group: '文件', defaultKey: 'CmdOrCtrl+O' },
  { cmd: 'save', label: '保存', group: '文件', defaultKey: 'CmdOrCtrl+S' },
  { cmd: 'export-pdf', label: '导出 PDF…', group: '文件', defaultKey: 'CmdOrCtrl+Alt+P' },
  { cmd: 'find', label: '查找', group: '编辑', defaultKey: 'CmdOrCtrl+F' },
  { cmd: 'h1', label: '标题 1', group: '格式', defaultKey: 'CmdOrCtrl+1' },
  { cmd: 'h2', label: '标题 2', group: '格式', defaultKey: 'CmdOrCtrl+2' },
  { cmd: 'h3', label: '标题 3', group: '格式', defaultKey: 'CmdOrCtrl+3' },
  { cmd: 'h4', label: '标题 4', group: '格式', defaultKey: 'CmdOrCtrl+4' },
  { cmd: 'h5', label: '标题 5', group: '格式', defaultKey: 'CmdOrCtrl+5' },
  { cmd: 'h6', label: '标题 6', group: '格式', defaultKey: 'CmdOrCtrl+6' },
  { cmd: 'p', label: '正文', group: '格式', defaultKey: 'CmdOrCtrl+0' },
  { cmd: 'bold', label: '加粗', group: '格式', defaultKey: 'CmdOrCtrl+B' },
  { cmd: 'italic', label: '斜体', group: '格式', defaultKey: 'CmdOrCtrl+I' },
  { cmd: 'code', label: '行内代码', group: '格式', defaultKey: 'CmdOrCtrl+Shift+`' },
  // 和「行内代码」是两回事：行内代码插一对单反引号（`x`），这个是三反引号的独立代码块。
  // 默认键沿用 Typora 的习惯（Ctrl+Shift+K），从 Typora 迁过来的人不用重新记。
  { cmd: 'codeblock', label: '代码块', group: '格式', defaultKey: 'CmdOrCtrl+Shift+K' },
  // 视图模式：只改"怎么看"，不动文档。默认键避开 CM6 自带的绑定（Ctrl+Shift+F 会撞搜索）。
  { cmd: 'focus-mode', label: '专注模式', group: '视图', defaultKey: 'CmdOrCtrl+Alt+F' },
  { cmd: 'typewriter-mode', label: '打字机模式', group: '视图', defaultKey: 'CmdOrCtrl+Alt+T' },
  // Typora 的源码模式习惯键，从那边迁过来不用重新记
  { cmd: 'source-mode', label: '源码模式', group: '视图', defaultKey: 'CmdOrCtrl+/' },
]

/** 用户自定义的覆盖表：cmd → accelerator。空表表示全用默认 */
export type Keymap = Record<string, string>

/** 某个命令当前生效的快捷键（用户改过就用改过的，否则用默认） */
export function keyOf(cmd: string, keymap: Keymap): string {
  const user = keymap[cmd]
  if (user) return user
  return COMMANDS.find((c) => c.cmd === cmd)?.defaultKey ?? ''
}

/** 这个命令是否被用户改过（设置面板要据此显示「改过」的标记） */
export function isCustomized(cmd: string, keymap: Keymap): boolean {
  return Object.prototype.hasOwnProperty.call(keymap, cmd)
}

/**
 * Electron accelerator → 给人看的样子。
 *
 * accelerator 是跨平台写法（CmdOrCtrl 在 mac 上是 Cmd），
 * 但界面里直接显示 `CmdOrCtrl+S` 很怪，Windows 上统一显示成 Ctrl。
 */
export function prettyKey(accel: string): string {
  if (!accel) return ''
  return accel
    .replace(/CommandOrControl/g, 'Ctrl')
    .replace(/CmdOrCtrl/g, 'Ctrl')
    .replace(/Command/g, 'Cmd')
    .replace(/Control/g, 'Ctrl')
    .replace(/Return/g, 'Enter')
}

/** 只按下修饰键时的 e.key，这些不能当主键 */
const MODIFIER_KEYS = new Set([
  'Control',
  'Shift',
  'Alt',
  'Meta',
  'AltGraph',
  'CapsLock',
  'NumLock',
  'ScrollLock',
  'Dead',
  'Unidentified',
  'Process',
])

/** e.key → Electron accelerator 里的键名（只列和 e.key 不一致的） */
const KEY_ALIAS: Record<string, string> = {
  ' ': 'Space',
  Spacebar: 'Space',
  Escape: 'Esc',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Delete: 'Delete',
  Backspace: 'Backspace',
  Enter: 'Return',
  Tab: 'Tab',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Insert: 'Insert',
  ContextMenu: 'Menu',
  PrintScreen: 'PrintScreen',
}

/** KeyboardEvent 里我们需要的那几个字段（不依赖 DOM 类型，主进程也能引用这个模块） */
export interface KeyLike {
  key: string
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  metaKey: boolean
}

export interface AccelResult {
  accel?: string
  error?: string
}

/**
 * 把一次按键转成 Electron accelerator。
 *
 * 规则：
 *   - 只按修饰键 → 不算（用户还在按组合键的中间过程）
 *   - 没有任何 Ctrl / Alt / Shift 的普通字符键 → 拒绝。否则会抢掉正常输入
 *   - F1–F24 例外：单按也允许（F 键本来就是功能键）
 *   - 修饰键顺序固定为 Ctrl → Alt → Shift，保证同一组合只有一种写法
 */
export function accelFromKey(e: KeyLike): AccelResult {
  if (MODIFIER_KEYS.has(e.key)) return { error: '只按了修饰键，继续按组合的最后一个键' }

  const mods: string[] = []
  if (e.ctrlKey || e.metaKey) mods.push('CmdOrCtrl')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')

  const main = normalizeKey(e.key)
  if (!main) return { error: `「${e.key}」不能用作快捷键` }

  const isFunctionKey = /^F([1-9]|1\d|2[0-4])$/.test(main)
  if (mods.length === 0 && !isFunctionKey) {
    return { error: '至少要带一个 Ctrl / Alt / Shift' }
  }

  return { accel: [...mods, main].join('+') }
}

function normalizeKey(key: string): string | null {
  // 别名必须**先**查：`' '`（空格）的 length 是 1，会掉进下面的单字符分支，
  // 于是 `KEY_ALIAS[' '] = 'Space'` 永远轮不到 —— 录出来的 accelerator 变成
  // `CmdOrCtrl+ `（尾部一个空格），Electron 不认，等于绑了一个永远不触发的键。
  const alias = KEY_ALIAS[key]
  if (alias) return alias

  if (key.length === 1) {
    // 字母统一大写，避免 'ctrl+s' 和 'Ctrl+S' 被当成两个不同的键；
    // 符号（` / - / = / 等）原样保留，Electron 认这些字符
    return key.toUpperCase()
  }
  // F1–F24 的 e.key 本来就是 'F1' 这种形式
  if (/^F\d{1,2}$/.test(key)) return key
  return null
}

/** 同一组合的不同写法（大小写）视为同一个键 */
export function sameAccel(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}
