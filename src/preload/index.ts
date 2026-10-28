import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('api', {
  openLibrary: () => ipcRenderer.invoke('library:open'),
  getLibrary: () => ipcRenderer.invoke('library:get'),
  setLibrary: (root: string) => ipcRenderer.invoke('library:set', root),
  listTree: (root: string) => ipcRenderer.invoke('fs:tree', root),
  readNote: (path: string) => ipcRenderer.invoke('fs:read', path),
  writeNote: (path: string, text: string, meta: unknown) =>
    ipcRenderer.invoke('fs:write', path, text, meta),
  saveImage: (notePath: string, base64: string, ext: string) =>
    ipcRenderer.invoke('img:save', notePath, base64, ext),
  brokenImagesOf: (path: string) => ipcRenderer.invoke('img:brokenOf', path),
  scanBrokenImages: (root: string) => ipcRenderer.invoke('img:brokenAll', root),
  getThemes: () => ipcRenderer.invoke('theme:list'),
  getThemeDir: () => ipcRenderer.invoke('theme:dir'),
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

  setDirty: (value: boolean) => ipcRenderer.send('app:dirty', value),
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
})
