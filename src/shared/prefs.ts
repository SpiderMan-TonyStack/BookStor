/**
 * 偏好设置的**唯一真源**。
 *
 * 为什么单独成一个文件：这些开关有三个消费者（主进程落盘/夹值、渲染层应用、
 * 单测断言），而 `config.ts` 依赖 electron，**不能**被 `scripts/test-units.mjs`
 * 直接 import。所以「默认值 + 清洗规则 + 模板展开」放在这里（零依赖），
 * 主进程只负责读写文件。
 *
 * 三条原则：
 *  ① **未知键一律丢弃**：配置文件是用户可以手改的，多塞一个字段不该让整个 prefs
 *     变成 any 往下传。
 *  ② **每个键都有兜底**：读坏了回默认值，而不是让某个开关变成 undefined 导致
 *     `if (prefs.autosave)` 静默关掉自动保存 —— 这种"设置自己坏了"最难排查。
 *  ③ **夹值放在这里**：缩放 0.8–1.5、缩进只认 2/4。渲染层只负责显示，不负责校验
 *     （面板里输入 999 时，回填值必须和实际生效值一致）。
 */

export interface Prefs {
  /** 自动保存（关掉后只有 Ctrl+S 才落盘，草稿仍照常写） */
  autosave: boolean
  /** 启动时打开上次那篇（草稿那篇优先级更高，不受此开关影响） */
  restoreLastFile: boolean
  /** 列表 / 代码缩进宽度，只认 2 或 4 */
  indentWidth: number
  /** 代码块显示行号（挂在 .jd-code-line 的 ::before 上，不进 CM6 高度模型） */
  codeLineNumbers: boolean
  /** 代码块自动换行（默认关：代码横向滚动比折行更好读） */
  codeWrap: boolean
  /** 新建代码块时自动填的语言标记；空串 = 不填 */
  codeDefaultLang: string
  /** 正文段落首行缩进 2 字符（只影响 .jd-p，不碰列表/引用/代码） */
  firstLineIndent: boolean
  /** 插入图片的目录模板，支持 `${filename}`；相对路径按笔记所在目录解析 */
  imageDirTemplate: string
  /** 图片引用加 `./` 前缀（Typora 的「为相对路径添加 ./」） */
  imageRelativeDot: boolean
  /** 显示底部状态栏 */
  showStatusbar: boolean
  /** 界面缩放（webContents.setZoomFactor），0.8–1.5 */
  zoom: number
  /** 导出 PDF 后在资源管理器里定位文件 */
  openExportDir: boolean
}

/**
 * 图片目录默认值 = **当前已有行为**（`./.笔记名.assets`）。
 *
 * 刻意不用 Typora 的 `./${filename}.assets`（没有前导点）：改默认值会让新插入的
 * 图片散落到另一个目录，老笔记里已有的 `./.xxx.assets` 又不会跟着搬，
 * 一个库里出现两套目录结构。想换成 Typora 风格在面板里改模板即可。
 */
export const IMAGE_TEMPLATE_DEFAULT = './.${filename}.assets'

export const PREFS_DEFAULTS: Prefs = {
  autosave: true,
  restoreLastFile: true,
  indentWidth: 2,
  codeLineNumbers: false,
  codeWrap: false,
  codeDefaultLang: '',
  firstLineIndent: false,
  imageDirTemplate: IMAGE_TEMPLATE_DEFAULT,
  imageRelativeDot: true,
  showStatusbar: true,
  zoom: 1,
  openExportDir: false,
}

export const ZOOM_MIN = 0.8
export const ZOOM_MAX = 1.5
/** 代码块语言标记的合法形状：字母开头，允许 + - # . _ */
const LANG_SHAPE = /^[A-Za-z][\w+#.-]{0,19}$/

function pickBool(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

function pickZoom(v: unknown, fallback: number): number {
  const n = typeof v === 'number' ? v : Number.NaN
  if (!Number.isFinite(n)) return fallback
  const clamped = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, n))
  return Math.round(clamped * 100) / 100
}

function pickLang(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback
  const s = v.trim().replace(/^```+/, '')
  if (s === '') return ''
  return LANG_SHAPE.test(s) ? s : fallback
}

/**
 * 模板清洗：只做「格式」层面的处理，不碰文件系统。
 *
 * 反斜杠统一成正斜杠（`assets\${filename}` 这种手写模板在 Windows 上很自然，
 * 但拼进 markdown 会变成转义序列）；控制字符去掉；空串回落默认值。
 */
function pickTemplate(v: unknown, fallback: string): string {
  if (typeof v !== 'string') return fallback
  const s = v
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\\/g, '/')
    .trim()
  return s === '' ? fallback : s.slice(0, 200)
}

/** 未知键丢弃 + 逐键兜底。`base` 通常是「当前配置」，用于只改一个开关时保留其余。 */
export function sanitizePrefs(patch: unknown, base: Prefs = PREFS_DEFAULTS): Prefs {
  const p = (patch && typeof patch === 'object' ? patch : {}) as Partial<Prefs>
  return {
    autosave: pickBool(p.autosave, base.autosave),
    restoreLastFile: pickBool(p.restoreLastFile, base.restoreLastFile),
    indentWidth: p.indentWidth === 4 ? 4 : p.indentWidth === 2 ? 2 : base.indentWidth,
    codeLineNumbers: pickBool(p.codeLineNumbers, base.codeLineNumbers),
    codeWrap: pickBool(p.codeWrap, base.codeWrap),
    codeDefaultLang: pickLang(p.codeDefaultLang, base.codeDefaultLang),
    firstLineIndent: pickBool(p.firstLineIndent, base.firstLineIndent),
    imageDirTemplate: pickTemplate(p.imageDirTemplate, base.imageDirTemplate),
    imageRelativeDot: pickBool(p.imageRelativeDot, base.imageRelativeDot),
    showStatusbar: pickBool(p.showStatusbar, base.showStatusbar),
    zoom: pickZoom(p.zoom, base.zoom),
    openExportDir: pickBool(p.openExportDir, base.openExportDir),
  }
}

/**
 * 把 `${filename}` 换成笔记名（不带扩展名）。`${noteName}` 作为别名一起认 ——
 * Typora 的模板习惯叫 filename，我们内部一直叫 noteName，两个都收下省得用户猜。
 */
export function applyImageTemplate(template: string, filename: string): string {
  const tpl = (template || '').trim() || IMAGE_TEMPLATE_DEFAULT
  return tpl.replace(/\$\{\s*(filename|noteName)\s*\}/gi, filename)
}
