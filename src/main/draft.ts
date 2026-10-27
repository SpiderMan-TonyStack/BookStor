/**
 * 崩溃草稿存储。
 *
 * 为什么不放 config.json（v0.1.0 就是那么干的）：
 * 草稿是「每 300ms 全量重写一遍正文」的高频写盘，而 config.json 里还躺着
 * 窗口尺寸、主题名、侧栏宽度、lastFile。两者混在一个文件里，等于：
 *   - 一篇 200KB 的笔记每敲几个字就把整个配置重写一次；
 *   - 草稿写失败（磁盘满 / 文件被锁）会连带让窗口尺寸、主题这些配置一起丢；
 *   - 反过来，改个侧栏宽度也要把 2MB 正文序列化一遍。
 * 生命周期完全不同的两类数据，不该共用一个文件。
 *
 * 所以拆出独立 draft.json，与 config.json 同目录，写盘同样是 tmp + fsync + rename。
 */

import { app } from 'electron'
import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { CrashDraft } from '../shared/types.js'
import { loadConfig, saveConfig } from './config.js'

/**
 * 单篇草稿的体积上限（**字节**，不是字符数）。
 * 中文一个字 3 字节，按 .length 判会让实际写入量到上限的 3 倍。
 * 超过就不存：这种体量基本是日志转存，不是手写笔记。
 */
const DRAFT_MAX_BYTES = 2 * 1024 * 1024

/** 上一次成功落盘的草稿，用于跳过内容未变的重复写 */
let lastPath = ''
let lastText = ''

function draftPath(): string {
  return path.join(app.getPath('userData'), 'draft.json')
}

/** tmp → fsync → rename：崩溃时最坏留一个 .tmp，draft.json 本身永远是完整 JSON */
async function writeDraftFile(draft: CrashDraft): Promise<void> {
  const file = draftPath()
  const tmp = `${file}.${randomBytes(4).toString('hex')}.tmp`
  await fs.mkdir(path.dirname(file), { recursive: true })
  let handle: import('node:fs/promises').FileHandle | null = null
  try {
    handle = await fs.open(tmp, 'w')
    await handle.writeFile(JSON.stringify(draft), 'utf8')
    // 草稿的全部意义就是扛住"下一秒断电"，所以这里必须 fsync
    await handle.sync()
    await handle.close()
    handle = null
    await fs.rename(tmp, file)
  } catch (err) {
    if (handle) await handle.close().catch(() => {})
    await fs.unlink(tmp).catch(() => {})
    throw err
  }
}

export async function saveDraft(filePath: string, text: string): Promise<boolean> {
  if (Buffer.byteLength(text, 'utf8') > DRAFT_MAX_BYTES) return false
  // 内容与上次落盘完全一致就别再写一遍：防抖管得住连续敲键，
  // 管不住"改了又改回来"，而每次都是整篇序列化。
  if (filePath === lastPath && text === lastText) return true

  await writeDraftFile({ path: filePath, text, at: Date.now() })
  lastPath = filePath
  lastText = text
  return true
}

export async function readDraft(): Promise<CrashDraft | null> {
  // 一次性迁移：v0.1.0 把草稿塞在 config.json 的 crashDraft 字段里。
  // 升级后如果直接删掉那个字段，用户就白丢一次恢复机会，所以先搬过来再清空。
  const cfg = await loadConfig()
  if (cfg.crashDraft) {
    const legacy = cfg.crashDraft
    try {
      await writeDraftFile(legacy)
      lastPath = legacy.path
      lastText = legacy.text
      await saveConfig({ crashDraft: null })
      console.info('[简牍] 已把 config.json 里的旧草稿迁移到 draft.json')
    } catch (err) {
      console.warn(`[简牍] 旧草稿迁移失败：${(err as Error).message}`)
    }
  }

  try {
    const raw = await fs.readFile(draftPath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<CrashDraft>
    if (!parsed.path || typeof parsed.text !== 'string') return null
    return { path: parsed.path, text: parsed.text, at: parsed.at ?? 0 }
  } catch {
    return null
  }
}

export async function clearDraft(): Promise<void> {
  lastPath = ''
  lastText = ''
  await fs.unlink(draftPath()).catch(() => {})
  // 顺带清掉可能残留的旧字段，避免下一轮又走迁移分支
  const cfg = await loadConfig()
  if (cfg.crashDraft) await saveConfig({ crashDraft: null })
}
