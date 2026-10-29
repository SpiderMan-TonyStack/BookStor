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
try {
  heading = await import('../src/renderer/heading.ts')
  fence = await import('../src/renderer/fence.ts')
  tableParse = await import('../src/renderer/table-parse.ts')
  commands = await import('../src/shared/commands.ts')
  lossless = await import('../src/main/lossless.ts')
  markdownHtml = await import('../src/renderer/markdown-html.ts')
  files = await import('../src/main/files.ts')
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
