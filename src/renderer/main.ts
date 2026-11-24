import type { CrashDraft, FileNode, NoteDoc } from '../shared/types.js'
import { renameExpanded, renderFlatList, renderTree, setActive } from './tree.js'
import { showFileMenu, type FileOpsContext, type HitNode, type ViewMode } from './file-ops.js'
import {
  createEditor,
  insertAtCursor,
  wrapSelection,
  wrapSelectionPair,
  insertLink,
  clearInlineMarks,
  linkAtCursor,
  removeLinkAt,
  setHeading,
  openSearch,
  insertCodeBlock,
  setBlockKindForSelection,
  changeHeadingLevelForSelection,
  indentListForSelection,
  toggleTaskStateForSelection,
  setTaskStateForSelection,
  insertBlock,
  insertSiblingParagraph,
  insertTableRowBelow,
  removeTableBlock,
  alignTableColumn,
  type EditorHandle,
} from './editor.js'
import {
  applyTheme,
  reloadTheme,
  currentThemeReport,
  currentThemeCss,
  BUILTIN_DARK,
  THEME_APPLIED_EVENT,
} from './theme.js'
import { computeOutline, renderOutline, highlightOutline, jumpTo, type OutlineItem } from './outline.js'
import { openSettings } from './settings.js'
import { openPrefs } from './prefs.js'
import { getPrefs, loadPrefs, savePrefs, PREFS_CHANGED } from './prefs-state.js'
import { installKeybindings } from './keybindings.js'
import { installFormatBar } from './format-bar.js'
import {
  loadAndApplyTypography,
  reapplyTypography,
  FONT_APPLIED_EVENT,
} from './typography.js'
import { countWords } from './text-stats.js'
import { setSourceMode } from './viewmode.js'
import { installTablePanel } from './table-panel.js'
import { openThemeReport } from './theme-report.js'
import { markdownToHtml } from './markdown-html.js'
import { inlineMermaidSvgs } from './mermaid-export.js'
import { invalidateMermaidCache } from './mermaid.js'

// ------------------------------------------------------------------ 启动耗时打点
//
// 启动是一条长长的 await 链，慢在哪一段靠猜没用：`listTree` 递归读盘、主题 CSS
// 翻译、`openNote` 里的装饰重算，三件事的量级差一个数量级。这里把每段结束时的时间
// （相对页面导航起点，`performance.now()` 的口径）记进一个对象，挂到 window 上供
// CDP 读 —— 打包版也能读，不需要 DevTools 的 profiler。
// 成本是十几次 `performance.now()`，可以忽略。
const bootT0 = performance.now()
const bootTimings: Record<string, number> = { 模块求值: Math.round(bootT0) }
function bootMark(name: string): void {
  bootTimings[name] = Math.round(performance.now())
}

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id)
  if (!el) throw new Error(`缺元素 #${id}`)
  return el as T
}

const elTree = $('jd-tree')
const elFilesWrap = $('jd-files-wrap')
const elFileFilter = $<HTMLInputElement>('jd-file-filter')
const elFileClear = $<HTMLButtonElement>('jd-file-clear')
const elLibName = $('jd-lib-name')
const elOpenLib = $('jd-open-lib')
const elTheme = $<HTMLSelectElement>('jd-theme')
const elEditorHost = $('jd-editor')
const elEmpty = $('jd-empty')
const elStatusPath = $('jd-status-path')
const elStatusSave = $('jd-status-save')
const elStatusMeta = $('jd-status-meta')
const elStatusCount = $('jd-status-count')
const elRecover = $('jd-recover')
const elRecoverText = $('jd-recover-text')
const elRecoverYes = $<HTMLButtonElement>('jd-recover-yes')
const elRecoverNo = $<HTMLButtonElement>('jd-recover-no')
const elSidebar = $('jd-sidebar')
const elSidebarResize = $('jd-sidebar-resize')
const elOutlineWrap = $('jd-outline-wrap')
const elOutline = $('jd-outline')
const elOlFilter = $<HTMLInputElement>('jd-ol-filter')
const elOlClear = $<HTMLButtonElement>('jd-ol-clear')
const elTabFiles = $('jd-tab-files')
const elTabOutline = $('jd-tab-outline')
const elWrite = $('write')

// ------------------------------------------------------------------ 状态

let libRoot = ''
let current: NoteDoc | null = null

/**
 * 文件面板的视图：树 / 平铺列表（右键菜单里切，只在本次会话有效，不写 config）。
 * Typora 的文件面板也是这两种；"记住上次用哪个"没做 —— 每次打开都是树更符合直觉。
 */
let fileView: ViewMode = 'tree'

/** 文件面板的搜索词（空 = 不筛）。输入即过滤，Esc / ✕ 清空 */
let fileFilter = ''

/**
 * 全库文件的扁平缓存（列表视图与搜索用）。
 *
 * 树是懒加载的（只读一层），要"跨目录按名字找"就必须扫全库一次。
 * 结构变化（新建/删除/重命名/外部改动）时置 null，下次用时再扫。
 */
let flatCache: FileNode[] | null = null

/**
 * 副窗口（右键「在新窗口中打开」打开的那个）。
 *
 * 副窗口**不写 lastFile**：否则在副窗口里随手翻两篇，主窗口下次启动打开的
 * 就是副窗口最后看的那篇 —— 用户意识不到是另一个窗口改的。
 */
const isSecondaryWindow = new URLSearchParams(location.search).has('file')
let dirty = false
let saving = false
let saveTimer: number | null = null
let editor: EditorHandle | null = null
let draftTimer: number | null = null
let outlineItems: OutlineItem[] = []
let outlineTimer: number | null = null
let statsTimer: number | null = null
let tablePanel: { refresh: () => void } | null = null
/** 视图模式（只在本次会话有效，不写 config） */
let focusMode = false
let typewriterMode = false
/**
 * 源码模式。这里存一份是为了**换笔记后能恢复** ——
 * `setDoc` 走的是 `EditorState.create`，field 会重建成默认值 false，
 * 不补一次的话，翻下一篇就悄悄退回渲染模式了。
 */
let sourceMode = false

/**
 * 待用户决策的崩溃草稿。
 *
 * 为什么要有这个变量：草稿条改成**非阻塞**之后（原来是「点掉它才继续」），
 * 有个绕不开的先后问题 —— 正常启动会 `openNote(lastFile)`，而 openNote 里
 * 「换文件先清上一篇草稿」会把我们要恢复的那份直接删掉。于是：
 *   - 读到的草稿先存在这里；
 *   - 用户还没点「恢复 / 丢弃」之前，**除了「保存的正是这篇」，任何路径都别清草稿**。
 * 宁可下次再提示一次，也不能把唯一一份没落盘的内容提前抹掉。
 */
let pendingDraft: CrashDraft | null = null

/**
 * 用户点过「恢复」吗。
 *
 * 用来区分两种「保存了同一篇」：
 *   - 点过恢复 → 草稿内容已经进了编辑器，之后保存（哪怕又改了几个字）就该收尾；
 *   - 没点恢复 → 用户自顾自编辑保存，草稿那份内容压根没被采用，不能清。
 */
let draftRestored = false

/**
 * 清草稿的唯一入口（除了用户点「丢弃」）。
 *
 * `savedPath` / `savedText` 只在「刚刚成功保存了这篇」时传。**两个都要对得上才清**：
 *   - 存的是别篇  → 草稿跟这篇没关系，别动；
 *   - 存的是这篇但内容不是草稿那份 → 说明草稿还没被采用过（用户没点「恢复」
 *     就自顾自编辑保存了），这时清掉等于把上次没保存的内容悄悄扔了。
 * 实测踩到过：启动后随手输入几个字，800ms 自动保存一跑，草稿当场消失、条子也收了。
 */
function clearDraftGuarded(savedPath?: string, savedText?: string): void {
  if (pendingDraft) {
    // 路径分隔符/大小写可能不同（一处来自 lastFile、一处来自 readNote），走 normPath
    const sameNote = !!savedPath && normPath(savedPath) === normPath(pendingDraft.path)
    const adopted = draftRestored || savedText === pendingDraft.text
    if (!sameNote || !adopted) return
    hideRecoverBar()
    pendingDraft = null
    draftRestored = false
  }
  void window.api.clearDraft()
}

/**
 * 我们自己最后一次写盘的时刻（毫秒）。
 *
 * 自动保存也会触发笔记库 watcher（写盘就是改文件），照单全收的话每 800ms
 * 就要 listTree 一次并把文件树整个重画 —— 白白滚回顶部，而树的结构
 * （有哪些文件）根本没变，变的只是某篇的内容。所以自写后 2 秒内的通知
 * 只处理「当前这篇变了没」，不重画树。添加/删除/改名是外部操作，不受影响。
 */
let selfSaveAt = 0

/**
 * dirty 的唯一写入口。
 * 顺手把状态推给主进程 —— 关窗拦截靠它，不能只留在渲染层。
 */
function setDirty(value: boolean): void {
  dirty = value
  window.api.setDirty(value)
}

const setSaveStatus = (text: string, cls = ''): void => {
  elStatusSave.textContent = text
  elStatusSave.className = cls
}

const setMetaStatus = (text: string): void => {
  elStatusMeta.textContent = text
}

// ------------------------------------------------------------------ 字数统计

function renderWordCount(): void {
  if (!editor || !current) {
    elStatusCount.textContent = ''
    return
  }
  const { chars, words } = countWords(editor.getDoc())
  elStatusCount.textContent = `${words.toLocaleString('zh-CN')} 字`
  elStatusCount.title = `${words.toLocaleString('zh-CN')} 字 · ${chars.toLocaleString('zh-CN')} 个字符`
}

/** 300ms 防抖：每敲一个字都遍历全文不值当，字数晚半拍也没人会察觉 */
function scheduleWordCount(): void {
  if (statsTimer !== null) window.clearTimeout(statsTimer)
  statsTimer = window.setTimeout(() => {
    statsTimer = null
    renderWordCount()
  }, 300)
}

// ------------------------------------------------------------------ 专注 / 打字机

/**
 * 两个模式都只改「怎么看」，不动文档一个字节。
 *
 * 专注模式里非当前段落的行淡出。`.jd-active` 由 lineclasses.ts 按**段落**给，
 * 不是光标所在的那一行：写着写着整段一起亮才叫专注，只亮一行反而要一直找光标。
 */
function setViewModes(next: { focus?: boolean; typewriter?: boolean }): void {
  if (next.focus !== undefined) focusMode = next.focus
  if (next.typewriter !== undefined) typewriterMode = next.typewriter

  elWrite.classList.toggle('jd-focus', focusMode)
  // 打字机本身不需要样式，但要有这个 class 才能从 DOM 判断"现在开着没有"
  // （状态栏文字会被主题翻译报告覆盖，不能当状态用）
  elWrite.classList.toggle('jd-typewriter', typewriterMode)

  const on: string[] = []
  if (focusMode) on.push('专注')
  if (typewriterMode) on.push('打字机')
  setMetaStatus(on.length > 0 ? `视图：${on.join(' + ')}` : '视图：常规')

  if (typewriterMode) typewriterScroll()
}

/**
 * 把光标行滚到视口垂直居中。
 *
 * 滚动容器是 `#write`，不是 `.cm-scroller`（后者被设成 overflow:visible），
 * 所以 `EditorView.scrollIntoView()` 在这里无效 —— 自己算：
 * 光标相对容器顶部的位移，减去半个视口高度，就是需要追加的滚动量。
 */
function typewriterScroll(): void {
  if (!typewriterMode || !editor) return
  const coords = editor.view.coordsAtPos(editor.view.state.selection.main.head)
  if (!coords) return
  const box = elWrite.getBoundingClientRect()
  elWrite.scrollTop += coords.top - box.top - elWrite.clientHeight / 2
}

function scheduleTypewriter(): void {
  if (!typewriterMode) return
  // 光标移动后 DOM 可能还没重排完，等一拍再量。
  // 用 setTimeout 而不是 rAF：窗口不可见时 rAF 会被完全暂停（实测 600ms 0 回调）。
  window.setTimeout(typewriterScroll, 0)
}

// ------------------------------------------------------------------ 源码模式

/**
 * 渲染模式 ↔ 源码模式。
 *
 * 只丢一个布尔进编辑器 state，markers / table / fold 三处各自决定要不要出装饰：
 * 源码模式下标记全露、图片回 `![](path)`、表格回 `| a | b |`、折叠也停掉。
 * 行级 class（`.jd-h1` / `.jd-code-block`）保留 —— Typora 的源码模式同样保留排版。
 */
function toggleSourceMode(): void {
  sourceMode = !sourceMode
  if (editor) {
    editor.view.dispatch({ effects: setSourceMode.of(sourceMode) })
    editor.view.focus()
  }
  setMetaStatus(sourceMode ? '源码模式：markdown 标记全部显示' : '已回到渲染模式')
}

// ------------------------------------------------------------------ 编辑器

function ensureEditor(): EditorHandle {
  if (editor) return editor
  editor = createEditor(elEditorHost, {
    onChange: () => {
      setDirty(true)
      setSaveStatus('未保存', 'is-dirty')
      scheduleSave()
      scheduleDraft()
      scheduleOutline()
      scheduleWordCount()
      scheduleTypewriter()
      tablePanel?.refresh()
    },
    onSaveRequest: () => void doSave(),
    onPasteImage: (file) => void handleImage(file),
    onDropImage: (file) => void handleImage(file),
    onSelection: (pos) => {
      highlightOutline(elOutline, outlineItems, pos)
      scheduleTypewriter()
      tablePanel?.refresh()
    },
  })
  return editor
}

// ------------------------------------------------------------------ 大纲（M5-1）

/** 大纲「查找」框里的当前词（空串 = 不过滤）。换笔记不清空，用户随时可以点 ✕。 */
let outlineFilter = ''

/** 只重画（标题数据没变，比如只改了查找词） */
function paintOutline(): void {
  renderOutline(
    elOutline,
    outlineItems,
    (pos) => {
      if (editor) jumpTo(editor.view, pos)
    },
    outlineFilter
  )
  syncOutlineToViewport()
}

/** 重建大纲：打开笔记后、文档改动后调用 */
function rebuildOutline(): void {
  if (!editor) {
    outlineItems = []
    elOutline.textContent = ''
    return
  }
  outlineItems = computeOutline(editor.view.state)
  paintOutline()
}

// 「查找」：输入即过滤（与 Typora 一致），Esc 或 ✕ 清空
elOlFilter.addEventListener('input', () => {
  outlineFilter = elOlFilter.value
  paintOutline()
})
elOlFilter.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  // 别让 Esc 继续冒泡到全局快捷键（它在那儿是「收起恢复条/关面板」）
  e.stopPropagation()
  e.preventDefault()
  clearOutlineFilter()
})
elOlClear.addEventListener('click', () => clearOutlineFilter())

function clearOutlineFilter(): void {
  if (!outlineFilter && !elOlFilter.value) return
  elOlFilter.value = ''
  outlineFilter = ''
  paintOutline()
}

/**
 * 大纲高亮 = **视口顶部所在的章节**，不是光标所在的章节。
 *
 * 一开始用的是光标，结果是：用滚轮往下翻，大纲高亮纹丝不动地停在原处，
 * 看起来就是「选中和内容对不上」。翻文档时不一定会点一下让光标过去，
 * 所以必须以视口为准。（点正文时 onSelection 也会调一次，两者通常一致。）
 *
 * 取视口顶部往下 24px（跳过 #write 的 padding-top）的中点坐标反查字符位置；
 * 反查失败（内容还没布局）就退回光标位置，至少不会整排都没高亮。
 */
function syncOutlineToViewport(): void {
  if (!editor || outlineItems.length === 0) return
  const rect = elWrite.getBoundingClientRect()
  const pos = editor.view.posAtCoords({ x: rect.left + rect.width / 2, y: rect.top + 24 })
  highlightOutline(elOutline, outlineItems, pos ?? editor.view.state.selection.main.head)
}

/**
 * 文档改动后重建大纲，防抖 150ms。
 * 逐行正则在中位数笔记上是微秒级，但 274KB / 8000 行的大文件要几毫秒，
 * 挂在每次 docChanged 上会让输入发涩；而大纲晚 150ms 更新没人会察觉。
 */
function scheduleOutline(): void {
  if (outlineTimer !== null) window.clearTimeout(outlineTimer)
  outlineTimer = window.setTimeout(() => {
    outlineTimer = null
    rebuildOutline()
  }, 150)
}

// ------------------------------------------------------------------ 侧栏标签页（文件 / 大纲）

/**
 * 两个标签页共用侧栏的整块高度，而不是上下挤在一起 ——
 * 文件树本身就有 17 个顶层目录，再分一半给大纲，两边都难用。
 * 显示与否只由标签页决定；大纲没有标题时由 renderOutline 自己显示
 * 「这篇没有标题」，不再靠隐藏整块来"假装没这个功能"。
 */
function setSidebarTab(name: 'files' | 'outline'): void {
  elTabFiles.classList.toggle('is-active', name === 'files')
  elTabOutline.classList.toggle('is-active', name === 'outline')
  // 隐藏的是整个 wrap（搜索栏 + 树），只藏树会把搜索栏孤零零留在侧栏里
  elFilesWrap.classList.toggle('hidden', name !== 'files')
  elOutlineWrap.classList.toggle('hidden', name !== 'outline')
}

elTabFiles.addEventListener('click', () => setSidebarTab('files'))
elTabOutline.addEventListener('click', () => setSidebarTab('outline'))

// 滚动时同步大纲高亮。节流 80ms：滚动事件一次能连发几十个，
// 每个都去 posAtCoords + 遍历大纲项没必要。
let outlineScrollTimer: number | null = null
elWrite.addEventListener(
  'scroll',
  () => {
    if (outlineScrollTimer !== null) return
    outlineScrollTimer = window.setTimeout(() => {
      outlineScrollTimer = null
      syncOutlineToViewport()
    }, 80)
  },
  { passive: true }
)

/**
 * 自动保存防抖时长，启动时从 config 读一次。
 *
 * 以前这里是硬编码的 800ms，而 config.json 里躺着一个谁都不读的
 * `autosaveDebounceMs` —— 改它当然没用。现在真的接上了。
 * 默认值与 config.ts 的 DEFAULTS 一致；读失败就退回 800。
 */
let autosaveMs = 800

function scheduleSave(): void {
  // 自动保存关掉时，把**已经排上**的那一轮也撤掉：否则「刚在设置里关掉」
  // 之后还会再写一次盘，用户看到的是「关了但它还是自己存了」。
  // 草稿（300ms）不跟着这个开关走 —— 那是崩溃时的最后一道防线。
  if (!getPrefs().autosave) {
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer)
      saveTimer = null
    }
    return
  }
  if (saveTimer !== null) window.clearTimeout(saveTimer)
  saveTimer = window.setTimeout(() => void doSave(), autosaveMs)
}

/**
 * 崩溃草稿：比自动保存更早、更频繁地落一份快照。
 * 自动保存失败（磁盘满、文件被独占）时，这仍是唯一能救回内容的东西，
 * 所以它和 doSave 是两个独立的定时器，不能合并。
 */
function scheduleDraft(): void {
  if (!current) return
  if (draftTimer !== null) window.clearTimeout(draftTimer)
  draftTimer = window.setTimeout(() => {
    if (!current || !editor || !dirty) return
    void window.api.saveDraft(current.path, editor.getDoc())
  }, 300)
}

/**
 * 收起草稿恢复条（不动磁盘上的草稿）。
 */
function hideRecoverBar(): void {
  elRecover.classList.add('hidden')
}

/**
 * 上次没走完正常流程？有草稿就在顶部显示恢复条。
 *
 * **不阻塞启动**（2026-11-11 改）。原来这里是 `await 用户点击`，条子不点，
 * 后面的「打开上次那篇」就永远不执行 —— 表现是文件树有内容、编辑器一片空白，
 * 而用户压根不知道要去点顶部那一行。反复强杀进程会稳定踩到（我自己踩过）。
 * 现在改成：先把上次那篇正常打开，再把条子挂上去；点「恢复」才用草稿覆盖。
 *
 * 也不用 window.confirm：原生对话框会阻塞渲染进程、无法样式化，
 * 而且在自动化环境里会被直接判为取消（实测把草稿静默扔掉了）。
 */
function offerCrashRecovery(draft: CrashDraft): void {
  pendingDraft = draft
  // `at` 可能是缺的或坏的（手写草稿、旧版本、磁盘写到一半）：`new Date(undefined)` 不抛错，
  // 只会安静地渲染成 1970/1/1 或 "Invalid Date"。宁可整段时间不显示，
  // 也别给用户看一个像是真事儿的假时间。
  const stamp = Number(draft.at)
  const stampDate = new Date(stamp)
  const when =
    Number.isFinite(stamp) && stamp > 0 && !Number.isNaN(stampDate.getTime())
      ? stampDate.toLocaleString('zh-CN')
      : ''
  const name = draft.path.split(/[\\/]/).pop() ?? draft.path
  elRecoverText.textContent = `上次退出时「${name}」还有 ${draft.text.length} 字没保存${when ? `（${when}）` : ''}`
  elRecover.classList.remove('hidden')

  // 监听器的挂/摘要能重来：恢复失败时条子会重新出现，那时必须还能再点
  const attach = (): void => {
    elRecoverYes.addEventListener('click', onYes)
    elRecoverNo.addEventListener('click', onNo)
  }
  const detach = (): void => {
    elRecoverYes.removeEventListener('click', onYes)
    elRecoverNo.removeEventListener('click', onNo)
    hideRecoverBar()
  }

  const onYes = (): void => {
    // 已经在这篇上改过又没保存：直接覆盖等于把刚才的编辑扔掉，
    // 不弹 confirm（会阻塞渲染进程），改成让用户自己先处理。
    if (dirty && current && normPath(current.path) === normPath(draft.path)) {
      setMetaStatus('当前这篇还有未保存的改动，先保存或撤销再恢复草稿')
      return
    }
    detach()
    void (async () => {
      try {
        // 走正常打开流程：读盘、文件树选中、记 lastFile 都由 openNote 负责。
        // 它内部那句「换文件先清草稿」会被 pendingDraft 拦住，刚好是我们想要的。
        if (!current || normPath(current.path) !== normPath(draft.path)) {
          await openNote(draft.path)
        }
        const ed = editor
        if (!ed || !current) throw new Error('编辑器尚未就绪')
        // 只换正文，其余字段（path / eolStyle / mtimeMs / bom…）保持读盘时的样子，
        // 保存时靠它们把换行符和编码原样写回去。
        current = { ...current, text: draft.text }
        setDirty(true)
        ed.setDoc(draft.text, dirNameOf(draft.path))
        // setDoc 走 EditorState.create，所有 StateField 归零 —— 补回源码模式
        if (sourceMode) ed.view.dispatch({ effects: setSourceMode.of(true) })
        // 磁盘那份若不是 UTF-8，草稿也只会是乱码 —— 同样锁只读，
        // 否则一按 Ctrl+S 就被编码检查拒掉，用户不知道手停在哪里。
        ed.setReadOnly(current.validUtf8 === false)
        ed.focus()
        setActive(elTree, draft.path)
        elStatusPath.textContent = draft.path
        elStatusPath.title = draft.path
        setSaveStatus('已恢复草稿（未保存）', 'is-dirty')
        setMetaStatus(when ? `已恢复 ${when} 的草稿，检查无误后按 Ctrl+S 写盘` : '已恢复草稿，检查无误后按 Ctrl+S 写盘')
        rebuildOutline()
        // 草稿内容已经进编辑器了，之后保存就该把草稿收尾（哪怕又改了几个字）
        draftRestored = true
        // 草稿文件故意留着：内容此刻只在内存里，再崩一次还得靠它。
        // 保存成功后 doSave 会调 clearDraftGuarded(path, text) 把它收尾。
      } catch (err) {
        // 失败就把条子放回去 —— 那里面是用户唯一一份没落盘的内容，
        // 不能因为「打不开」就跟着消失。
        pendingDraft = draft
        elRecover.classList.remove('hidden')
        attach()
        setMetaStatus(`草稿恢复失败：${(err as Error).message}`)
      }
    })()
  }

  const onNo = (): void => {
    detach()
    // 丢弃草稿，但磁盘上的文件一个字都不动
    pendingDraft = null
    draftRestored = false
    void window.api.clearDraft()
    // 打开的是磁盘版本；之前可能已被 openNote 打开，内容不用再动
    setMetaStatus('已丢弃上次的草稿')
  }

  attach()
}


/**
 * 保存。
 *
 * 返回值是「这次调用结束时，改动是否已经安全落到磁盘」：
 *   true  = 不用存（没改动）或已存好
 *   false = 没能落盘（编码被拒 / 冲突时用户选了先不保存 / 写盘失败）
 *
 * 调用方必须看这个返回值。`openNote` 就靠它决定「能不能换下一篇」——
 * 忽略它的话，冲突被取消之后仍会照样切换文件，编辑器里那版改动就凭空没了。
 */
async function doSave(force = false): Promise<boolean> {
  // 没有笔记/编辑器 = 没有东西可丢，视为已完成
  if (!current || !editor) return true
  // 正在写盘：这一次不能算完成。换笔记的调用方据此先停下，
  // 等这一轮写完再切 —— 否则切过去之后回调会把内容写到新笔记的 current 上。
  if (saving) return false
  if (!dirty) return true
  // 非 UTF-8 的文件连编辑都不该发生（openNote 已把编辑器设成只读），
  // 这里再兜一层：万一有路径绕过，也绝不让它写回磁盘。
  if (current.validUtf8 === false) {
    setSaveStatus('只读', 'is-error')
    window.alert(
      '这篇笔记不是 UTF-8 编码，为免把原文转码写坏，简牍不会保存它。\n\n' +
        '请先用其他工具把它转成 UTF-8，再重新打开。'
    )
    return false
  }
  saving = true
  setSaveStatus('保存中…')

  const text = editor.getDoc()
  const res = await window.api.writeNote(current.path, text, {
    eolStyle: current.eolStyle,
    eolMap: current.eolMap,
    bom: current.bom,
    endsWithNewline: current.endsWithNewline,
    // 打开（或上次保存）时看到的 mtime：主进程拿它和磁盘现状比，
    // 不一致说明这篇在别处被改过（Typora / 网盘同步 / git 切分支）
    expectMtimeMs: current.mtimeMs,
    // size 一起传：两个指纹都命中时主进程会跳过「整篇重读判编码」，
    // 280KB 的笔记每次保存能省掉一次全量读盘
    expectSize: current.size,
    force,
  })

  saving = false

  if (res.ok) {
    // 写盘期间用户可能又敲了字：只有内容确实还是刚写下去的那份才算「干净」
    const stillSame = editor.getDoc() === text
    setDirty(!stillSame)
    if (!stillSame) scheduleSave()
    current.mtimeMs = res.mtimeMs
    current.size = res.size
    // 记下「刚刚是我们自己写的」：笔记库 watcher 随后会报一次变更，
    // 那次不该被当成外部修改去重画文件树（见 onLibraryChanged 里的 selfSaveAt）
    selfSaveAt = Date.now()
    setSaveStatus('已保存', 'is-saved')
    // 写盘成功且内容未再变 → 草稿没用了，清掉（否则下次启动会误以为崩溃过）。
    // 但如果启动时那条恢复提示还没被处理，得「这篇 + 这份内容」都对上才清 ——
    // 见 clearDraftGuarded 的注释。
    if (stillSame) clearDraftGuarded(current.path, text)
    window.setTimeout(() => {
      if (!dirty) setSaveStatus('')
    }, 1600)
    return true
  }

  // --- 外部修改冲突：不静默覆盖，让用户选
  //
  // 这是整条保存链路上唯一「选错就丢数据」的地方，所以三个选项都要说清后果：
  // 覆盖 = 别人那版没了；放弃本地 = 我这版没了；先看看 = 什么都不动。
  if (res.conflict) {
    setSaveStatus('有冲突', 'is-error')
    const keepMine = window.confirm(
      '这篇笔记在你打开之后被其他程序修改过。\n\n' +
        `文件：${current.path}\n\n` +
        '点「确定」用简牍里的内容覆盖磁盘上的版本（对方的修改会丢失）。\n' +
        '点「取消」先不保存 —— 建议重新打开这篇，看看到底改了什么。'
    )
    if (keepMine) {
      // 用户明确要求覆盖：把磁盘当前的 mtime/size 记下来，避免下一轮又撞同一次冲突
      // （size 也要跟上 —— 只更新 mtime 会让指纹对不上，白读一遍盘）
      current.mtimeMs = res.mtimeMs
      current.size = res.size
      setDirty(true)
      return await doSave(true)
    }
    setMetaStatus('已取消保存：磁盘上的文件比编辑器里的新')
    return false
  }

  // --- 编码不符：主进程拒绝写盘，这里给可操作的解释（不是"未知错误"）
  if (res.encoding) {
    setSaveStatus('只读', 'is-error')
    setMetaStatus('⚠ 非 UTF-8，已拒绝保存')
    window.alert(res.error ?? '原文件不是 UTF-8 编码，已拒绝保存。')
    return false
  }

  // 写盘失败必须显式弹错（策划案 §7 红线）
  setSaveStatus('保存失败', 'is-error')
  window.alert(`保存失败：\n${res.error ?? '未知错误'}\n\n文件：${current.path}`)
  return false
}

// ------------------------------------------------------------------ 图片

async function handleImage(file: File): Promise<void> {
  if (!current || !editor) return
  // 只读笔记（非 UTF-8）插图片没有意义：内容改不动磁盘，插进去只会挂在编辑器里，
  // 而 CM6 的 EditorState.readOnly 只拦用户输入，`view.dispatch` 发的事务照过 ——
  // 所以这一层必须自己挡。
  if (current.validUtf8 === false) {
    setMetaStatus('这篇不是 UTF-8 编码，只读 —— 先转码后再插图')
    return
  }
  const maxBytes = 40 * 1024 * 1024
  if (file.size > maxBytes) {
    window.alert(`图片太大（${(file.size / 1024 / 1024).toFixed(1)}MB），上限 40MB。`)
    return
  }
  const buf = await file.arrayBuffer()
  const base64 = arrayBufferToBase64(buf)
  const ext = (file.name.split('.').pop() ?? 'png').toLowerCase()
  const rel = await window.api.saveImage(current.path, base64, ext)
  insertAtCursor(editor.view, `![](${rel})`)
  setDirty(true)
  scheduleSave()
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let bin = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(bin)
}

// ------------------------------------------------------------------ 打开笔记

async function openNote(filePath: string): Promise<void> {
  // 有未保存的改动就先存。存不下去（非 UTF-8 / 冲突选了「先不保存」/ 写盘失败）
  // 就不换文件 —— 直接切走等于把那版改动连同撤销历史一起扔掉，
  // 而且用户会以为"已经自动保存过了"。
  if (current && dirty) {
    // 正在写盘的那一轮 doSave 会返回 false（它还没落盘），直接当成"存不下"
    // 会让用户莫名其妙卡在原地。先等它写完，再决定能不能切。
    for (let i = 0; i < 20 && saving; i++) {
      await new Promise<void>((r) => window.setTimeout(r, 100))
    }
    const saved = await doSave()
    if (!saved) {
      setMetaStatus('这篇还有未保存的改动，已停在当前文件（先处理保存问题再切换）')
      return
    }
  }

  const doc = await window.api.readNote(filePath)
  current = doc
  setDirty(false)
  // 换文件前先把上一篇的草稿清掉，否则重启会提示恢复错误的内容。
  // 例外：启动时那条恢复提示还没被处理 —— 那时被清掉的正是唯一一份
  // 没落盘的内容，所以由 clearDraftGuarded 拦着。
  if (draftTimer !== null) {
    window.clearTimeout(draftTimer)
    draftTimer = null
  }
  clearDraftGuarded()
  // 副窗口不写 lastFile（否则它会顶替主窗口的"上次打开"）
  if (!isSecondaryWindow) void window.api.setLastFile(filePath)

  elEmpty.classList.add('hidden')
  const ed = ensureEditor()
  // 第二个参数是笔记所在目录，图片的相对路径要靠它解析成 file:// 地址
  ed.setDoc(doc.text, dirNameOf(filePath))
  // 非 UTF-8 文件：锁成只读。乱码上再怎么编辑也没有意义，
  // 而一旦保存就会把原文永久转码写坏 —— 见 writeNote 的编码检查。
  ed.setReadOnly(doc.validUtf8 === false)
  ed.focus()
  // setDoc 重建了 state，源码模式要跟着补回来（否则翻下一篇就悄悄退回渲染模式）
  if (sourceMode) ed.view.dispatch({ effects: setSourceMode.of(true) })

  // 换笔记要回到顶部。滚动容器是外层的 #write，不是 CM6 的 .cm-scroller
  // （后者是 overflow:visible，见 outline.ts 的注释），所以不能指望 CM6 自己重置。
  // 用 setTimeout 而不是 requestAnimationFrame：窗口不可见时 rAF 会被完全暂停
  // （实测 hidden 状态下 600ms 内一次都不跑），而换笔记这件事在后台也可能发生。
  // 两次是为了等 setDoc 之后的重新排版稳定下来。
  setTimeout(() => {
    elWrite.scrollTop = 0
  }, 0)
  setTimeout(() => {
    elWrite.scrollTop = 0
  }, 80)

  setActive(elTree, filePath)
  elStatusPath.textContent = filePath
  elStatusPath.title = filePath
  setSaveStatus('')

  const eolLabel =
    doc.eolStyle === 'crlf' ? 'CRLF' : doc.eolStyle === 'lf' ? 'LF' : doc.eolStyle === 'cr' ? 'CR' : '混合换行'
  const bits = [eolLabel, fmtSize(doc.size)]
  if (doc.bom) bits.push('BOM')
  if (!doc.endsWithNewline) bits.push('末尾无换行')
  // 非 UTF-8 必须在状态栏就说清楚：这是**只读**的原因，
  // 否则用户会以为「打不开/敲不进字」是软件坏了
  if (doc.validUtf8 === false) bits.push('⚠ 非 UTF-8，只读')
  setMetaStatus(bits.join(' · '))

  // 裂图提示：有就明说，不静默
  // 裂图检测要扫这篇的图片目录（实测 36ms，还是一次 IPC 往返），但它只是"顺便告知"——
  // 挡在这里会让大纲和字数白等，首屏也跟着晚一帧。改成不阻塞：
  // 算完如果这篇还开着，再把提示补到状态栏上。
  void window.api
    .brokenImagesOf(filePath)
    .then((broken) => {
      if (broken.length === 0) return
      // 期间用户可能已经换了笔记，别把上一篇的裂图数写在当前这篇的状态栏上
      if (current?.path !== filePath) return
      setMetaStatus(`${bits.join(' · ')} · ⚠ 裂图 ${broken.length}`)
    })
    .catch(() => {
      /* 检测失败不影响打开 */
    })

  // 新笔记的大纲 / 字数 / 表格浮条：都不影响正文显示，放到下一轮事件循环。
  // 这样正文（setDoc 的结果）能先上屏，侧栏这些晚 0~1 帧再补齐。
  setTimeout(() => {
    if (current?.path !== filePath) return
    rebuildOutline()
    renderWordCount()
    tablePanel?.refresh()
  }, 0)
}

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

/** 取路径里的目录部分（图片相对路径的解析基准） */
function dirNameOf(filePath: string): string {
  const i = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'))
  return i > 0 ? filePath.slice(0, i) : ''
}

/**
 * 归一化路径后再比较。
 *
 * Windows 下 `D:/a` 和 `D:\a` 是同一个位置，但不是同一个字符串 ——
 * 直接 `startsWith` 会静默失败，现象是「重启后回到文件树、不打开上次那篇」，
 * 而且**不报任何错**。正反斜杠混用是常态：用户手改过 config、别的工具写过面板、
 * 或者任何一处用了 `path.posix` 都会留下正斜杠。
 */
function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

// ------------------------------------------------------------------ 侧栏宽度

/**
 * 拖拽改宽。宽度写进 config.sidebarWidth，下次启动恢复。
 * 用 pointer 事件而不是 mousedown/mousemove：拖到窗口外也能继续跟着走，
 * 鼠标松开的事件不会丢（mousemove 方案在快速甩出窗口时会卡住）。
 */
function setupSidebarResize(): void {
  let dragging = false

  elSidebarResize.addEventListener('pointerdown', (ev) => {
    ev.preventDefault()
    dragging = true
    elSidebarResize.classList.add('is-dragging')
    elSidebarResize.setPointerCapture(ev.pointerId)
  })

  elSidebarResize.addEventListener('pointermove', (ev) => {
    if (!dragging) return
    const left = elSidebar.getBoundingClientRect().left
    const w = Math.round(ev.clientX - left)
    const clamped = Math.max(160, Math.min(480, w))
    document.documentElement.style.setProperty('--jd-sidebar-w', `${clamped}px`)
  })

  const finish = (ev: PointerEvent): void => {
    if (!dragging) return
    dragging = false
    elSidebarResize.classList.remove('is-dragging')
    try {
      elSidebarResize.releasePointerCapture(ev.pointerId)
    } catch {
      /* 指针已经没了，忽略 */
    }
    const w = Math.round(elSidebar.getBoundingClientRect().width)
    void window.api.saveSidebarWidth(w)
  }

  elSidebarResize.addEventListener('pointerup', finish)
  elSidebarResize.addEventListener('pointercancel', finish)

  // 双击恢复默认宽度
  elSidebarResize.addEventListener('dblclick', () => {
    document.documentElement.style.setProperty('--jd-sidebar-w', '240px')
    void window.api.saveSidebarWidth(240)
  })
}

async function restoreSidebarWidth(): Promise<void> {
  const w = await window.api.getSidebarWidth()
  if (w >= 160 && w <= 480) {
    document.documentElement.style.setProperty('--jd-sidebar-w', `${w}px`)
  }
}

// ------------------------------------------------------------------ 笔记库

async function loadLibrary(root: string): Promise<void> {
  libRoot = root
  elLibName.textContent = root.split(/[\\/]/).filter(Boolean).pop() ?? root
  elLibName.title = root
  // 换了库，扁平缓存整份作废
  flatCache = null
  await paintFilePanel()
}

/** 把整棵树摊平成文件数组（列表视图与搜索要跨目录，树本身是懒加载的） */
function flattenTree(nodes: FileNode[], out: FileNode[]): void {
  for (const n of nodes) {
    if (n.isDir) flattenTree(n.children ?? [], out)
    else out.push(n)
  }
}

/**
 * 按当前视图 + 搜索词重画文件面板。
 *
 * 三种情况：
 *   - 树视图且没有搜索词 → 只读顶层（`listDir`），子目录展开时再要，最省；
 *   - 列表视图 / 有搜索词 → 扫一次全库（`listTree`）并缓存，平铺显示；
 *   - 结构变了（新建/删除/重命名/外部改动）→ 调用方先把 `flatCache` 置 null。
 */
async function paintFilePanel(): Promise<void> {
  if (!libRoot) return
  const query = fileFilter.trim().toLowerCase()

  if (fileView === 'list' || query) {
    if (flatCache === null) {
      const tree = await window.api.listTree(libRoot)
      const flat: FileNode[] = []
      flattenTree(tree, flat)
      // 按路径排：同目录的排在一起，读起来和资源管理器的"名称"视图一致
      flat.sort((a, b) => a.path.localeCompare(b.path, 'zh-CN', { numeric: true }))
      flatCache = flat
    }
    const files = query ? flatCache.filter((f) => f.name.toLowerCase().includes(query)) : flatCache
    renderFlatList(elTree, files, {
      root: libRoot,
      activePath: current?.path ?? '',
      onOpen: (p) => void openNote(p),
      onContext: handleFileContext,
      onMove: (src, dir) => void moveFileInto(src, dir),
    })
    return
  }

  // 只读顶层：文件树默认全部收起，展开哪个目录再要它那一层。
  // 全量 listTree 要走完整棵目录树（245 篇实测 26ms，库越大越久），
  // 而收起状态下这些子节点连 DOM 都不建 —— 扫了也用不上。
  const nodes = await window.api.listDir(libRoot)
  renderTree(elTree, {
    root: nodes,
    activePath: current?.path ?? '',
    onOpen: (p) => void openNote(p),
    loadChildren: (p) => window.api.listDir(p),
    onContext: handleFileContext,
    rootPath: libRoot,
    onMove: (src, dir) => void moveFileInto(src, dir),
  })
}

/**
 * 重命名成功后同步编辑器里的路径。
 *
 * **不重新读盘**：那会把用户没保存的改动冲掉。只改 `current.path`，
 * 之后 Ctrl+S 自然写到新文件名上。
 * 重命名的若是当前笔记的**父目录**，按前缀替换（`oldDir/a.md` → `newDir/a.md`）。
 */
function onFileRenamed(oldPath: string, newPath: string): void {
  if (!current) return
  const cur = normPath(current.path)
  const oldNorm = normPath(oldPath)
  let next = ''
  if (cur === oldNorm) next = newPath
  else if (cur.startsWith(`${oldNorm}/`)) next = newPath + current.path.slice(oldPath.length)
  else return

  // 重命名的若是目录，把展开状态一起搬走 —— 否则树重画后那个目录变回收起，
  // 正在编辑的这篇在新路径下"消失"，高亮也无处可挂
  renameExpanded(oldPath, newPath)

  // 重命名的若是目录，把展开状态一起搬走 —— 否则树重画后那个目录变回收起，
  // 正在编辑的这篇在新路径下"消失"，高亮也无处可挂
  renameExpanded(oldPath, newPath)

  current = { ...current, path: next }
  elStatusPath.textContent = next
  elStatusPath.title = next
  setActive(elTree, next)
  if (!isSecondaryWindow) void window.api.setLastFile(next)
}

/**
 * 删除成功后：如果删的是正在编辑的那篇（或它的父目录），把编辑器摘下来。
 *
 * **必须摘**：`current` 还指着已删路径的话，800ms 后自动保存会把文件
 * **重新写回磁盘** —— 用户看到的"删除"等于没删。`doSave()` 对 `current == null`
 * 直接返回 true，所以摘掉之后就彻底写不回去了。
 */
function onFileTrashed(target: string): void {
  if (!current) return
  const cur = normPath(current.path)
  const t = normPath(target)
  if (cur !== t && !cur.startsWith(`${t}/`)) return

  current = null
  setDirty(false)
  setSaveStatus('')
  editor?.setDoc('', '')
  elEmpty.classList.remove('hidden')
  elStatusPath.textContent = ''
  elStatusPath.title = ''
  rebuildOutline()
  renderWordCount()
}

/** 路径最后一段（正反斜杠都认） */
function baseNameOf(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] ?? p
}

/**
 * 拖拽移动完成后的收尾。
 *
 * 三件事必须一起做，少一件就会"看起来移动了、其实状态错位"：
 *   1. **展开状态跟着搬**（拖的是目录时）—— 否则重画后目录变回收起，
 *      正在编辑的那篇在新路径下"消失"；
 *   2. **当前笔记跟着换路径** —— 它可能正是被拖的那篇，也可能在被拖的目录里。
 *      不换的话下一次 Ctrl+S 会写到**旧路径**（文件已经不在了，会被重新创建出来）；
 *   3. **扁平缓存作废** —— 列表视图与搜索才看得到新位置。
 *
 * 顺带一提：不重新读盘。移动不改内容，重读只会把未保存的改动冲掉。
 */
async function moveFileInto(srcPath: string, targetDir: string): Promise<void> {
  const res = await window.api.moveEntry(srcPath, targetDir)
  if (!res.ok || !res.path) {
    setMetaStatus(res.error ?? '移动失败')
    return
  }
  const next = res.path
  renameExpanded(srcPath, next)

  if (current) {
    const cur = normPath(current.path)
    const srcNorm = normPath(srcPath)
    let moved = ''
    if (cur === srcNorm) moved = next
    else if (cur.startsWith(`${srcNorm}/`)) moved = next + current.path.slice(srcPath.length)
    if (moved) {
      current = { ...current, path: moved }
      elStatusPath.textContent = moved
      elStatusPath.title = moved
      if (!isSecondaryWindow) void window.api.setLastFile(moved)
    }
  }

  flatCache = null
  await paintFilePanel()
  setMetaStatus(`已移动到「${baseNameOf(targetDir)}」`)
}

/** 右键菜单要用的一组回调（每次弹菜单新建一份，避免抓住旧的 current） */
function fileOpsContext(): FileOpsContext {
  return {
    root: () => libRoot,
    currentPath: () => current?.path ?? null,
    open: (p) => openNote(p),
    refresh: async () => {
      // 结构变了：扁平缓存必须作废，否则列表视图里还留着已删的条目
      flatCache = null
      await paintFilePanel()
    },
    status: (text) => setMetaStatus(text),
    viewMode: () => fileView,
    setViewMode: (mode) => {
      if (fileView === mode) return
      fileView = mode
      void paintFilePanel()
      setMetaStatus(mode === 'list' ? '文件面板：文档列表（平铺全部笔记）' : '文件面板：文档树')
    },
    focusSearch: (word) => {
      // 右键「搜索」先切到文件页签 —— 在大纲页签里聚焦看不见的输入框很怪
      setSidebarTab('files')
      elFileFilter.value = word
      fileFilter = word
      void paintFilePanel()
      elFileFilter.focus()
      elFileFilter.select()
    },
    onRenamed: onFileRenamed,
    onTrashed: onFileTrashed,
  }
}

function handleFileContext(node: HitNode | null, x: number, y: number): void {
  if (!libRoot) return
  showFileMenu({ node, x, y, ctx: fileOpsContext() })
}

// ---- 文件面板的搜索 ----
elFileFilter.addEventListener('input', () => {
  fileFilter = elFileFilter.value
  void paintFilePanel()
})
elFileFilter.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  // 别让 Esc 冒泡到全局（那里是"收起恢复条 / 关面板"）
  e.stopPropagation()
  e.preventDefault()
  clearFileFilter()
  elFileFilter.blur()
})
elFileClear.addEventListener('click', () => {
  clearFileFilter()
  elFileFilter.focus()
})

function clearFileFilter(): void {
  if (!fileFilter && !elFileFilter.value) return
  elFileFilter.value = ''
  fileFilter = ''
  void paintFilePanel()
}

elOpenLib.addEventListener('click', () => {
  void (async () => {
    const root = await window.api.openLibrary()
    if (root) await loadLibrary(root)
  })()
})

// ------------------------------------------------------------------ 主题

/**
 * 下拉框里只列这几个主题，其余 `.css` 一个都不显示。
 *
 * **只影响这个列表，磁盘一个字节都不动**：那些主题还在 Typora 的
 * 主题目录里（`%APPDATA%\Typora\themes\`，那是 Typora 自己的地方，
 * 简牍只读不写）。想放回来，把名字加进这个数组就行 —— 带不带 `.css`
 * 都认，大小写也不敏感。
 *
 * 两个内置档（`（内置）` / `（内置 · 深色）`）不走这里：它们是渲染层
 * 自己拼进去的虚拟项，恒在，不受这张表影响。
 */
const VISIBLE_THEMES = ['rider-dark']

/** 主题文件名（`rider-dark.css`）是否在上面那张白名单里 */
function isThemeVisible(file: string): boolean {
  const base = file.replace(/\.css$/i, '').toLowerCase()
  return VISIBLE_THEMES.some((n) => n.toLowerCase() === base)
}

async function loadThemes(selected?: string): Promise<void> {
  const themes = (await window.api.getThemes()).filter(isThemeVisible)
  elTheme.textContent = ''
  const builtin = document.createElement('option')
  builtin.value = ''
  builtin.textContent = '（内置）'
  elTheme.append(builtin)
  // 内置的深色档：策划案 §3.1-6 的「亮/暗两套兜底」。它不是主题文件，
  // 值也取自 config 里一直留着却没实现的那个 'builtin-dark'
  const builtinDark = document.createElement('option')
  builtinDark.value = BUILTIN_DARK
  builtinDark.textContent = '（内置 · 深色）'
  elTheme.append(builtinDark)
  for (const t of themes) {
    const o = document.createElement('option')
    o.value = t
    o.textContent = t.replace(/\.css$/i, '')
    elTheme.append(o)
  }
  if (selected === BUILTIN_DARK) elTheme.value = BUILTIN_DARK
  else if (selected && themes.includes(selected)) elTheme.value = selected
  else if (selected) {
    // config 里还留着已被藏起来的主题名（以前切过 dyzj-dark 之类）。
    // 下拉里现在没有它，`elTheme.value` 会被浏览器吃掉、落回第一项，
    // 而 config 里仍写着旧名字 —— 下次启动再走一遍同样的回落，永远对不上。
    // 这里顺手归一成内置浅色，让配置和界面对齐。
    void window.api.setCurrentTheme('')
  }
}

/**
 * 主题（内置档 / 运行时切换 / 文件热重载）每次注入或切换样式后，CM6 的高度表必须重测：
 * 主题改的是 <head> 里的 <style>，CM6 只观察编辑器内部 DOM，不会自动重测，
 * 于是用旧行高反查点击位置会落到错行（"第一次点击其他行光标偏"就是这个）。
 * applyTheme 在每次注入后派发 THEME_APPLIED_EVENT，这里统一在下一帧强制重新测量。
 */
window.addEventListener(THEME_APPLIED_EVENT, () => {
  editor?.view?.requestMeasure()
  // 主题每次注入都可能改写 <head> 里 <style> 的内容，把字体覆盖再挪到最后
  reapplyTypography()
})

// 字号一变，CM6 的行高/行宽全变；不给它重测，点击坐标会按旧高度表反查（同主题那个坑）
window.addEventListener(FONT_APPLIED_EVENT, () => {
  editor?.view?.requestMeasure()
})

/**
 * 行为偏好变化（行号 / 自动换行 / 首行缩进 / 状态栏 / 缩放）。
 *
 * 这几项都会改变**行的几何尺寸**：自动换行让一行变高、行号多一条左内边距、
 * 状态栏隐藏让可视区高 26px。CM6 的高度表不会自己知道 CSS 变了，必须重测，
 * 否则点击落错行 —— 和主题异步注入是同一个坑（README「光标落错行」）。
 */
window.addEventListener(PREFS_CHANGED, () => {
  editor?.view?.requestMeasure()
  if (!getPrefs().autosave) {
    // 关掉自动保存：把**已经排上**的那一轮撤掉。
    // 只在 scheduleSave() 里判断是不够的 —— 那个函数要等下一次敲键才被调用，
    // 撤销就晚了一步，用户看到的是「刚关掉它又自己存了一次」。
    if (saveTimer !== null) {
      window.clearTimeout(saveTimer)
      saveTimer = null
    }
    return
  }
  // 刚把自动保存打开，而手头正有未落盘的改动：立刻补排一次。
  // 不补的话这份改动要等下一次敲键才会保存 —— 用户刚点开开关、关掉窗口，
  // 结果还是弹「有未保存的修改」，开关像是没生效。
  if (dirty) scheduleSave()
})

/**
 * Ctrl + 滚轮缩放（对齐 Typora 的「按住 Ctrl 使用鼠标滚轮缩放」）。
 *
 * 挂在 window capture 上并 preventDefault：Chromium 自己也认 Ctrl+滚轮，
 * 不拦的话会先被内置缩放处理一次，我们再叠一次，一次滚动跳两级。
 * 步进 10%，和面板下拉的档位一致，这样滚出来的值在下拉里能对上。
 */
window.addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey) return
    e.preventDefault()
    const cur = getPrefs().zoom
    const step = e.deltaY < 0 ? 0.1 : -0.1
    const next = Math.min(1.5, Math.max(0.8, Math.round((cur + step) * 100) / 100))
    if (next !== cur) void savePrefs({ zoom: next })
  },
  { capture: true, passive: false }
)

/** 主题切换：翻译 → 注入 → 状态栏报账 */
async function switchTheme(name: string): Promise<void> {
  if (!name || name === BUILTIN_DARK) {
    await applyTheme(name)
    // mermaid 的 SVG 把颜色烤在属性里，换主题必须让它们整批重渲染
    invalidateMermaidCache(editor?.view)
    setMetaStatus(name === BUILTIN_DARK ? '内置样式 · 深色' : '内置样式 · 浅色')
    return
  }
  setMetaStatus(`正在翻译主题 ${name} …`)
  try {
    const result = await applyTheme(name)
    if (!result) return
    invalidateMermaidCache(editor?.view)
    const r = currentThemeReport()
    const bits = [
      `应用 ${r?.kept ?? 0} 条`,
      `丢弃 ${r?.dropped ?? 0} 条`,
      `字体 ${r?.fontFaces ?? 0}`,
      `内联 ${r?.sources.length ?? 0} 文件`,
    ]
    if (r && r.warnings.length > 0) bits.push(`警告 ${r.warnings.length}`)
    setMetaStatus(`主题 ${name.replace(/\.css$/i, '')} · ${bits.join(' · ')}`)
    // 报告明细留给控制台，排查时看这里
    console.info('[简牍] 主题翻译报告', r)
  } catch (err) {
    setMetaStatus(`主题翻译失败：${(err as Error).message}`)
    console.error('[简牍] 主题翻译失败', err)
  }
}

elTheme.addEventListener('change', () => {
  const name = elTheme.value
  void window.api.setCurrentTheme(name)
  void switchTheme(name)
})

// 主题文件在 Typora 里被改了一行 → 这里自动重翻译（400ms 防抖在主进程做）
window.api.onThemeChanged(() => {
  const name = elTheme.value
  // 两个内置档没有主题文件，没有「被改」这回事
  if (!name || name === BUILTIN_DARK) return
  void (async () => {
    try {
      await reloadTheme(name)
      setMetaStatus(`主题 ${name.replace(/\.css$/i, '')} 已热重载`)
    } catch (err) {
      setMetaStatus(`主题热重载失败：${(err as Error).message}`)
    }
  })()
})

// ------------------------------------------------------------------ 外部改动通知

/**
 * 笔记库里的 .md 被外部改了（Typora / Obsidian / git / 网盘同步）。
 *
 * 三件事，优先级从高到低：
 *   1. **有未保存改动**：什么都不动，只提示。自动重载会把用户正在写的东西冲掉。
 *   2. 没有改动、但磁盘上这篇变了 → 自动重载（这是最常见的情况：你在 Typora 里改了、切回来）
 *   3. 一直重画文件树（增删改名都能看见）
 *
 * 注意「磁盘上这篇变了」的判定用的是 mtime，和 writeNote 的冲突检测同源 ——
 * 两边标准必须一致，否则会出现「这边说没变、保存时又说冲突」的矛盾现象。
 */
let libRefreshTimer: number | null = null
window.api.onLibraryChanged(() => {
  // 主进程已经防抖过 500ms，这里再收一道：避免一次保存引发多轮重画
  if (libRefreshTimer !== null) window.clearTimeout(libRefreshTimer)
  libRefreshTimer = window.setTimeout(() => {
    libRefreshTimer = null
    void (async () => {
      if (!libRoot) return
      // 1) 文件树重画。自己刚写完盘的那几秒跳过 —— 树的结构没变，
      //    重画只会把滚动位置和折叠状态清掉（见 selfSaveAt）
      if (Date.now() - selfSaveAt > 2000) {
        try {
          // 外部增删改名之后，扁平缓存里的路径可能已经失效，整份作废再重画
          flatCache = null
          await paintFilePanel()
        } catch {
          /* 库可能被拔掉了（U 盘）或改名了，静默忽略 */
        }
      }

      if (!current) return

      // 2) 当前这篇变了没有？
      let onDisk: NoteDoc
      try {
        onDisk = await window.api.readNote(current.path)
      } catch {
        // 文件被删了/改名了：不要把它从编辑器里抢走（用户可能正看着），只提示
        setMetaStatus('⚠ 当前笔记已被删除或改名（编辑器里还留着内容）')
        return
      }
      // mtime 用同一个容差（1ms 级抖动不算变，见 main/lossless.ts）
      const changed = Math.abs(onDisk.mtimeMs - current.mtimeMs) > 1
      if (!changed) return

      if (dirty) {
        // 有未保存改动 → **绝不自动覆盖**。只提示，让 Ctrl+S 时的冲突框去处理。
        setMetaStatus('⚠ 这篇在别处被修改了；你有未保存的改动，保存时会问你怎么处理')
        return
      }

      // 没有改动 → 直接同步成磁盘上的版本（保住光标附近的位置没意义，内容变了）
      const prevPath = current.path
      current = onDisk
      setDirty(false)
      if (editor) {
        editor.setDoc(onDisk.text, dirNameOf(prevPath))
        editor.setReadOnly(onDisk.validUtf8 === false)
        // setDoc 走的是 `EditorState.create`，所有 StateField 都归零 ——
        // 源码模式会跟着掉回 false，而模块变量 sourceMode 还是 true。
        // 不补这一句的话，表现是：开着源码模式时别的程序存了一次文件，
        // 源码模式就悄悄关了；更别扭的是变量和实际状态脱节，
        // 再按一次 Ctrl+/ 会显示「已回到渲染模式」但其实什么都没变（得按两次）。
        // openNote 里早就有同样的补丁，这条同步路径是漏网的那一个。
        if (sourceMode) editor.view.dispatch({ effects: setSourceMode.of(true) })
      }
      rebuildOutline()
      renderWordCount()
      tablePanel?.refresh()
      setMetaStatus('已同步外部修改')
    })()
  }, 120)
})

// ------------------------------------------------------------------ PDF 导出

/** Windows 绝对路径 → file:// URL（盘符那一段不能编码，否则 `E:` 会变成 `E%3A`） */
function toFileUrl(absPath: string): string {
  const parts = absPath.replace(/\\/g, '/').split('/')
  return 'file:///' + parts.map((s, i) => (i === 0 ? s : encodeURIComponent(s))).join('/')
}

/** 把 `<img src="相对路径">` 换成绝对 file://：打印页在临时目录里，相对路径找不到图 */
function absolutizeImages(html: string, baseDir: string): string {
  const dir = baseDir.replace(/\\/g, '/').replace(/\/+$/, '')
  return html.replace(
    /(<img\b[^>]*\bsrc=")([^"]*)(")/g,
    (whole, pre: string, src: string, post: string) => {
      if (!src || /^(https?:|data:|file:)/i.test(src)) return whole
      let decoded = src
      try {
        decoded = decodeURIComponent(src)
      } catch {
        /* 路径里有裸 % 之类，按原样用 */
      }
      const abs =
        /^[a-zA-Z]:/.test(decoded) || decoded.startsWith('/')
          ? decoded
          : `${dir}/${decoded.replace(/^\.\//, '')}`
      return pre + toFileUrl(abs) + post
    }
  )
}

function escapeForHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * 导出 PDF。
 *
 * **不走 pandoc**：本机根本没装（策划案里"本机已装 pandoc"那句话已经过期），
 * 而让用户为了导出去装一个外部二进制不合适。
 * 改成 `markdownToHtml()` 用**编辑器同一个 Lezer parser** 生成 HTML，
 * 套上当前主题的翻译结果，交给隐藏窗口 `printToPDF` —— 纸面和屏幕是同一套样式。
 *
 * ```mermaid 会被换成真图（`inlineMermaidSvgs`）：以前这里明确是代码块，
 * 因为图只活在 CM6 的 widget 缓存里、导出的静态 HTML 拿不到。现在导出前
 * 先把它们渲染成 SVG 内联进去；渲染失败仍保留代码块，至少内容还在。
 */
async function exportPdf(): Promise<void> {
  if (!current || !editor) return
  setMetaStatus('正在生成 PDF…')
  try {
    const doc = editor.getDoc()
    const baseDir = dirNameOf(current.path)
    // 顺序：md → html → mermaid 换图 → 图片绝对化。
    // mermaid 必须在图片绝对化之前做：它只关心代码块，但反过来
    // absolutizeImages 会遍历所有 <img>，对 SVG 里的没影响 —— 顺序其实无所谓，
    // 这里放在前面是为了让 mermaid 失败时的代码块也能正常导出图片。
    const body = absolutizeImages(await inlineMermaidSvgs(markdownToHtml(doc), doc), baseDir)
    const title = escapeForHtml(current.path.split(/[\\/]/).pop() ?? '导出')
    const css = currentThemeCss()
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${title}</title>
<style>${css}</style>
<style>
  html { background: #fff; }
  body { margin: 0; }
  /* 打印时不要屏幕那套「限宽 90% + 居中」，纸面宽度交给 @page */
  #write { max-width: none !important; width: auto !important; margin: 0 !important; padding: 0 !important; }
  .jd-h1, .jd-h2, .jd-h3, .jd-h4, .jd-h5, .jd-h6 { break-after: avoid; }
  pre, table, blockquote, .jd-mermaid, img { break-inside: avoid; }
  @page { margin: 16mm 14mm; }
</style></head>
<body class="jd-content"><div id="write">${body}</div></body></html>`

    const res = await window.api.exportPdf(html, current.path.replace(/\.md$/i, '') + '.pdf')
    if (res.canceled) {
      setMetaStatus('已取消导出')
      return
    }
    setMetaStatus(res.ok ? 'PDF 已导出' : `导出失败：${res.error ?? '未知错误'}`)
    if (!res.ok) window.alert(`导出 PDF 失败：\n${res.error ?? '未知错误'}`)
  } catch (err) {
    const msg = (err as Error).message
    setMetaStatus(`导出失败：${msg}`)
    window.alert(`导出 PDF 失败：\n${msg}`)
  }
}

// ------------------------------------------------------------------ 菜单命令

/**
 * 执行一条命令。
 *
 * 有两个入口会调它：菜单（含菜单 accelerator 触发）和渲染层的快捷键监听
 * （keybindings.ts）。同一命令两条路径都指向这里，行为不会分叉。
 *
 * 60ms 去重：这两条路径谁先谁后取决于 Electron 内部时机，个别组合可能两边都
 * 收到。不拦一下的话「加粗」会把选区裹两层 `****`。人手不可能 60ms 内按两次同一个键。
 */
const lastRun = new Map<string, number>()

/**
 * 菜单「链接操作」的两个动作。
 *
 * 复制走剪贴板 API（不需要主进程），打开走 `app:openExternal` —— 那边只放行
 * http/https/mailto，`shell.openExternal` 对 `file:` / 自定义协议等于让笔记内容
 * 去启动本机程序，不能放行。
 */
async function actOnLink(action: 'open' | 'copy'): Promise<void> {
  if (!editor) return
  const hit = linkAtCursor(editor.view)
  if (!hit || !hit.url) {
    setMetaStatus('光标不在链接里')
    return
  }
  if (action === 'copy') {
    try {
      await navigator.clipboard.writeText(hit.url)
      setMetaStatus(`已复制链接地址：${hit.url}`)
    } catch {
      setMetaStatus('复制失败：剪贴板不可用')
    }
    return
  }
  const err = await window.api.openExternal(hit.url)
  setMetaStatus(err ? `打不开链接：${err}` : `已用系统默认程序打开：${hit.url}`)
}

/**
 * 菜单「图像 → 插入本地图片…」。
 *
 * 用一个临时的 `<input type=file>` 取文件，拿到 File 之后走的是**粘贴图片那条
 * 同一条路**（`handleImage`：大小上限 → 存进 .assets → 插入 `![](相对路径)`）。
 * 另写一套复制/落盘逻辑必然和粘贴行为分叉。
 */
async function pickImageFile(): Promise<void> {
  if (!current) return
  if (current.validUtf8 === false) {
    setMetaStatus('这篇不是 UTF-8 编码，只读 —— 先转码后再插图')
    return
  }
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'image/*'
  input.addEventListener('change', () => {
    const f = input.files?.[0]
    if (f) void handleImage(f)
  })
  input.click()
}

/**
 * 警告框（Typora 的 `> [!NOTE]` 语法，GitHub / Obsidian 也是这一套）。
 *
 * 为什么用 `> [!NOTE]` 而不是 Typora 自己那套 `::: note`：待办里备注过，
 * `> [!TYPE]` 是纯引用 + 一行标记，**不做渲染时也还是合法 markdown**（就是一个引用块），
 * 而 `:::` 容器不认它的渲染器会把它当普通文字显示出来。纯文本是唯一真源，
 * 所以选退一步也能看的那种。
 */
const ADMONITION_TYPES = new Set(['note', 'tip', 'important', 'warning', 'caution'])

function admonitionBlock(type: string): string {
  const t = ADMONITION_TYPES.has(type) ? type : 'note'
  return `> [!${t.toUpperCase()}]\n> `
}

export function runCommand(cmd: string): void {
  const now = performance.now()
  if (now - (lastRun.get(cmd) ?? 0) < 60) return
  lastRun.set(cmd, now)

  const ed = editor

  // 警告框是一组命令（admonition:note / tip / …），菜单里五个按钮共用这一条路径。
  // 裸 `admonition` 也要认：快捷键面板里那一行（可以自己绑键）发出来的就是它，
  // 不认的话用户绑了键按下去毫无反应。
  if (cmd === 'admonition' || cmd.startsWith('admonition:')) {
    const type = cmd.startsWith('admonition:') ? cmd.slice('admonition:'.length) : 'note'
    if (ed) insertBlock(ed.view, admonitionBlock(type))
    return
  }

  switch (cmd) {
    case 'open-library':
      elOpenLib.click()
      return
    case 'save':
      void doSave()
      return
    case 'find':
      // CM6 的搜索面板必须用命令打开（openSearchPanel），
      // 光 focus 编辑器什么都不会发生 —— 之前这里就是空操作。
      if (ed) openSearch(ed.view)
      return
    case 'save-then-close':
      void (async () => {
        // 副窗口版本的「保存并关闭」：存完只关这个窗口，不退整个应用。
        // 逻辑与 save-then-quit 相同，只是最后一步换成 window.close()。
        for (let i = 0; i < 20; i++) {
          if (saving) {
            await new Promise<void>((r) => window.setTimeout(r, 100))
            continue
          }
          const saved = await doSave()
          if (saved) window.close()
          return
        }
        setMetaStatus('写盘耗时过长，「保存并关闭」已取消 —— 请稍后再试')
      })()
      return
    case 'save-then-quit':
      void (async () => {
        // 只有真的写到盘上才退出。存不下去（冲突取消 / 编码被拒 / 写盘失败）
        // 就留在窗口里 —— 「保存并关闭」的结果不能是"没保存也关掉"。
        //
        // 正在写盘的那一轮 doSave 会返回 false（它还没落盘），这时不能直接
        // 放弃，否则「保存并关闭」看起来像什么都没发生。等它写完再走一遍。
        for (let i = 0; i < 20; i++) {
          if (saving) {
            await new Promise<void>((r) => window.setTimeout(r, 100))
            continue
          }
          const saved = await doSave()
          if (saved) window.api.quitNow()
          return
        }
        setMetaStatus('写盘耗时过长，「保存并关闭」已取消 —— 请稍后再试')
      })()
      return
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      if (ed) setHeading(ed.view, Number(cmd.slice(1)))
      return
    case 'p':
      if (ed) setHeading(ed.view, 0)
      return
    // ---- 段落（4.3.0）：块级操作。行内样式在「格式」，这里只改块前缀 ----
    case 'promote-heading':
      // 提升 = 级别数字变小（H2 → H1），所以是 -1
      if (ed && !changeHeadingLevelForSelection(ed.view, -1)) {
        setMetaStatus('提升标题级别：光标不在标题行')
      }
      return
    case 'demote-heading':
      if (ed && !changeHeadingLevelForSelection(ed.view, 1)) {
        setMetaStatus('降低标题级别：光标不在标题行')
      }
      return
    case 'quote':
      if (ed) setBlockKindForSelection(ed.view, 'quote')
      return
    case 'ol':
      if (ed) setBlockKindForSelection(ed.view, 'ol')
      return
    case 'ul':
      if (ed) setBlockKindForSelection(ed.view, 'ul')
      return
    case 'task-list':
      if (ed) setBlockKindForSelection(ed.view, 'task')
      return
    case 'math-block':
      // `$$\n\n$$`，光标落在两块 `$$` 中间的空行上
      if (ed) insertBlock(ed.view, '$$\n\n$$', 3)
      return
    case 'table':
      // 两列：表头 / 分隔行 / 一行空数据。光标落在第一个表头单元格里（`| ` 之后）
      if (ed) insertBlock(ed.view, '|     |     |\n| --- | --- |\n|     |     |', 2)
      return
    case 'table-row-below':
      if (ed && !insertTableRowBelow(ed.view)) setMetaStatus('光标不在表格里')
      return
    case 'table-remove':
      if (ed && !removeTableBlock(ed.view)) setMetaStatus('光标不在表格里')
      return
    case 'align-left':
    case 'align-center':
    case 'align-right':
    case 'align-default': {
      // 命令名就是对齐值的来源：align-default → null（不加冒号 = 默认对齐）
      const align = cmd === 'align-default' ? null : (cmd.slice('align-'.length) as 'left' | 'center' | 'right')
      if (ed && !alignTableColumn(ed.view, align)) setMetaStatus('光标不在表格里（对齐按「当前列」生效）')
      return
    }
    case 'hr':
      // 用 `***` 不用 `---`：`---` 紧跟在段落下一行会被解析成 setext 二级标题
      if (ed) insertBlock(ed.view, '***')
      return
    case 'toc':
      if (ed) insertBlock(ed.view, '[TOC]')
      return
    case 'footnote':
      // `[^1]: 内容`，光标落在冒号后面；编号让用户自己改（我们不做脚注重排）
      if (ed) insertBlock(ed.view, '[^1]: ', 6)
      return
    case 'ref-link':
      // `[ref]: https://`，光标落在方括号里改名
      if (ed) insertBlock(ed.view, '[ref]: https://', 1)
      return
    case 'front-matter':
      // 光标落在 `title: ` 冒号后面（11 = `---\ntitle: ` 的长度）
      if (ed) insertBlock(ed.view, '---\ntitle: \n---', 11)
      return
    case 'paragraph-above':
      if (ed) insertSiblingParagraph(ed.view, 'above')
      return
    case 'paragraph-below':
      if (ed) insertSiblingParagraph(ed.view, 'below')
      return
    case 'task-done':
      if (ed && !setTaskStateForSelection(ed.view, true)) setMetaStatus('光标不在任务列表项里')
      return
    case 'task-todo':
      if (ed && !setTaskStateForSelection(ed.view, false)) setMetaStatus('光标不在任务列表项里')
      return
    case 'indent-more':
      if (ed && !indentListForSelection(ed.view, 1, getPrefs().indentWidth)) setMetaStatus('增加缩进：光标不在列表行（引用和正文不缩进）')
      return
    case 'indent-less':
      if (ed && !indentListForSelection(ed.view, -1, getPrefs().indentWidth)) setMetaStatus('减少缩进：光标不在列表行（引用和正文不缩进）')
      return
    case 'bold':
      if (ed) wrapSelection(ed.view, '**')
      return
    case 'italic':
      if (ed) wrapSelection(ed.view, '*')
      return
    case 'code':
      if (ed) wrapSelection(ed.view, '`')
      return
    case 'codeblock':
      if (ed) insertCodeBlock(ed.view, getPrefs().codeDefaultLang)
      return
    case 'underline':
      // markdown 没有下划线语法，Typora 用 <u>；渲染层会把标签藏掉只留下划线
      if (ed) wrapSelectionPair(ed.view, '<u>', '</u>', '下划线文字')
      return
    case 'strikethrough':
      if (ed) wrapSelection(ed.view, '~~')
      return
    case 'highlight':
      if (ed) wrapSelection(ed.view, '==')
      return
    case 'comment':
      if (ed) wrapSelectionPair(ed.view, '<!-- ', ' -->', '注释')
      return
    case 'link':
      if (ed) insertLink(ed.view)
      return
    case 'clear-format':
      if (ed && !clearInlineMarks(ed.view)) setMetaStatus('这里没有可清除的行内样式')
      return
    case 'link-open':
      void actOnLink('open')
      return
    case 'link-copy':
      void actOnLink('copy')
      return
    case 'link-remove':
      if (ed && !removeLinkAt(ed.view)) setMetaStatus('光标不在链接里')
      return
    case 'image-insert':
      void pickImageFile()
      return
    case 'focus-mode':
      setViewModes({ focus: !focusMode })
      return
    case 'typewriter-mode':
      setViewModes({ typewriter: !typewriterMode })
      return
    case 'source-mode':
      toggleSourceMode()
      return
    case 'export-pdf':
      void exportPdf()
      return
    case 'settings':
      void openSettings()
      return
    case 'prefs':
      void openPrefs()
      return
    case 'theme-report':
      openThemeReport()
      return
  }
}

window.api.onMenu(runCommand)

// 渲染层自己的快捷键分发：菜单 accelerator 会被 CM6 抢，见 keybindings.ts 的说明
installKeybindings(runCommand)

// 右键格式条：选中文本后右键就地改样式，按钮全部转发给 runCommand（与菜单同源）
installFormatBar({
  getView: () => editor?.view ?? null,
  run: runCommand,
  notify: (msg) => setMetaStatus(msg),
})

// ------------------------------------------------------------------ 启动

void (async () => {
  setupSidebarResize()
  tablePanel = installTablePanel({
    el: $('jd-table-panel'),
    getView: () => editor?.view ?? null,
    onStatus: setMetaStatus,
  })

  // 这几件事**互不依赖**，一次全发出去并发等。
  //
  // 原来是 6 个 `await` 串着走：每个 IPC 往返都要过一次主进程，实测这一段 25~30ms，
  // 其中大部分时间是"排队"而不是"干活"。串行还带来一个次生问题：
  // 主题、库路径、草稿三条链路谁都等谁，慢的那个拖住全部。
  const restoreJob = restoreSidebarWidth()
  // 偏好先读：`applyPrefs()` 要往 #write / body 上挂 class，晚了会出现
  // 「打开软件先闪一下无行号的代码块，再跳成有行号」。它和下面几个 IPC 并发。
  const prefsJob = loadPrefs()
  const [libRoot, savedTheme, lastFile, draft, startupError, autosaveRaw] = await Promise.all([
    window.api.getLibrary().catch((): string | null => null),
    window.api.getCurrentTheme().catch(() => ''),
    window.api.getLastFile().catch(() => ''),
    // 先把草稿读出来拿在手上：下面 openNote 会清 draft.json（换文件的正常行为），
    // 那份草稿就再也回不来了。读到之后由 pendingDraft 替它挡着。
    window.api.getDraft().catch((err: unknown): CrashDraft | null => {
      console.warn('[简牍] 读取崩溃草稿失败：', err)
      return null
    }),
    // 配置文件读坏时下面会**接住但不显示**：启动流程后面还有好几次 setMetaStatus
    //（loadThemes → switchTheme 的「内置样式 · 深色」/「主题 xxx · 应用 N 条」），
    // 当场说的话两三行之后就被盖掉。放到启动末尾再报才是屏幕上真能读到的那句。
    window.api.getConfigError().catch(() => ''),
    window.api.getAutosaveMs().catch(() => Number.NaN),
  ])
  await restoreJob
  await prefsJob
  bootMark('并发读配置')
  // 自动保存防抖：读失败/越界由主进程夹好，这里兜一层默认值
  if (Number.isFinite(autosaveRaw) && autosaveRaw >= 100) autosaveMs = autosaveRaw

  // 文件树先发出去，但**不挡开笔记**：它只读一层（默认全收起），正文才是用户最想看到的。
  // 两个任务并行，谁先好谁先上屏。
  const treeJob = libRoot ? loadLibrary(libRoot) : null

  await loadThemes(savedTheme)
  bootMark('列主题')
  // 先注入主题，再打开笔记：否则 setDoc 用兜底样式测量，主题异步注入后行高变了
  // 却没触发 CM6 重测，第一次点击光标会落到错行（见 THEME_APPLIED_EVENT 监听器注释）。
  if (elTheme.value) await switchTheme(elTheme.value)
  bootMark('应用主题')
  // 字体/字号覆盖必须排在主题之后应用：两者都是 `#write{…}`（1,0,0），
  // 同特异性只比先后 —— 顺序反了就被主题压回去（见 typography.ts 的说明）。
  await loadAndApplyTypography()
  bootMark('字体字号')

  if (libRoot) {
    // 打开上次那篇 —— 不再等用户点恢复条（那样条子一挂着，笔记永远打不开）。
    // 用 normPath 比较分隔符与大小写，别直接 startsWith（见 normPath 的注释）。
    const inside = (p: string): boolean => normPath(p).startsWith(normPath(libRoot))
    // 副窗口（右键「在新窗口中打开」）要打开的是**指定的那篇**，
    // 不能按 lastFile 走 —— 否则新窗口里显示的是主窗口正看的那篇，等于白开
    const bootFile = new URLSearchParams(location.search).get('file')
    // 草稿那篇通常就是用户最后在看的（lastFile 可能落后一步），优先它
    const target =
      bootFile && inside(bootFile)
        ? bootFile
          : draft && inside(draft.path)
            ? draft.path
            : // 「启动时打开上次那篇」可以关掉：有人习惯每次从空白开始。
              // 草稿那篇不受开关影响 —— 那是「有没存完的东西」，性质不同。
              lastFile && inside(lastFile) && getPrefs().restoreLastFile
              ? lastFile
              : ''
    if (target) {
      try {
        await openNote(target)
      } catch (err) {
        // 文件可能被删/改名了，静默停在文件树即可；但要留一行日志，
        // 否则「启动后没打开上次那篇」只能靠猜（2026-11-11 排查过一次）。
        console.warn('[简牍] 恢复上次打开的文件失败：', err)
      }
    }
    bootMark('打开笔记')
    if (treeJob) {
      try {
        await treeJob
      } catch (err) {
        console.warn('[简牍] 文件树加载失败：', err)
      }
    }
    bootMark('文件树就绪')
    // 笔记已经打开，再把恢复条挂上去（非阻塞，点不点都不影响使用）
    if (draft) offerCrashRecovery(draft)
  } else {
    setMetaStatus('未打开笔记库')
  }
  // 启动期的配置错误放到**最后**说：它是唯一一句「为什么文件树空了」的解释，
  // 一旦被主题报账盖掉，用户就只剩困惑。
  if (startupError) setMetaStatus(`⚠ ${startupError}`)
  bootMark('启动完成')
  // 首帧：所有 await 都结束不代表画完了，这一帧画出来用户才真的看见内容
  requestAnimationFrame(() => bootMark('首帧'))
  ;(window as unknown as Record<string, unknown>)['__jdBootTimings'] = bootTimings
})()

// 兜底：正常关窗路径走主进程的「保存并关闭」，这里只处理页面级刷新。
// 注意不能在这里 await 写盘 —— 页面卸载时异步操作跑不完，等于没保护。
window.addEventListener('beforeunload', () => {
  if (!dirty) return
  // 只来得及把草稿塞进同步路径；真正的保护在主进程 close 事件里
  if (current && editor) void window.api.saveDraft(current.path, editor.getDoc())
})

/**
 * 自动化钩子：让 CDP / DevTools 能直接打开设置面板。
 *
 * 系统菜单是主进程画的，CDP 点不到「设置 → 快捷键…」那一项；
 * 没有这个入口，设置面板的整条链路（读配置 → 渲染 → 录制 → 写回）
 * 就只能在测试里靠人工点。挂出来的只是「打开面板」这一个动作，没有额外权限。
 */
;(window as unknown as Record<string, unknown>)['__jdOpenSettings'] = openSettings
;(window as unknown as Record<string, unknown>)['__jdOpenPrefs'] = openPrefs
// 菜单是主进程画的，CDP 点不到「格式 → 下划线」这类项；没有这个钩子，每条命令
// 都只能靠人手按快捷键去验。它只转发到 runCommand，也就是菜单走的同一条路径。
;(window as unknown as Record<string, unknown>)['__jdRun'] = runCommand
