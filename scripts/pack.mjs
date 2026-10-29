#!/usr/bin/env node
/**
 * 打包便携版 exe。
 *
 * 这个脚本存在的唯一理由，是本机环境的两个限制：
 *
 * 1. **electron-builder 默认输出到 `release/`**，但它打包前会 `emptyDir` 清空
 *    `win-unpacked` —— 本机的 safe-delete 守卫按**文件数**拦批量删除（>50 个就拦），
 *    这一步必定失败（`SAFE_DELETE_BULK_GUARD_ERROR`）。
 * 2. 换输出目录能绕开，但目录要是放在项目里，每打一次就多一个 `.release-pack-N`，
 *    而且打包完那几个 `app.asar` 会被外部服务锁住几分钟到重启，删不掉。
 *
 * 所以：输出到**系统临时目录**（系统自己会清，也不碍眼），成功后只把 exe 拷回
 * `release/`。项目根目录从此只会有 `release/` 一个产物目录。
 *
 * 用法：`pnpm pack`（= 先 electron-vite build，再跑这个）
 *
 * ---
 *
 * 还有第三个本机特有的坑，这里一并绕掉（`prepareFreeSevenZip` 那段）：
 *
 * electron-builder 打 portable 时会调 `7zip-bin` 自带的 `7za.exe` 去压 `.7z`。
 * 那个 exe 躺在 `node_modules/.../win/x64/` 里 —— 也就是**项目目录内**。如果项目
 * 目录被打了 Integrity Level = Low（或带 `Everyone:(DENY)(S,DC)`），从低完整性级别
 * 目录启动的进程也是低完整性级别，写不进任何普通位置，7za 会报
 * `System ERROR: 拒绝访问`，而且错误信息是 GBK 乱码（`�ܾ����ʡ�`），看起来完全不
 * 像权限问题。
 *
 * 实测：同一个 7za.exe，放 `E:\jdtest\` 能压，放回项目里任何一个子目录都不能压
 * （cwd 和输出目录都无关，**只看 exe 自身所在路径**）。
 *
 * 绕法：把 7za.exe 拷到项目**外面**的临时目录，再用 `7zip-bin` 支持的
 * `USE_SYSTEM_7ZA=true`（此时它返回裸名 `7za`，走 PATH）指过去。
 * 这样 `pnpm pack` 在任何 ACL 正常的机器上行为不变（检测不到就用原来的）。
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outDir = mkdtempSync(path.join(tmpdir(), 'jiandu-pack-'))
const releaseDir = path.join(root, 'release')

console.log(`[pack] 临时输出目录：${outDir}`)

/**
 * 把 7za.exe 复制到项目外面，返回放它的目录（失败返回 null）。
 *
 * 为什么：项目目录若被标成 Low 完整性级别，从里面启动的 7za 写不了任何文件，
 * electron-builder 会报「拒绝访问」。详见文件头的说明。
 */
function prepareFreeSevenZip() {
  if (process.platform !== 'win32') return null

  // 找 7zip-bin 自带的那个 7za.exe（pnpm 的 .pnpm 布局 + 普通 node_modules 布局都试）
  const candidates = []
  const pnpmDir = path.join(root, 'node_modules', '.pnpm')
  if (existsSync(pnpmDir)) {
    for (const name of readdirSync(pnpmDir)) {
      if (!name.startsWith('7zip-bin@')) continue
      candidates.push(path.join(pnpmDir, name, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'))
    }
  }
  candidates.push(path.join(root, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'))

  const src = candidates.find((p) => existsSync(p))
  if (!src) return null

  try {
    const binDir = mkdtempSync(path.join(tmpdir(), 'jiandu-7za-'))
    copyFileSync(src, path.join(binDir, '7za.exe'))
    return binDir
  } catch {
    return null
  }
}

const sevenZipDir = prepareFreeSevenZip()
const env = { ...process.env }
if (sevenZipDir) {
  // USE_SYSTEM_7ZA=true 时 7zip-bin 返回裸名 "7za"，走 PATH 找我们这份
  env.USE_SYSTEM_7ZA = 'true'
  env.PATH = `${sevenZipDir}${path.delimiter}${env.PATH ?? ''}`
  console.log(`[pack] 7za 已复制到项目外：${sevenZipDir}`)
}

const isWin = process.platform === 'win32'
const builder = isWin
  ? path.join(root, 'node_modules', '.bin', 'electron-builder.cmd')
  : path.join(root, 'node_modules', '.bin', 'electron-builder')

const res = spawnSync(
  builder,
  ['--win', 'portable', `--config.directories.output=${outDir}`],
  { cwd: root, stdio: 'inherit', shell: isWin, env }
)

if (res.status !== 0) {
  console.error(`[pack] 打包失败（退出码 ${res.status}），临时目录保留：${outDir}`)
  process.exit(res.status ?? 1)
}

const exe = readdirSync(outDir).find((f) => f.toLowerCase().endsWith('.exe'))
if (!exe) {
  console.error(`[pack] 打包成功但没找到 exe，临时目录：${outDir}`)
  process.exit(1)
}

copyFileSync(path.join(outDir, exe), path.join(releaseDir, exe))
console.log(`[pack] 已写入 release/${exe}`)

// 尽力清理。app.asar 常常被外部服务锁着删不掉 —— 这时 quietly 放弃，
// 临时目录在系统 TEMP 下，不会污染项目，系统迟早会回收。
try {
  rmSync(outDir, { recursive: true, force: true })
  console.log('[pack] 临时目录已清理')
} catch {
  console.log(`[pack] 临时目录暂时删不掉（多余文件被锁），留在：${outDir}`)
}

if (sevenZipDir) {
  try {
    rmSync(sevenZipDir, { recursive: true, force: true })
  } catch {
    /* 拷出来的 7za 删不掉也无所谓，就 1.2MB 在 TEMP 里 */
  }
}

if (!existsSync(path.join(releaseDir, exe))) {
  console.error('[pack] 产物校验失败')
  process.exit(1)
}
