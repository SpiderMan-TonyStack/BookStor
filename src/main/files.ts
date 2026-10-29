import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { FileNode, NoteDoc, SaveResult, BrokenImage, SaveMeta } from '../shared/types.js'
// 这一条显式写 `.ts`（其余文件都写 `.js`）：`scripts/test-units.mjs` 用 Node 的
// 类型剥离直接 import 本文件，而 Node **不做** `.js` → `.ts` 的扩展名替换
// （官方文档：import 里的扩展名必须写实，「import './file.ts', not './file'」），
// 写 `./lossless.js` 在磁盘上找不到对应文件，`pnpm test` 会 ERR_MODULE_NOT_FOUND。
// electron-vite 与本项目 tsconfig（allowImportingTsExtensions + noEmit）都认显式 .ts。
import { atomicWrite, decodeBuffer, encodeText, mtimeConflicts } from './lossless.ts'

/**
 * 非点开头的黑名单（策划案 §5.8）。
 *
 * 点开头的目录/文件在 walk 里已统一跳过（.git、.obsidian、.pandoc-3.6.4、
 * .xxx.assets 附件目录、.gitignore 全在其中），所以这里**只列非点开头**的。
 * 之前这里列了一堆点开头的名字，配合下面两处重复的 isHidden 判断，
 * 实际全是死代码 —— 删掉不改变行为，只是让「为什么这行不显示」有唯一解释。
 */
const HIDDEN = new Set(['node_modules'])

/** 目录递归深度上限（两处 walk 共用这一个常量，别再各写一份 12） */
const MAX_DEPTH = 12

/** 目录/文件是否要跳过。`listTree` 与 `scanBrokenImages` 必须用同一套规则 */
function shouldSkip(name: string): boolean {
  return name.startsWith('.') || HIDDEN.has(name)
}

/** 让 .md 排在目录之后、同层内按名称自然排序（文件树好看） */
function sortNodes(a: FileNode, b: FileNode): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
  return a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
}

export async function listTree(root: string): Promise<FileNode[]> {
  async function walk(dir: string, depth: number): Promise<FileNode[]> {
    if (depth > MAX_DEPTH) return []
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const nodes: FileNode[] = []
    for (const e of entries) {
      // 点开头的一律不入树：隐藏目录、附件目录、.gitignore 之类都不该出现在文件树里
      if (shouldSkip(e.name)) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        nodes.push({ name: e.name, path: full, isDir: true, children: await walk(full, depth + 1) })
      } else if (e.isFile() && /\.(md|markdown|txt)$/i.test(e.name)) {
        nodes.push({ name: e.name, path: full, isDir: false })
      }
    }
    return nodes.sort(sortNodes)
  }
  return walk(root, 0)
}

/** 全库 .md 路径（跟着同一套隐藏目录规则走，两处 walk 合成这一份） */
async function collectMarkdownFiles(root: string): Promise<string[]> {
  const out: string[] = []
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (shouldSkip(e.name)) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        await walk(full, depth + 1)
      } else if (e.isFile() && /\.md$/i.test(e.name)) {
        out.push(full)
      }
    }
  }
  await walk(root, 0)
  return out
}

/**
 * 主进程自己记的「这份文件我亲口验过是合法 UTF-8」账本。
 *
 * 为什么不能只信渲染层传来的 `expectMtimeMs` / `expectSize`：
 * 那两个值就是渲染层从 `readNote` 拿到、再原样送回来的 —— 一个**从来没被我们读过**
 * 的 GBK 文件，它自己的 mtime/size 当然和「刚 stat 到的」一致，指纹百分之百命中。
 * 只按指纹跳过读盘，等于给刚打开的乱码文件开了一条写入通道，第二道防线形同虚设。
 *
 * 所以快路径的前提改成：**这个 path 的这个 (mtime, size) 状态，我们亲自读并验过**。
 * 只有 readNote（合法时）和 writeNote（写成功后）会记账；别的程序造出来的文件
 * 永远不会在里面，一定走完整读盘复检。
 */
const verifiedUtf8 = new Map<string, { mtimeMs: number; size: number }>()

/** 上限只是防长会话里无限涨（正常库几百篇，远够用） */
const VERIFIED_MAX = 4096

function markVerified(filePath: string, mtimeMs: number, size: number): void {
  // 删了再加：让它排到 Map 末尾，这里不需要严格的 LRU，只要「老的不占位」
  verifiedUtf8.delete(filePath)
  verifiedUtf8.set(filePath, { mtimeMs, size })
  if (verifiedUtf8.size > VERIFIED_MAX) {
    // 满了就整体丢掉重来 —— 丢了只是退回「每次都复检」，不影响正确性
    verifiedUtf8.clear()
  }
}

function isVerified(filePath: string, disk: { mtimeMs: number; size: number }): boolean {
  const known = verifiedUtf8.get(filePath)
  return (
    known !== undefined &&
    !mtimeConflicts(disk.mtimeMs, known.mtimeMs) &&
    disk.size === known.size
  )
}

export async function readNote(filePath: string): Promise<NoteDoc> {
  const buf = await fs.readFile(filePath)
  const st = await fs.stat(filePath)
  const decoded = decodeBuffer(buf)
  // 合法的读进来 → 记账，之后的保存可以放心跳过编码复检。
  // 非法的**不能**记：它本来就是「不该被写」的那一类，快路径必须永远绕开它。
  if (decoded.validUtf8) markVerified(filePath, st.mtimeMs, st.size)
  else verifiedUtf8.delete(filePath)
  return {
    path: filePath,
    text: decoded.text,
    eolStyle: decoded.eolStyle,
    eolMap: decoded.eolMap,
    bom: decoded.bom,
    endsWithNewline: decoded.endsWithNewline,
    validUtf8: decoded.validUtf8,
    mtimeMs: st.mtimeMs,
    size: st.size,
  }
}

/**
 * 写盘。meta 里带上原文件的编码特征，写回时逐项还原 —— 这是无损的落点。
 *
 * 两道保护（都在**真正动手写之前**做完，失败时磁盘一个字都不动）：
 *
 * 1. **mtime 冲突检测**：meta.expectMtimeMs 是「打开/上次保存时看到的 mtime」。
 *    如果磁盘上的 mtime 已经变了，说明这篇在别处被改过（Typora 里改了、
 *    网盘同步下来了、git 切分支了）。这时直接覆盖 = 静默吞掉别人的修改，
 *    而且是**双向**吞（我们这版覆盖它的，它的也从编辑器里消失了）。
 *    所以返回 conflict，交给用户决定是覆盖还是重读。
 *
 * 2. **不往非 UTF-8 文件里写 UTF-8**：原文件若是 GBK/GB18030/二进制，
 *    编辑器里看到的是 � 乱码；一旦写回，整个文件就被永久转码成 UTF-8，
 *    原来能打开的文件从此全乱。这种事「撤销」救不回来，所以直接拒绝。
 */
export async function writeNote(
  filePath: string,
  text: string,
  meta: SaveMeta
): Promise<SaveResult> {
  try {
    const disk = await statOrNull(filePath)

    // --- 保护 2：编码检查（比 mtime 更硬，先做）
    //
    // 每次保存都整篇重读一遍判编码，对 280KB 的笔记是纯浪费 —— 那个字节流
    // 刚在上一轮保存时被我们写过一次，正常情况下不会变。所以先做「指纹」判断：
    // 磁盘现状与我们**亲自验过**的那份 (mtime, size) 一致 → 文件没被别人动过
    // → 编码当然还是当初那个合法的 → 跳过读盘。
    //
    // 任何一项对不上就老老实实读一遍再判 —— 那才是「可能被换成 GBK」的场景。
    // `force` **不能**跳过这里：它的语义只是「我知道被改过，覆盖它」，
    // 不是「我知道它不是 UTF-8，把它转码」—— 后者不可逆。
    if (disk) {
      const unchanged =
        isVerified(filePath, disk) &&
        typeof meta.expectMtimeMs === 'number' &&
        typeof meta.expectSize === 'number' &&
        !mtimeConflicts(disk.mtimeMs, meta.expectMtimeMs) &&
        disk.size === meta.expectSize
      if (!unchanged) {
        const existing = decodeBuffer(await fs.readFile(filePath))
        if (!existing.validUtf8) {
          // 顺手把这条账抹掉：它已经不是当初那份合法文件了
          verifiedUtf8.delete(filePath)
          return {
            ok: false,
            mtimeMs: disk.mtimeMs,
            size: disk.size,
            encoding: true,
            error:
              '这个文件不是 UTF-8 编码（可能是 GBK/GB18030 或二进制）。' +
              '为免把原文转码写坏，已拒绝保存；请先在别的工具里转成 UTF-8，或用「另存为」导出。',
          }
        }
      }
    }

    // --- 保护 1：外部修改检测（用户明确选「覆盖」时 meta.force 为 true）
    if (disk && !meta.force && mtimeConflicts(disk.mtimeMs, meta.expectMtimeMs)) {
      return {
        ok: false,
        mtimeMs: disk.mtimeMs,
        size: disk.size,
        conflict: true,
        error: '文件已被其他程序修改',
      }
    }

    const data = encodeText(text, {
      eolStyle: meta.eolStyle,
      eolMap: meta.eolMap,
      bom: meta.bom,
    })
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await atomicWrite(filePath, data)
    const st = await fs.stat(filePath)
    // 刚写下去的是我们自己 encode 的 UTF-8 → 记账，下次保存可走快路径
    markVerified(filePath, st.mtimeMs, st.size)
    return { ok: true, mtimeMs: st.mtimeMs, size: st.size }
  } catch (err) {
    return {
      ok: false,
      mtimeMs: 0,
      size: 0,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/** stat 但把「文件不存在」当成 null（新建笔记是正常路径，不是错误） */
async function statOrNull(p: string): Promise<{ mtimeMs: number; size: number } | null> {
  try {
    const st = await fs.stat(p)
    return { mtimeMs: st.mtimeMs, size: st.size }
  } catch {
    return null
  }
}

/**
 * 图片落盘：完全复刻 Typora 约定 ./.${笔记名}.assets/ 与文件名风格
 *   image-<yyyyMMddHHmmss>-<3位随机>.png
 */
export async function saveImage(notePath: string, base64: string, ext: string): Promise<string> {
  const noteName = path.basename(notePath, path.extname(notePath))
  const dir = path.join(path.dirname(notePath), `.${noteName}.assets`)
  await fs.mkdir(dir, { recursive: true })

  const cleanExt = ext.replace(/^\./, '').toLowerCase() || 'png'
  const d = new Date()
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  const stamp =
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  let fileName = `image-${stamp}-${randomBytes(2).toString('hex')}.${cleanExt}`

  let n = 1
  while (await exists(path.join(dir, fileName))) {
    fileName = `image-${stamp}-${randomBytes(2).toString('hex')}-${n++}.${cleanExt}`
  }

  await fs.writeFile(path.join(dir, fileName), Buffer.from(base64, 'base64'))
  // 返回 markdown 里该写的相对路径（正斜杠，与 Typora 一致）
  return `./.${noteName}.assets/${fileName}`
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

const IMG_RE = /!\[[^\]]*\]\(([^)]*)\)/g

/**
 * 与 verify-roundtrip.mjs 完全一致的取图逻辑。
 * 注意带空格的文件名 Typora 是**不编码直接写**的（实测 134 处），不能用 \S+ 取。
 */
function extractImageTargets(text: string): string[] {
  const out: string[] = []
  for (const m of text.matchAll(IMG_RE)) {
    let inner = (m[1] ?? '').trim()
    if (!inner) continue
    const titleMatch = inner.match(/^(.+?)\s+("[^"]*"|'[^']*'|\([^)]*\))$/)
    if (titleMatch?.[1]) inner = titleMatch[1].trim()
    if (inner.startsWith('<') && inner.endsWith('>')) inner = inner.slice(1, -1)
    out.push(inner)
  }
  return out
}

/** 打开一篇笔记时核对它的图片，裂图要显式暴露（策划案 §5.7 第 3 条） */
export async function scanBrokenImagesOf(filePath: string): Promise<BrokenImage[]> {
  // 走 decodeBuffer 而不是 fs.readFile(p,'utf8')：后者会把 UTF-8 BOM 留在
  // 字符串开头（Node 不剥 BOM），于是首行的 `![](x)` 前面多一个 \uFEFF ——
  // 正则照样能匹配上（img 不在行首时无事），但 BOM 紧贴图片语法的边角情况
  // （文件第一行就是图片）会漏判。顺带也统一了换行处理。
  // 库里有 4 篇带 BOM，这类漏判一旦发生就是"该报的裂图没报"。
  const text = decodeBuffer(await fs.readFile(filePath)).text
  const dir = path.dirname(filePath)
  const broken: BrokenImage[] = []
  for (const raw of extractImageTargets(text)) {
    if (/^(https?:|data:)/i.test(raw)) continue
    const normalized = raw.replace(/\\/g, '/')
    let decoded = normalized
    try {
      decoded = decodeURIComponent(normalized)
    } catch {
      /* 保留原样 */
    }
    const abs = path.resolve(dir, decoded)
    if (!(await exists(abs))) broken.push({ notePath: filePath, rawPath: raw, resolvedPath: abs })
  }
  return broken
}

/** 全库裂图核对（M1 验收用，对应 verify-roundtrip 的图片部分） */
export async function scanBrokenImages(root: string): Promise<BrokenImage[]> {
  // 走 collectMarkdownFiles：与 listTree 共用同一套隐藏目录规则
  // （策划案 §5.8 承诺「隐藏目录不参与任何扫描统计」）。
  const files = await collectMarkdownFiles(root)

  const all: BrokenImage[] = []
  for (const f of files) {
    try {
      all.push(...(await scanBrokenImagesOf(f)))
    } catch {
      /* 单篇失败不影响整体统计 */
    }
  }
  return all
}
