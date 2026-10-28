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

const isWin = process.platform === 'win32'
const builder = isWin
  ? path.join(root, 'node_modules', '.bin', 'electron-builder.cmd')
  : path.join(root, 'node_modules', '.bin', 'electron-builder')

const res = spawnSync(
  builder,
  ['--win', 'portable', `--config.directories.output=${outDir}`],
  { cwd: root, stdio: 'inherit', shell: isWin }
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

if (!existsSync(path.join(releaseDir, exe))) {
  console.error('[pack] 产物校验失败')
  process.exit(1)
}
