#!/usr/bin/env node
/**
 * 纯函数断言 —— 覆盖「逻辑只有一份、改错就全库翻车」的四个模块。
 *
 *   node --test scripts/test-units.mjs      （或 pnpm test）
 *
 * 为什么需要它：`verify-roundtrip.mjs` 只守得住无损编解码，而且是拿 245 篇真笔记
 * 做**端到端**比对。`stepFence` / `parseHeading` 这类判断改坏了，
 * 端到端脚本不会报错 —— 它只比字节，渲染成什么样它看不见。以前验证这两处
 * 只能靠"全库跑一遍看净增行数"（fence.ts 注释里那些 2252 / 8206 行），
 * 那个数字不可复现、也没法进 CI。所以把边界直接固化成断言。
 *
 * 覆盖的正是踩过的坑：
 *   - 列表项里的标题（`- ## x`，库里 50 文件 232 行这么写）
 *   - 深缩进围栏（列表项内 4–8 空格）与「块内更深缩进不能提前关块」
 *   - BOM + CRLF + 末尾无换行（245 篇里 4 篇 BOM、188 篇 CRLF、123 篇末尾无换行）
 *   - 表格行的转义竖线与对齐分隔行
 *   - 快捷键录制的合法性判定（只按修饰键 / 无修饰键 / F 键）
 *   - 裸 CR 风格、非 UTF-8 判定、mtime 冲突、writeNote 拒绝写坏盘（数据安全 P0）
 *
 * 零新增依赖：node:test + node:assert。直接 import .ts（与 verify 脚本同一条路）。
 *
 * 数据安全那组是**异步落盘测试**：用 os.tmpdir() 建临时目录，跑完即删。
 * 它们守的是「比往返更外面一层」的东西 —— 往返测试比的是我们自己的
 * decode/encode 是否自洽，两边一起错就永远绿；这几条比的是
 * 「面对磁盘上真实的别的程序留下的字节，我们有没有动手」。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// 直接 import .ts 依赖 Node ≥ 22.18 的类型剥离。用动态 import 是为了在低版本
// 给一句人话，而不是甩一堆 ERR_UNKNOWN_FILE_EXTENSION。
let heading
let fence
let tableParse
let commands
let lossless
let markdownHtml
let files
let inlineMarks
let imagePath
let blockEdits
let prefs
try {
  heading = await import('../src/renderer/heading.ts')
  fence = await import('../src/renderer/fence.ts')
  tableParse = await import('../src/renderer/table-parse.ts')
  commands = await import('../src/shared/commands.ts')
  lossless = await import('../src/main/lossless.ts')
  markdownHtml = await import('../src/renderer/markdown-html.ts')
  files = await import('../src/main/files.ts')
  inlineMarks = await import('../src/renderer/inline-marks.ts')
  imagePath = await import('../src/shared/image-path.ts')
  blockEdits = await import('../src/renderer/block-edits.ts')
  prefs = await import('../src/shared/prefs.ts')
} catch (err) {
  console.error(
    '✗ 加载 .ts 源文件失败\n' +
      `  当前 Node ${process.version}。本脚本直接 import TypeScript 源码，\n` +
      '  需要 Node ≥ 22.18（内置类型剥离），或加 --experimental-strip-types 运行。\n' +
      `  原始错误：${err && err.message ? err.message : String(err)}`
  )
  process.exit(2)
}

const { parseHeading, headingText } = heading
const { createFenceState, stepFence } = fence
const { splitRow, parseAlign, columnAt, joinRow } = tableParse
const { accelFromKey, prettyKey, sameAccel } = commands
const { decodeBuffer, encodeText, mtimeConflicts } = lossless
const { markdownToHtml } = markdownHtml
const { writeNote, readNote } = files
const { stripInline, findLinkAt } = inlineMarks
const { cleanImageTarget } = imagePath

// ---------------------------------------------------------------- 标题识别

test('heading: 行首标题', () => {
  assert.deepEqual(parseHeading('## 标题'), {
    level: 2,
    markEnd: 3,
    textStart: 3,
    inList: false,
  })
  // 一到六级都认
  for (let n = 1; n <= 6; n++) {
    const h = parseHeading(`${'#'.repeat(n)} x`)
    assert.equal(h?.level, n)
    assert.equal(h?.inList, false)
  }
})

test('heading: 列表项里的标题（- ## x / 1. ### x）', () => {
  // 库里 50 个文件、232 行这么写，多半是从网页复制时被套了列表符号
  const bullet = parseHeading('- ## C++ 教程')
  assert.deepEqual(bullet, { level: 2, markEnd: 5, textStart: 5, inList: true })
  assert.equal(headingText('- ## C++ 教程'), 'C++ 教程')

  const ordered = parseHeading('1. ### 编号')
  assert.deepEqual(ordered, { level: 3, markEnd: 7, textStart: 7, inList: true })

  const star = parseHeading('* #### 星号')
  assert.equal(star?.level, 4)
  assert.equal(star?.inList, true)

  // 列表项本来就允许缩进（嵌套列表），这里和普通标题的规则不同
  const indented = parseHeading('\t- ## 缩进')
  assert.deepEqual(indented, { level: 2, markEnd: 6, textStart: 6, inList: true })
})

test('heading: 该拒绝的都拒绝', () => {
  // 普通标题**故意**不允许前导缩进：放宽会把缩进代码块里的 # 误判成标题
  assert.equal(parseHeading('  ## 缩进标题'), null)
  // 没有空格分隔的不是标题
  assert.equal(parseHeading('#标签'), null)
  // 七级不存在（正则 #{1,6} 之后必须跟空白，第七个 # 不是空白）
  assert.equal(parseHeading('####### 七级'), null)
  // 普通正文
  assert.equal(parseHeading('这不是标题'), null)
  // 围栏行不是标题
  assert.equal(parseHeading('```cpp'), null)
})

test('heading: 取正文时剥掉收尾的闭合井号', () => {
  assert.equal(headingText('## 标题 ##'), '标题')
  assert.equal(headingText('- ## C++ 教程 ###'), 'C++ 教程')
  // 中间的 # 是正文，不能动
  assert.equal(headingText('## C# 与 F#'), 'C# 与 F#')
})

// ---------------------------------------------------------------- 围栏状态机

test('fence: 最基本的开与关', () => {
  const st = createFenceState()
  assert.deepEqual(stepFence(st, '```cpp'), {
    isMarker: true,
    inside: false,
    indent: 0,
    ticks: 3,
    lang: 'cpp',
  })
  // 块内普通内容行
  assert.deepEqual(stepFence(st, 'int x;'), {
    isMarker: false,
    inside: true,
    indent: 0,
    ticks: 0,
    lang: '',
  })
  // 块内空行仍然是块内
  assert.equal(stepFence(st, '').inside, true)
  // 关闭
  assert.deepEqual(stepFence(st, '```'), {
    isMarker: true,
    inside: false,
    indent: 0,
    ticks: 3,
    lang: '',
  })
  // 关闭之后的内容行不再算块内
  assert.equal(stepFence(st, '正文').inside, false)
})

test('fence: 列表项里 4–8 空格缩进的围栏要能开启', () => {
  // 库里 183 行 / 10 个文件，围栏是嵌在列表项里的
  for (const pad of [4, 6, 8]) {
    const st = createFenceState()
    const open = stepFence(st, `${' '.repeat(pad)}` + '```lua')
    assert.equal(open.isMarker, true, `缩进 ${pad} 应能开启`)
    assert.equal(open.indent, pad)
    assert.equal(open.lang, 'lua')
    assert.equal(stepFence(st, `${' '.repeat(pad)}print(1)`).inside, true)
  }
})

test('fence: 块内更深的 ``` 是内容，不能提前关块', () => {
  // 这是"把缩进上限从 3 放宽到 8"会踩的坑：代码块内部的示例代码也有深缩进围栏，
  // 朴素放宽会让它把块提前关掉，实测净减 8206 行。
  const st = createFenceState()
  assert.equal(stepFence(st, '    ```cpp').isMarker, true)
  assert.equal(stepFence(st, '    int x;').inside, true)

  // 缩进 8 > 开启时的 4 → 这一行是块内内容
  const deeper = stepFence(st, '        ```')
  assert.deepEqual(deeper, { isMarker: false, inside: true, indent: 8, ticks: 0, lang: '' })

  // 缩进 4 ≤ 4 → 这才是关闭
  const close = stepFence(st, '    ```')
  assert.equal(close.isMarker, true)
  assert.equal(close.inside, false)
})

test('fence: 缩进 0 的围栏能关掉缩进 4 开启的块', () => {
  const st = createFenceState()
  stepFence(st, '    ```')
  assert.equal(stepFence(st, '正文').inside, true)
  assert.equal(stepFence(st, '```').isMarker, true)
  assert.equal(stepFence(st, '正文').inside, false)
})

test('fence: ~~~ 与 ``` 同权，超过 8 空格不算围栏', () => {
  const st = createFenceState()
  const tilde = stepFence(st, '~~~python')
  assert.equal(tilde.isMarker, true)
  assert.equal(tilde.ticks, 3)
  assert.equal(tilde.lang, 'python')
  assert.equal(stepFence(st, '~~~').isMarker, true)

  const st2 = createFenceState()
  // 9 个空格：超出上限，当普通缩进内容处理，不能开启代码块
  assert.deepEqual(stepFence(st2, '         ' + '```'), {
    isMarker: false,
    inside: false,
    indent: 0,
    ticks: 0,
    lang: '',
  })
})

// ---------------------------------------------------------------- 表格行

test('table: 切分单元格', () => {
  assert.deepEqual(splitRow('| a | b |'), ['a', 'b'])
  // 首尾竖线可以没有
  assert.deepEqual(splitRow('a | b'), ['a', 'b'])
  // 转义竖线是字面量，不能当分隔符
  assert.deepEqual(splitRow('| a \\| b | c |'), ['a | b', 'c'])
  // 结尾恰好是 \| 时不能当成"包住整行的竖线"去掉，否则会吞掉一个字符
  assert.deepEqual(splitRow('| a \\|'), ['a |'])
  // 空单元格保留（列数不能丢）
  assert.deepEqual(splitRow('| a || c |'), ['a', '', 'c'])
})

test('table: 对齐分隔行', () => {
  assert.deepEqual(parseAlign('| --- | :-: | ---: | :--- |'), [null, 'center', 'right', 'left'])
  // 不是分隔行 → null（findTables 据此退回源码，不画错的表）
  assert.equal(parseAlign('| foo | bar |'), null)
  assert.equal(parseAlign('| --- | oops |'), null)
})

test('table: 光标落在第几列（表格面板靠它定位）', () => {
  // 带首竖线：第一个 `|` 只是边框，不算"进入第二列"
  assert.equal(columnAt('| a | b |', 2), 0)
  assert.equal(columnAt('| a | b |', 6), 1)
  // 首尾没有竖线的写法
  assert.equal(columnAt('a | b', 0), 0)
  assert.equal(columnAt('a | b', 4), 1)
  // 转义竖线 `\|` 不是分隔符，不能把列数数错
  assert.equal(columnAt('| a \\| b | c |', 8), 0)
  assert.equal(columnAt('| a \\| b | c |', 12), 1)
  // 越界偏移不该炸。这里返回 1（光标停在末尾那个 `|` 之后），
  // 由 tableAt 按这一行实际切出来的列数 clamp 回 0。
  assert.equal(columnAt('| a |', 999), 1)
})

test('table: 单元格拼回一行', () => {
  assert.equal(joinRow(['a', 'b']), '| a | b |')
  assert.equal(joinRow(['', '']), '|  |  |')
  assert.equal(joinRow(['x']), '| x |')
})

// ---------------------------------------------------------------- 快捷键录制

test('keymap: 合法组合', () => {
  const base = { shiftKey: false, altKey: false, metaKey: false }
  assert.equal(accelFromKey({ key: 's', ctrlKey: true, ...base }).accel, 'CmdOrCtrl+S')
  // 修饰键顺序固定 Ctrl → Alt → Shift，同一组合只有一种写法
  assert.equal(
    accelFromKey({ key: 'k', ctrlKey: true, shiftKey: true, altKey: true, metaKey: false }).accel,
    'CmdOrCtrl+Alt+Shift+K'
  )
  // 字母统一大写
  assert.equal(accelFromKey({ key: 'b', ctrlKey: true, ...base }).accel, 'CmdOrCtrl+B')
})

test('keymap: 键名别名', () => {
  const base = { shiftKey: false, altKey: false, metaKey: false }
  assert.equal(accelFromKey({ key: ' ', ctrlKey: true, ...base }).accel, 'CmdOrCtrl+Space')
  assert.equal(accelFromKey({ key: 'Escape', ctrlKey: true, ...base }).accel, 'CmdOrCtrl+Esc')
  assert.equal(accelFromKey({ key: 'ArrowUp', ctrlKey: true, ...base }).accel, 'CmdOrCtrl+Up')
  assert.equal(accelFromKey({ key: 'Enter', ctrlKey: true, ...base }).accel, 'CmdOrCtrl+Return')
})

test('keymap: 该拒绝的都拒绝', () => {
  const none = { shiftKey: false, altKey: false, metaKey: false }
  // 只按了修饰键 → 用户还在按组合的中间过程，继续等
  assert.ok(accelFromKey({ key: 'Shift', ctrlKey: false, ...none }).error)
  assert.ok(accelFromKey({ key: 'Control', ctrlKey: true, ...none }).error)
  assert.ok(accelFromKey({ key: 'Meta', ...none, metaKey: true }).error)
  // 没有任何修饰键的普通字符 → 会抢掉正常输入
  assert.ok(accelFromKey({ key: 'a', ctrlKey: false, ...none }).error)
  // 超出 F1–F24
  assert.ok(accelFromKey({ key: 'F25', ctrlKey: false, ...none }).error)
})

test('keymap: F 键允许单按', () => {
  const none = { shiftKey: false, altKey: false, metaKey: false }
  assert.equal(accelFromKey({ key: 'F5', ctrlKey: false, ...none }).accel, 'F5')
  assert.equal(accelFromKey({ key: 'F12', ctrlKey: false, ...none }).accel, 'F12')
})

test('keymap: 大小写视为同一个键 + 显示名', () => {
  assert.equal(sameAccel('CmdOrCtrl+S', 'cmdorctrl+s'), true)
  assert.equal(sameAccel('CmdOrCtrl+S', 'Ctrl+S'), false)
  assert.equal(prettyKey('CmdOrCtrl+Shift+K'), 'Ctrl+Shift+K')
  assert.equal(prettyKey(''), '')
})

// ---------------------------------------------------------------- 无损编解码

/** 往返：喂字节进去，断言吐出来的字节一模一样 */
function roundtrip(buf) {
  const decoded = decodeBuffer(buf)
  const re = encodeText(decoded.text, {
    eolStyle: decoded.eolStyle,
    eolMap: decoded.eolMap,
    bom: decoded.bom,
  })
  return { decoded, re }
}

test('lossless: BOM + CRLF + 末尾无换行（三种特征同时出现）', () => {
  // 245 篇里 4 篇带 BOM、188 篇纯 CRLF、123 篇末尾没有换行符
  const buf = Buffer.from('\uFEFFa\r\nb', 'utf8')
  const { decoded, re } = roundtrip(buf)
  assert.equal(decoded.bom, true)
  assert.equal(decoded.eolStyle, 'crlf')
  assert.equal(decoded.endsWithNewline, false)
  assert.equal(decoded.text, 'a\nb')
  assert.ok(re.equals(buf), '往返必须逐字节相等')
})

test('lossless: 纯 LF 且末尾有换行', () => {
  const buf = Buffer.from('a\nb\n', 'utf8')
  const { decoded, re } = roundtrip(buf)
  assert.equal(decoded.eolStyle, 'lf')
  assert.equal(decoded.endsWithNewline, true)
  assert.ok(re.equals(buf))
})

test('lossless: 单篇内混用换行（逐处还原，不统一）', () => {
  // mixed 时必须逐处记住原始序列；统一成一种就是篡改
  const buf = Buffer.from('a\r\nb\nc\rd', 'utf8')
  const { decoded, re } = roundtrip(buf)
  assert.equal(decoded.eolStyle, 'mixed')
  assert.deepEqual(decoded.eolMap, ['\r\n', '\n', '\r'])
  assert.ok(re.equals(buf))
})

test('lossless: 末尾没有换行就绝不补', () => {
  const buf = Buffer.from('a', 'utf8')
  const { decoded, re } = roundtrip(buf)
  assert.equal(decoded.endsWithNewline, false)
  assert.equal(re.toString('utf8'), 'a')
  assert.equal(re.length, 1, '补一个 \\n 就是篡改用户删掉的空行')
})

test('lossless: 用户主动删掉末尾空行后也要如实写回', () => {
  // 原文是 "a\n"，用户在编辑器里删掉最后的换行
  const decoded = decodeBuffer(Buffer.from('a\n', 'utf8'))
  assert.equal(decoded.text, 'a\n')
  const re = encodeText('a', { eolStyle: decoded.eolStyle, eolMap: decoded.eolMap, bom: decoded.bom })
  assert.equal(re.toString('utf8'), 'a')
})

test('lossless: 空文件与只有 BOM 的文件', () => {
  const empty = roundtrip(Buffer.alloc(0))
  assert.equal(empty.decoded.text, '')
  assert.equal(empty.decoded.bom, false)
  assert.equal(empty.re.length, 0)

  const bomOnly = Buffer.from([0xef, 0xbb, 0xbf])
  const r = roundtrip(bomOnly)
  assert.equal(r.decoded.bom, true)
  assert.equal(r.decoded.text, '')
  assert.ok(r.re.equals(bomOnly))
})

test('lossless: 中文按 UTF-8 三字节计', () => {
  const buf = Buffer.from('中文\n', 'utf8')
  assert.equal(buf.length, 7)
  const { decoded, re } = roundtrip(buf)
  assert.equal(decoded.text, '中文\n')
  assert.ok(re.equals(buf))
})

// ---------------------------------------------------------------- 数据安全（P0）

test('lossless: 裸 CR 单独成风格，往返不翻倍', () => {
  // 老 Mac 风格：整篇只有 \r。以前它被算进 crlf 计数，于是 eolStyle='crlf'、
  // eolMap=null，写回时每个 \r 变成 \r\n —— 文件字节数翻倍，等于全文被改写。
  const buf = Buffer.from('a\rb\rc', 'utf8')
  const { decoded, re } = roundtrip(buf)
  assert.equal(decoded.eolStyle, 'cr', '裸 CR 必须是独立风格，不能混进 crlf')
  assert.equal(decoded.text, 'a\nb\nc')
  assert.ok(re.equals(buf), '往返必须逐字节相等（这正是以前坏掉的地方）')
  assert.equal(re.length, buf.length, '长度不能变，翻倍就是损坏')
})

test('lossless: CR 与 LF 混用时仍是 mixed 且逐处还原', () => {
  const buf = Buffer.from('a\rb\nc\r\nd', 'utf8')
  const { decoded, re } = roundtrip(buf)
  assert.equal(decoded.eolStyle, 'mixed')
  assert.deepEqual(decoded.eolMap, ['\r', '\n', '\r\n'])
  assert.ok(re.equals(buf))
})

test('lossless: 合法 UTF-8 标记为 validUtf8', () => {
  assert.equal(decodeBuffer(Buffer.from('中文 abc\n', 'utf8')).validUtf8, true)
  // 空文件与只有 BOM 的文件都算合法
  assert.equal(decodeBuffer(Buffer.alloc(0)).validUtf8, true)
  assert.equal(decodeBuffer(Buffer.from([0xef, 0xbb, 0xbf])).validUtf8, true)
})

test('lossless: 非法 UTF-8 被识别出来（GBK 中文的典型字节）', () => {
  // 「中文」的 GBK 编码是 D6 D0 CE C4 —— D6 后面跟 D0 不是合法 UTF-8 续字节
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])
  const decoded = decodeBuffer(gbk)
  assert.equal(decoded.validUtf8, false, 'GBK 字节必须被判成非 UTF-8，否则会被静默转码写坏')
  // 仍然给一份能显示的文本（坏字节变 U+FFFD），因为用户至少要看一眼
  assert.ok(decoded.text.includes('\uFFFD'))
})

test('lossless: 截断的多字节序列也算非法', () => {
  // 「中」是 E4 B8 AD，只留前两个字节 = 半个汉字
  assert.equal(decodeBuffer(Buffer.from([0xe4, 0xb8])).validUtf8, false)
})

test('lossless: BOM 不影响 UTF-8 合法性判定', () => {
  const ok = decodeBuffer(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('中', 'utf8')]))
  assert.equal(ok.validUtf8, true)
  assert.equal(ok.bom, true)
  assert.equal(ok.text, '中')
  // BOM + 非法字节
  const bad = decodeBuffer(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from([0xd6, 0xd0])]))
  assert.equal(bad.validUtf8, false)
  assert.equal(bad.bom, true)
})

test('mtime: 没带 expect 就不报冲突', () => {
  // 新建笔记 / 老调用都走这条，不能被一个探测不到的东西拦住
  assert.equal(mtimeConflicts(1000, undefined), false)
  assert.equal(mtimeConflicts(1000, NaN), false)
})

test('mtime: 几毫秒内的抖动不算冲突', () => {
  // 网盘客户端、杀软扫过之后会「补」时间戳；部分文件系统只存到秒
  assert.equal(mtimeConflicts(1000, 1000), false)
  assert.equal(mtimeConflicts(1001, 1000), false)
  assert.equal(mtimeConflicts(1000, 1001), false)
})

test('mtime: 真被改过就报冲突', () => {
  assert.equal(mtimeConflicts(5000, 1000), true)
  assert.equal(mtimeConflicts(1000, 5000), true)
})

test('writeNote: 磁盘被外部改过时拒绝写盘（不静默覆盖）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jd-p0-'))
  const file = path.join(dir, 'note.md')
  await fs.writeFile(file, '原内容\n', 'utf8')

  // 记下「打开时」的 mtime，然后模拟别的程序改了它
  const opened = (await fs.stat(file)).mtimeMs
  await fs.writeFile(file, '别人改的内容\n', 'utf8')
  await fs.utimes(file, new Date(), new Date(Date.now() + 5000))

  const res = await writeNote(file, '我写的内容\n', {
    eolStyle: 'lf',
    eolMap: null,
    bom: false,
    endsWithNewline: true,
    expectMtimeMs: opened,
  })
  assert.equal(res.ok, false)
  assert.equal(res.conflict, true)
  // 关键断言：磁盘上还是别人的内容，我们的写盘必须先检查后动手
  assert.equal(await fs.readFile(file, 'utf8'), '别人改的内容\n')

  // force=true 时用户已经确认过，允许覆盖
  const forced = await writeNote(file, '我写的内容\n', {
    eolStyle: 'lf',
    eolMap: null,
    bom: false,
    endsWithNewline: true,
    expectMtimeMs: opened,
    force: true,
  })
  assert.equal(forced.ok, true)
  assert.equal(await fs.readFile(file, 'utf8'), '我写的内容\n')

  await fs.rm(dir, { recursive: true, force: true })
})

test('writeNote: 非 UTF-8 文件拒绝写盘（否则全文被转码写坏）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jd-p0-'))
  const file = path.join(dir, 'gbk.md')
  // 「中文」的 GBK 字节
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0a])
  await fs.writeFile(file, gbk)

  const res = await writeNote(file, '中文\n', {
    eolStyle: 'lf',
    eolMap: null,
    bom: false,
    endsWithNewline: true,
  })
  assert.equal(res.ok, false)
  assert.equal(res.encoding, true)
  // 关键断言：原文件一个字节都没动
  assert.ok((await fs.readFile(file)).equals(gbk))

  await fs.rm(dir, { recursive: true, force: true })
})

test('writeNote: 正常保存后 mtime 会更新，且字节完全一致', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jd-p0-'))
  const file = path.join(dir, 'ok.md')
  const original = Buffer.from('\uFEFFa\r\nb', 'utf8')
  await fs.writeFile(file, original)

  const doc = decodeBuffer(await fs.readFile(file))
  const before = (await fs.stat(file)).mtimeMs
  const res = await writeNote(file, doc.text, {
    eolStyle: doc.eolStyle,
    eolMap: doc.eolMap,
    bom: doc.bom,
    endsWithNewline: doc.endsWithNewline,
    expectMtimeMs: before,
  })
  assert.equal(res.ok, true)
  assert.ok((await fs.readFile(file)).equals(original), '内容没改时重写必须逐字节相等')
  // 返回的 mtime 要能直接喂给下一次保存（渲染层就是这么用的）
  assert.equal(typeof res.mtimeMs, 'number')
  assert.ok(res.mtimeMs > 0)

  await fs.rm(dir, { recursive: true, force: true })
})

test('writeNote: 文件不存在时直接创建（新建笔记不是错误）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jd-p0-'))
  // 连子目录都不存在：writeNote 自己 mkdir -p
  const file = path.join(dir, '新目录', '新笔记.md')

  const res = await writeNote(file, '第一行\n第二行\n', {
    eolStyle: 'lf',
    eolMap: null,
    bom: false,
    endsWithNewline: true,
    // 新建时磁盘上没有文件，mtime 检查必须放行（statOrNull 返回 null）
    expectMtimeMs: 123,
  })
  assert.equal(res.ok, true)
  assert.equal(await fs.readFile(file, 'utf8'), '第一行\n第二行\n')

  await fs.rm(dir, { recursive: true, force: true })
})

test('writeNote: force 不能绕过编码检查', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jd-p0-'))
  const file = path.join(dir, 'gbk.md')
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])
  await fs.writeFile(file, gbk)

  // force 的语义只是「我知道磁盘被改过，覆盖它」，
  // 不是「我知道这不是 UTF-8，把它转码」—— 后者不可逆，永远不放行
  const res = await writeNote(file, '中文', {
    eolStyle: 'lf',
    eolMap: null,
    bom: false,
    endsWithNewline: false,
    force: true,
  })
  assert.equal(res.ok, false)
  assert.equal(res.encoding, true)
  assert.ok((await fs.readFile(file)).equals(gbk), 'force 也不能动非 UTF-8 文件')

  await fs.rm(dir, { recursive: true, force: true })
})

test('writeNote: 快路径只认「主进程亲自验过」的文件，不信渲染层送来的指纹', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jd-p0-'))
  const file = path.join(dir, 'fp.md')

  // 1) 合法文件：readNote 会记账 → 之后的保存可以走快路径
  await fs.writeFile(file, Buffer.from('正常内容\n', 'utf8'))
  const doc = await readNote(file)
  assert.equal(doc.validUtf8, true)
  const r1 = await writeNote(file, '改过的内容\n', {
    eolStyle: 'lf',
    eolMap: null,
    bom: false,
    endsWithNewline: true,
    expectMtimeMs: doc.mtimeMs,
    expectSize: doc.size,
  })
  assert.equal(r1.ok, true)

  // 2) GBK 文件：渲染层送来的指纹就是它自己的 mtime/size（readNote 原样返回的），
  //    指纹百分之百命中。但主进程从没验过它是合法 UTF-8 —— 必须照样拒绝。
  //    这正是「只按指纹跳过读盘」会漏掉的洞：刚打开的乱码文件一字未动，
  //    它的 mtime/size 当然和刚 stat 到的一致。
  const gbkFile = path.join(dir, 'gbk.md')
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])
  await fs.writeFile(gbkFile, gbk)
  const gbkDoc = await readNote(gbkFile)
  assert.equal(gbkDoc.validUtf8, false)
  const r2 = await writeNote(gbkFile, '中文', {
    eolStyle: 'lf',
    eolMap: null,
    bom: false,
    endsWithNewline: false,
    // 完全真实的指纹 —— 不是故意造错
    expectMtimeMs: gbkDoc.mtimeMs,
    expectSize: gbkDoc.size,
  })
  assert.equal(r2.ok, false, '指纹命中也不能放过没验过的 GBK')
  assert.equal(r2.encoding, true)
  assert.ok((await fs.readFile(gbkFile)).equals(gbk), '原字节不能动')

  // 3) 从没被 readNote 碰过的 GBK（比如直接构造出来就存），同样拒绝
  const coldFile = path.join(dir, 'cold.md')
  await fs.writeFile(coldFile, gbk)
  const st3 = await fs.stat(coldFile)
  const r3 = await writeNote(coldFile, '中文', {
    eolStyle: 'lf',
    eolMap: null,
    bom: false,
    endsWithNewline: false,
    expectMtimeMs: st3.mtimeMs,
    expectSize: st3.size,
  })
  assert.equal(r3.ok, false)
  assert.equal(r3.encoding, true)

  await fs.rm(dir, { recursive: true, force: true })
})

test('writeNote: 只传 mtime 不传 size 时退回「每次都复检」', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jd-p0-'))
  const file = path.join(dir, 'gbk.md')
  const gbk = Buffer.from([0xd6, 0xd0, 0xce, 0xc4])
  await fs.writeFile(file, gbk)
  const st = await fs.stat(file)

  // 没有 expectSize → 无法证明"文件没被动过" → 必须读盘（保守行为）
  const res = await writeNote(file, '中文', {
    eolStyle: 'lf',
    eolMap: null,
    bom: false,
    endsWithNewline: false,
    expectMtimeMs: st.mtimeMs,
  })
  assert.equal(res.ok, false)
  assert.equal(res.encoding, true)

  await fs.rm(dir, { recursive: true, force: true })
})

test('writeNote: 整篇裸 CR 原样写回（不会翻倍成 CRLF）', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'jd-p0-'))
  const file = path.join(dir, 'oldmac.md')
  const original = Buffer.from('a\rb\rc', 'utf8')
  await fs.writeFile(file, original)

  const doc = decodeBuffer(await fs.readFile(file))
  assert.equal(doc.eolStyle, 'cr')
  const res = await writeNote(file, doc.text, {
    eolStyle: doc.eolStyle,
    eolMap: doc.eolMap,
    bom: doc.bom,
    endsWithNewline: doc.endsWithNewline,
  })
  assert.equal(res.ok, true)
  const after = await fs.readFile(file)
  assert.ok(after.equals(original), 'CR 写回 CR —— 翻倍成 CRLF 就是数据损坏')
  assert.equal(after.length, original.length)

  await fs.rm(dir, { recursive: true, force: true })
})

// ---------------------------------------------------------------- HTML 导出（PDF 用）

test('markdown-html: 标题 / 段落 / 行内标记', () => {
  const html = markdownToHtml('# 标题\n\n段落 **粗** 和 *斜* 与 `code`')
  assert.match(html, /<h1 class="jd-h1">标题<\/h1>/)
  assert.match(html, /<strong>粗<\/strong>/)
  assert.match(html, /<em>斜<\/em>/)
  assert.match(html, /<code class="jd-code-inline">code<\/code>/)
})

test('markdown-html: 表格有表头且有对齐', () => {
  const html = markdownToHtml('| a | b |\n| --- | :-: |\n| 1 | 2 |')
  assert.match(html, /<th class="jd-table-head-cell">a<\/th>/)
  assert.match(html, /<th class="jd-table-head-cell" style="text-align:center">b<\/th>/)
  assert.match(html, /<td class="jd-table-cell">1<\/td>/)
})

test('markdown-html: 代码块去掉围栏、保留语言名', () => {
  const html = markdownToHtml('```js\nconst a = 1\n```')
  assert.match(html, /<pre class="jd-code-block"><code class="language-js">const a = 1<\/code><\/pre>/)
})

test('markdown-html: 列表项不重复包段落', () => {
  const html = markdownToHtml('- 项一\n- 项二')
  assert.match(html, /<li class="jd-li">项一<\/li>/)
  assert.doesNotMatch(html, /<li class="jd-li">\s*<p/)
})

test('markdown-html: 正文里的尖括号和 & 被转义', () => {
  const html = markdownToHtml('a < b & c > d')
  assert.match(html, /&lt;/)
  assert.match(html, /&amp;/)
})

// ---------------------------------------------------------------- 行内标记（清除样式 / 链接操作）

test('inline: 剥掉成对标记', () => {
  assert.equal(stripInline('**粗** 和 *斜* 和 ~~删~~'), '粗 和 斜 和 删')
  assert.equal(stripInline('`code` 与 ==高亮=='), 'code 与 高亮')
  assert.equal(stripInline('<u>下划线</u>保留'), '下划线保留')
})

test('inline: 链接只留文字、图片只留 alt', () => {
  assert.equal(stripInline('看[这里](https://a.b/c)'), '看这里')
  assert.equal(stripInline('![图](a.png)说明'), '图说明')
})

test('inline: 注释整段消失', () => {
  assert.equal(stripInline('前<!-- 秘密 -->后'), '前后')
})

test('inline: 普通文本原样返回', () => {
  const s = '没有标记的一句话'
  assert.equal(stripInline(s), s)
})

test('inline: 找光标处的链接（含边界）', () => {
  const line = '前 [文字](https://a.b) 后'
  assert.deepEqual(findLinkAt(line, 6), { text: '文字', url: 'https://a.b', from: 2, to: 19 })
  assert.deepEqual(findLinkAt(line, 2), { text: '文字', url: 'https://a.b', from: 2, to: 19 })
  assert.deepEqual(findLinkAt(line, 19), { text: '文字', url: 'https://a.b', from: 2, to: 19 })
  assert.equal(findLinkAt(line, 0), null)
  assert.equal(findLinkAt('没有链接的一行', 3), null)
})

test('inline: 图片不算可打开的链接', () => {
  assert.equal(findLinkAt('![图](a.png)', 3), null)
})

// ---------------------------------------------------------------- 图片路径清理
//
// 主进程（裂图检测）与渲染层（图片 widget）共用这一份。两边一旦漂开，
// 表现是「正文里图能显示、裂图检测说不存在」，不报错也不崩，只能靠人肉发现。

test('image: 普通相对路径原样返回', () => {
  assert.equal(cleanImageTarget('./.笔记.assets/image-20261110175518-dac9.png'),
               './.笔记.assets/image-20261110175518-dac9.png')
})

test('image: 去掉三种写法的 title', () => {
  assert.equal(cleanImageTarget('a.png "标题"'), 'a.png')
  assert.equal(cleanImageTarget("a.png '标题'"), 'a.png')
  assert.equal(cleanImageTarget('a.png (标题)'), 'a.png')
})

test('image: 去掉尖括号包裹（带空格的文件名）', () => {
  assert.equal(cleanImageTarget('<带 空格.png>'), '带 空格.png')
})

test('image: 无引号的空格文件名不能被当成 title 吃掉', () => {
  // Typora 实测有 134 处直接写空格、不加引号也不编码 —— 这里必须保留
  assert.equal(cleanImageTarget('image 2026.png'), 'image 2026.png')
})

test('image: 前后空白与空串', () => {
  assert.equal(cleanImageTarget('  a.png  '), 'a.png')
  assert.equal(cleanImageTarget(''), '')
  assert.equal(cleanImageTarget('   '), '')
})

// ---------------------------------------------------------------- 段落块（4.3.0）
//
// 「段落」菜单里的块级操作全是「一行文本 → 换一种块前缀」的字符串变换。
// 这类东西错起来很安静：缩进被吃掉、`1. a` 变成 `1. 1. a`、六级标题再降级
// 反而清空 —— 渲染出来还是能看的文字，只能靠断言锁。
//
// 所有函数都约定**保留行首缩进**。库里 232 行 `- ## x`（列表项里嵌标题）
// 就靠这条不被破坏，所以下面专门有一组缩进断言。

const { blockKindOf, setBlockKind, splitIndent, stripBlockPrefix } = blockEdits
const { changeHeadingLevel, headingLevelOf, indentList } = blockEdits
const { toggleTaskChecked, setTaskChecked, isBlankLine, ordinalFor } = blockEdits

test('block: 认得出五类块，且任务项优先于普通无序项', () => {
  assert.equal(blockKindOf('普通段落'), 'p')
  assert.equal(blockKindOf('> 引用'), 'quote')
  assert.equal(blockKindOf('>无空格引用'), 'quote')
  assert.equal(blockKindOf('- 无序'), 'ul')
  assert.equal(blockKindOf('* 星号'), 'ul')
  assert.equal(blockKindOf('1. 有序'), 'ol')
  assert.equal(blockKindOf('2) 圆括号有序'), 'ol')
  assert.equal(blockKindOf('- [ ] 待办'), 'task')
  assert.equal(blockKindOf('- [x] 已完成'), 'task')
  // `-1` 不是列表（后面没有空格），是正文
  assert.equal(blockKindOf('-1 负号开头'), 'p')
  // 缩进不影响判断
  assert.equal(blockKindOf('    - 缩进四格'), 'ul')
})

test('block: 拆缩进 / 剥前缀都只动缩进之后那截', () => {
  assert.deepEqual(splitIndent('  文本'), { indent: '  ', rest: '文本' })
  assert.deepEqual(splitIndent('\t- a'), { indent: '\t', rest: '- a' })
  // `- ## x` 剥成 `## x` —— 标题标记不能被当成列表前缀一起剥掉
  assert.deepEqual(stripBlockPrefix('- ## x'), { indent: '', rest: '## x' })
  // 引用 + 列表叠层只剥一层语义，四种前缀依次过一遍
  assert.deepEqual(stripBlockPrefix('> - [ ] a'), { indent: '', rest: 'a' })
})

test('block: 改成各类块，保留缩进', () => {
  assert.equal(setBlockKind('正文', 'quote'), '> 正文')
  assert.equal(setBlockKind('正文', 'ul'), '- 正文')
  assert.equal(setBlockKind('正文', 'task'), '- [ ] 正文')
  assert.equal(setBlockKind('正文', 'ol'), '1. 正文')
  assert.equal(setBlockKind('    正文', 'ul'), '    - 正文')
  assert.equal(setBlockKind('1. 正文', 'ul'), '- 正文')
  assert.equal(setBlockKind('> 正文', 'task'), '- [ ] 正文')
})

test('block: 已经是这一类就退回段落（toggle 语义）', () => {
  // 没有这一步，用户就没有「取消列表」的入口 —— 只能手动删前缀
  assert.equal(setBlockKind('- 正文', 'ul'), '正文')
  assert.equal(setBlockKind('> 正文', 'quote'), '正文')
  assert.equal(setBlockKind('1. 正文', 'ol'), '正文')
  assert.equal(setBlockKind('- [ ] 正文', 'task'), '正文')
  // 从别的块转过来仍是转，不是退回
  assert.equal(setBlockKind('- [ ] 正文', 'ul'), '- 正文')
})

test('block: 有序列表的序号由调用方给，多行才排得下去', () => {
  assert.equal(setBlockKind('甲', 'ol', 1), '1. 甲')
  assert.equal(setBlockKind('乙', 'ol', 2), '2. 乙')
  assert.equal(setBlockKind('丙', 'ol', 10), '10. 丙')
  assert.equal(ordinalFor(0), 1)
  assert.equal(ordinalFor(-3), 1)
  assert.equal(ordinalFor(Number.NaN), 1)
  assert.equal(ordinalFor(4), 4)
})

test('block: 提升 / 降低标题级别', () => {
  // delta 是「级别变化量」：-1 = 提升（# 变少）、+1 = 降低（# 变多）。
  // 方向搞反是这条函数最容易犯的错，所以两边都断言。
  // 不是标题就一律不动 —— 不给「段落→H1」的便利（选中混排多行会误伤正文）
  assert.equal(changeHeadingLevel('正文', -1), null)
  assert.equal(changeHeadingLevel('正文', 1), null)
  assert.equal(changeHeadingLevel('## 标题', -1), '# 标题')
  assert.equal(changeHeadingLevel('## 标题', 1), '### 标题')
  // 到顶 / 到底：级别夹在 1~6，内容不动（不返回 null —— 它确实是标题）
  assert.equal(changeHeadingLevel('# 标题', -1), '# 标题')
  assert.equal(changeHeadingLevel('###### 标题', 1), '###### 标题')
  // 缩进与列表里的标题都要保住
  assert.equal(changeHeadingLevel('  ## 标题', -1), '  # 标题')
  // 列表项里嵌的标题（库里 232 行）不认 —— 那要连 `- ` 一起处理，是另一件事，
  // 硬来会把列表结构拆掉
  assert.equal(changeHeadingLevel('- ## 标题', -1), null)
  // 尾部收尾的 `##` 不动（那是用户自己的写法）
  assert.equal(changeHeadingLevel('## 标题 ##', 1), '### 标题 ##')
  // `#` 与文字之间的间隔原样保留：库里 732 个标题是两个空格，
  // 重新拼一个空格会让它「提升一级」时顺带改掉一个字节
  assert.equal(changeHeadingLevel('###  流程概述', 1), '####  流程概述')
  assert.equal(changeHeadingLevel('###  流程概述', -1), '##  流程概述')
  assert.equal(changeHeadingLevel('##\t标题', 1), '###\t标题')
})

test('block: 标题级别（大纲 / 菜单打勾用）', () => {
  assert.equal(headingLevelOf('# 一'), 1)
  assert.equal(headingLevelOf('#### 四'), 4)
  assert.equal(headingLevelOf('正文'), 0)
  assert.equal(headingLevelOf('#没空格'), 0) // 不是标题语法
})

test('block: 列表缩进每级 2 空格，减到头夹到 0', () => {
  assert.equal(indentList('- a', 1), '  - a')
  assert.equal(indentList('  - a', 1), '    - a')
  assert.equal(indentList('  - a', -1), '- a')
  assert.equal(indentList('- a', -1), '- a')
  assert.equal(indentList('1. 有序', 1), '  1. 有序')
  // 引用行**不缩进**：`> x` 缩到 4 个空格就变成「缩进代码块」，
  // 引用块会被降级成代码（连按三次「增加缩进」即可复现），所以一律不动
  assert.equal(indentList('> 引用', 1), null)
  assert.equal(indentList('  > 引用', 1), null)
  // 正文不动：给普通段落加两个空格在 markdown 里没有任何语义，
  // 只会在文件里留下看不见的空白差异（Typora 的「列表缩进」也不碰正文）
  assert.equal(indentList('正文', 1), null)
  assert.equal(indentList('    正文', -1), null)
})

test('block: 任务勾选（toggle 与明确设置两种）', () => {
  assert.equal(toggleTaskChecked('- [ ] 待办'), '- [x] 待办')
  assert.equal(toggleTaskChecked('- [x] 完成'), '- [ ] 完成')
  assert.equal(toggleTaskChecked('- [X] 大写也算'), '- [ ] 大写也算')
  assert.equal(toggleTaskChecked('- 普通列表'), null)
  assert.equal(toggleTaskChecked('正文'), null)

  assert.equal(setTaskChecked('- [ ] a', true), '- [x] a')
  assert.equal(setTaskChecked('- [x] a', true), '- [x] a') // 已是目标状态，原样
  assert.equal(setTaskChecked('- [x] a', false), '- [ ] a')
  assert.equal(setTaskChecked('  - [ ] 缩进', true), '  - [x] 缩进')
  assert.equal(setTaskChecked('正文', true), null)
})

test('block: 表格有几列（行尾竖线可省、转义竖线不算分隔）', () => {
  assert.equal(tableColumnCount('| a | b |'), 2)
  assert.equal(tableColumnCount('| a | b'), 2)
  assert.equal(tableColumnCount('|---|'), 1)
  // `||` 是「一个空格子」，算 1 列
  assert.equal(tableColumnCount('||'), 1)
  // 行首没写竖线也照样数（原实现要求行首必须有 `|`，否则返回 0 → 插入的新行只有 1 格）
  assert.equal(tableColumnCount('a | b | c'), 3)
  // 转义竖线是**字面竖线**，不能算分隔符。库里的真实用例：
  // `C++教程/初步认识/运算符.md` 表头 `| p | q | p&q | p\|q | p^q |` 是 5 列，
  // 自己 split('|') 会算成 6 → 「在下方插入行」把整表撑出一列空格子
  assert.equal(tableColumnCount('| p | q | p&q | p\\|q | p^q |'), 5)
  // 不是表格行
  assert.equal(tableColumnCount('正文'), 0)
  assert.equal(tableColumnCount(''), 0)
})

test('block: 空行判定', () => {
  assert.equal(isBlankLine(''), true)
  assert.equal(isBlankLine('   \t'), true)
  assert.equal(isBlankLine(' \-'), false)
})

// ---------------------------------------------------------------- 表格列对齐（4.4.0）
//
// 「对齐」在 markdown 里只有一种表达：分隔行那一格的首尾冒号。改对齐必须**只动冒号**，
// 短横线数量和整行空格风格原样保留 —— 一旦图省事用 joinRow 重建整行，
// 用户的 `|---|:--:|---|` 会被格式化成 `| --- | :-: | --- |`，等于偷偷改别人的文件。

const { cellSpans, alignCellText, setColumnAlign, tableColumnCount } = tableParse

test('align: 单元格区间要含位置（含行首/行尾缺竖线的写法）', () => {
  // 标准写法：三格，区间跳过两侧空格
  assert.deepEqual(cellSpans('| --- | :--: | --- |'), [
    { start: 2, end: 5 },
    { start: 8, end: 12 },
    { start: 15, end: 18 },
  ])
  // 无空格写法
  assert.deepEqual(cellSpans('|---|:--:|---|'), [
    { start: 1, end: 4 },
    { start: 5, end: 9 },
    { start: 10, end: 13 },
  ])
  // 首尾竖线都省略
  assert.deepEqual(cellSpans('--- | ---'), [
    { start: 0, end: 3 },
    { start: 6, end: 9 },
  ])
  // 转义的 `\|` 是字面竖线，不能当分隔符
  assert.equal(cellSpans('| a\\|b | --- |').length, 2)
})

test('align: 改标记只增删冒号，短横线宽度原样', () => {
  assert.equal(alignCellText('---', 'left'), ':---')
  assert.equal(alignCellText('---', 'center'), ':---:')
  assert.equal(alignCellText('---', 'right'), '---:')
  assert.equal(alignCellText('---', null), '---')
  // 宽度不被压缩：`----` 不会变成 `---`
  assert.equal(alignCellText(':----:', 'right'), '----:')
  assert.equal(alignCellText('----', null), '----')
  // 空单元格给个合法的兜底
  assert.equal(alignCellText('', 'center'), ':---:')
})

test('align: 只替换目标那一格，整行其它字节不动', () => {
  // 紧凑写法（无空格）改动后仍然是紧凑写法
  assert.equal(setColumnAlign('|---|:--:|---|', 2, 'center'), '|---|:--:|:---:|')
  // 第 0 列改右对齐
  assert.equal(setColumnAlign('| --- | :--: | --- |', 0, 'right'), '| ---: | :--: | --- |')
  // 取消对齐 = 只去掉冒号
  assert.equal(setColumnAlign('| --- | :--: | --- |', 1, null), '| --- | -- | --- |')
  // 首尾没有竖线时，两侧空格也照旧
  assert.equal(setColumnAlign(' --- | --- ', 1, 'center'), ' --- | :---: ')
  // 已经是目标状态 → 原样返回（不产生多余的改写）
  assert.equal(setColumnAlign('| :---: | --- |', 0, 'center'), '| :---: | --- |')
})

test('align: 不是分隔行 / 列号越界 → null（不硬写）', () => {
  assert.equal(setColumnAlign('| a | b |', 0, 'center'), null)
  assert.equal(setColumnAlign('', 0, 'center'), null)
  assert.equal(setColumnAlign('普通一行', 0, 'left'), null)
  assert.equal(setColumnAlign('| --- | --- |', 2, 'left'), null)
  assert.equal(setColumnAlign('| --- | --- |', -1, 'left'), null)
})

// ---------------------------------------------------------------- 围栏（4.4.1 补）
//
// 库里 `书籍/ue/gas.md` 一个文件就有 30 处 `    -   ```cpp`（代码块作为列表项的第一个
// 子块，Typora 与 CommonMark 都认）。旧实现只认「前面全是空白」的围栏，
// 于是这种行开不了块，而它们的**关闭**行（8 空格裸围栏）却是合法的 → 被当成开启
// → 整篇里代码与正文成对反转（实测 UMG 核心架构.md 1919 行、gas.md 316 行归错）。

test('fence: 列表项行上的围栏能开启（内容缩进 = 反引号所在列）', () => {
  const st = createFenceState()
  const open = stepFence(st, '    -   ```cpp')
  assert.equal(open.isMarker, true)
  assert.equal(open.lang, 'cpp')
  assert.equal(open.indent, 8) // `    -   ` 共 8 列，关闭围栏也在这一列上
  assert.equal(st.in, true)
  // 内容行
  assert.equal(stepFence(st, '        ShouldDo()').inside, true)
  // 8 空格裸围栏关闭
  const close = stepFence(st, '        ```')
  assert.equal(close.isMarker, true)
  assert.equal(st.in, false)
})

test('fence: 正文里用三个反引号包函数不算围栏', () => {
  // `build.md` 里 4 处 `- ```bIWYU``` (说明)`：这是正文，不是围栏。
  // 当成围栏开启的话，后面整篇会变成代码块。
  const st = createFenceState()
  const r = stepFence(st, '- ```bIWYU``` (Include What You Use) 标志')
  assert.equal(r.isMarker, false)
  assert.equal(st.in, false)
})

/** 这一行之后是否仍在代码块内 */
const inBlock = (st) => st.in === true

test('fence: 引用块里的围栏（`> ``` ）', () => {
  const st = createFenceState()
  const open = stepFence(st, '> ```c++')
  assert.equal(open.isMarker, true)
  assert.equal(open.lang, 'c++')
  assert.equal(open.indent, 2) // 反引号在整行第 2 列，markers 靠它定位
  assert.equal(inBlock(st), true)
  // 引用内的内容行（每行都带 `> `）
  assert.equal(stepFence(st, '> int x;').inside, true)
  // 引用里的空行（只有一个 `>`）也算块内
  assert.equal(stepFence(st, '>').inside, true)
  // 同层关闭
  assert.equal(stepFence(st, '> ```').isMarker, true)
  assert.equal(inBlock(st), false)
})

test('fence: 引用结束会把里面的代码块一起结束', () => {
  const st = createFenceState()
  stepFence(st, '> ```')
  assert.equal(inBlock(st), true)
  // 没有 `>` 的空行 = 引用块结束 → 代码块也结束，这一行按正文处理
  const r = stepFence(st, '')
  assert.equal(r.inside, false)
  assert.equal(inBlock(st), false)
})

test('fence: 引用 + 列表项一起套（`> - ```c++`）', () => {
  const st = createFenceState()
  const open = stepFence(st, '> - ```c++')
  assert.equal(open.isMarker, true)
  assert.equal(open.lang, 'c++')
  assert.equal(stepFence(st, '>   GameplayEffect').inside, true)
  assert.equal(stepFence(st, '>   ```').isMarker, true)
  assert.equal(inBlock(st), false)
})

test('fence: 不同引用层的围栏不互相配对', () => {
  const st = createFenceState()
  stepFence(st, '> ```')
  // 外面一层没有 `>` 的围栏不能关掉引用里的块（它属于另一层）
  const r = stepFence(st, '```')
  assert.equal(r.isMarker, false)
  assert.equal(inBlock(st), false) // 但引用结束会把块关掉
})

test('fence: 首行带 BOM 的围栏要能认出（库里 4 篇整篇源码就是这种）', () => {
  const st = createFenceState()
  const open = stepFence(st, '\ufeff```c++')
  assert.equal(open.isMarker, true)
  assert.equal(open.lang, 'c++')
  assert.equal(st.in, true)
  assert.equal(stepFence(st, 'int main() {}').inside, true)
  assert.equal(stepFence(st, '```').isMarker, true)
  assert.equal(st.in, false)
})

// ---------------------------------------------------------------- 代码块语言（4.5.0）
//
// 「右下角选语言」看起来是 UI 功能，但真正容易出错的是**改写围栏**那一步：
// 语言标记在哪几个字符上、`title="..."` 之类的附加信息有没有被顺手抹掉、
// 没有语言时是从哪儿插入。这些都适合在这里钉死。

const { fenceLang, withLang } = await import('../src/renderer/code-lang.ts')

test('code-lang: 找出围栏里的语言标记（三种位置都认）', () => {
  assert.deepEqual(fenceLang('```cpp'), { from: 3, to: 6, lang: 'cpp' })
  assert.deepEqual(fenceLang('```'), { from: 3, to: 3, lang: '' })
  assert.deepEqual(fenceLang('    ```python'), { from: 7, to: 13, lang: 'python' })
  assert.deepEqual(fenceLang('> ```c++'), { from: 5, to: 8, lang: 'c++' })
  assert.deepEqual(fenceLang('- ```js'), { from: 5, to: 7, lang: 'js' })
  assert.deepEqual(fenceLang('~~~rust'), { from: 3, to: 7, lang: 'rust' })
  // 反引号与语言之间有空格也认（位置指向语言本身）
  assert.deepEqual(fenceLang('``` cpp'), { from: 4, to: 7, lang: 'cpp' })
  // 不是围栏行
  assert.equal(fenceLang('正文一行'), null)
  assert.equal(fenceLang(''), null)
})

test('code-lang: 换语言只动语言那一段', () => {
  assert.equal(withLang('```cpp', 'python'), '```python')
  assert.equal(withLang('```', 'js'), '```js')
  assert.equal(withLang('> ```cpp', 'python'), '> ```python')
  assert.equal(withLang('    ```cpp', 'python'), '    ```python')
  // 附加信息（GitHub 的 title="..."）原样留在原地
  assert.equal(withLang('```cpp title="a b"', 'python'), '```python title="a b"')
  // 清空语言：后面还有参数就留一个空格，没有就整体收干净
  assert.equal(withLang('```cpp title="a b"', ''), '``` title="a b"')
  assert.equal(withLang('``` cpp', ''), '```')
  assert.equal(withLang('```cpp', ''), '```')
  // 不是围栏行 → 不硬改
  assert.equal(withLang('正文', 'js'), null)
})

// ---------------------------------------------------------------- 行内标记 → 纯文本（4.7.1）
//
// 大纲只能显示纯文本，`### **1. 结论**` 以前会在侧栏原样露出星号。
// 这个函数**只做减法**：除了去掉标记字符什么都不改 —— 所以每条断言都盯着
// 「内容有没有被多删/多留」，而不是格式好不好看。

const { plainInlineMarkdown } = await import('../src/renderer/inline-text.ts')

test('inline-text: 加粗 / 斜体 / 删除线 / 高亮 去掉标记，文字一字不动', () => {
  assert.equal(plainInlineMarkdown('**1. UMG 和 Slate 是什么关系？**'), '1. UMG 和 Slate 是什么关系？')
  assert.equal(plainInlineMarkdown('*斜体* 与 **加粗**'), '斜体 与 加粗')
  assert.equal(plainInlineMarkdown('***又粗又斜***'), '又粗又斜')
  assert.equal(plainInlineMarkdown('_下划线斜体_ 与 __加粗__'), '下划线斜体 与 加粗')
  assert.equal(plainInlineMarkdown('~~删除~~ 和 ==高亮=='), '删除 和 高亮')
})

test('inline-text: 行内代码里的星号是字面量，不能当加粗', () => {
  assert.equal(plainInlineMarkdown('带 `a**b**c` 的标题'), '带 a**b**c 的标题')
  assert.equal(plainInlineMarkdown('`*x*`'), '*x*')
  // 代码里连着多个空格要保住（先还原代码再归一空白的话就会被压掉）
  assert.equal(plainInlineMarkdown('`a  b`'), 'a  b')
})

test('inline-text: 链接 / 图片 / 脚注 / HTML 只留可见文字', () => {
  assert.equal(plainInlineMarkdown('[Typora](https://typora.io)'), 'Typora')
  assert.equal(plainInlineMarkdown('![图注](a.png)'), '图注')
  assert.equal(plainInlineMarkdown('见 [文档](../x.md) 与图文'), '见 文档 与图文')
  assert.equal(plainInlineMarkdown('结论[^1]'), '结论')
  assert.equal(plainInlineMarkdown('<u>下划线</u> 与 <sub>2</sub>'), '下划线 与 2')
  assert.equal(plainInlineMarkdown('前 <!-- 注释 --> 后'), '前 后')
})

test('inline-text: 反斜杠转义还原成字面字符', () => {
  assert.equal(plainInlineMarkdown('\\*不是斜体\\*'), '*不是斜体*')
  assert.equal(plainInlineMarkdown('\\`不是代码\\`'), '`不是代码`')
  assert.equal(plainInlineMarkdown('1 \\* 2 \\* 3'), '1 * 2 * 3')
})

test('inline-text: 不成对 / 内侧有空格的不当标记，原样保留', () => {
  // 算式里的孤立星号不能被吃
  assert.equal(plainInlineMarkdown('a * b * c'), 'a * b * c')
  // 只开不闭
  assert.equal(plainInlineMarkdown('**没闭合'), '**没闭合')
  // 内侧紧贴空格：markers.ts 也不认这种
  assert.equal(plainInlineMarkdown('a ** b ** c'), 'a ** b ** c')
  // 空串
  assert.equal(plainInlineMarkdown(''), '')
})

test('inline-text: 接到标题上 —— ### **1. 题** → 大纲显示「1. 题」', () => {
  assert.equal(headingText('### **1. UMG 和 Slate 是什么关系？**'), '1. UMG 和 Slate 是什么关系？')
  assert.equal(headingText('## 纯文本标题'), '纯文本标题')
  // 收尾的可选 `##` 仍然要去掉，再去行内标记
  assert.equal(headingText('## **标题** ##'), '标题')
  // 列表项里的标题（`- ## x`）
  assert.equal(headingText('- ## **嵌在列表里的标题**'), '嵌在列表里的标题')
})

// ---------------------------------------------------------------- 文件树右键（4.8.0）
//
// 右键菜单本身是 DOM 操作，靠 CDP 逐个点（已经点过 11 项）。这里钉的是
// **两个纯函数层**：名字校验与展示格式化 —— 它们出错的方式很安静
// （建出删不掉的怪文件 / 属性面板显示 0 字节），正好适合断言。

const { formatSize, formatTime, fileKind } = await import('../src/renderer/format.ts')
const { checkEntryName } = files

test('entry-name: 合法名字原样通过（首尾空格自动去掉）', () => {
  assert.deepEqual(checkEntryName('新笔记'), { ok: true, name: '新笔记' })
  assert.deepEqual(checkEntryName('  两边有空格  '), { ok: true, name: '两边有空格' })
  assert.deepEqual(checkEntryName('带 空格 的名字'), { ok: true, name: '带 空格 的名字' })
  // 中文、英文、点号（不是开头）、下划线都放行
  assert.deepEqual(checkEntryName('v1.2 说明_v2'), { ok: true, name: 'v1.2 说明_v2' })
})

test('entry-name: 空 / . / .. / 点开头一律拒', () => {
  for (const bad of ['', '   ', '.', '..', '.hidden', '.assets']) {
    assert.equal(checkEntryName(bad).ok, false, JSON.stringify(bad))
  }
})

test('entry-name: Windows 非法字符逐个拒（建出来会删不掉）', () => {
  for (const bad of ['a/b', 'a\\b', 'a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b']) {
    const r = checkEntryName(bad)
    assert.equal(r.ok, false, JSON.stringify(bad))
    assert.match(r.error, /不能包含/)
  }
  // 控制字符（粘贴带进来的 \u0000-\u001f）
  assert.equal(checkEntryName('a\u0001b').ok, false)
})

test('entry-name: 超长名字拒（上限 120）', () => {
  assert.equal(checkEntryName('a'.repeat(120)).ok, true)
  assert.equal(checkEntryName('a'.repeat(121)).ok, false)
})

test('format: 大小按 字节 / KB / MB 分档，无效值不瞎猜', () => {
  assert.equal(formatSize(0), '0 字节')
  assert.equal(formatSize(1023), '1023 字节')
  assert.equal(formatSize(1024), '1.0 KB')
  assert.equal(formatSize(1536), '1.5 KB')
  assert.equal(formatSize(1024 * 1024), '1.00 MB')
  // 负数 / NaN 不能显示成「-1 字节」或「NaN 字节」
  assert.equal(formatSize(-1), '未知')
  assert.equal(formatSize(Number.NaN), '未知')
})

test('format: 时间戳格式固定，无效时间返回「未知」', () => {
  // 时区相关，不断言具体值，只断言形状（属性面板要求"一眼能读"）
  assert.match(formatTime(Date.UTC(2026, 10, 12, 8, 7)), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  assert.equal(formatTime(Number.NaN), '未知')
  assert.equal(formatTime(Number.POSITIVE_INFINITY), '未知')
})

test('format: 扩展名决定类型名', () => {
  assert.equal(fileKind('a.md'), 'Markdown 文档')
  assert.match(fileKind('a.markdown'), /\.markdown/)
  assert.match(fileKind('a.txt'), /\.txt/)
  // 大小写不敏感
  assert.match(fileKind('A.MARKDOWN'), /\.markdown/)
})

// ---------------------------------------------------------------- 偏好设置（4.10.0）
//
// 这几条守的是「设置自己坏了」：配置文件是用户可以手改的，一个字段写错
// 不该让某个开关变成 undefined —— `if (prefs.autosave)` 会把 undefined 当 false，
// 自动保存**静默关掉**，而界面上没有任何异常。夹值规则也在这里锁死，
// 主进程和面板都只信这一份。

const { sanitizePrefs, PREFS_DEFAULTS, applyImageTemplate, IMAGE_TEMPLATE_DEFAULT } = prefs

test('prefs: 空输入 = 全默认，且不共享同一个对象', () => {
  const a = sanitizePrefs(undefined)
  assert.deepEqual(a, PREFS_DEFAULTS)
  // 返回的必须是新对象：直接返回 DEFAULTS 会让调用方改一处、全局默认值跟着变
  assert.notEqual(a, PREFS_DEFAULTS)
  a.autosave = false
  assert.equal(PREFS_DEFAULTS.autosave, true)
})

test('prefs: 未知键丢弃，认识的键逐个覆盖', () => {
  const p = sanitizePrefs({ autosave: false, codeWrap: true, 乱写的: 1, __proto__: null })
  assert.equal(p.autosave, false)
  assert.equal(p.codeWrap, true)
  assert.equal('乱写的' in p, false)
  // 没提到的键保持默认，不会被 undefined 冲掉
  assert.equal(p.showStatusbar, true)
  assert.equal(p.indentWidth, 2)
})

test('prefs: 缩进只认 2 / 4，其他值回落到基准', () => {
  assert.equal(sanitizePrefs({ indentWidth: 4 }).indentWidth, 4)
  assert.equal(sanitizePrefs({ indentWidth: 2 }).indentWidth, 2)
  assert.equal(sanitizePrefs({ indentWidth: 3 }).indentWidth, 2)
  assert.equal(sanitizePrefs({ indentWidth: '4' }).indentWidth, 2)
  // 局部更新时的基准是「当前配置」，不是默认值
  assert.equal(sanitizePrefs({ autosave: false }, { ...PREFS_DEFAULTS, indentWidth: 4 }).indentWidth, 4)
})

test('prefs: 缩放夹在 0.8–1.5，坏值不把界面缩没', () => {
  assert.equal(sanitizePrefs({ zoom: 9 }).zoom, 1.5)
  assert.equal(sanitizePrefs({ zoom: 0.1 }).zoom, 0.8)
  assert.equal(sanitizePrefs({ zoom: 1.1 }).zoom, 1.1)
  assert.equal(sanitizePrefs({ zoom: Number.NaN }).zoom, 1)
  // 浮点误差要收掉：1.15 存成 1.1499999999999999 会让面板下拉永远对不上
  assert.equal(sanitizePrefs({ zoom: 1.1499999999999999 }).zoom, 1.15)
})

test('prefs: 代码块语言只收合法形状（它会被拼进围栏）', () => {
  assert.equal(sanitizePrefs({ codeDefaultLang: 'cpp' }).codeDefaultLang, 'cpp')
  assert.equal(sanitizePrefs({ codeDefaultLang: '  c++  ' }).codeDefaultLang, 'c++')
  assert.equal(sanitizePrefs({ codeDefaultLang: 'c#' }).codeDefaultLang, 'c#')
  assert.equal(sanitizePrefs({ codeDefaultLang: '' }).codeDefaultLang, '')
  // 带空格 / 换行的不接受：会把围栏写坏或多插一行
  assert.equal(sanitizePrefs({ codeDefaultLang: 'a b' }).codeDefaultLang, '')
  // 粘贴整段围栏头时把反引号剥掉（```js → js），而不是判非法
  assert.equal(sanitizePrefs({ codeDefaultLang: '```js' }).codeDefaultLang, 'js')
  assert.equal(sanitizePrefs({ codeDefaultLang: 'include\nx' }).codeDefaultLang, '')
})

test('prefs: 图片模板替换占位符，空模板回落默认', () => {
  assert.equal(applyImageTemplate('./.${filename}.assets', '笔记A'), './.笔记A.assets')
  assert.equal(applyImageTemplate('assets/${ noteName }', '笔记B'), 'assets/笔记B')
  assert.equal(applyImageTemplate('', '笔记C'), IMAGE_TEMPLATE_DEFAULT.replace('${filename}', '笔记C'))
  // 没有占位符就原样（统一存到一个固定目录的用法）
  assert.equal(applyImageTemplate('D:/images', 'x'), 'D:/images')
  // 模板里的反斜杠换成斜杠：markdown 里反斜杠是转义符
  assert.equal(sanitizePrefs({ imageDirTemplate: 'assets\\${filename}' }).imageDirTemplate, 'assets/${filename}')
})

test('image: markdown 引用路径（相对 / ./ / 绝对）', () => {
  const { imageMarkdownPath } = files
  // 默认（加 ./）：和 Typora 写法一致
  assert.equal(imageMarkdownPath('C:/notes', 'C:/notes/.a.assets', 'x.png', true, false), './.a.assets/x.png')
  // 关掉 ./：仍是相对路径，只是不带头
  assert.equal(imageMarkdownPath('C:/notes', 'C:/notes/.a.assets', 'x.png', false, false), '.a.assets/x.png')
  // 模板本身是绝对路径：原样输出（正斜杠），不加 ./
  assert.equal(imageMarkdownPath('C:/notes', 'D:/images', 'x.png', true, true), 'D:/images/x.png')
  // 已经在子目录外面：保留 ../（不再叠一层 ./，./../ 是没意义的写法）
  assert.equal(imageMarkdownPath('C:/notes/sub', 'C:/notes/img', 'x.png', true, false), '../img/x.png')
})

test('block: 缩进宽度可配 4 空格，且只影响列表行', () => {
  assert.equal(blockEdits.indentList('- a', 1, 2), '  - a')
  assert.equal(blockEdits.indentList('- a', 1, 4), '    - a')
  assert.equal(blockEdits.indentList('  - a', -1, 4), '- a')
  // 宽度只认 2/4：传 3 按 2 处理（否则库内已有的 2 空格层级会对不齐）
  assert.equal(blockEdits.indentList('- a', 1, 3), '  - a')
  // 正文与引用不缩进（引用缩 4 空格会变成缩进代码块）
  assert.equal(blockEdits.indentList('正文', 1, 4), null)
  assert.equal(blockEdits.indentList('> 引用', 1, 4), null)
})
