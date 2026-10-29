import { app } from 'electron'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'

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
  /** 用户自定义的快捷键覆盖表（cmd → Electron accelerator）。
   *  空表 = 全部用默认值。只存改过的项，默认值永远以 shared/commands.ts 为准，
   *  这样以后调默认键时不会和用户配置打架。 */
  keymap: Record<string, string>
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
  keymap: {},
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
    cache = { ...DEFAULTS, ...parsed }
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

/** 默认搜索 Typora 的主题目录（实测位置） */
export function defaultThemeDir(): string {
  return path.join(app.getPath('appData'), 'Typora', 'themes')
}
