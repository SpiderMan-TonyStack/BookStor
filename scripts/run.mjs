#!/usr/bin/env node
/**
 * 启动简牍（开发/免打包运行）。
 *
 * 为什么不用 `electron .`：
 * Electron 在加载 package.json 之后、执行我们任何一行 JS 之前，就已经按
 * app.getName()（= package.json 的 name，这里是 jiandu）初始化了 Chromium
 * 的 crashpad / 缓存子系统，并尝试创建 %APPDATA%\jiandu。
 * 这一步发生在 JS 之前，所以我们代码里的 resolveUserDataDir() 救不了它 ——
 * 如果 %APPDATA%\jiandu 建不出来（受限账户、只读漫游配置、某些安全软件），
 * Electron 会以 0xc0000005 原生崩溃，且不打印任何 JS 堆栈、stdout/stderr 全空。
 *
 * 唯一可靠的绕法是在**命令行**上就指定 --user-data-dir，让 Chromium 从一开始
 * 就不去碰 %APPDATA%。这也是 electron-builder 便携版的做法。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

/** electron 包导出的就是可执行文件路径 */
const electronBin = require('electron')
if (typeof electronBin !== 'string') {
  console.error('找不到 electron 可执行文件，先跑 pnpm install')
  process.exit(1)
}

const userDataDir = path.join(root, '.userdata')
fs.mkdirSync(userDataDir, { recursive: true })

const args = [
  '.',
  // 让 Chromium 的所有子系统（crashpad、Cache、Local Storage…）都落到可写目录
  `--user-data-dir=${userDataDir}`,
  // 本机 %APPDATA% 下若干目录拒绝访问时，Chromium 的沙箱初始化会失败
  '--no-sandbox',
  ...process.argv.slice(2),
]

console.log(`[简牍] user-data-dir = ${userDataDir}`)

// 有些 shell / IDE 会注入 ELECTRON_RUN_AS_NODE=1，那会让 electron 以纯 Node 模式
// 启动（require('electron').app 为 undefined）。必须**删掉这个键**，置空字符串无效。
const env = { ...process.env }
delete env['ELECTRON_RUN_AS_NODE']

const child = spawn(electronBin, args, { cwd: root, stdio: 'inherit', env })

child.on('exit', (code, signal) => {
  if (signal) console.log(`[简牍] 退出（信号 ${signal}）`)
  else if (code !== 0) console.log(`[简牍] 退出码 ${code}`)
  process.exit(code ?? 0)
})
