/**
 * 共享类型：主进程 ↔ 渲染进程
 */

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
  eolStyle: 'crlf' | 'lf' | 'mixed'
  eolMap: string[] | null
  /** 原文件是否带 UTF-8 BOM */
  bom: boolean
  /** 原文件末尾是否带换行符 */
  endsWithNewline: boolean
  /** 文件 mtime（毫秒），用于外部修改检测 */
  mtimeMs: number
  /** 文件字节数 */
  size: number
}

export interface SaveMeta {
  eolStyle: 'crlf' | 'lf' | 'mixed'
  eolMap: string[] | null
  bom: boolean
  endsWithNewline: boolean
}

export interface SaveResult {
  ok: boolean
  mtimeMs: number
  size: number
  error?: string
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
      readNote(path: string): Promise<NoteDoc>
      writeNote(path: string, text: string, meta: SaveMeta): Promise<SaveResult>
      saveImage(notePath: string, base64: string, ext: string): Promise<string>
      brokenImagesOf(path: string): Promise<BrokenImage[]>
      scanBrokenImages(root: string): Promise<BrokenImage[]>
      getThemes(): Promise<string[]>
      getThemeDir(): Promise<string>
      getCurrentTheme(): Promise<string>
      setCurrentTheme(name: string): Promise<string>
      translateTheme(name: string): Promise<ThemePayload>
      /** 崩溃草稿；超过 2MB 的文件不存（返回 false） */
      saveDraft(path: string, text: string): Promise<boolean>
      getDraft(): Promise<CrashDraft | null>
      clearDraft(): Promise<void>
      getLastFile(): Promise<string>
      setLastFile(path: string): Promise<string>
      getSidebarWidth(): Promise<number>
      saveSidebarWidth(w: number): Promise<number>
      /** 把「有未保存改动」告诉主进程，关窗时用它决定拦不拦 */
      setDirty(value: boolean): void
      /**
       * 让 Windows 原生标题栏跟着主题明暗走。
       * 标题栏是系统画的，CSS 碰不到；只能让主进程设 nativeTheme.themeSource。
       */
      setTitleBarTheme(mode: 'dark' | 'light'): void
      /** 存完盘后主动退出（主进程的「保存并关闭」走这条） */
      quitNow(): void
      onMenu(cb: (cmd: string) => void): void
      onThemeChanged(cb: () => void): void
    }
  }
}
