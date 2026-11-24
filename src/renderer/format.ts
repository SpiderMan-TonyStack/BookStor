/**
 * 展示用的格式化函数（4.8.0）。
 *
 * 单独一份、零依赖：`scripts/test-units.mjs` 会直接用 Node 的类型剥离 import 它。
 * 放在 `file-ops.ts` 里的话，单测一 import 就会把 `dialog.js` / `menu.js`
 * 整条 DOM 依赖链拉进来，而 Node 不做 `.js` → `.ts` 的扩展名替换，直接报错。
 */

/** 字节数 → 人类可读（与资源管理器一致：字节 / KB / MB） */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '未知'
  if (bytes < 1024) return `${bytes} 字节`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

/** 时间戳 → `2026-11-12 16:07`（本地时区，24 小时制；无效时间返回「未知」） */
export function formatTime(ms: number): string {
  const d = new Date(ms)
  if (!Number.isFinite(ms) || Number.isNaN(d.getTime())) return '未知'
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/** 按扩展名给个中文类型名（属性面板用） */
export function fileKind(name: string): string {
  if (/\.markdown$/i.test(name)) return 'Markdown 文档（.markdown）'
  if (/\.txt$/i.test(name)) return '纯文本（.txt）'
  return 'Markdown 文档'
}
