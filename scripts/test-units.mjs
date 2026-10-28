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
 *
 * 零新增依赖：node:test + node:assert。直接 import .ts（与 verify 脚本同一条路）。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

// 直接 import .ts 依赖 Node ≥ 22.18 的类型剥离。用动态 import 是为了在低版本
// 给一句人话，而不是甩一堆 ERR_UNKNOWN_FILE_EXTENSION。
let heading
let fence
let tableParse
let commands
let lossless
try {
  heading = await import('../src/renderer/heading.ts')
  fence = await import('../src/renderer/fence.ts')
  tableParse = await import('../src/renderer/table-parse.ts')
  commands = await import('../src/shared/commands.ts')
  lossless = await import('../src/main/lossless.ts')
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
const { splitRow, parseAlign } = tableParse
const { accelFromKey, prettyKey, sameAccel } = commands
const { decodeBuffer, encodeText } = lossless

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
