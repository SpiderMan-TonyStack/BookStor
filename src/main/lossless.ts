/**
 * 无损编码层 —— 整个项目最重要的一个文件。
 *
 * 目标：读进来再写回去，磁盘上的字节必须完全一致（BOM、换行符、末尾换行全都要保）。
 *
 * 实测数据（D:\BaiduSyncdisk\笔记，245 篇）：
 *   - 纯 CRLF 188 篇 / 纯 LF 54 篇 / 单篇内部混用 0 篇
 *   - 4 篇带 UTF-8 BOM
 *   - 123 篇末尾没有换行符
 * 这三项只要错一个，verify-roundtrip 就会红。所以这里用「记录原状 + 写回时还原」
 * 而不是「猜一个统一的换行风格」。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'

export type EolStyle = 'crlf' | 'lf' | 'mixed'

export interface DecodedFile {
  text: string
  eolStyle: EolStyle
  /** mixed 时记录每一处换行的原始序列，用于写回时逐处还原 */
  eolMap: string[] | null
  bom: boolean
  endsWithNewline: boolean
}

const BOM = '\uFEFF'

/** 把磁盘字节解成「编辑器友好的 \n 文本」+ 还原所需的全部元信息 */
export function decodeBuffer(buf: Buffer): DecodedFile {
  let bom = false
  let offset = 0
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    bom = true
    offset = 3
  }
  const raw = buf.subarray(offset).toString('utf8')

  // 逐处扫描换行，判断风格（不破坏内容，只记录）
  const eolMap: string[] = []
  let crlf = 0
  let lf = 0
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch === '\r') {
      if (raw[i + 1] === '\n') {
        eolMap.push('\r\n')
        crlf++
        i++
      } else {
        eolMap.push('\r')
        crlf++
      }
    } else if (ch === '\n') {
      eolMap.push('\n')
      lf++
    }
  }

  const eolStyle: EolStyle = crlf > 0 && lf > 0 ? 'mixed' : crlf > 0 ? 'crlf' : 'lf'
  const endsWithNewline = eolMap.length > 0 && (raw.endsWith('\n') || raw.endsWith('\r'))

  return {
    text: raw.replace(/\r\n|\r/g, '\n'),
    eolStyle,
    // 纯一种风格时不需要 map，省内存
    eolMap: eolStyle === 'mixed' ? eolMap : null,
    bom,
    endsWithNewline,
  }
}

/** 把编辑器里的 \n 文本还原成原始字节布局 */
export function encodeText(
  text: string,
  meta: { eolStyle: EolStyle; eolMap: string[] | null; bom: boolean }
): Buffer {
  // 编辑器里理论上只会有 \n，但防御性归一，避免用户粘贴进 \r\n 后写坏
  const lines = text.replace(/\r\n|\r/g, '\n').split('\n')

  let out = ''
  for (let i = 0; i < lines.length; i++) {
    out += lines[i]
    if (i < lines.length - 1) {
      if (meta.eolMap && i < meta.eolMap.length) {
        // mixed 文件：这一处用回它原来那个换行序列
        out += meta.eolMap[i]
      } else {
        out += meta.eolStyle === 'crlf' ? '\r\n' : '\n'
      }
    }
  }

  // 注意：这里【不】按 endsWithNewline 强补末尾换行。
  // "原文末尾没有换行" 这件事由 split/join 天然保住了（"a" → "a"，"a\n" → "a<eol>"）。
  // 如果这里再补一次，用户手动删掉末尾空行时就会被我们偷偷加回去 —— 那是篡改，不是无损。
  return Buffer.from((meta.bom ? BOM : '') + out, 'utf8')
}

export async function readDecoded(filePath: string): Promise<DecodedFile> {
  return decodeBuffer(await fs.readFile(filePath))
}

/**
 * 原子写：临时文件 → fsync → rename 覆盖。
 * 只写 tmp 并 rename，崩溃时最坏是留下一个 .tmp 垃圾，原文件一定还是完整的。
 */
export async function atomicWrite(filePath: string, data: Buffer): Promise<void> {
  const dir = path.dirname(filePath)
  const tmp = path.join(dir, `.${path.basename(filePath)}.${randomBytes(4).toString('hex')}.tmp`)
  let handle: import('node:fs/promises').FileHandle | null = null
  try {
    handle = await fs.open(tmp, 'w')
    await handle.writeFile(data)
    await handle.sync()
    await handle.close()
    handle = null
    await renameWithRetry(tmp, filePath)
  } catch (err) {
    if (handle) await handle.close().catch(() => {})
    await fs.unlink(tmp).catch(() => {})
    throw err
  }
}

/** Windows 上杀毒/网盘同步会短暂占用文件，rename 偶发 EPERM，重试几次 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  let lastErr: unknown = null
  for (let i = 0; i < 6; i++) {
    try {
      await fs.rename(from, to)
      return
    } catch (err) {
      lastErr = err
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EPERM' && code !== 'EACCES' && code !== 'EBUSY') throw err
      await new Promise((r) => setTimeout(r, 40 * (i + 1)))
    }
  }
  throw lastErr
}
