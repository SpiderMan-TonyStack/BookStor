/**
 * 渲染层快捷键分发。
 *
 * 为什么不能只靠 Electron 菜单的 accelerator：
 * 菜单 accelerator 和 CodeMirror 自己的 keymap 会抢同一组按键，而且 **CM6 常常赢**。
 * 实测把「代码块」绑到 Ctrl+Shift+K（Typora 的习惯）后，按下只是让 CM6 执行了
 * deleteLine —— 文档少了一行，命令根本没触发，还不报错。更糟的是 Ctrl+I
 * 正好撞上 CM6 的 selectParentSyntax，而那是「斜体」的默认键。
 *
 * 所以这里在 window 的 **capture 阶段**统一拦截：命中某条命令就执行并
 * stopPropagation —— capture 阶段早于 CM6 挂在内容元素上的 handler，
 * CM6 完全收不到这个 keydown，也就不会顺手做别的事。
 *
 * 菜单那边仍然保留 accelerator：一是菜单里能显示当前快捷键（说明书作用），
 * 二是两条路径都执行同一个 runCommand，谁先赢结果都一样，不会分叉。
 */

import { COMMANDS, keyOf, accelFromKey, sameAccel, type Keymap } from '../shared/commands.js'

/** 真正执行命令的回调，由 main.ts 注入（避免和 main.ts 循环依赖） */
let exec: ((cmd: string) => void) | null = null
let keymap: Keymap = {}

/**
 * 暂停分发。
 * 设置面板打开时要暂停：否则用户点开「保存」的录制框、按下 Ctrl+S，
 * 会先被这里拦下来真的保存一次，录制框什么都录不到。
 */
let paused = false

export function setKeymapPaused(value: boolean): void {
  paused = value
}

/** 从配置重新拉一次覆盖表（改完快捷键、或启动时） */
export async function reloadKeymap(): Promise<void> {
  try {
    const data = await window.api.getKeymap()
    keymap = data.keymap ?? {}
  } catch {
    keymap = {}
  }
}

export function installKeybindings(executor: (cmd: string) => void): void {
  exec = executor
  void reloadKeymap()
  // capture: true —— 必须在 CM6 之前拿到按键，这是整套方案的立足点
  window.addEventListener('keydown', onKeydown, true)
}

function onKeydown(e: KeyboardEvent): void {
  if (!exec) return
  if (paused) return
  // 中文输入法组字过程中，Ctrl/Shift 也在参与组字，别抢
  if (e.isComposing) return
  // 长按会连续触发，格式化命令不该重复包裹
  if (e.repeat) return

  const res = accelFromKey(e)
  if (!res.accel) return

  const hit = COMMANDS.find((c) => sameAccel(keyOf(c.cmd, keymap), res.accel as string))
  if (!hit) return

  e.preventDefault()
  e.stopPropagation()
  exec(hit.cmd)
}
