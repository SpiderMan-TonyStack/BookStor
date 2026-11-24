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
// 同上：本文件会被 test-units.mjs 直接 import，内部引用一律写实扩展名
import { cleanImageTarget } from '../shared/image-path.ts'
import { applyImageTemplate, IMAGE_TEMPLATE_DEFAULT } from '../shared/prefs.ts'

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

/**
 * 只列一层（文件树懒加载用）。
 *
 * 文件树默认全部收起，收起时子节点根本没有 DOM，也就没必要在启动时把整棵树扫一遍。
 * 展开某个目录再来要它这一层的孩子 —— 一次 `readdir` 的量级是毫秒级，
 * 而全量 `listTree` 在 245 篇的库上要 60ms 左右，库越大越久。
 *
 * `children` 故意不填：`undefined` 表示"还没读过"，与"读过但是空的"（`[]`）区分开，
 * 文件树据此决定要不要发一次请求。
 */
export async function listDir(dir: string): Promise<FileNode[]> {
  let entries: import('node:fs').Dirent[]
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const nodes: FileNode[] = []
  for (const e of entries) {
    if (shouldSkip(e.name)) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) nodes.push({ name: e.name, path: full, isDir: true })
    else if (e.isFile() && /\.(md|markdown|txt)$/i.test(e.name)) {
      nodes.push({ name: e.name, path: full, isDir: false })
    }
  }
  return nodes.sort(sortNodes)
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
    // 子目录并发扫描：原来是在 for 循环里 `await walk(...)`，一个目录一个目录排队，
    // 深度越大越明显（每个 await 之间都白等一次事件循环）。这里先发出全部请求再一起等，
    // 顺序由后面的 sort 保证，与串行版本结果完全一致。
    const pending: Promise<void>[] = []
    for (const e of entries) {
      // 点开头的一律不入树：隐藏目录、附件目录、.gitignore 之类都不该出现在文件树里
      if (shouldSkip(e.name)) continue
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        const node: FileNode = { name: e.name, path: full, isDir: true, children: [] }
        nodes.push(node)
        pending.push(
          walk(full, depth + 1).then((kids) => {
            node.children = kids
          })
        )
      } else if (e.isFile() && /\.(md|markdown|txt)$/i.test(e.name)) {
        nodes.push({ name: e.name, path: full, isDir: false })
      }
    }
    if (pending.length > 0) await Promise.all(pending)
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

/** 图片落盘参数（由主进程从 prefs 读出来传进来，files.ts 自己不碰 electron） */
export interface ImageSaveOptions {
  /** 目录模板，支持 `${filename}`；相对路径按笔记所在目录解析 */
  template: string
  /** 引用是否加 `./` 前缀 */
  dot: boolean
}

const IMAGE_DEFAULTS: ImageSaveOptions = { template: IMAGE_TEMPLATE_DEFAULT, dot: true }

/**
 * 算出 markdown 里该写的图片路径（纯函数，可单测）。
 *
 * `absolute` 表示**模板本身是绝对路径**（不是"解析后的目录恰好是绝对路径" ——
 * 相对模板 resolve 之后也是绝对路径，用后者判断会把所有图片都写成绝对路径）。
 *
 * 三种情况：
 *   - 模板是绝对路径 → 返回绝对路径（正斜杠）。本机的图片库在别的盘时用这种；
 *   - 模板在笔记目录内 → 返回相对路径；`dot` 为真时补 `./`（Typora 的写法，
 *     在 Typora / Obsidian 之间迁移都不会被认成协议头）；
 *   - 已经以 `./` 或 `../` 开头 → 原样，不再叠一层 `./`。
 *
 * 一律输出正斜杠：markdown 里的反斜杠是转义符，`assets\a.png` 会被读成
 * 「assets + 转义 a」。
 */
export function imageMarkdownPath(
  noteDir: string,
  dir: string,
  fileName: string,
  dot: boolean,
  absolute = false
): string {
  const abs = path.join(dir, fileName)
  if (absolute) return abs.replace(/\\/g, '/')
  const rel = path.relative(noteDir, abs).replace(/\\/g, '/')
  if (!dot) return rel
  if (rel.startsWith('./') || rel.startsWith('../')) return rel
  return `./${rel}`
}

/**
 * 图片落盘：默认仍是 Typora 约定 `./.${笔记名}.assets/`，文件名风格
 *   image-<yyyyMMddHHmmss>-<2字节随机>.png
 *
 * 目录和 `./` 前缀从偏好设置读（见 `shared/prefs.ts` 的 imageDirTemplate）。
 * 参数**由调用方传**而不是这里 `import config`：config 依赖 electron，
 * 一旦引进来，`scripts/test-units.mjs` 就再也 import 不了本文件。
 */
export async function saveImage(
  notePath: string,
  base64: string,
  ext: string,
  options: ImageSaveOptions = IMAGE_DEFAULTS
): Promise<string> {
  const noteDir = path.dirname(notePath)
  const noteName = path.basename(notePath, path.extname(notePath))
  const expanded = applyImageTemplate(options.template, noteName)
  const templateAbsolute = path.isAbsolute(expanded)
  const dir = templateAbsolute ? path.normalize(expanded) : path.resolve(noteDir, expanded)
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
  return imageMarkdownPath(noteDir, dir, fileName, options.dot, templateAbsolute)
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
    const inner = cleanImageTarget(m[1] ?? '')
    if (!inner) continue
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

// ------------------------------------------------------------------ 文件树右键操作（4.8.0）

/**
 * 名字里不允许出现的字符。
 *
 * 按 **Windows 的规则**收（`\ / : * ? " < > |` 加控制字符），跨平台都够用 ——
 * 反过来只按 POSIX 收的话，在 Windows 上会创建出 `a:b.md` 这种删不掉的怪文件。
 */
const BAD_NAME = /[\\/:*?"<>|\u0000-\u001f]/

/** 新建 / 重命名的名字校验结果 */
export type NameCheck = { ok: true; name: string } | { ok: false; error: string }

/**
 * 校验用户输入的名字。
 *
 * 点开头的名字**直接拒**：`shouldSkip()` 会把这类文件从文件树里隐藏，
 * 允许创建的话就是「建完看不见、还得去资源管理器删」。
 */
export function checkEntryName(raw: string): NameCheck {
  const name = raw.trim()
  if (!name) return { ok: false, error: '名字不能为空' }
  if (name === '.' || name === '..') return { ok: false, error: '不能用 . 或 .. 作名字' }
  if (BAD_NAME.test(name)) return { ok: false, error: '名字里不能包含 \\ / : * ? " < > | 这些字符' }
  if (name.startsWith('.')) return { ok: false, error: '名字不能以点开头（这类文件/目录不会显示在文件树里）' }
  if (name.length > 120) return { ok: false, error: '名字太长了（上限 120 字）' }
  return { ok: true, name }
}

/** 新建文件 / 文件夹的结果（`path` 只在成功时有） */
export interface CreateResult {
  ok: boolean
  path?: string
  error?: string
}

/**
 * 在 `dir` 里新建一个文件或文件夹。
 *
 * - 文件名没写扩展名时补 `.md`（这个软件只认 markdown，用户不需要自己敲）；
 * - 用 `flag: 'wx'` / 非递归 `mkdir` 让**已存在自然失败**，不会覆盖别人的笔记
 *   （这是"新建"最容易写错的地方：普通 writeFile 会把同名文件清空）。
 */
export async function createEntry(dir: string, rawName: string, isDir: boolean): Promise<CreateResult> {
  const check = checkEntryName(rawName)
  if (!check.ok) return { ok: false, error: check.error }

  let name = check.name
  if (!isDir && !/\.[A-Za-z0-9]+$/.test(name)) name += '.md'
  const target = path.join(dir, name)

  try {
    if (isDir) {
      await fs.mkdir(target)
    } else {
      await fs.writeFile(target, '', { encoding: 'utf8', flag: 'wx' })
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return { ok: false, error: `「${name}」已经存在` }
    if (code === 'ENOENT') return { ok: false, error: '这个文件夹已经不在了（可能被删或改名）' }
    if (code === 'EPERM' || code === 'EACCES') return { ok: false, error: '没有权限在这里写入' }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  return { ok: true, path: target }
}

/**
 * 重命名（文件或文件夹）。
 *
 * 新名字**没带扩展名时沿用原来的**：把 `笔记.md` 改成 `笔记` 不该丢掉 `.md`
 * —— 丢了文件就从文件树里消失了（树只列 `.md`/`.markdown`/`.txt`）。
 * 用户显式写 `a.txt` 就照他写。
 */
export async function renameEntry(oldPath: string, rawName: string): Promise<CreateResult> {
  const check = checkEntryName(rawName)
  if (!check.ok) return { ok: false, error: check.error }

  let st: import('node:fs').Stats
  try {
    st = await fs.stat(oldPath)
  } catch {
    return { ok: false, error: '这个文件已经不在了（可能被删或改名）' }
  }

  let name = check.name
  const hasExt = /\.[A-Za-z0-9]+$/.test(name)
  if (!st.isDirectory() && !hasExt) {
    const oldExt = path.extname(oldPath)
    if (oldExt) name += oldExt
  }

  const target = path.join(path.dirname(oldPath), name)
  if (path.resolve(target).toLowerCase() === path.resolve(oldPath).toLowerCase()) {
    // 只是大小写变化在 Windows 上也是同一个文件，别硬 rename（会报 EPERM）
    return { ok: true, path: oldPath }
  }
  try {
    // 目标已存在就报错：rename 会**直接覆盖**同名文件，那是删数据
    await fs.access(target)
    return { ok: false, error: `「${name}」已经存在` }
  } catch {
    /* 不存在才是我们要的 */
  }

  try {
    await fs.rename(oldPath, target)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EPERM' || code === 'EACCES') return { ok: false, error: '文件被别的程序占用，关掉再试' }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  return { ok: true, path: target }
}

/** 右键「属性」要显示的信息 */
export interface EntryInfo {
  path: string
  name: string
  isDir: boolean
  /** 字节数（目录恒为 0） */
  size: number
  /** 修改时间（毫秒时间戳） */
  mtimeMs: number
}

/** 取单个文件/目录的属性（不存在返回 null，调用方据此提示） */
export async function statEntry(target: string): Promise<EntryInfo | null> {
  try {
    const st = await fs.stat(target)
    return {
      path: target,
      name: path.basename(target),
      isDir: st.isDirectory(),
      size: st.isDirectory() ? 0 : st.size,
      mtimeMs: st.mtimeMs,
    }
  } catch {
    return null
  }
}

/**
 * 把文件/目录移动到另一个目录（拖拽移动）。
 *
 * 与重命名一样，**目标已存在就报错** —— `fs.rename` 会直接覆盖同名文件，
 * 那是删数据。三条硬约束：
 *   1. 源必须还在（拖着的这会儿可能被别的程序删了）；
 *   2. 目标必须是**存在的目录**（不是文件、不是刚被删掉的目录）；
 *   3. 不能把目录移进**它自己或它的子孙**里（会得到一个打不开的环）。
 */
export async function moveEntry(src: string, targetDir: string): Promise<CreateResult> {
  let st: import('node:fs').Stats
  try {
    st = await fs.stat(src)
  } catch {
    return { ok: false, error: '这个文件已经不在了（可能被删或改名）' }
  }

  let dirSt: import('node:fs').Stats | null = null
  try {
    dirSt = await fs.stat(targetDir)
  } catch {
    return { ok: false, error: '目标文件夹已经不在了' }
  }
  if (!dirSt.isDirectory()) return { ok: false, error: '目标不是文件夹' }

  const name = path.basename(src)
  const dest = path.join(targetDir, name)
  // 同一性比较用 resolve + 小写：Windows 上 `D://a` 与 `d:/a` 是同一个位置
  const srcNorm = path.resolve(src).toLowerCase()
  const dirNorm = path.resolve(targetDir).toLowerCase()

  if (path.resolve(dest).toLowerCase() === srcNorm) {
    return { ok: false, error: '已经在这个文件夹里了' }
  }
  if (st.isDirectory() && (dirNorm === srcNorm || dirNorm.startsWith(`${srcNorm}${path.sep}`))) {
    return { ok: false, error: '不能把文件夹移到它自己里面' }
  }

  try {
    await fs.access(dest)
    return { ok: false, error: `目标文件夹里已经有「${name}」了` }
  } catch {
    /* 不存在才是我们要的 */
  }

  try {
    await fs.rename(src, dest)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    // 跨卷 rename 在 Windows 上直接失败（EXDEV）。要做就得"复制整棵树 + 删源"，
    // 中途失败会留下两份半成品 —— 这个版本不做，明确告诉用户。
    if (code === 'EXDEV') return { ok: false, error: '不支持跨磁盘移动（两个位置不在同一个盘上）' }
    if (code === 'EPERM' || code === 'EACCES') return { ok: false, error: '文件被别的程序占用，关掉再试' }
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  return { ok: true, path: dest }
}
