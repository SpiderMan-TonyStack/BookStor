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
  // 下划线在 markdown 里没有原生语法，Typora 用 <u>…</u>，我们照抄
  { cmd: 'underline', label: '下划线', group: '格式', defaultKey: 'CmdOrCtrl+U' },
  { cmd: 'code', label: '行内代码', group: '格式', defaultKey: 'CmdOrCtrl+Shift+`' },
  // 和「行内代码」是两回事：行内代码插一对单反引号（`x`），这个是三反引号的独立代码块。
  // 默认键沿用 Typora 的习惯（Ctrl+Shift+K），从 Typora 迁过来的人不用重新记。
  { cmd: 'codeblock', label: '代码块', group: '格式', defaultKey: 'CmdOrCtrl+Shift+K' },
  { cmd: 'strikethrough', label: '删除线', group: '格式', defaultKey: 'Alt+Shift+5' },
  // Typora 的「高亮」本来就不带默认键，这里保持一致；想绑就自己去快捷键面板绑
  { cmd: 'highlight', label: '高亮', group: '格式', defaultKey: '' },
  { cmd: 'comment', label: '注释', group: '格式', defaultKey: 'CmdOrCtrl+Alt+/' },
  { cmd: 'link', label: '超链接', group: '格式', defaultKey: 'CmdOrCtrl+K' },
  { cmd: 'clear-format', label: '清除样式', group: '格式', defaultKey: 'CmdOrCtrl+\\' },
  // ---- 段落（4.3.0）：块级操作。和上面的行内样式分开成一组，
  //      因为菜单里它们本来就分属两个顶级菜单（Typora 的「格式」/「段落」），
  //      设置面板按 group 分组，也就跟着分开了。
  { cmd: 'promote-heading', label: '提升标题级别', group: '段落', defaultKey: 'CmdOrCtrl+=' },
  { cmd: 'demote-heading', label: '降低标题级别', group: '段落', defaultKey: 'CmdOrCtrl+-' },
  { cmd: 'quote', label: '引用', group: '段落', defaultKey: 'CmdOrCtrl+Shift+Q' },
  { cmd: 'ol', label: '有序列表', group: '段落', defaultKey: 'CmdOrCtrl+Shift+[' },
  { cmd: 'ul', label: '无序列表', group: '段落', defaultKey: 'CmdOrCtrl+Shift+]' },
  { cmd: 'task-list', label: '任务列表', group: '段落', defaultKey: 'CmdOrCtrl+Shift+X' },
  // 代码块和公式块都是「围栏类」，键位沿用 Typora：Ctrl+Shift+K / Ctrl+Shift+M
  { cmd: 'math-block', label: '公式块', group: '段落', defaultKey: 'CmdOrCtrl+Shift+M' },
  // 下面这些 Typora 也不给默认键（用得少，占着键位反而浪费）
  { cmd: 'table', label: '表格', group: '段落', defaultKey: '' },
  // 表格列对齐（4.4.0）：GFM 里只有分隔行的冒号能表达对齐，所以这四条命令
  // 只改「光标所在列」那一格。默认不给键 —— Typora 也没给，用得不多。
  { cmd: 'align-left', label: '左对齐', group: '段落', defaultKey: '' },
  { cmd: 'align-center', label: '居中对齐', group: '段落', defaultKey: '' },
  { cmd: 'align-right', label: '右对齐', group: '段落', defaultKey: '' },
  { cmd: 'align-default', label: '默认对齐', group: '段落', defaultKey: '' },
  { cmd: 'admonition', label: '警告框', group: '段落', defaultKey: '' },
  { cmd: 'hr', label: '水平分割线', group: '段落', defaultKey: '' },
  { cmd: 'toc', label: '内容目录', group: '段落', defaultKey: '' },
  { cmd: 'footnote', label: '脚注', group: '段落', defaultKey: '' },
  { cmd: 'ref-link', label: '链接引用', group: '段落', defaultKey: '' },
  { cmd: 'front-matter', label: 'YAML Front Matter', group: '段落', defaultKey: '' },
  { cmd: 'paragraph-above', label: '在上方插入段落', group: '段落', defaultKey: '' },
  { cmd: 'paragraph-below', label: '在下方插入段落', group: '段落', defaultKey: '' },
  { cmd: 'task-done', label: '任务状态：标记完成', group: '段落', defaultKey: '' },
  { cmd: 'task-todo', label: '任务状态：标记未完成', group: '段落', defaultKey: '' },
  // 缩进 Tab / Shift+Tab 已由 CM6 的 indentWithTab 接管；这两条是给菜单用的入口
  { cmd: 'indent-more', label: '增加缩进', group: '段落', defaultKey: '' },
  { cmd: 'indent-less', label: '减少缩进', group: '段落', defaultKey: '' },
  // 视图模式：只改"怎么看"，不动文档。默认键避开 CM6 自带的绑定（Ctrl+Shift+F 会撞搜索）。
  { cmd: 'focus-mode', label: '专注模式', group: '视图', defaultKey: 'CmdOrCtrl+Alt+F' },
  { cmd: 'typewriter-mode', label: '打字机模式', group: '视图', defaultKey: 'CmdOrCtrl+Alt+T' },
  // Typora 的源码模式习惯键，从那边迁过来不用重新记
  { cmd: 'source-mode', label: '源码模式', group: '视图', defaultKey: 'CmdOrCtrl+/' },
  // 诊断用：翻译管线丢了哪些规则、改了哪些选择器
  { cmd: 'theme-report', label: '主题兼容度报告', group: '视图', defaultKey: 'CmdOrCtrl+Alt+R' },
  // 偏好设置：Ctrl+, 是各平台的通用习惯（VS Code / Rider / macOS 都这样）。
  // 进这张表而不是在菜单里硬写 accelerator —— 这样菜单显示、渲染层分发、
  // 快捷键设置里能改，三条路径读的是同一份定义。
  { cmd: 'prefs', label: '偏好设置…', group: '设置', defaultKey: 'CmdOrCtrl+,' },
  // 快捷键面板本身也进这张表，否则它列不出自己、也没法给它绑键。
  // 给空默认键：不硬塞一个没人要的全局快捷键，但用户可以自己绑。
  { cmd: 'settings', label: '快捷键…', group: '设置', defaultKey: '' },
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
 * Shift 之后的符号 → 键位本身。
 *
 * 必须做这一步：`KeyboardEvent.key` 给的是**字符**，不是键位。
 * 按 Ctrl+Shift+[ 时 e.key 是 `{`，按 Alt+Shift+5 时是 `%` —— 于是录出来/比对的是
 * `CmdOrCtrl+Shift+{`，跟命令表里写的 `CmdOrCtrl+Shift+[` 永远对不上。
 * Electron 的 accelerator 认的是**键位**（`Ctrl+Shift+[` 就是「按住 shift 敲 [ 键」），
 * 所以这里把符号还原回基础键位。
 *
 * 只收美式布局的常见映射；其它布局下用户改绑一次即可（比瞎猜更安全）。
 */
const SHIFTED_ALIAS: Record<string, string> = {
  '~': '`',
  '!': '1',
  '@': '2',
  '#': '3',
  $: '4',
  '%': '5',
  '^': '6',
  '&': '7',
  '*': '8',
  '(': '9',
  ')': '0',
  _: '-',
  '+': '=',
  '{': '[',
  '}': ']',
  '|': '\\',
  ':': ';',
  '"': "'",
  '<': ',',
  '>': '.',
  '?': '/',
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

  const main = normalizeKey(e.key, e.shiftKey)
  if (!main) return { error: `「${e.key}」不能用作快捷键` }

  const isFunctionKey = /^F([1-9]|1\d|2[0-4])$/.test(main)
  if (mods.length === 0 && !isFunctionKey) {
    return { error: '至少要带一个 Ctrl / Alt / Shift' }
  }

  return { accel: [...mods, main].join('+') }
}

function normalizeKey(key: string, shiftHeld = false): string | null {
  // 别名必须**先**查：`' '`（空格）的 length 是 1，会掉进下面的单字符分支，
  // 于是 `KEY_ALIAS[' '] = 'Space'` 永远轮不到 —— 录出来的 accelerator 变成
  // `CmdOrCtrl+ `（尾部一个空格），Electron 不认，等于绑了一个永远不触发的键。
  const alias = KEY_ALIAS[key]
  if (alias) return alias

  // 按住 Shift 时 e.key 是字符（`{` / `%` / `_`），得还原成键位（见 SHIFTED_ALIAS）
  if (shiftHeld) {
    const base = SHIFTED_ALIAS[key]
    if (base) return base
  }

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
