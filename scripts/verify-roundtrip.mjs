#!/usr/bin/env node
/**
 * 逐字节往返校验 —— M1 的验收脚本。
 *
 *   node scripts/verify-roundtrip.mjs [笔记库路径]
 *
 * 做三件事：
 *   1. 遍历库里全部 .md，逐篇 读字节 → decode → encode → 比对字节
 *      断言「逐字节相等」，不是「语义相等」。BOM / 换行符 / 末尾换行全藏在这一个断言里。
 *   2. 统计裂图数，与 94 这个已测基线比对，变多就报红。
 *   3. 输出汇总 + 失败清单。
 *
 * 退出码 0 = 全绿。
 */

import { promises as fs } from 'node:fs'
import * as path from 'node:path'
import { decodeBuffer, encodeText } from '../src/main/lossless.ts'

const LIB = process.argv[2] ?? 'D:\\BaiduSyncdisk\\笔记'
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
      if (HIDDEN_DIRS.has(e.name)) continue
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
  const stats = { crlf: 0, lf: 0, mixed: 0, bom: 0, noTrailingNewline: 0, empty: 0 }

  for (const file of files) {
    const original = await fs.readFile(file)
    const decoded = decodeBuffer(original)

    if (decoded.eolStyle === 'crlf') stats.crlf++
    else if (decoded.eolStyle === 'lf') stats.lf++
    else stats.mixed++
    if (decoded.bom) stats.bom++
    if (!decoded.endsWithNewline && original.length > 0) stats.noTrailingNewline++
    if (original.length === 0) stats.empty++

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

  return { failures, stats }
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
    const text = (await fs.readFile(file)).toString('utf8')
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
console.log(`笔记库: ${LIB}\n`)

if (!(await exists(LIB))) {
  console.error(`✗ 目录不存在: ${LIB}`)
  process.exit(2)
}

const files = await walk(LIB)
console.log(`扫描到 ${files.length} 篇 .md\n`)

const { failures, stats } = await checkRoundtrip(files)

console.log('── 编码分布 ─────────────────────────────')
console.log(`  纯 CRLF        ${stats.crlf}`)
console.log(`  纯 LF          ${stats.lf}`)
console.log(`  单篇内混用     ${stats.mixed}`)
console.log(`  带 BOM         ${stats.bom}`)
console.log(`  末尾无换行     ${stats.noTrailingNewline}`)
console.log(`  空文件         ${stats.empty}`)

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
if (failures.length === 0) {
  console.log(`  ✓ 全部 ${files.length} 篇逐字节相等`)
} else {
  console.log(`  ✗ ${failures.length} 篇不一致:`)
  for (const f of failures.slice(0, 30)) {
    console.log(`\n    ${f.file}`)
    console.log(`      ${f.reason}`)
  }
  if (failures.length > 30) console.log(`\n    …另有 ${failures.length - 30} 篇`)
}

const imgOk = broken <= BROKEN_BASELINE
console.log('\n─────────────────────────────────────────')
console.log(`裂图: ${imgOk ? '✓ 未超过基线' : `✗ 比基线多了 ${broken - BROKEN_BASELINE} 处`}`)
console.log(`耗时: ${((Date.now() - t0) / 1000).toFixed(1)}s`)

process.exit(failures.length === 0 && imgOk ? 0 : 1)
