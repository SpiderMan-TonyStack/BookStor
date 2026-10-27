import { app } from 'electron'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

/**
 * 选一个真的能写的 userData 目录。
 *
 * 为什么需要这件事（实测）：
 * 1. 便携版（electron-builder portable）解压到临时目录运行，配置写在 %APPDATA%
 *    会让「便携」名不副实 —— 换个 U 盘跑就是全新配置。
 * 2. 受限环境（沙箱 / 只读漫游配置 / 组策略）下，Chromium 在启动早期无法创建
 *    userData 目录时会直接以 0xc0000005 原生崩溃，且不吐任何 JS 堆栈 ——
 *    表现为「窗口一闪不出、日志全空」，极难定位。
 *
 * 因此：先确定候选目录，逐个尝试 mkdir + 写探测文件，第一个成功的就用它。
 * 全部失败时退回 os.tmpdir()（至少还能起来，不至于崩）。
 */

interface Candidate {
  dir: string
  why: string
}

function canWrite(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true })
    const probe = path.join(dir, `.write-probe-${process.pid}`)
    fs.writeFileSync(probe, 'ok', 'utf8')
    fs.unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

/** 按优先级列出 userData 候选目录 */
function candidates(defaultDir: string): Candidate[] {
  const list: Candidate[] = []

  // 便携版：electron-builder 注入 PORTABLE_EXECUTABLE_DIR
  const portableDir = process.env['PORTABLE_EXECUTABLE_DIR']
  if (portableDir) {
    list.push({ dir: path.join(portableDir, 'userdata'), why: '便携版：配置跟随 exe' })
  }

  // 开发/免安装：放在应用目录下，便于随身携带与排查
  if (!app.isPackaged) {
    list.push({ dir: path.join(app.getAppPath(), '.userdata'), why: '开发：项目内 .userdata' })
  }

  list.push({ dir: defaultDir, why: '系统默认 %APPDATA%' })
  list.push({ dir: path.join(os.tmpdir(), 'jiandu-userdata'), why: '兜底：临时目录' })
  return list
}

let resolved = ''

/**
 * 在 app ready **之前**调用：确定并把 userData 指到可写目录。
 * 返回最终使用的目录，以及是否发生了降级（降级要在控制台说明，否则用户找不到配置）。
 */
export function resolveUserDataDir(): { dir: string; fellBack: boolean; reason: string } {
  const defaultDir = app.getPath('userData')
  if (resolved) return { dir: resolved, fellBack: resolved !== defaultDir, reason: '' }

  for (const c of candidates(defaultDir)) {
    if (!canWrite(c.dir)) continue
    if (c.dir !== defaultDir) {
      app.setPath('userData', c.dir)
      // sessionData 默认跟随 userData，但已经初始化时要显式一起挪
      try {
        app.setPath('sessionData', c.dir)
      } catch {
        /* 某些版本没有 sessionData，忽略 */
      }
      // 光 setPath 不够：crashpad / 磁盘缓存等子系统在 setPath 生效前就已经
      // 按旧路径初始化，旧路径不可写时仍会原生崩溃。补一个 Chromium 开关，
      // 让所有子系统都落到同一个可写目录。
      app.commandLine.appendSwitch('user-data-dir', c.dir)
      app.commandLine.appendSwitch('disk-cache-dir', path.join(c.dir, 'Cache'))
    }
    resolved = c.dir
    return { dir: c.dir, fellBack: c.dir !== defaultDir, reason: c.why }
  }

  // 理论上到不了这里：tmpdir 也写不了的话 Electron 本身也起不来
  resolved = defaultDir
  return { dir: defaultDir, fellBack: false, reason: '' }
}
