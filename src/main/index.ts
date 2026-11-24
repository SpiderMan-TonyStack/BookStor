import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, shell } from 'electron'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { COMMANDS, keyOf, type Keymap } from '../shared/commands.js'
import { promises as fs, watch, type FSWatcher } from 'node:fs'
import { resolveUserDataDir } from './paths.js'
import { loadConfig, saveConfig, defaultThemeDir, getLastLoadError, getPrefs, setPrefs } from './config.js'
import { saveDraft, readDraft, clearDraft } from './draft.js'
import {
  listTree,
  listDir,
  readNote,
  writeNote,
  saveImage,
  scanBrokenImages,
  scanBrokenImagesOf,
  createEntry,
  renameEntry,
  moveEntry,
  statEntry,
} from './files.js'
import { translateTheme, loadMapping } from './theme.js'
import type { SaveMeta, ThemePayload } from '../shared/types.js'

// ⚠ 必须在任何东西用到 userData 之前执行：Chromium 在启动早期就要创建 userData
// 目录，创建失败是原生崩溃（0xc0000005），不吐 JS 堆栈，表现为「窗口不出、日志全空」。
const userDataInfo = resolveUserDataDir()

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged

let mainWindow: BrowserWindow | null = null

/**
 * 哪些窗口自报「有未保存改动」（按 `webContents.id` 记），供关窗拦截使用。
 *
 * 4.8.0 起支持多窗口（右键「在新窗口中打开」），单个布尔量会让**副窗口**的
 * dirty 状态顶替主窗口的：副窗口改了几个字 → 主窗口关窗也弹「还有未保存的修改」，
 * 反之副窗口丢改动时又不拦。改成按窗口记，各管各的。
 */
const dirtyWindows = new Set<number>()

/**
 * 录制快捷键期间置 true：此时菜单**不挂任何 accelerator**。
 *
 * 为什么必须这样：Electron 的菜单快捷键在主进程就吃掉了按键，
 * 渲染层根本收不到 keydown。用户想把已经绑给「保存」的 Ctrl+S 改到别的命令，
 * 一按 Ctrl+S 就触发保存、录制框什么都没录到 —— 看起来像「按了没反应」。
 * 所以进录制前先把菜单重建一遍、把键全摘掉，录完再挂回去。
 */
let captureMode = false

/**
 * 把菜单命令发给**当前聚焦的窗口**。
 *
 * 多窗口之后 `mainWindow` 不再等于「用户正在用的那个」：在副窗口点菜单里的
 * 「保存」，命令发给主窗口就成了保存另一篇（AC 内容对不上）。聚焦窗口拿不到
 * 时退回主窗口 —— 比如菜单是在所有窗口都失焦的瞬间被点开的。
 */
function send(cmd: string): void {
  const focused = BrowserWindow.getFocusedWindow()
  const target = focused && !focused.isDestroyed() ? focused : mainWindow
  target?.webContents.send('menu', cmd)
}

/** 从命令表生成一个菜单项，label / accelerator 都跟着 commands.ts 走 */
function mi(cmd: string, keymap: Keymap): Electron.MenuItemConstructorOptions {
  const def = COMMANDS.find((c) => c.cmd === cmd)
  const accel = keyOf(cmd, keymap)
  return {
    label: def?.label ?? cmd,
    // `registerAccelerator: false` —— accelerator 只用来在菜单里**显示**，不真正注册。
    //
    // 注册了就会先被主进程吃掉，和渲染层 keybindings 形成两条触发路径。
    // 格式化类命令双触发只是把字裹两层，60ms 去重盖得住；但 toggle 类命令
    // （专注模式 / 打字机）双触发会"开一次又关一次"，按下去毫无反应，
    // 状态栏还显示回到「常规」—— 实测去重挡不住（IPC 到达间隔偶尔超过 60ms）。
    // 现在只剩渲染层一条路径，行为可预测。
    ...(accel && !captureMode ? { accelerator: accel, registerAccelerator: false } : {}),
    click: () => send(cmd),
  }
}

async function buildMenu(): Promise<void> {
  const cfg = await loadConfig()
  const keymap: Keymap = cfg.keymap ?? {}

  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: '文件',
      submenu: [
        mi('open-library', keymap),
        { type: 'separator' },
        mi('save', keymap),
        mi('export-pdf', keymap),
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
        mi('find', keymap),
      ],
    },
    {
      label: '格式',
      submenu: [
        mi('bold', keymap),
        mi('italic', keymap),
        mi('underline', keymap),
        mi('code', keymap),
        { type: 'separator' },
        mi('strikethrough', keymap),
        mi('highlight', keymap),
        mi('comment', keymap),
        { type: 'separator' },
        mi('link', keymap),
        // 下面两个是子菜单，没有默认键（和 Typora 一致），所以不走 mi()，
        // 也就不会出现在快捷键面板里 —— 它们不是「一条命令」而是一组操作。
        {
          label: '链接操作',
          submenu: [
            { label: '打开链接', click: () => send('link-open') },
            { label: '复制链接地址', click: () => send('link-copy') },
            { label: '移除链接', click: () => send('link-remove') },
          ],
        },
        {
          label: '图像',
          submenu: [{ label: '插入本地图片…', click: () => send('image-insert') }],
        },
        { type: 'separator' },
        mi('clear-format', keymap),
      ],
    },
    // 段落（4.3.0）：块级操作单独成菜单，分组顺序对齐 Typora 的「段落」。
    // 标题类从「格式」搬到这里 —— 它们本来就是块级的，之前挤在格式菜单里
    // 只是因为没有别的地方可放。
    {
      label: '段落',
      submenu: [
        mi('h1', keymap),
        mi('h2', keymap),
        mi('h3', keymap),
        mi('h4', keymap),
        mi('h5', keymap),
        mi('h6', keymap),
        mi('p', keymap),
        { type: 'separator' },
        mi('promote-heading', keymap),
        mi('demote-heading', keymap),
        { type: 'separator' },
        {
          label: '表格',
          submenu: [
            { label: '插入表格', click: () => send('table') },
            { type: 'separator' },
            { label: '在下方插入行', click: () => send('table-row-below') },
            { label: '删除表格', click: () => send('table-remove') },
            { type: 'separator' },
            // 对齐作用于「光标所在那一列」，和 Typora 一致
            {
              label: '对齐',
              submenu: [
                mi('align-left', keymap),
                mi('align-center', keymap),
                mi('align-right', keymap),
                mi('align-default', keymap),
              ],
            },
          ],
        },
        mi('math-block', keymap),
        mi('codeblock', keymap),
        {
          label: '警告框',
          submenu: [
            { label: 'Note（备注）', click: () => send('admonition:note') },
            { label: 'Tip（提示）', click: () => send('admonition:tip') },
            { label: 'Important（重要）', click: () => send('admonition:important') },
            { label: 'Warning（警告）', click: () => send('admonition:warning') },
            { label: 'Caution（危险）', click: () => send('admonition:caution') },
          ],
        },
        { type: 'separator' },
        mi('quote', keymap),
        { type: 'separator' },
        mi('ol', keymap),
        mi('ul', keymap),
        mi('task-list', keymap),
        {
          label: '任务状态',
          submenu: [
            { label: '标记为已完成', click: () => send('task-done') },
            { label: '标记为未完成', click: () => send('task-todo') },
          ],
        },
        {
          label: '列表缩进',
          submenu: [
            { label: '增加缩进（Tab）', click: () => send('indent-more') },
            { label: '减少缩进（Shift+Tab）', click: () => send('indent-less') },
          ],
        },
        { type: 'separator' },
        mi('paragraph-above', keymap),
        mi('paragraph-below', keymap),
        { type: 'separator' },
        mi('ref-link', keymap),
        mi('footnote', keymap),
        { type: 'separator' },
        mi('hr', keymap),
        mi('toc', keymap),
        mi('front-matter', keymap),
      ],
    },
    {
      label: '视图',
      submenu: [
        mi('focus-mode', keymap),
        mi('typewriter-mode', keymap),
        mi('source-mode', keymap),
        { type: 'separator' },
        { role: 'reload', label: '重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
      ],
    },
    {
      label: '设置',
      submenu: [
        // 这两项本身不参与自定义 —— 改「打开设置」的键没有意义，也容易把自己锁死。
        // 「偏好设置」在命令表里（Ctrl+,），所以走 mi()；「快捷键…」没有默认键。
        mi('prefs', keymap),
        { label: '快捷键…', click: () => send('settings') },
        mi('theme-report', keymap),
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** 新建窗口的参数 */
interface NewWindowOptions {
  /** 打开这个文件（右键「在新窗口中打开」用）；不给就按 lastFile 走 */
  file?: string
  /** 副窗口：不改 `mainWindow` 指向、不保存窗口位置 */
  secondary?: boolean
}

async function createWindow(opts: NewWindowOptions = {}): Promise<BrowserWindow> {
  const cfg = await loadConfig()
  // 副窗口叠在主窗口上偏移 32px：完全重合时用户会以为「点了没反应」
  const base =
    opts.secondary && mainWindow && !mainWindow.isDestroyed()
      ? mainWindow.getBounds()
      : cfg.windowBounds
  const offset = opts.secondary ? 32 : 0

  const win = new BrowserWindow({
    width: base.width,
    height: base.height,
    ...(base.x !== undefined ? { x: base.x + offset } : {}),
    ...(base.y !== undefined ? { y: base.y + offset } : {}),
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

  // 只有主窗口参与「发菜单命令的兜底目标」与「记住窗口位置」这两件事
  if (!opts.secondary) mainWindow = win
  // 缩放要在页面加载前设好：加载后再设会让 CM6 用旧缩放测一遍高度，
  // 首次点击可能落到错行（和主题异步注入是同一类问题）。
  try {
    win.webContents.setZoomFactor(cfg.prefs.zoom)
  } catch {
    /* 夹值已在 shared/prefs.ts 做过；这里失败只影响外观，不该挡住开窗 */
  }
  win.once('ready-to-show', () => win.show())

  // 关窗保护：这个窗口自己有未落盘的改动时，先问一句再关。
  // 之前是在渲染层用 beforeunload + void doSave() —— 那是异步的，
  // 窗口已经销毁，await 后面的写盘根本没机会跑完，等于没保护。
  win.on('close', (e) => {
    const id = win.webContents.id
    if (!dirtyWindows.has(id)) return
    const choice = dialog.showMessageBoxSync(win, {
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
      dirtyWindows.delete(id)
      return
    }
    // 选择保存：拦下这次关闭，让渲染层存完再自己退出。
    // 副窗口发 save-then-close（只关自己），主窗口发 save-then-quit（退整个应用）。
    e.preventDefault()
    win.webContents.send('menu', opts.secondary ? 'save-then-close' : 'save-then-quit')
  })

  // 窗口位置只记主窗口的：副窗口偏移过 32px，记进去会让下次启动的位置越跑越偏
  if (!opts.secondary) {
    const saveBounds = async (): Promise<void> => {
      if (!mainWindow || mainWindow.isDestroyed()) return
      const b = mainWindow.getBounds()
      await saveConfig({ windowBounds: { x: b.x, y: b.y, width: b.width, height: b.height } })
    }
    win.on('resized', () => void saveBounds())
    win.on('moved', () => void saveBounds())
  }

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  if (isDev && process.env['ELECTRON_RENDERER_URL']) {
    const url = new URL(process.env['ELECTRON_RENDERER_URL'])
    if (opts.file) url.searchParams.set('file', opts.file)
    await win.loadURL(url.toString())
  } else {
    await win.loadFile(
      path.join(__dirname, '../renderer/index.html'),
      opts.file ? { query: { file: opts.file } } : {}
    )
  }
  return win
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
  // 换了库就得换监听目标（watchLibraryDir 内部会关掉旧的）
  void watchLibraryDir(root)
  return root
})

ipcMain.handle('library:set', async (_e, root: string) => {
  await saveConfig({ libraryRoot: root })
  void watchLibraryDir(root)
  return root
})

ipcMain.handle('fs:tree', async (_e, root: string) => listTree(root))

// 文件树懒加载：只读一层。文件树默认全收起，展开哪个目录才要它这一层。
ipcMain.handle('fs:listDir', async (_e, dir: string) => listDir(dir))

/**
 * 路径是否在「已打开的笔记库」里。
 *
 * 所有写操作（新建/重命名/删除）都先过这一关。渲染层的右键菜单只可能指向库内
 * 的节点，但 IPC 是**公开的**：万一渲染层出了注入问题，也不该能顺着 IPC 删到
 * 库外的任意文件。这是「进程边界上做校验」而不是「相信调用方」。
 *
 * `allowRoot` 只给「新建」用 —— 在库根目录下建文件是合法的，
 * 而对根目录本身重命名/删除永远不该允许。
 */
async function outsideLibrary(target: string, allowRoot = false): Promise<string | null> {
  const cfg = await loadConfig()
  const root = cfg.libraryRoot
  if (!root) return '还没有打开笔记库'
  const norm = (p: string): string => path.resolve(p).replace(/\\/g, '/').toLowerCase()
  const r = norm(root)
  const t = norm(target)
  if (t === r) return allowRoot ? null : '不能对笔记库根目录做这个操作'
  if (t.startsWith(r.endsWith('/') ? r : `${r}/`)) return null
  return '只能操作笔记库里的文件'
}

/** 新建文件 / 文件夹（文件树右键） */
ipcMain.handle('fs:new', async (_e, dir: string, name: string, isDir: boolean) => {
  const bad = await outsideLibrary(dir, true)
  if (bad) return { ok: false, error: bad }
  return createEntry(dir, name, isDir)
})

/** 重命名（文件树右键） */
ipcMain.handle('fs:rename', async (_e, target: string, name: string) => {
  const bad = await outsideLibrary(target)
  if (bad) return { ok: false, error: bad }
  return renameEntry(target, name)
})

/**
 * 删除：**进系统回收站**，不是直接抹掉。
 *
 * `shell.trashItem` 是 Electron 提供的跨平台回收站接口（Windows 走 IFileOperation），
 * 误删了还能捞回来 —— 笔记是用户的资产，这个软件里没有「不可恢复的删除」。
 */
ipcMain.handle('fs:trash', async (_e, target: string) => {
  const bad = await outsideLibrary(target)
  if (bad) return { ok: false, error: bad }
  try {
    await fs.access(target)
  } catch {
    return { ok: false, error: '这个文件已经不在了（可能被删或改名）' }
  }
  try {
    await shell.trashItem(target)
  } catch (err) {
    // 回收站不可用（企业策略 / 网络盘 / 某些沙箱环境会直接拒）。
    // 这里**绝不悄悄改成永久删除** —— 只把"可以走第二条路"告诉渲染层，
    // 由它弹一个明确的「永久删除」二次确认。见 file-ops.ts 的删除分支。
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      forceAvailable: true,
    }
  }
  return { ok: true }
})

/**
 * 永久删除（不进回收站）。
 *
 * **只有 `fs:trash` 明确失败、且用户二次确认之后才会走到这里** ——
 * `shell.trashItem` 在某些环境（企业策略、网络盘、受限沙箱）会直接抛
 * 「Failed to perform delete operation」，那时如果不给第二条路，
 * 用户点了「删除」就永远删不掉，而且看不出为什么。
 *
 * 校验与回收站那条一模一样：必须在库内、必须存在。
 */
ipcMain.handle('fs:remove', async (_e, target: string) => {
  const bad = await outsideLibrary(target)
  if (bad) return { ok: false, error: bad }
  try {
    await fs.access(target)
  } catch {
    return { ok: false, error: '这个文件已经不在了（可能被删或改名）' }
  }
  try {
    await fs.rm(target, { recursive: true, force: false })
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
  return { ok: true }
})

/**
 * 移动文件/目录（拖拽放下）。
 *
 * 源必须在库内，**目标目录允许是库根**（`allowRoot`）—— 把文件拖到树空白处
 * 就是"移回库根"，这是正常操作；而对根目录本身重命名/删除仍然禁止。
 */
ipcMain.handle('fs:move', async (_e, src: string, targetDir: string) => {
  const badSrc = await outsideLibrary(src)
  if (badSrc) return { ok: false, error: badSrc }
  const badDir = await outsideLibrary(targetDir, true)
  if (badDir) return { ok: false, error: badDir }
  return moveEntry(src, targetDir)
})

/** 在资源管理器里定位文件/目录（右键「打开文件位置」） */
ipcMain.handle('fs:reveal', async (_e, target: string) => {
  const bad = await outsideLibrary(target)
  if (bad) return bad
  try {
    await fs.access(target)
  } catch {
    return '这个文件已经不在了（可能被删或改名）'
  }
  shell.showItemInFolder(path.normalize(target))
  return ''
})

/** 属性面板用的 stat（大小 / 修改时间） */
ipcMain.handle('fs:stat', async (_e, target: string) => statEntry(target))

/**
 * 在新窗口里打开一篇笔记（右键「在新窗口中打开」）。
 *
 * 副窗口共享同一个库与同一份配置，但**不改 mainWindow 指向**、不保存窗口位置；
 * 关窗保护与 dirty 也按窗口各记各的（见 dirtyWindows）。
 */
ipcMain.handle('win:new', async (_e, file?: string) => {
  await createWindow({ ...(file ? { file } : {}), secondary: true })
  return true
})

ipcMain.handle('fs:read', async (_e, filePath: string) => readNote(filePath))

ipcMain.handle('fs:write', async (_e, filePath: string, text: string, meta: SaveMeta) =>
  writeNote(filePath, text, meta)
)

ipcMain.handle('img:save', async (_e, notePath: string, base64: string, ext: string) => {
  // 图片目录/前缀属于「行为偏好」，在进程边界读一次就够；渲染层不传这些，
  // 免得它自己造一份模板（两处各有一份必然漂）。
  const prefs = await getPrefs()
  return saveImage(notePath, base64, ext, {
    template: prefs.imageDirTemplate,
    dot: prefs.imageRelativeDot,
  })
})

ipcMain.handle('img:brokenOf', async (_e, filePath: string) => scanBrokenImagesOf(filePath))

ipcMain.handle('img:brokenAll', async (_e, root: string) => scanBrokenImages(root))

/**
 * 在系统文件管理器里定位图片（右键图片 → 打开图片所在位置）。
 *
 * `shell.showItemInFolder` 既不抛异常、**也没有返回值** —— 文件不存在时它什么
 * 都不做。不自己先 stat 一遍的话，用户看到的就是「点了菜单没反应」。
 */
ipcMain.handle('img:reveal', async (_e, absPath: string) => {
  if (!absPath) return '这个图片没有本地文件（网络图片或内联图片）'
  const p = path.normalize(absPath)
  try {
    await fs.access(p)
  } catch {
    return `图片文件不存在：\n${p}`
  }
  shell.showItemInFolder(p)
  return ''
})

/**
 * 导出 PDF：渲染层已经拼好整页 HTML（含翻译后的主题 CSS），
 * 这里只负责"选路径 → 交给隐藏窗口打印"。
 *
 * 为什么用隐藏窗口而不是主窗口直接 printToPDF：
 * 编辑器是 CM6 虚拟化的，屏幕上只有视口那几十行有 DOM，直接打印会得到大片空白。
 * 隐藏窗口里放的是**静态 HTML**，全文都在，纸张尺寸也由 @page 决定。
 */
ipcMain.handle('export:pdf', async (_e, html: string, suggested: string) => {
  if (!mainWindow) return { ok: false, error: '窗口不存在' }

  const res = await dialog.showSaveDialog(mainWindow, {
    title: '导出 PDF',
    defaultPath: suggested,
    filters: [{ name: 'PDF 文档', extensions: ['pdf'] }],
  })
  if (res.canceled || !res.filePath) return { ok: false, canceled: true }

  const tmpDir = await fs.mkdtemp(path.join(app.getPath('temp'), 'jiandu-pdf-'))
  const tmpHtml = path.join(tmpDir, 'doc.html')
  let win: BrowserWindow | null = null

  try {
    await fs.writeFile(tmpHtml, html, 'utf8')
    win = new BrowserWindow({
      show: false,
      width: 900,
      height: 1200,
      webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
    })
    await win.loadFile(tmpHtml)

    // 等图片解码完再打印：printToPDF 不会等图片，差一秒就是一片空白
    await win.webContents
      .executeJavaScript(
        `Promise.all([...document.images].map((i) => i.decode().catch(() => {}))).then(() => true)`,
        true
      )
      .catch(() => {})

    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: 'A4',
      preferCSSPageSize: false,
    })
    await fs.writeFile(res.filePath, pdf)
    // 导出的痛点不是生成，而是「文件存哪了」。默认关（不打扰），
    // 开了就定位到文件 —— 用 showItemInFolder 而不是 openPath(目录)：
    // 后者会新开一个窗口，用户还得自己找那一个文件。
    if ((await getPrefs()).openExportDir) shell.showItemInFolder(res.filePath)
    return { ok: true, path: res.filePath }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    if (win && !win.isDestroyed()) win.destroy()
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {})
  }
})

/**
 * 用系统默认程序打开链接（菜单「链接操作 → 打开链接」）。
 *
 * **只放行 http/https/mailto**：`shell.openExternal` 拿到 `file:` 或自定义协议时
 * 等于让笔记里的任意字符串去启动本机程序，而笔记内容常常是从别处粘来的，
 * 不能当可信输入。
 */
ipcMain.handle('app:openExternal', async (_e, url: string) => {
  const u = String(url ?? '').trim()
  if (!/^(https?:|mailto:)/i.test(u)) return '只支持 http / https / mailto 链接'
  try {
    await shell.openExternal(u)
    return ''
  } catch (err) {
    return (err as Error).message
  }
})

/**
 * 系统剪贴板（右键格式条的剪切 / 复制 / 粘贴）。
 *
 * 走主进程的 `clipboard` 模块而不是渲染进程的 `navigator.clipboard`：
 * 我们跑在 `file://` 下，读剪贴板会受权限策略限制（readText 直接 reject），
 * 而 Electron 主进程的 clipboard 是同步的原生接口，没有这层问题。
 */
ipcMain.handle('clipboard:write', (_e, text: string) => {
  clipboard.writeText(String(text ?? ''))
  return true
})

ipcMain.handle('clipboard:read', () => clipboard.readText())

/**
 * 界面缩放：所有窗口用同一个值（和 Typora 的 zoom 一致 —— 它是「软件设置」，
 * 不是「这个窗口的临时状态」）。副窗口不同步会出现「主窗口 120%、新开一个 100%」。
 */
function applyZoomToAllWindows(factor: number): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    try {
      win.webContents.setZoomFactor(factor)
    } catch {
      // 窗口正在销毁时 setZoomFactor 会抛；缩放是纯外观，失败不该冒泡到调用方
    }
  }
}

/**
 * 行为偏好的读写（编辑器 / 文件 / 图像 / 导出 / 缩放）。
 *
 * 用一对通道整包收发，而不是每个开关一对 IPC：开关会持续增加，一对一的写法
 * 每加一个就要动 preload、types、主进程三处，漏一处就是「面板上有、点了没用」。
 * 清洗规则在 shared/prefs.ts（零依赖，单测覆盖），这里只负责落盘和副作用。
 */
ipcMain.handle('app:getPrefs', async () => getPrefs())

ipcMain.handle('app:setPrefs', async (_e, patch: unknown) => {
  // 缩放对比必须放在 setPrefs 的**队列内部**（onApply）：在这里先 getPrefs() 取旧值
  // 再比较，两个并发请求会读到同一个旧值，最终谁赢、要不要设缩放都不确定。
  // 其余开关由渲染层自己应用（class 在 DOM 上）。
  return setPrefs(patch, (next, prev) => {
    if (next.zoom !== prev.zoom) applyZoomToAllWindows(next.zoom)
  })
})

/**
 * 正文字体 / 字号（偏好设置 → 外观）。
 *
 * 只存「用户明确改过」的值：空串和 0 都表示**跟随主题**，不是默认成某个字体 ——
 * 主题自己的 `#write{font-family:…;font-size:…}` 才是默认值，写死一个就等于
 * 把主题换了字体，换个主题观感就散了。
 */
ipcMain.handle('app:getFont', async () => {
  const cfg = await loadConfig()
  return { family: cfg.fontFamily ?? '', size: cfg.fontSize ?? 0 }
})

ipcMain.handle('app:setFont', async (_e, patch: { family?: string; size?: number }) => {
  const next: Partial<{ fontFamily: string; fontSize: number }> = {}
  if (typeof patch?.family === 'string') next.fontFamily = patch.family.trim()
  if (typeof patch?.size === 'number' && Number.isFinite(patch.size)) {
    // 夹到合理区间：小于 8 看不清，大于 40 一屏放不下几行
    next.fontSize = Math.max(0, Math.min(40, Math.round(patch.size)))
  }
  await saveConfig(next)
  const cfg = await loadConfig()
  return { family: cfg.fontFamily ?? '', size: cfg.fontSize ?? 0 }
})

/** 当前主题目录（配置里没有就用 userData 下的 themes） */
async function currentThemeDir(): Promise<string> {
  const cfg = await loadConfig()
  return cfg.themeDir || defaultThemeDir()
}

ipcMain.handle('theme:dir', async () => currentThemeDir())

/**
 * 在资源管理器里打开主题目录。
 *
 * 目录可能还不存在（刚装、配置里的 themeDir 指向一个没建的路径），先 mkdir 再开 ——
 * 否则 `shell.openPath` 直接失败，用户只看到"没反应"。
 * 返回空串表示成功：Electron 的 openPath 用 error string 报错，不是抛异常。
 */
ipcMain.handle('theme:openDir', async () => {
  const dir = await currentThemeDir()
  try {
    await fs.mkdir(dir, { recursive: true })
  } catch (err) {
    return `建不了目录：${(err as Error).message}`
  }
  try {
    return await shell.openPath(dir)
  } catch (err) {
    return (err as Error).message
  }
})

/**
 * 内置主题可能所在的位置：打包后在 `resources/theme/`（见 package.json 的
 * extraResources），开发期在 `src/theme/`。与 `mappingCandidates()` 同一套思路。
 */
function bundledThemeDirs(): string[] {
  const appPath = app.getAppPath()
  return [
    path.join(process.resourcesPath ?? '', 'theme'),
    path.join(appPath, 'resources', 'theme'),
    path.join(appPath, 'src', 'theme'),
  ].filter((p) => p.length > 0)
}

/**
 * 把内置主题种进用户主题目录（首次启动 / 目录被清空时）。
 *
 * 主题目录从 Typora 的目录改成自己的之后必须有这一步，否则新机器上主题
 * 列表是空的。规则：
 *   - 用户自己在配置里指定了 `themeDir` 就完全不碰；
 *   - 只种**不存在**的文件 —— 用户改过或故意删掉的 css 不会被下次启动
 *     覆盖回去（磁盘上的 css 就是真相，和主题热重载同一套预期）；
 *   - 单个文件失败不影响其它，种不上最多是少一个主题，不能挡住启动。
 */
async function seedThemeDir(): Promise<void> {
  const cfg = await loadConfig()
  if (cfg.themeDir) return
  const dir = defaultThemeDir()
  try {
    await fs.mkdir(dir, { recursive: true })
  } catch (err) {
    console.warn(`[简牍] 建不了主题目录 ${dir}：${(err as Error).message}`)
    return
  }
  for (const src of bundledThemeDirs()) {
    let names: string[]
    try {
      names = (await fs.readdir(src)).filter((f) => f.toLowerCase().endsWith('.css'))
    } catch {
      continue
    }
    if (names.length === 0) continue
    for (const name of names) {
      const dest = path.join(dir, name)
      try {
        await fs.access(dest)
        continue // 已存在，保留用户的版本
      } catch {
        /* 不存在，继续种 */
      }
      try {
        await fs.copyFile(path.join(src, name), dest)
      } catch (err) {
        console.warn(`[简牍] 主题 ${name} 种不进去：${(err as Error).message}`)
      }
    }
    return // 第一个有内容的来源就够了
  }
}

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

// ------------------------------------------------------------------ 笔记目录监听
//
// 为什么要它：以前外部改了笔记（Typora / Obsidian / git checkout / 网盘同步），
// 简牍**只有在你按保存时**才会发现（靠 writeNote 的 mtime 冲突检测）。
// 文件树里多了一篇、删了一篇、改了名，则要等下次启动才看见。
//
// 现在：监听到 .md 变化 → 防抖 → 通知渲染层。渲染层做两件事：
//   1. 重画文件树（增删改名都能看见）
//   2. 当前这篇若被外部改过：**没有未保存改动就自动重载**，有改动就只提示
//      （绝不自动覆盖 —— 那和 writeNote 的冲突检测是同一件事，不能两套标准）
let libWatcher: FSWatcher | null = null
let libWatchTimer: NodeJS.Timeout | null = null
let libWatched = ''

async function watchLibraryDir(root: string): Promise<void> {
  if (libWatched === root && libWatcher) return
  libWatcher?.close()
  libWatcher = null
  libWatched = ''
  if (!root) return
  try {
    libWatcher = watch(root, { recursive: true }, (_evt, filename) => {
      if (!filename) return
      const f = String(filename)
      // 只看笔记本身：.assets 里的图片增删不改文件树，也和"这篇正文被改过"无关
      if (!/\.(md|markdown|txt)$/i.test(f)) return
      // 点开头的目录（.obsidian / .主题 / .xxx.assets）不参与 —— 与 listTree 同一套规则
      if (f.split(/[\\/]/).some((seg) => seg.startsWith('.'))) return
      if (libWatchTimer) clearTimeout(libWatchTimer)
      // 500ms 防抖：编辑器保存会连发多个事件，一次保存触发三四次重画会闪
      libWatchTimer = setTimeout(() => {
        mainWindow?.webContents.send('library-changed')
      }, 500)
    })
    libWatched = root
  } catch (err) {
    // 监听失败不影响任何既有功能（保存时的 mtime 检测仍然在），只是不能实时刷新
    console.warn(`[简牍] 笔记目录监听失败：${(err as Error).message}`)
  }
}

/** 渲染层拿来做「配置落在哪」的排查用（便携版可能降级到临时目录） */
ipcMain.handle('app:userData', async () => ({
  dir: userDataInfo.dir,
  fellBack: userDataInfo.fellBack,
  reason: userDataInfo.reason,
}))

/**
 * 配置文件读坏了没有？
 *
 * `loadConfig` 在读不懂时回落默认值（文件树突然空了 / 主题变回内置），
 * 这条以前是**完全静默**的，用户只能觉得"软件坏了"。现在启动时问一次，
 * 有错就在状态栏说明白 —— 让问题可见，比让它"看起来正常"重要。
 * 返回空串表示没问题。
 */
ipcMain.handle('app:getConfigError', async () => getLastLoadError())

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
ipcMain.on('app:dirty', (e, value: boolean) => {
  const id = e.sender.id
  if (value) dirtyWindows.add(id)
  else dirtyWindows.delete(id)
})

/**
 * 原生标题栏跟随主题明暗。
 *
 * 标题栏那一行是 Windows 画的（DWM），渲染层的 CSS 完全够不着 ——
 * 主题切成深色后，正文一片黑、标题栏还是浅灰，割裂感很明显。
 * nativeTheme.themeSource 是唯一能影响它的开关：设成 dark 后 Windows
 * 会把标题栏（含右上角三个按钮）切成深色。
 *
 * 只传 'dark' | 'light' 两种，因为系统标题栏本来就只有这一档；
 * 想精确到主题那个具体色值（比如 #262626）必须改成无边框自绘标题栏。
 */
ipcMain.on('app:titlebar-theme', (_e, mode: unknown) => {
  if (mode !== 'dark' && mode !== 'light') return
  if (nativeTheme.themeSource === mode) return
  nativeTheme.themeSource = mode
})

// ------------------------------------------------------------------ 快捷键设置

/** 设置面板开局要的数据：当前覆盖表 + 全部可改命令 */
ipcMain.handle('keymap:get', async () => {
  const cfg = await loadConfig()
  return { keymap: cfg.keymap ?? {}, commands: COMMANDS }
})

/**
 * 保存覆盖表并立刻重建菜单。
 *
 * 顺手做两件清理，免得配置文件越用越脏：
 *   - 丢掉空值（用户点了「清除」就是删掉这一项，回落到默认键）
 *   - 丢掉命令表里已经不存在的 cmd（旧版本留下的，或我以后删掉的命令）
 */
ipcMain.handle('keymap:set', async (_e, map: unknown) => {
  const clean: Keymap = {}
  if (map && typeof map === 'object') {
    for (const [cmd, accel] of Object.entries(map as Record<string, unknown>)) {
      if (typeof accel !== 'string' || !accel.trim()) continue
      if (!COMMANDS.some((c) => c.cmd === cmd)) continue
      clean[cmd] = accel.trim()
    }
  }
  await saveConfig({ keymap: clean })
  await buildMenu()
  return clean
})

/** 进入/退出录制：录制期间菜单不挂 accelerator，否则想改 Ctrl+S 只会触发「保存」 */
ipcMain.on('keymap:capture', (_e, on: unknown) => {
  captureMode = Boolean(on)
  void buildMenu()
})

/** 侧栏宽度：拖一下记住，下次启动还原 */
ipcMain.handle('app:getSidebarWidth', async () => (await loadConfig()).sidebarWidth)
ipcMain.handle('app:setSidebarWidth', async (_e, w: number) => {
  await saveConfig({ sidebarWidth: Math.max(160, Math.min(480, Math.round(w))) })
  return w
})

/**
 * 自动保存防抖时长。
 *
 * 这个字段以前躺在 config.json 里**没有任何代码读**（800ms 硬编码在
 * `renderer/main.ts` 的 `scheduleSave`），附录 B 自己也承认了。现在渲染层启动时
 * 问一次，配置改了就真的生效 —— 否则「配置文件里有这个选项」就是骗人的。
 *
 * 夹在 100ms..10s：太小会让每次按键都写一次盘（200KB 的笔记直接卡），
 * 太大会让自动保存形同虚设。
 */
ipcMain.handle('app:getAutosaveMs', async () => {
  const v = (await loadConfig()).autosaveDebounceMs
  return Number.isFinite(v) ? Math.max(100, Math.min(10_000, Math.round(v))) : 800
})

/** 渲染层存完盘后请求退出（「保存并关闭」走这条路） */
ipcMain.on('app:quit-now', () => {
  dirtyWindows.clear()
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
    // 配置读坏了必须留痕：否则用户只看到"文件树空了、主题变回内置"，
    // 完全不知道是 config.json 解析失败（提示由渲染层显示）。
    const cfgErr = getLastLoadError()
    if (cfgErr) console.warn(`[简牍] ${cfgErr}`)

    await buildMenu()
    // 先种主题再开窗：渲染层一启动就会列主题，目录空着会先看到"只有内置档"
    await seedThemeDir()
    await createWindow()
    await watchThemeDir()
    // 上次的库如果还在，启动就把监听挂上，不用等用户再点一次「打开」
    void watchLibraryDir((await loadConfig()).libraryRoot)

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow()
    })
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
