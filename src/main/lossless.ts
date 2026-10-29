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
import { TextDecoder } from 'node:util'
import type { EolStyle } from '../shared/types.js'

// 换行风格只在这一处定义（shared/types.ts），这里只做转发 ——
// 项目里已经吃过「同一张表抄两份、然后漂移」的亏（见 README「已知的坑」）。
export type { EolStyle }

export interface DecodedFile {
  text: string
  eolStyle: EolStyle
  /** mixed 时记录每一处换行的原始序列，用于写回时逐处还原 */
  eolMap: string[] | null
  bom: boolean
  endsWithNewline: boolean
  /**
   * 原文件是不是**合法 UTF-8**。
   *
   * false 表示里面存在非法字节序列（GBK / GB18030 / 二进制 / 半个中文……）。
   * 这种情况下 `toString('utf8')` 会把坏字节静默换成 U+FFFD（�），
   * 而写回时我们又只能产出 UTF-8 —— 也就是说：**打开一次再保存一次，原文件就永久坏了**。
   * 所以上层必须凭这个标记拒绝写盘（见 files.ts 的 writeNote 与 renderer 的只读提示）。
   */
  validUtf8: boolean
}

const BOM = '\uFEFF'

/** 严格解码器：遇到非法序列直接抛错，用来判定「是不是真 UTF-8」 */
const strictUtf8 = new TextDecoder('utf-8', { fatal: true })

/** 把磁盘字节解成「编辑器友好的 \n 文本」+ 还原所需的全部元信息 */
export function decodeBuffer(buf: Buffer): DecodedFile {
  let bom = false
  let offset = 0
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    bom = true
    offset = 3
  }
  const body = buf.subarray(offset)

  let raw: string
  let validUtf8 = true
  try {
    raw = strictUtf8.decode(body)
  } catch {
    // 非法 UTF-8：仍然解出一份「尽量能看」的文本（坏字节显示成 �），
    // 但打上 invalid 标记，让上层拒绝写回。宁可让用户看到乱码，
    // 也不能让用户在不知情的情况下把原文件覆盖成另一个编码。
    validUtf8 = false
    raw = body.toString('utf8')
  }

  // 逐处扫描换行，判断风格（不破坏内容，只记录）
  const eolMap: string[] = []
  let crlf = 0
  let lf = 0
  let cr = 0
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch === '\r') {
      if (raw[i + 1] === '\n') {
        eolMap.push('\r\n')
        crlf++
        i++
      } else {
        // 裸 CR（老 Mac 风格）：必须**单独算一种**，见下面的判定注释
        eolMap.push('\r')
        cr++
      }
    } else if (ch === '\n') {
      eolMap.push('\n')
      lf++
    }
  }

  // 三种换行各自计数，按「出现了几种」决定风格。
  //
  // 以前裸 CR 也记进 crlf 计数里，后果是：整篇只有 \r 的文件被判成 'crlf'，
  // 而 'crlf' 不保留 eolMap —— 写回时每个 \r 都被替换成 \r\n，
  // 字节数凭空翻倍、git 里显示「全文重写」。这是纯粹的损坏，且用户毫无察觉。
  // 所以裸 CR 要么单独成 'cr'，要么与别的混用时进 'mixed'（保留 eolMap 逐处还原）。
  const kinds = (crlf > 0 ? 1 : 0) + (lf > 0 ? 1 : 0) + (cr > 0 ? 1 : 0)
  const eolStyle: EolStyle = kinds > 1 ? 'mixed' : crlf > 0 ? 'crlf' : cr > 0 ? 'cr' : 'lf'
  const endsWithNewline = eolMap.length > 0 && (raw.endsWith('\n') || raw.endsWith('\r'))

  return {
    text: raw.replace(/\r\n|\r/g, '\n'),
    eolStyle,
    // 纯一种风格时不需要 map，省内存
    eolMap: eolStyle === 'mixed' ? eolMap : null,
    bom,
    endsWithNewline,
    validUtf8,
  }
}

/** 各换行风格对应的输出序列（'mixed' 走 eolMap，这里的 mixed 只是兜底） */
const EOL_TEXT: Record<EolStyle, string> = { crlf: '\r\n', lf: '\n', cr: '\r', mixed: '\n' }

/**
 * mtime 比较的容差（毫秒）。
 *
 * 不能要求严格相等：部分文件系统只存到秒，网盘客户端和杀软还会在扫过之后
 * 「补」一次时间戳。这些抖动都在几毫秒内；真正被别的程序改过，时间差是分钟级。
 */
export const MTIME_TOLERANCE_MS = 1

/**
 * 磁盘上的文件是否在「我们看到它的那一刻」之后被改过。
 *
 * expect 是 undefined 时一律不报冲突 —— 新建笔记、或者调用方没带 mtime
 * （兼容老调用）时不该被一个探测不到的东西拦住。
 *
 * 抽成纯函数是为了能被 test-units 直接断言：这条判断错了就是静默丢数据，
 * 而「静默」意味着只有用户发现笔记少了半篇时才可能被注意到。
 */
export function mtimeConflicts(diskMtimeMs: number, expectMtimeMs?: number): boolean {
  if (typeof expectMtimeMs !== 'number' || !Number.isFinite(expectMtimeMs)) return false
  return Math.abs(diskMtimeMs - expectMtimeMs) > MTIME_TOLERANCE_MS
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
        out += EOL_TEXT[meta.eolStyle]
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
