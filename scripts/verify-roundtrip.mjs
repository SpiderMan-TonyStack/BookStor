#!/usr/bin/env node
/**
 * 逐字节往返校验 —— M1 的验收脚本。
 *
 *   node scripts/verify-roundtrip.mjs [笔记库路径]
 *
 * 做三件事：
 *   1. 遍历库里全部 .md，逐篇 读字节 → decode → encode → 比对字节
 *      断言「逐字节相等」，不是「语义相等」。BOM / 换行符 / 末尾换行全藏在这一个断言里。
 *      非 UTF-8 的篇目不参与比对（坏字节解成 � 后再编码回不去，比了必然红），
 *      但它们会单独列一区打印出来 —— 那种文件在编辑器里是只读的，用户得知道。
 *   2. 统计裂图数，与 94 这个已测基线比对，变多就报红。
 *   3. 输出汇总 + 失败清单。
 *
 * 退出码 0 = 全绿。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'

// 直接 import .ts 依赖 Node ≥ 22.18 的类型剥离（本机 v22.22 可用）。
// 用动态 import 是为了在低版本 Node 上给一句人话，而不是甩一堆
// ERR_UNKNOWN_FILE_EXTENSION —— 这个脚本是「无损」红线的守门人，
// 它挂了必须一眼看懂为什么挂。
let lossless
try {
  lossless = await import('../src/main/lossless.ts')
} catch (err) {
  console.error(
    '✗ 加载 src/main/lossless.ts 失败\n' +
      `  当前 Node ${process.version}。本脚本直接 import TypeScript 源码，\n` +
      '  需要 Node ≥ 22.18（内置类型剥离），或加 --experimental-strip-types 运行。\n' +
      `  原始错误：${err && err.message ? err.message : String(err)}`
  )
  process.exit(2)
}
const { decodeBuffer, encodeText } = lossless

// 笔记库位置：命令行第一个参数优先；没传就按候选链找第一个存在的目录。
// 以前硬编码 D:\BaiduSyncdisk\笔记 —— 项目目录里带着一份 `笔记\` 副本时，
// 不传参数就会去校验一个可能不存在的盘符（或者更糟：校验的是另一份库）。
const LIB_CANDIDATES = [
  'D:\\BaiduSyncdisk\\笔记',
  path.resolve(import.meta.dirname, '..', '笔记'),
]
const BROKEN_BASELINE = 94

/** 与编辑器一致：隐藏目录不入树、不参与统计（见策划案 §5.8） */
const HIDDEN_DIRS = new Set(['.git', 'node_modules'])

const isHiddenEntry = (name) =>
  name.startsWith('.') && name !== '.' && name !== '..'

async function walk(dir, out = []) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (HIDDEN_DIRS.has(e.name) || isHiddenEntry(e.name)) continue
      await walk(full, out)
    } else if (e.isFile() && e.name.toLowerCase().endsWith('.md')) {
      out.push(full)
    }
  }
  return out
}

// ---------------------------------------------------------------- 往返

async function checkRoundtrip(files) {
  const failures = []
  /** 非 UTF-8 文件：往返**必然**不相等（坏字节变 \uFFFD 后再编码就回不去了） */
  const notRoundtripable = []
  const stats = {
    crlf: 0,
    lf: 0,
    cr: 0,
    mixed: 0,
    bom: 0,
    noTrailingNewline: 0,
    empty: 0,
    invalidUtf8: 0,
  }

  for (const file of files) {
    const original = await fs.readFile(file)
    const decoded = decodeBuffer(original)

    // 'cr' 必须单独统计，不能掉进 mixed —— 它以前被算进 crlf，
    // 于是整篇 \r 的文件往返后字节翻倍（现在修了，这里的统计也要跟上）。
    if (decoded.eolStyle === 'crlf') stats.crlf++
    else if (decoded.eolStyle === 'lf') stats.lf++
    else if (decoded.eolStyle === 'cr') stats.cr++
    else stats.mixed++
    if (decoded.bom) stats.bom++
    if (!decoded.endsWithNewline && original.length > 0) stats.noTrailingNewline++
    if (original.length === 0) stats.empty++

    // 非 UTF-8 的文件单独归类，**不参与往返比对**：坏字节被解成 U+FFFD（�），
    // 再编码回去变不回原始字节，比了必然红。这类文件现在由保存路径直接拒绝写盘
    // （见 files.ts 的 writeNote 编码检查），所以不该让 verify 变红 ——
    // 但「库里有非 UTF-8 文件」是用户需要知道的事实，单独列一区打印。
    //
    // 判断放在比对之前而不是"比不过再判"：这样即使某个非 UTF-8 文件碰巧能往返，
    // 也不会被误报成"损坏"。
    if (!decoded.validUtf8) {
      stats.invalidUtf8++
      notRoundtripable.push({ file, size: original.length })
      continue
    }

    const reencoded = encodeText(decoded.text, {
      eolStyle: decoded.eolStyle,
      eolMap: decoded.eolMap,
      bom: decoded.bom,
    })

    if (!reencoded.equals(original)) {
      failures.push({
        file,
        reason: describeMismatch(original, reencoded),
        originalSize: original.length,
        reencodedSize: reencoded.length,
      })
    }
  }

  return { failures, stats, notRoundtripable }
}

function describeMismatch(a, b) {
  if (a.length !== b.length) {
    return `字节数不同：原 ${a.length} → 回 ${b.length}`
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      const ctx = (buf) =>
        buf
          .subarray(Math.max(0, i - 12), i + 12)
          .toString('utf8')
          .replace(/\r/g, '\\r')
          .replace(/\n/g, '\\n')
      return `首处差异在偏移 ${i}（0x${a[i].toString(16)} vs 0x${b[i].toString(16)}）上下文: …${ctx(a)}…`
    }
  }
  return '长度相同但内容不同（不应发生）'
}

// ---------------------------------------------------------------- 裂图

/**
 * 注意：Typora 会把带空格的图片文件名**原样**写进 markdown，不做 %20 编码、也不加尖括号：
 *   ![](./.Rider小操作.assets/Pasted image 20250425163232.png)
 * 这类引用实测有 134 处。所以这里不能用 `[^)\s]+`（会在第一个空格处断掉、
 * 整条匹配失败从而被静默跳过 → 统计偏低）。改用「括号内全取，再剥掉可选的标题」。
 */
const IMG_RE = /!\[[^\]]*\]\(([^)]*)\)/g

function extractImageTargets(text) {
  const out = []
  for (const m of text.matchAll(IMG_RE)) {
    let inner = (m[1] ?? '').trim()
    if (!inner) continue
    // 去掉可选的 title：  path "title"  /  path 'title'  /  path (title)
    const titleMatch = inner.match(/^(.+?)\s+("[^"]*"|'[^']*'|\([^)]*\))$/)
    if (titleMatch) inner = titleMatch[1].trim()
    // <path with spaces> 形式（实测库里没有，但标准允许）
    if (inner.startsWith('<') && inner.endsWith('>')) inner = inner.slice(1, -1)
    out.push(inner)
  }
  return out
}

async function checkBrokenImages(files) {
  let total = 0
  let broken = 0
  const missingAssetsDirs = new Set()

  for (const file of files) {
    // 与 files.ts 的 scanBrokenImagesOf 用同一条解码路径：裸 utf8 读会把 BOM
    // 留在字符串开头，首行紧贴图片语法时会漏判（库里 4 篇带 BOM）
    const text = decodeBuffer(await fs.readFile(file)).text
    const dir = path.dirname(file)

    for (const raw of extractImageTargets(text)) {
      if (/^(https?:|data:)/i.test(raw)) continue
      total++

      // 浏览器不把 \ 当分隔符；这里与渲染层用同一条归一规则
      const normalized = raw.replace(/\\/g, '/')
      let decodedPath = normalized
      try {
        decodedPath = decodeURIComponent(normalized)
      } catch {
        // 路径里有裸 % 之类的非法转义，按原样用
      }
      const abs = path.resolve(dir, decodedPath)

      try {
        await fs.access(abs)
      } catch {
        broken++
        const assetsDir = path.dirname(abs)
        if (!(await exists(assetsDir))) missingAssetsDirs.add(assetsDir)
      }
    }
  }

  return { total, broken, missingAssetsDirs: [...missingAssetsDirs] }
}

async function exists(p) {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------- 主流程

const t0 = Date.now()

let LIB = process.argv[2]
if (!LIB) {
  for (const candidate of LIB_CANDIDATES) {
    if (await exists(candidate)) {
      LIB = candidate
      break
    }
  }
  LIB ??= LIB_CANDIDATES[0]
}

console.log(`笔记库: ${LIB}\n`)

if (!(await exists(LIB))) {
  console.error(`✗ 目录不存在: ${LIB}`)
  console.error('  用法: node scripts/verify-roundtrip.mjs [笔记库路径]')
  process.exit(2)
}

const files = await walk(LIB)
console.log(`扫描到 ${files.length} 篇 .md\n`)

const { failures, stats, notRoundtripable } = await checkRoundtrip(files)

console.log('── 编码分布 ─────────────────────────────')
console.log(`  纯 CRLF        ${stats.crlf}`)
console.log(`  纯 LF          ${stats.lf}`)
console.log(`  纯 CR（裸）    ${stats.cr}`)
console.log(`  单篇内混用     ${stats.mixed}`)
console.log(`  带 BOM         ${stats.bom}`)
console.log(`  末尾无换行     ${stats.noTrailingNewline}`)
console.log(`  空文件         ${stats.empty}`)
console.log(`  非 UTF-8       ${stats.invalidUtf8}   （编辑器拒绝保存，跳过往返比对）`)

const { total, broken, missingAssetsDirs } = await checkBrokenImages(files)

console.log('\n── 图片 ─────────────────────────────────')
console.log(`  本地引用       ${total}`)
console.log(`  裂图           ${broken}   （基线 ${BROKEN_BASELINE}）`)
if (missingAssetsDirs.length > 0) {
  console.log(`  缺失的 assets 目录 ${missingAssetsDirs.length} 个:`)
  for (const d of missingAssetsDirs.slice(0, 10)) console.log(`    ${d}`)
  if (missingAssetsDirs.length > 10) console.log(`    …另有 ${missingAssetsDirs.length - 10} 个`)
}

console.log('\n── 往返校验 ─────────────────────────────')
const checked = files.length - notRoundtripable.length
if (failures.length === 0) {
  console.log(`  ✓ 全部 ${checked} 篇逐字节相等`)
} else {
  console.log(`  ✗ ${failures.length} 篇不一致:`)
  for (const f of failures.slice(0, 30)) {
    console.log(`\n    ${f.file}`)
    console.log(`      ${f.reason}`)
  }
  if (failures.length > 30) console.log(`\n    …另有 ${failures.length - 30} 篇`)
}

if (notRoundtripable.length > 0) {
  console.log(`\n── 非 UTF-8（不参与往返，保存会被拒绝）─────`)
  for (const f of notRoundtripable.slice(0, 10)) {
    console.log(`    ${f.file}  (${f.size} 字节)`)
  }
  if (notRoundtripable.length > 10) {
    console.log(`    …另有 ${notRoundtripable.length - 10} 篇`)
  }
  console.log('  这些文件在编辑器里是只读的。要用简牍编辑它们，先转成 UTF-8。')
}

const imgOk = broken <= BROKEN_BASELINE
console.log('\n─────────────────────────────────────────')
console.log(`裂图: ${imgOk ? '✓ 未超过基线' : `✗ 比基线多了 ${broken - BROKEN_BASELINE} 处`}`)
console.log(`耗时: ${((Date.now() - t0) / 1000).toFixed(1)}s`)

process.exit(failures.length === 0 && imgOk ? 0 : 1)
