import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  openLibrary: () => ipcRenderer.invoke('library:open'),
  getLibrary: () => ipcRenderer.invoke('library:get'),
  setLibrary: (root: string) => ipcRenderer.invoke('library:set', root),
  listTree: (root: string) => ipcRenderer.invoke('fs:tree', root),
  // 只读一层（文件树懒加载）
  listDir: (dir: string) => ipcRenderer.invoke('fs:listDir', dir),
  readNote: (path: string) => ipcRenderer.invoke('fs:read', path),
  // 文件树右键（4.8.0）：新建 / 重命名 / 删除（进回收站）/ 定位 / 属性
  newEntry: (dir: string, name: string, isDir: boolean) =>
    ipcRenderer.invoke('fs:new', dir, name, isDir),
  renameEntry: (target: string, name: string) => ipcRenderer.invoke('fs:rename', target, name),
  /** 拖拽移动：把 src 移到 targetDir 里（同名会失败，不覆盖） */
  moveEntry: (src: string, targetDir: string) => ipcRenderer.invoke('fs:move', src, targetDir),
  trashEntry: (target: string) => ipcRenderer.invoke('fs:trash', target),
  /** 永久删除（只有回收站不可用、且用户二次确认后才调） */
  removeEntry: (target: string) => ipcRenderer.invoke('fs:remove', target),
  revealEntry: (target: string) => ipcRenderer.invoke('fs:reveal', target),
  statEntry: (target: string) => ipcRenderer.invoke('fs:stat', target),
  /** 在新窗口打开（file 为空则打开上次那篇） */
  openInNewWindow: (file?: string) => ipcRenderer.invoke('win:new', file),
  writeNote: (path: string, text: string, meta: unknown) =>
    ipcRenderer.invoke('fs:write', path, text, meta),
  saveImage: (notePath: string, base64: string, ext: string) =>
    ipcRenderer.invoke('img:save', notePath, base64, ext),
  brokenImagesOf: (path: string) => ipcRenderer.invoke('img:brokenOf', path),
  revealImage: (absPath: string) => ipcRenderer.invoke('img:reveal', absPath),
  scanBrokenImages: (root: string) => ipcRenderer.invoke('img:brokenAll', root),
  getThemes: () => ipcRenderer.invoke('theme:list'),
  getThemeDir: () => ipcRenderer.invoke('theme:dir'),
  openThemeDir: () => ipcRenderer.invoke('theme:openDir'),
  getFont: () => ipcRenderer.invoke('app:getFont'),
  setFont: (patch: { family?: string; size?: number }) => ipcRenderer.invoke('app:setFont', patch),
  /** 行为偏好整包读写（编辑器 / 文件 / 图像 / 导出 / 缩放），清洗在主进程 */
  getPrefs: () => ipcRenderer.invoke('app:getPrefs'),
  setPrefs: (patch: unknown) => ipcRenderer.invoke('app:setPrefs', patch),
  getCurrentTheme: () => ipcRenderer.invoke('theme:getCurrent'),
  setCurrentTheme: (name: string) => ipcRenderer.invoke('theme:setCurrent', name),
  translateTheme: (name: string) => ipcRenderer.invoke('theme:translate', name),
  /** 导出 PDF：html 是渲染层拼好的整页（含主题 CSS），主进程负责选路径 + 隐藏窗口打印 */
  exportPdf: (html: string, suggested: string) => ipcRenderer.invoke('export:pdf', html, suggested),

  saveDraft: (path: string, text: string) => ipcRenderer.invoke('draft:save', path, text),
  getDraft: () => ipcRenderer.invoke('draft:get'),
  clearDraft: () => ipcRenderer.invoke('draft:clear'),

  getLastFile: () => ipcRenderer.invoke('app:getLastFile'),
  setLastFile: (path: string) => ipcRenderer.invoke('app:setLastFile', path),

  getSidebarWidth: () => ipcRenderer.invoke('app:getSidebarWidth'),
  saveSidebarWidth: (w: number) => ipcRenderer.invoke('app:setSidebarWidth', w),
  getAutosaveMs: () => ipcRenderer.invoke('app:getAutosaveMs'),
  getConfigError: () => ipcRenderer.invoke('app:getConfigError'),

  setDirty: (value: boolean) => ipcRenderer.send('app:dirty', value),
  openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
  readClipboard: () => ipcRenderer.invoke('clipboard:read'),
  writeClipboard: (text: string) => ipcRenderer.invoke('clipboard:write', text),
  setTitleBarTheme: (mode: 'dark' | 'light') => ipcRenderer.send('app:titlebar-theme', mode),

  getKeymap: () => ipcRenderer.invoke('keymap:get'),
  setKeymap: (map: Record<string, string>) => ipcRenderer.invoke('keymap:set', map),
  setCaptureMode: (on: boolean) => ipcRenderer.send('keymap:capture', on),
  quitNow: () => ipcRenderer.send('app:quit-now'),

  onMenu: (cb: (cmd: string) => void) => {
    ipcRenderer.on('menu', (_e, cmd: string) => cb(cmd))
  },
  onThemeChanged: (cb: () => void) => {
    ipcRenderer.on('theme-changed', () => cb())
  },
  /** 笔记库里的 .md 被外部改了/增删改名了（500ms 防抖后推送） */
  onLibraryChanged: (cb: () => void) => {
    ipcRenderer.on('library-changed', () => cb())
  },
})
