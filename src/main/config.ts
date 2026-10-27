import { app } from 'electron'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'

export interface AppConfig {
  libraryRoot: string
  /** 最近打开的文件（重启后恢复） */
  lastFile: string
  openTabs: string[]
  windowBounds: { x?: number; y?: number; width: number; height: number }
  sidebarWidth: number
  autosaveDebounceMs: number
  themeDir: string
  themeName: string
  /** 崩溃恢复用：未落盘的内容快照
   *  @deprecated 草稿已迁到独立的 draft.json（见 src/main/draft.ts）。
   *  这里只为**迁移旧配置**保留字段：读到它就搬到 draft.json 并清空。 */
  crashDraft: { path: string; text: string; at: number } | null
}

const DEFAULTS: AppConfig = {
  libraryRoot: '',
  lastFile: '',
  openTabs: [],
  windowBounds: { width: 1280, height: 860 },
  sidebarWidth: 240,
  autosaveDebounceMs: 800,
  themeDir: '',
  themeName: 'builtin-dark',
  crashDraft: null,
}

let cache: AppConfig | null = null
let configPath = ''

export function getConfigPath(): string {
  if (!configPath) configPath = path.join(app.getPath('userData'), 'config.json')
  return configPath
}

export async function loadConfig(): Promise<AppConfig> {
  if (cache) return cache
  try {
    const raw = await fs.readFile(getConfigPath(), 'utf8')
    // 手工编辑配置文件时（PowerShell 的 `Set-Content -Encoding UTF8` 会带 BOM），
    // 开头的 U+FEFF 会让 JSON.parse 直接抛错，于是整个配置被静默丢成默认值 ——
    // 表现是「文件树空了」这种莫名其妙的现象。这里先剥掉。
    const parsed = JSON.parse(raw.replace(/^\uFEFF/, '')) as Partial<AppConfig>
    cache = { ...DEFAULTS, ...parsed }
  } catch {
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
