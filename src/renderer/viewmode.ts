import { StateEffect, StateField, type EditorState } from '@codemirror/state'

/**
 * 源码模式（`Ctrl+/`，策划案 §3.2）。
 *
 * 只有**一个布尔值**，但它的读者有三个模块 —— 所以单独放一个文件，
 * 谁都不依赖谁，避免 markers / table / fold 之间互相 import 造成环。
 *
 *   1. `markers.ts`  不再隐藏 `# ** ` > - 1.` 这些标记，图片也不再换成 widget
 *   2. `table.ts`    不再把表格换成真 `<table>`，直接看 `| a | b |` 源码行
 *   3. `fold.ts`     不再折叠（折叠会藏内容，和"看源码"是矛盾的）
 *
 * 行级 class（`.jd-h1` / `.jd-code-block`）**保留**：Typora 的源码模式也保留排版，
 * 只是把标记露出来。这一点不改，主题下的观感才对。
 */
export const setSourceMode = StateEffect.define<boolean>()

export const sourceModeField = StateField.define<boolean>({
  create: () => false,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setSourceMode)) return e.value
    return value
  },
})

/** 给各模块读：现在是不是源码模式 */
export function isSourceMode(state: EditorState): boolean {
  return state.field(sourceModeField, false) ?? false
}
