// electron-builder 之后补写 exe 资源（图标 + 版本信息）。
//
// 为什么需要这个钩子（实测，别删注释）：
//   electron-builder 25.1.8 在 winPackager.js:142 无条件追加
//     --set-version-string OriginalFilename ""
//   → 空值。rcedit 2.6.0 收到空字符串直接报
//     Fatal error: --set-version-string requires 'Key' and 'Value'
//   → 整个资源写入步骤失败，构建中断。
//   已在 node_modules 里确认该行源码；试过 executableName / 换 productName / 清 release
//   都无效，因为那个 args.push 不看任何配置。
//
// 于是：构建时关掉 electron-builder 的资源写入（win.signAndEditExecutable=false），
//   改由这个 afterPack 钩子自己调 rcedit，把 OriginalFilename 写成真实文件名。
//   这样图标和版本信息照有，且不依赖 patch node_modules。

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

/** rcedit 在 electron-builder 的二进制缓存里（winCodeSign 包附带） */
function findRcedit() {
  const cacheRoot = path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache', 'winCodeSign')
  if (!fs.existsSync(cacheRoot)) return null
  const dirs = fs
    .readdirSync(cacheRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse()
  for (const d of dirs) {
    const exe = path.join(cacheRoot, d, 'rcedit-x64.exe')
    if (fs.existsSync(exe)) return exe
  }
  return null
}

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return

  const rcedit = findRcedit()
  if (!rcedit) {
    console.warn('[afterPack] 找不到 rcedit，跳过 exe 图标与版本信息（不影响功能）')
    return
  }

  const appOutDir = context.appOutDir
  const info = context.packager.appInfo
  const iconPath = path.join(context.packager.projectDir, 'scripts', 'icon.ico')

  const version = info.version || '0.1.0'
  const winVersion = `${version}.0`

  // 只处理 appOutDir 根下的主 exe（resources/ 里的 elevate.exe 不动）
  const exes = fs
    .readdirSync(appOutDir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.toLowerCase().endsWith('.exe'))
    .map((d) => path.join(appOutDir, d.name))

  for (const exe of exes) {
    const fileName = path.basename(exe)
    const args = [
      exe,
      '--set-version-string',
      'FileDescription',
      info.description || info.productName,
      '--set-version-string',
      'ProductName',
      info.productName,
      '--set-version-string',
      'LegalCopyright',
      info.copyright,
      '--set-version-string',
      'InternalName',
      path.basename(fileName, '.exe'),
      // ← 这一行就是 electron-builder 写错的地方：必须是真实文件名，不能是空串
      '--set-version-string',
      'OriginalFilename',
      fileName,
      '--set-file-version',
      version,
      '--set-product-version',
      winVersion,
    ]
    if (info.companyName) args.push('--set-version-string', 'CompanyName', info.companyName)
    if (fs.existsSync(iconPath)) args.push('--set-icon', iconPath)

    try {
      execFileSync(rcedit, args, { stdio: 'pipe' })
      console.log(`[afterPack] 已写入 ${fileName} 的图标与版本信息`)
    } catch (err) {
      // 图标写不进去不该让构建失败——功能不受影响，只是丑
      console.warn(`[afterPack] 写 ${fileName} 资源失败：${err.message}`)
    }
  }
}
