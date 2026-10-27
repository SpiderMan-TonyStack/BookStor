import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promises as fs, watch, type FSWatcher } from 'node:fs'
import { resolveUserDataDir } from './paths.js'
import { loadConfig, saveConfig, defaultThemeDir } from './config.js'
import { saveDraft, readDraft, clearDraft } from './draft.js'
import { listTree, readNote, writeNote, saveImage, scanBrokenImages, scanBrokenImagesOf } from './files.js'
import { translateTheme, loadMapping, type ThemeResult } from './theme.js'
import type { SaveMeta, ThemePayload } from '../shared/types.js'

// ⚠ 必须在任何东西用到 userData 之前执行：Chromium 在启动早期就要创建 userData
// 目录，创建失败是原生崩溃（0xc0000005），不吐 JS 堆栈，表现为「窗口不出、日志全空」。
const userDataInfo = resolveUserDataDir()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null

/** 渲染层报告的「有未保存改动」状态，供关窗拦截使用（IPC 推上来，主进程不猜） */
let rendererDirty = false

function send(cmd: string): void {
  mainWindow?.webContents.send('menu', cmd)
}

function buildMenu(): void {
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        { label: '打开笔记库…', accelerator: 'CmdOrCtrl+O', click: () => send('open-library') },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '复制' },
        { role: 'paste', label: '粘贴' },
        { role: 'selectAll', label: '全选' },
        { type: 'separator' },
        { label: '查找', accelerator: 'CmdOrCtrl+F', click: () => send('find') },
      ],
    },
    {
      label: '格式',
      submenu: [
        { label: '标题 1', accelerator: 'CmdOrCtrl+1', click: () => send('h1') },
        { label: '标题 2', accelerator: 'CmdOrCtrl+2', click: () => send('h2') },
        { label: '标题 3', accelerator: 'CmdOrCtrl+3', click: () => send('h3') },
        { label: '标题 4', accelerator: 'CmdOrCtrl+4', click: () => send('h4') },
        { label: '标题 5', accelerator: 'CmdOrCtrl+5', click: () => send('h5') },
        { label: '标题 6', accelerator: 'CmdOrCtrl+6', click: () => send('h6') },
        { label: '正文', accelerator: 'CmdOrCtrl+0', click: () => send('p') },
        { type: 'separator' },
        { label: '加粗', accelerator: 'CmdOrCtrl+B', click: () => send('bold') },
        { label: '斜体', accelerator: 'CmdOrCtrl+I', click: () => send('italic') },
        { label: '行内代码', accelerator: 'CmdOrCtrl+Shift+`', click: () => send('code') },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

async function createWindow(): Promise<void> {
  const cfg = await loadConfig()

  mainWindow = new BrowserWindow({
    width: cfg.windowBounds.width,
    height: cfg.windowBounds.height,
    ...(cfg.windowBounds.x !== undefined ? { x: cfg.windowBounds.x } : {}),
    ...(cfg.windowBounds.y !== undefined ? { y: cfg.windowBounds.y } : {}),
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: '#262626',
    title: '简牍',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  // 关窗保护：渲染层有未落盘的改动时，先问一句再关。
  // 之前是在渲染层用 beforeunload + void doSave() —— 那是异步的，
  // 窗口已经销毁，await 后面的写盘根本没机会跑完，等于没保护。
  mainWindow.on('close', (e) => {
    if (!rendererDirty) return
    const choice = dialog.showMessageBoxSync(mainWindow!, {
      type: 'warning',
      buttons: ['保存并关闭', '取消', '放弃改动'],
      defaultId: 0,
      cancelId: 1,
      title: '还有未保存的修改',
      message: '当前笔记还没存盘。',
      detail: '「保存并关闭」会先写盘再退出；「放弃改动」会丢掉这次的修改。',
    })
    if (choice === 1) {
      e.preventDefault()
      return
    }
    if (choice === 2) {
      rendererDirty = false
      return
    }
    // 选择保存：拦下这次关闭，让渲染层存完再自己退出
    e.preventDefault()
    mainWindow?.webContents.send('menu', 'save-then-quit')
  })

  const saveBounds = async (): Promise<void> => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const b = mainWindow.getBounds()
    await saveConfig({ windowBounds: { x: b.x, y: b.y, width: b.width, height: b.height } })
  }
  mainWindow.on('resized', () => void saveBounds())
  mainWindow.on('moved', () => void saveBounds())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    await mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    await mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

// ------------------------------------------------------------------ IPC

ipcMain.handle('library:get', async () => {
  const cfg = await loadConfig()
  if (!cfg.libraryRoot) return null
  try {
    await fs.access(cfg.libraryRoot)
    return cfg.libraryRoot
  } catch {
    return null
  }
})

ipcMain.handle('library:open', async () => {
  if (!mainWindow) return null
  const res = await dialog.showOpenDialog(mainWindow, {
    title: '选择笔记库文件夹',
    defaultPath: (await loadConfig()).libraryRoot || undefined,
    properties: ['openDirectory'],
  })
  if (res.canceled || res.filePaths.length === 0) return null
  const root = res.filePaths[0]!
  await saveConfig({ libraryRoot: root })
  return root
})

ipcMain.handle('library:set', async (_e, root: string) => {
  await saveConfig({ libraryRoot: root })
  return root
})

ipcMain.handle('fs:tree', async (_e, root: string) => listTree(root))

ipcMain.handle('fs:read', async (_e, filePath: string) => readNote(filePath))

ipcMain.handle('fs:write', async (_e, filePath: string, text: string, meta: SaveMeta) =>
  writeNote(filePath, text, meta)
)

ipcMain.handle('img:save', async (_e, notePath: string, base64: string, ext: string) =>
  saveImage(notePath, base64, ext)
)

ipcMain.handle('img:brokenOf', async (_e, filePath: string) => scanBrokenImagesOf(filePath))

ipcMain.handle('img:brokenAll', async (_e, root: string) => scanBrokenImages(root))

/** 当前主题目录（配置里没有就用 Typora 实测默认位置） */
async function currentThemeDir(): Promise<string> {
  const cfg = await loadConfig()
  return cfg.themeDir || defaultThemeDir()
}

ipcMain.handle('theme:dir', async () => currentThemeDir())

/** 上次用的主题（重启后自动恢复，策划案 §5.4） */
ipcMain.handle('theme:getCurrent', async () => {
  const cfg = await loadConfig()
  return cfg.themeName || ''
})

ipcMain.handle('theme:setCurrent', async (_e, name: string) => {
  await saveConfig({ themeName: name })
  return name
})

ipcMain.handle('theme:list', async () => {
  const dir = await currentThemeDir()
  try {
    const entries = await fs.readdir(dir)
    return entries.filter((f) => f.toLowerCase().endsWith('.css')).sort()
  } catch {
    return []
  }
})

/** mapping.json 可能的位置：打包后随 asar 走，开发期在源码里 */
function mappingCandidates(): string[] {
  const appPath = app.getAppPath()
  return [
    path.join(appPath, 'resources', 'theme', 'mapping.json'),
    path.join(appPath, 'src', 'theme', 'mapping.json'),
    path.join(__dirname, '../../src/theme/mapping.json'),
    path.join(process.resourcesPath ?? '', 'theme', 'mapping.json'),
  ].filter((p) => p.length > 0)
}

let lastTheme: { name: string; result: ThemeResult } | null = null

ipcMain.handle('theme:translate', async (_e, name: string): Promise<ThemePayload> => {
  if (!name) throw new Error('未指定主题')
  const dir = await currentThemeDir()
  const file = path.resolve(dir, name)

  // 防目录穿越：解析后必须还在主题目录里
  if (!file.startsWith(path.resolve(dir) + path.sep)) {
    throw new Error(`主题不在主题目录内：${name}`)
  }

  const mapping = await loadMapping(mappingCandidates())
  const result = await translateTheme(file, mapping)
  lastTheme = { name, result }

  return {
    css: result.css,
    report: result.report,
    vars: result.vars,
  }
})

// 主题目录热重载：改一行 CSS，刷新就变（策划案 §5.4）
let themeWatcher: FSWatcher | null = null
let themeWatchTimer: NodeJS.Timeout | null = null

async function watchThemeDir(): Promise<void> {
  themeWatcher?.close()
  themeWatcher = null
  const dir = await currentThemeDir()
  try {
    // 递归监听：主题常把真实规则拆进 source/ 子目录（dyzj-dark 就是 4 层）
    themeWatcher = watch(dir, { recursive: true }, (_evt, filename) => {
      if (!filename) return
      const f = String(filename)
      if (!/\.(css|woff2?|ttf|eot|gif|png|jpe?g|svg)$/i.test(f)) return
      if (themeWatchTimer) clearTimeout(themeWatchTimer)
      // 400ms 防抖：编辑器保存 CSS 会连发多个事件
      themeWatchTimer = setTimeout(() => {
        mainWindow?.webContents.send('theme-changed')
      }, 400)
    })
  } catch (err) {
    console.warn(`[简牍] 主题目录监听失败：${(err as Error).message}`)
  }
}

/** 渲染层拿来做「配置落在哪」的排查用（便携版可能降级到临时目录） */
ipcMain.handle('app:userData', async () => ({
  dir: userDataInfo.dir,
  fellBack: userDataInfo.fellBack,
  reason: userDataInfo.reason,
}))

// ------------------------------------------------------------------ 崩溃草稿
//
// 编辑器每次改动 → 防抖 300ms 写一份全文快照
// 保存成功 / 正常关窗 → 清掉
// 下次启动若还有快照 → 说明上次没走完正常流程，问用户要不要恢复
//
// 存储在**独立的 draft.json** 里，不再借 config.json 一用：
// 那是每 300ms 一次的全量重写，和窗口尺寸/主题名混在一个文件里会互相牵连
// （详见 src/main/draft.ts 顶部注释）。

ipcMain.handle('draft:save', async (_e, filePath: string, text: string) => saveDraft(filePath, text))
ipcMain.handle('draft:get', async () => readDraft())
ipcMain.handle('draft:clear', async () => clearDraft())

/** 重启后回到上次那篇笔记（lastFile 字段同理，之前一直空着） */
ipcMain.handle('app:getLastFile', async () => (await loadConfig()).lastFile)
ipcMain.handle('app:setLastFile', async (_e, filePath: string) => {
  await saveConfig({ lastFile: filePath })
  return filePath
})

/** 渲染层每次 dirty 状态变化都推上来，主进程关窗时据此决定要不要拦 */
ipcMain.on('app:dirty', (_e, value: boolean) => {
  rendererDirty = value
})

/** 侧栏宽度：拖一下记住，下次启动还原 */
ipcMain.handle('app:getSidebarWidth', async () => (await loadConfig()).sidebarWidth)
ipcMain.handle('app:setSidebarWidth', async (_e, w: number) => {
  await saveConfig({ sidebarWidth: Math.max(160, Math.min(480, Math.round(w))) })
  return w
})

/** 渲染层存完盘后请求退出（「保存并关闭」走这条路） */
ipcMain.on('app:quit-now', () => {
  rendererDirty = false
  app.quit()
})

// ------------------------------------------------------------------ 生命周期

// 单实例：笔记软件多开会导致同一文件两个编辑器互相覆盖（数据不丢红线）。
// 第二个实例直接把已有窗口叫到前台，然后自己退出。
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // 第二个实例：不建窗口、不碰任何文件，直接退出
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
    mainWindow.show()
  })

  app.whenReady().then(async () => {
    if (userDataInfo.fellBack) {
      console.warn(`[简牍] userData 降级到 ${userDataInfo.dir}（${userDataInfo.reason}）`)
    }
    buildMenu()
    await createWindow()
    await watchThemeDir()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
