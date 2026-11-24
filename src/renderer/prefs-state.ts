/**
 * 渲染层的行为偏好状态（编辑器 / 文件 / 图像 / 外观 / 导出）。
 *
 * 为什么要有这一层，而不是各处直接调 `window.api.getPrefs()`：
 *
 *  ① **应用点只有一处**。五个开关里有三个是靠 `#write` 上的 class 生效的
 *     （代码行号 / 自动换行 / 首行缩进），一个状态栏开关靠 body class。散着写
 *     就会出现「改了设置，但某处忘了同步」—— 表现是重启后才生效。
 *  ② **读一次，同步读**。`scheduleSave()` 在每次敲键时都要判断「自动保存开没开」，
 *     不能每次都 await 一次 IPC。启动时读进内存，之后只在本模块里改。
 *  ③ **保存失败不改内存值**。主进程是唯一的夹值权威（缩放 0.8–1.5、缩进只认 2/4），
 *     写失败就保住旧值，避免面板显示 150%、实际还是 100%。
 *
 * ⚠ 本模块的 `chain` 与主进程 `config.ts` 的 `prefsChain` 是**两道独立队列**：
 * 渲染层保证同一个窗口里的请求有序、且内存态只被最新结果覆盖；主进程保证多窗口
 * 并发时「读 → 合并 → 写」不互相丢更新。缺任何一道都会出问题（见 savePrefs 注释）。
 */

import { PREFS_DEFAULTS, type Prefs } from '../shared/prefs.js'

/** 偏好变化事件：main.ts 用它重新测量 CM6（class 变了 → 行高可能变） */
export const PREFS_CHANGED = 'jd-prefs-changed'

let current: Prefs = { ...PREFS_DEFAULTS }

/**
 * 所有读写共用的**串行队列**。
 *
 * 读也要排队（`loadPrefs` 会先等它）：面板打开时若正好有一次保存在飞，
 * 「读盘」可能读到写盘前的旧值，然后用旧值覆盖内存态 —— 表现是刚点开的开关
 * 又自己弹回去。这类问题只在慢盘 / 首次启动时偶发，最难复现。
 */
let chain: Promise<unknown> = Promise.resolve()

export function getPrefs(): Prefs {
  return current
}

/**
 * 读一次（启动时 + 每次打开面板时）。读失败就用默认值 —— 偏好读不到不该挡住开笔记。
 */
export async function loadPrefs(): Promise<Prefs> {
  await chain.catch(() => undefined)
  try {
    current = await window.api.getPrefs()
  } catch (err) {
    console.warn('[简牍] 读取偏好设置失败，使用默认值：', err)
    current = { ...PREFS_DEFAULTS }
  }
  applyPrefs()
  return current
}

/**
 * 改几项：主进程落盘 + 夹值，成功后才更新内存并重新应用。
 *
 * 为什么要排队（踩出来的）：连点四个开关会并发发出四次 `setPrefs`，主进程每次都要
 * 「读配置 → 合并 → 写盘」；两个请求可以交错读到同一份旧值，响应回来的顺序也不保证。
 * 结果是**内存里的 prefs 被一个过期的响应覆盖** —— 磁盘上四项都存对了，界面上却
 * 少两个 class（实测只剩 `jd-code-lineno`，自动换行和首行缩进当场失效）。
 */
export function savePrefs(patch: Partial<Prefs>): Promise<Prefs> {
  const task = chain.then(
    async () => {
      try {
        current = await window.api.setPrefs(patch)
      } catch (err) {
        console.warn('[简牍] 保存偏好设置失败：', err)
        return current
      }
      applyPrefs()
      window.dispatchEvent(new CustomEvent(PREFS_CHANGED, { detail: current }))
      return current
    },
    // 上一轮失败了也要继续排队：一次写盘失败不该让后续设置永久改不动
    async () => current
  )
  chain = task.catch(() => undefined)
  return task
}

/**
 * 把偏好映射成 DOM 状态。
 *
 * 全部用 class 而不是改内联样式：主题可能也想给 `.jd-code-line` 写规则，
 * class 开关能和主题的规则共存，内联样式则会不可逆地压过去。
 */
export function applyPrefs(): void {
  const body = document.body
  body.classList.toggle('jd-hide-statusbar', !current.showStatusbar)

  const write = document.getElementById('write')
  if (!write) return
  write.classList.toggle('jd-code-lineno', current.codeLineNumbers)
  write.classList.toggle('jd-code-wrap', current.codeWrap)
  write.classList.toggle('jd-first-indent', current.firstLineIndent)
}
