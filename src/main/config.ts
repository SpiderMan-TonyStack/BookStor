import { app } from 'electron'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { PREFS_DEFAULTS, sanitizePrefs, type Prefs } from '../shared/prefs.js'

export interface AppConfig {
  libraryRoot: string
  /** 最近打开的文件（重启后恢复） */
  lastFile: string
  windowBounds: { x?: number; y?: number; width: number; height: number }
  sidebarWidth: number
  /** 自动保存防抖（毫秒）。渲染层启动时通过 app:getAutosaveMs 读一次 */
  autosaveDebounceMs: number
  themeDir: string
  themeName: string
  /** 正文字体族；空串 = 用主题自己的字体（偏好设置 → 外观） */
  fontFamily: string
  /** 正文字号（px）；0 = 用主题自己的字号 */
  fontSize: number
  /** 用户自定义的快捷键覆盖表（cmd → Electron accelerator）。
   *  空表 = 全部用默认值。只存改过的项，默认值永远以 shared/commands.ts 为准，
   *  这样以后调默认键时不会和用户配置打架。 */
  keymap: Record<string, string>
  /**
   * 行为类偏好（编辑器 / 文件 / 图像 / 导出 / 缩放）。
   *
   * 单独收在一个对象里而不是散成一堆顶层字段：这些开关会一起被渲染层整包读写
   * （`app:getPrefs` / `app:setPrefs`），散着放就得为每个开关写一对 IPC。
   * 清洗规则在 `shared/prefs.ts` —— 那里零依赖，能被单测直接 import。
   */
  prefs: Prefs
  /** 崩溃恢复用：未落盘的内容快照
   *  @deprecated 草稿已迁到独立的 draft.json（见 src/main/draft.ts）。
   *  这里只为**迁移旧配置**保留字段：读到它就搬到 draft.json 并清空。 */
  crashDraft: { path: string; text: string; at: number } | null
}

const DEFAULTS: AppConfig = {
  libraryRoot: '',
  lastFile: '',
  windowBounds: { width: 1280, height: 860 },
  sidebarWidth: 240,
  autosaveDebounceMs: 800,
  themeDir: '',
  themeName: 'builtin-dark',
  fontFamily: '',
  fontSize: 0,
  keymap: {},
  prefs: { ...PREFS_DEFAULTS },
  crashDraft: null,
}

let cache: AppConfig | null = null
let configPath = ''

/**
 * 上次 loadConfig 是否因为「文件存在但读不懂」而回落到了默认值。
 *
 * 这条以前是纯静默的：`catch { cache = DEFAULTS }` —— JSON 写坏了、权限没了、
 * 或者手工编辑时漏了逗号，表现都是「文件树空了 / 主题变回内置」，而屏幕上
 * 没有任何提示，用户只会觉得软件坏了。现在记下来，由主进程在启动时打印，
 * 并让渲染层能查（`app:userData` 顺带带出去）。
 */
let lastLoadError = ''

export function getLastLoadError(): string {
  return lastLoadError
}

export function getConfigPath(): string {
  if (!configPath) configPath = path.join(app.getPath('userData'), 'config.json')
  return configPath
}

export async function loadConfig(): Promise<AppConfig> {
  if (cache) return cache
  let raw: string
  try {
    raw = await fs.readFile(getConfigPath(), 'utf8')
  } catch (err) {
    // 文件不存在 = 首次启动，属于正常路径，不算错误
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      lastLoadError = `读不到配置文件（${code ?? 'unknown'}）：${(err as Error).message}`
    }
    cache = { ...DEFAULTS }
    return cache
  }
  try {
    // 手工编辑配置文件时（PowerShell 的 `Set-Content -Encoding UTF8` 会带 BOM），
    // 开头的 U+FEFF 会让 JSON.parse 直接抛错，于是整个配置被静默丢成默认值 ——
    // 表现是「文件树空了」这种莫名其妙的现象。这里先剥掉。
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as Partial<AppConfig>
    // prefs 必须**逐键**合并：老配置文件里没有这个字段（升级路径），手改时漏掉
    // 某一项也很常见。直接 `{...DEFAULTS, ...parsed}` 会让整个 prefs 变成
    // undefined 或半截对象，`if (prefs.autosave)` 于是静默关掉自动保存。
    cache = { ...DEFAULTS, ...parsed, prefs: sanitizePrefs(parsed.prefs, PREFS_DEFAULTS) }
    lastLoadError = ''
  } catch (err) {
    // 文件在、但读不懂。**必须留下痕迹**，否则用户完全无从排查。
    lastLoadError = `配置文件解析失败，已回落默认值：${(err as Error).message}`
    cache = { ...DEFAULTS }
  }
  return cache
}

export async function saveConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  const cur = await loadConfig()
  const next: AppConfig = { ...cur, ...patch }
  cache = next
  const file = getConfigPath()
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  await fs.writeFile(tmp, JSON.stringify(next, null, 2), 'utf8')
  await fs.rename(tmp, file)
  return next
}

/**
 * 读当前行为偏好（已逐键兜底，调用方不用再判 undefined）。
 *
 * 单独给一个函数而不是让调用方各自 `(await loadConfig()).prefs`：
 * `prefs` 是对象，直接往外递会被调用方误改（cache 是同一个引用）。
 */
export async function getPrefs(): Promise<Prefs> {
  const cfg = await loadConfig()
  return { ...cfg.prefs }
}

/**
 * 只改传进来的那几项，其余保持当前值。
 *
 * 合并基准必须是**当前配置**而不是 DEFAULTS —— 否则面板里改一个「自动换行」，
 * 会把用户之前调过的缩放、模板一起重置回默认。这类"改 A 丢 B"的 bug
 * 只有在用户第二次打开面板时才被发现。
 *
 * **串行执行**：渲染层已经排过队（见 renderer/prefs-state.ts），这里再排一次是为了
 * 多窗口 —— 两个窗口同时改设置时，并发「读 → 合并 → 写」会互相丢更新。
 *
 * `onApply` 在**队列内部**、写盘之后调用，拿到（新值, 旧值）。需要「值变了才做」的
 * 副作用（比如缩放在所有窗口上生效）必须走这里：在队列外面自己 `getPrefs()` 取旧值
 * 再比较，两个并发请求会读到同一个旧值，判断与执行顺序都不对。
 */
let prefsChain: Promise<unknown> = Promise.resolve()

export function setPrefs(
  patch: unknown,
  onApply?: (next: Prefs, prev: Prefs) => void
): Promise<Prefs> {
  const task = prefsChain.then(async () => {
    const cur = await loadConfig()
    const prev = { ...cur.prefs }
    const next = sanitizePrefs(patch, cur.prefs)
    await saveConfig({ prefs: next })
    try {
      onApply?.(next, prev)
    } catch {
      // 副作用失败（比如窗口正在销毁）不该让这次保存算失败 —— 磁盘已经写好了
    }
    return { ...next }
  })
  prefsChain = task.catch(() => undefined)
  return task
}

/**
 * 默认主题目录：跟着 userData 走 —— 便携版是 `<exe 同级>\userdata\themes`，
 * 开发模式是项目内 `.userdata/themes`。
 *
 * 这里**刻意不再**指向 `%APPDATA%\Typora\themes`。以前那么做是为了"直接吃
 * Typora 的主题"，但它把简牍变成了半寄生状态：
 *   - 没装 Typora 的机器上目录不存在 → `theme:list` 读不到就返回 []，
 *     主题列表只剩两个内置档，而且**一声不吭** —— 纯净版拷到别的电脑，
 *     rider-dark 会静默消失；
 *   - 改主题等于改别的软件的目录，用户分不清哪份才是自己的。
 *
 * 现在由启动时的 `seedThemeDir()` 把内置主题种进这个目录，自带即用。
 * 想用 Typora 生态的主题，把 .css 拷进来即可 —— 翻译管线完全不变。
 */
export function defaultThemeDir(): string {
  return path.join(app.getPath('userData'), 'themes')
}
