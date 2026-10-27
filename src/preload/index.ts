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
  onMenu: (cb: (cmd: string) => void) => {
    ipcRenderer.on('menu', (_e, cmd: string) => cb(cmd))
  },
  onThemeChanged: (cb: () => void) => {
    ipcRenderer.on('theme-changed', () => cb())
  },
})
