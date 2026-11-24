/**
 * 文件树的右键菜单（4.8.0）。
 *
 * 菜单内容与 Typora 的文件面板对齐（「在新窗口中打开 / 新建文件 / 新建文件夹 /
 * 搜索 / 文档列表 / 文档树 / 重命名 / 删除 / 属性 / 复制文件路径 / 打开文件位置」），
 * 每一项都落到一个具体的主进程 IPC 或渲染层动作上。
 *
 * 这个文件只负责「菜单长什么样 + 点了做什么」，**不碰文件树的结构** ——
 * 结构变了就调 `ctx.refresh()`，重新读盘重画由 main.ts 负责。
 */

import { openConfirm, openInfo, openPrompt } from './dialog.js'
import { showContextMenu, type MenuItem } from './menu.js'
import { fileKind, formatSize, formatTime } from './format.js'

/** 右键点到了什么：目录 / 文件 / 空白（空白 = 笔记库根） */
export interface HitNode {
  path: string
  name: string
  isDir: boolean
}

export type ViewMode = 'tree' | 'list'

export interface FileOpsContext {
  /** 笔记库根目录 */
  root(): string
  /** 当前打开的笔记路径 */
  currentPath(): string | null
  open(path: string): void | Promise<void>
  /** 文件树结构变了（新建/删除/重命名之后） */
  refresh(): void | Promise<void>
  status(text: string): void
  viewMode(): ViewMode
  setViewMode(mode: ViewMode): void
  /** 把搜索框聚焦，并把词填进去（右键「搜索」） */
  focusSearch(word: string): void
  /** 重命名成功后：把编辑器里那篇的路径跟着改掉（不重读盘，免得丢未保存内容） */
  onRenamed(oldPath: string, newPath: string): void
  /** 删除成功后：如果删的是当前这篇，把编辑器切到空白状态 */
  onTrashed(path: string): void
}

/** 取路径里的文件名部分（正反斜杠都认） */
function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

function dirName(p: string): string {
  const norm = p.replace(/\\/g, '/')
  const i = norm.lastIndexOf('/')
  return i <= 0 ? norm : norm.slice(0, i)
}

/** 名字去掉扩展名（菜单里「搜索」用名字，不带 `.md`） */
function withoutExt(name: string): string {
  return name.replace(/\.(md|markdown|txt)$/i, '')
}

/**
 * 前端即时校验。
 *
 * **规则以主进程的 `checkEntryName` 为准**（它才是最终裁决），这里只是为了让
 * 用户在输入时就看见红字，而不是点了「确定」才知道名字不能用。两边宁可都写，
 * 也不要为了省几行让体验退化 —— 但新增规则记得两边一起改。
 */
function quickNameError(raw: string): string | null {
  const name = raw.trim()
  if (!name) return '名字不能为空'
  if (name === '.' || name === '..') return '不能用 . 或 .. 作名字'
  if (/[\\/:*?"<>|]/.test(name)) return '名字里不能包含 \\ / : * ? " < > | 这些字符'
  if (name.startsWith('.')) return '名字不能以点开头（这类文件不会显示在文件树里）'
  return null
}

/** 新建的目标目录：目录 → 自己；文件 → 所在目录；空白 → 库根 */
function targetDir(node: HitNode | null, root: string): string {
  if (!node) return root
  return node.isDir ? node.path : dirName(node.path)
}

/**
 * 弹出右键菜单。
 *
 * `node === null` 表示点在空白处 —— 那是对「笔记库根目录」的操作。
 * `disabled` 的项保留在菜单里（灰掉）而不是隐藏：用户需要知道"这里能做什么、
 * 但当前不可用"，比如库根不能重命名。
 */
export function showFileMenu(opts: {
  node: HitNode | null
  x: number
  y: number
  ctx: FileOpsContext
}): void {
  const { node, x, y, ctx } = opts
  const root = ctx.root()
  const isRoot = node === null
  const isDir = node ? node.isDir : true
  const dir = targetDir(node, root)
  const mode = ctx.viewMode()

  const items: MenuItem[] = []

  // ---- 在新窗口中打开 ----
  items.push({
    label: '在新窗口中打开',
    onClick: () => {
      void window.api.openInNewWindow(node && !node.isDir ? node.path : undefined)
    },
  })

  items.push({ sep: true })

  // ---- 新建 ----
  const create = (wantDir: boolean): void => {
    openPrompt({
      title: wantDir ? '新建文件夹' : '新建文件',
      label: `在「${baseName(dir)}」里${wantDir ? '新建文件夹' : '新建笔记'}`,
      placeholder: wantDir ? '文件夹名' : '文件名（不用写 .md）',
      okText: '创建',
      validate: quickNameError,
      onOk: async (value) => {
        const res = await window.api.newEntry(dir, value, wantDir)
        if (!res.ok) throw new Error(res.error ?? '创建失败')
        await ctx.refresh()
        if (!wantDir && res.path) {
          // 新建的笔记直接打开：Typora 也是这个行为，省一次点击
          await ctx.open(res.path)
        }
        ctx.status(`已新建${wantDir ? '文件夹' : '笔记'}「${baseName(res.path ?? value)}」`)
      },
    })
  }
  items.push({ label: '新建文件', onClick: () => create(false) })
  items.push({ label: '新建文件夹', onClick: () => create(true) })

  items.push({ sep: true })

  // ---- 搜索：把侧栏搜索框聚焦，并带入当前节点的名字 ----
  items.push({
    label: '搜索',
    hint: node ? withoutExt(node.name) : undefined,
    onClick: () => ctx.focusSearch(node ? withoutExt(node.name) : ''),
  })

  items.push({ sep: true })

  // ---- 视图：文档列表 / 文档树（互斥，带勾） ----
  items.push({
    label: '文档列表',
    checked: mode === 'list',
    onClick: () => ctx.setViewMode('list'),
  })
  items.push({
    label: '文档树',
    checked: mode === 'tree',
    onClick: () => ctx.setViewMode('tree'),
  })

  items.push({ sep: true })

  // ---- 重命名 ----
  items.push({
    label: '重命名',
    disabled: isRoot,
    onClick: () => {
      if (!node) return
      openPrompt({
        title: '重命名',
        label: '新名字（不写扩展名就沿用原来的）',
        value: node.name,
        okText: '重命名',
        validate: quickNameError,
        onOk: async (value) => {
          const res = await window.api.renameEntry(node.path, value)
          if (!res.ok) throw new Error(res.error ?? '重命名失败')
          const next = res.path ?? node.path
          ctx.onRenamed(node.path, next)
          await ctx.refresh()
          ctx.status(`已重命名为「${baseName(next)}」`)
        },
      })
    },
  })

  // ---- 删除（进回收站，永远可恢复） ----
  items.push({
    label: '删除',
    danger: true,
    disabled: isRoot,
    onClick: () => {
      if (!node) return
      const target = node
      const label = `${target.isDir ? '文件夹' : '笔记'}「${withoutExt(target.name)}」`

      /** 删完之后的收尾（两条删除路径共用） */
      const finish = async (how: '回收站' | '永久'): Promise<void> => {
        ctx.onTrashed(target.path)
        await ctx.refresh()
        ctx.status(`已删除${label}${how === '回收站' ? '（在回收站里）' : '（已永久删除）'}`)
      }

      /**
       * 回收站被系统拒绝时的第二条路。
       *
       * `shell.trashItem` 在部分环境（企业策略 / 网络盘 / 受限沙箱）会直接抛
       * 「Failed to perform delete operation」。那时**不能悄悄改成永久删除**，
       * 也不能就此罢手让用户删不掉 —— 单独弹一次明确的「永久删除」确认。
       */
      const askForce = (reason: string): void => {
        // 延到下一轮：当前这层对话框的 submit 返回后会 closeModal()，
        // 同步开新框会被那一次 closeModal 一起关掉
        window.setTimeout(() => {
          openConfirm({
            title: '无法移入回收站',
            message: `${label}无法移到系统回收站：${reason}`,
            detail: '要永久删除吗？永久删除不进回收站，删了就找不回来。',
            okText: '永久删除',
            danger: true,
            onOk: async () => {
              const res = await window.api.removeEntry(target.path)
              if (!res.ok) throw new Error(res.error ?? '删除失败')
              await finish('永久')
            },
          })
        }, 0)
      }

      openConfirm({
        title: '删除',
        message: `确定删除${label}？`,
        detail: '会移到系统回收站，误删可以从回收站还原。',
        okText: '删除',
        danger: true,
        onOk: async () => {
          const res = await window.api.trashEntry(target.path)
          if (res.ok) {
            await finish('回收站')
            return
          }
          if (res.forceAvailable) {
            askForce(res.error ?? '系统拒绝执行删除')
            return
          }
          throw new Error(res.error ?? '删除失败')
        },
      })
    },
  })

  items.push({ sep: true })

  // ---- 属性 ----
  items.push({
    label: '属性',
    onClick: () => {
      void (async () => {
        const target = node ? node.path : root
        const info = await window.api.statEntry(target)
        if (!info) {
          ctx.status('这个文件已经不在了（可能被删或改名）')
          return
        }
        const rows = [
          { label: '名称', value: info.name },
          { label: '类型', value: info.isDir ? '文件夹' : fileKind(info.name) },
          { label: '大小', value: info.isDir ? '—（文件夹）' : formatSize(info.size) },
          { label: '修改时间', value: formatTime(info.mtimeMs) },
          { label: '位置', value: dirName(info.path), mono: true },
        ]
        if (!info.isDir) {
          // 字数只对文本笔记有意义，读失败就不显示（别为了一个数字让属性框报错）
          try {
            const doc = await window.api.readNote(info.path)
            rows.push({ label: '字数', value: `${doc.text.length} 字 / ${doc.text.split('\n').length} 行` })
          } catch {
            /* 读不出来就跳过 */
          }
        }
        openInfo({ title: '属性', rows, copyText: '复制完整路径', onCopy: () => copyPath(target, ctx) })
      })()
    },
  })

  // ---- 复制路径 ----
  items.push({
    label: '复制文件路径',
    onClick: () => copyPath(node ? node.path : root, ctx),
  })

  // ---- 打开文件位置 ----
  items.push({
    label: '打开文件位置',
    onClick: () => {
      void (async () => {
        const target = node ? node.path : root
        const err = await window.api.revealEntry(target)
        // `showItemInFolder` 不抛异常也没有返回值 —— 失败原因由主进程先 stat 后返回空串/错误
        if (err) ctx.status(err)
      })()
    },
  })

  showContextMenu(items, x, y)
}

/** 复制路径到剪贴板（走主进程的 clipboard：渲染层的 navigator.clipboard 在 file:// 下不可靠） */
function copyPath(target: string, ctx: FileOpsContext): void {
  void (async () => {
    try {
      await window.api.writeClipboard(target)
      ctx.status(`已复制路径：${target}`)
    } catch (err) {
      ctx.status(`复制失败：${err instanceof Error ? err.message : String(err)}`)
    }
  })()
}
