import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'
import type { FileNode, NoteDoc, SaveResult, BrokenImage, SaveMeta } from '../shared/types.js'
import { atomicWrite, decodeBuffer, encodeText } from './lossless.js'

/** 隐藏目录不入树（策划案 §5.8） */
const HIDDEN = new Set(['.obsidian', '.git', '.workbuddy', '.pandoc-3.6.4', '.主题', 'node_modules'])

function isHidden(name: string): boolean {
  if (HIDDEN.has(name)) return true
  // .xxx.assets 附件目录也不入树
  return name.startsWith('.') && name.endsWith('.assets')
}

/** 让 .md 排在目录之后、同层内按名称自然排序（文件树好看） */
function sortNodes(a: FileNode, b: FileNode): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
  return a.name.localeCompare(b.name, 'zh-CN', { numeric: true })
}

export async function listTree(root: string): Promise<FileNode[]> {
  async function walk(dir: string, depth: number): Promise<FileNode[]> {
    if (depth > 12) return []
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return []
    }
    const nodes: FileNode[] = []
    for (const e of entries) {
      if (e.name.startsWith('.') && isHidden(e.name)) continue
      if (e.name.startsWith('.')) continue // 其余点开头的（.gitignore 等）也不显示
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (isHidden(e.name)) continue
        nodes.push({ name: e.name, path: full, isDir: true, children: await walk(full, depth + 1) })
      } else if (e.isFile() && /\.(md|markdown|txt)$/i.test(e.name)) {
        nodes.push({ name: e.name, path: full, isDir: false })
      }
    }
    return nodes.sort(sortNodes)
  }
  return walk(root, 0)
}

export async function readNote(filePath: string): Promise<NoteDoc> {
  const buf = await fs.readFile(filePath)
  const st = await fs.stat(filePath)
  const decoded = decodeBuffer(buf)
  return {
    path: filePath,
    text: decoded.text,
    eolStyle: decoded.eolStyle,
    eolMap: decoded.eolMap,
    bom: decoded.bom,
    endsWithNewline: decoded.endsWithNewline,
    mtimeMs: st.mtimeMs,
    size: st.size,
  }
}

/**
 * 写盘。meta 里带上原文件的编码特征，写回时逐项还原 —— 这是无损的落点。
 */
export async function writeNote(
  filePath: string,
  text: string,
  meta: SaveMeta
): Promise<SaveResult> {
  try {
    const data = encodeText(text, {
      eolStyle: meta.eolStyle,
      eolMap: meta.eolMap,
      bom: meta.bom,
    })
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await atomicWrite(filePath, data)
    const st = await fs.stat(filePath)
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
  const text = await fs.readFile(filePath, 'utf8')
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
  const files: string[] = []
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > 12) return
    let entries: import('node:fs').Dirent[]
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === '.git' || e.name === 'node_modules') continue
        await walk(full, depth + 1)
      } else if (e.isFile() && /\.md$/i.test(e.name)) {
        files.push(full)
      }
    }
  }
  await walk(root, 0)

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
