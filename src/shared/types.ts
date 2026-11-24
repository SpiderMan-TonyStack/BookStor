/**
 * 共享类型：主进程 ↔ 渲染进程
 */

import type { CommandDef, Keymap } from './commands.js'
import type { Prefs } from './prefs.js'

/**
 * 换行风格。
 *
 * 'cr' 是裸 CR（老 Mac / 某些导出工具），**必须单独一格**：以前它被算进 'crlf'，
 * 而 'crlf' 不保留 eolMap，写回时每个 \r 都变成 \r\n —— 整篇字节翻倍，
 * 用户看到的是「全文都被改了一行」。
 */
export type EolStyle = 'crlf' | 'lf' | 'cr' | 'mixed'

export interface FileNode {
  name: string
  path: string
  isDir: boolean
  children?: FileNode[]
}

export interface NoteDoc {
  path: string
  /** 原始字节解码后的文本（已剥 BOM，换行统一成 \n） */
  text: string
  /** 原文件的换行风格；'mixed' 时 eolMap 记录每一处原始换行序列 */
  eolStyle: EolStyle
  eolMap: string[] | null
  /** 原文件是否带 UTF-8 BOM */
  bom: boolean
  /** 原文件末尾是否带换行符 */
  endsWithNewline: boolean
  /**
   * 原文件是否为合法 UTF-8。
   * false 时编辑器里看到的是乱码，且**保存会被主进程拒绝**（见 SaveResult.encoding）。
   */
  validUtf8: boolean
  /** 文件 mtime（毫秒），用于外部修改检测 */
  mtimeMs: number
  /** 文件字节数 */
  size: number
}

export interface SaveMeta {
  eolStyle: EolStyle
  eolMap: string[] | null
  bom: boolean
  /**
   * 原文末尾有没有换行。
   *
   * `encodeText` **不用**它：末尾换行由 split/join 天然保住（`"a"` → `"a"`、
   * `"a\n"` → `"a"+eol`），照着这个标记补一次就是篡改（用户手动删掉末尾空行
   * 会被我们偷偷加回去）。带在 meta 里只是让写盘那一侧看得见原文全貌。
   */
  endsWithNewline: boolean
  /** 打开/上次保存时看到的 mtime；不一致就报冲突。不传则不检测（兼容老调用） */
  expectMtimeMs?: number
  /**
   * 打开/上次保存时看到的字节数。
   *
   * 和 `expectMtimeMs` 一起构成「文件没被动过」的指纹：两者都命中就跳过写盘前的
   * 整篇读盘编码复检（否则每次保存都要把 280KB 重读一遍判 UTF-8）。
   * 只传 mtime 不传 size 时退回保守行为 —— 每次都复检。
   */
  expectSize?: number
  /** 用户已经确认「以我这版覆盖」时置 true，跳过冲突检测 */
  force?: boolean
}

export interface SaveResult {
  ok: boolean
  mtimeMs: number
  size: number
  error?: string
  /** 磁盘上的文件在编辑器打开之后被别的程序改过 */
  conflict?: boolean
  /** 原文件不是 UTF-8，主进程拒绝写盘（否则会把全文转码写坏） */
  encoding?: boolean
}

export interface BrokenImage {
  notePath: string
  rawPath: string
  resolvedPath: string
}

/** 主题翻译报告（策划案 §5.3：应用 N 条 / 丢弃 M 条 / 明细） */
export interface ThemeReport {
  file: string
  sources: string[]
  rawLines: number
  outLines: number
  kept: number
  dropped: number
  urls: number
  fontFaces: number
  imports: number
  keyframes: number
  droppedSamples: string[]
  renamedSamples: string[]
  warnings: string[]
}

export interface ThemePayload {
  css: string
  report: ThemeReport
  vars: Record<string, string>
}

/** 崩溃草稿：编辑器未落盘时的全文快照（M1「崩溃恢复」的实现载体） */
export interface CrashDraft {
  path: string
  text: string
  at: number
}

declare global {
  interface Window {
    api: {
      openLibrary(): Promise<string | null>
      getLibrary(): Promise<string | null>
      setLibrary(root: string): Promise<string | null>
      listTree(root: string): Promise<FileNode[]>
      /** 只读一层目录（文件树懒加载；`children` 不填表示还没读过） */
      listDir(dir: string): Promise<FileNode[]>
      /** 新建文件/文件夹（名字非法或已存在时 `ok:false` + 中文原因） */
      newEntry(dir: string, name: string, isDir: boolean): Promise<{ ok: boolean; path?: string; error?: string }>
      /** 移动文件/目录到另一个目录（拖拽用；同名会失败，不覆盖） */
      moveEntry(src: string, targetDir: string): Promise<{ ok: boolean; path?: string; error?: string }>
      /** 重命名（新名字没带扩展名时沿用原来的） */
      renameEntry(target: string, name: string): Promise<{ ok: boolean; path?: string; error?: string }>
      /** 删除到系统回收站；`forceAvailable` 表示回收站被系统拒绝、可以走永久删除 */
      trashEntry(target: string): Promise<{ ok: boolean; error?: string; forceAvailable?: boolean }>
      /** 永久删除（只在回收站不可用且用户二次确认后调用） */
      removeEntry(target: string): Promise<{ ok: boolean; error?: string }>
      /** 在资源管理器里定位（成功返回空串，失败返回中文原因） */
      revealEntry(target: string): Promise<string>
      /** 文件/目录属性（不存在返回 null） */
      statEntry(
        target: string
      ): Promise<{ path: string; name: string; isDir: boolean; size: number; mtimeMs: number } | null>
      openInNewWindow(file?: string): Promise<boolean>
      readNote(path: string): Promise<NoteDoc>
      writeNote(path: string, text: string, meta: SaveMeta): Promise<SaveResult>
      saveImage(notePath: string, base64: string, ext: string): Promise<string>
      brokenImagesOf(path: string): Promise<BrokenImage[]>
      scanBrokenImages(root: string): Promise<BrokenImage[]>
      /** 在资源管理器里定位图片文件；返回错误串，空串 = 成功 */
      revealImage(absPath: string): Promise<string>
      getThemes(): Promise<string[]>
      getThemeDir(): Promise<string>
      /** 在系统文件管理器里打开主题目录；返回错误串，空串 = 成功 */
      openThemeDir(): Promise<string>
      /** 正文字体 / 字号：空串和 0 表示跟随主题 */
      getFont(): Promise<{ family: string; size: number }>
      setFont(patch: { family?: string; size?: number }): Promise<{ family: string; size: number }>
      /** 行为偏好：整包读、整包改（未知键丢弃，值由主进程夹区间） */
      getPrefs(): Promise<Prefs>
      setPrefs(patch: Partial<Prefs>): Promise<Prefs>
      /** 用系统默认程序打开链接；只放行 http/https/mailto，返回错误串，空串 = 成功 */
      openExternal(url: string): Promise<string>
      /** 系统剪贴板读写（右键格式条用；渲染进程的 navigator.clipboard 在 file:// 下受限） */
      readClipboard(): Promise<string>
      writeClipboard(text: string): Promise<boolean>
      getCurrentTheme(): Promise<string>
      setCurrentTheme(name: string): Promise<string>
      translateTheme(name: string): Promise<ThemePayload>
      /** 导出 PDF：渲染层拼好整页 HTML，主进程弹保存框并用隐藏窗口打印 */
      exportPdf(
        html: string,
        suggested: string
      ): Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string }>
      /** 崩溃草稿；超过 2MB 的文件不存（返回 false） */
      saveDraft(path: string, text: string): Promise<boolean>
      getDraft(): Promise<CrashDraft | null>
      clearDraft(): Promise<void>
      getLastFile(): Promise<string>
      setLastFile(path: string): Promise<string>
      getSidebarWidth(): Promise<number>
      saveSidebarWidth(w: number): Promise<number>
      /** 自动保存防抖时长（毫秒，来自 config.autosaveDebounceMs，已夹在 100..10000） */
      getAutosaveMs(): Promise<number>
      /** 配置文件读坏了没有？空串表示没问题（读坏时会静默回落默认值，必须显式暴露） */
      getConfigError(): Promise<string>
      /** 把「有未保存改动」告诉主进程，关窗时用它决定拦不拦 */
      setDirty(value: boolean): void
      /**
       * 让 Windows 原生标题栏跟着主题明暗走。
       * 标题栏是系统画的，CSS 碰不到；只能让主进程设 nativeTheme.themeSource。
       */
      setTitleBarTheme(mode: 'dark' | 'light'): void
      /** 快捷键设置：当前覆盖表 + 全部可改命令 */
      getKeymap(): Promise<{ keymap: Keymap; commands: CommandDef[] }>
      /** 保存覆盖表，主进程会立刻重建菜单（改完即生效） */
      setKeymap(map: Keymap): Promise<Keymap>
      /**
       * 进入/退出「录制快捷键」模式。
       * 录制期间主进程会把菜单上的 accelerator 全部摘掉 —— 否则 Electron 在
       * 主进程就把按键吃了，渲染层收不到 keydown，想改 Ctrl+S 时只会触发保存。
       */
      setCaptureMode(on: boolean): void
      /** 存完盘后主动退出（主进程的「保存并关闭」走这条） */
      quitNow(): void
      onMenu(cb: (cmd: string) => void): void
      onThemeChanged(cb: () => void): void
      /** 笔记库里的 .md 被外部改了 / 增删改名了（主进程 500ms 防抖后推送） */
      onLibraryChanged(cb: () => void): void
    }
  }
}
