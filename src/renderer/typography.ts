/**
 * 正文字体 / 字号的运行时覆盖（偏好设置 → 外观）。
 *
 * 为什么不能直接改主题：主题是用户从 Typora 生态拿来的 css，我们一个字都不该动。
 * 所以走「在 `<head>` 末尾追加一条 `#write{…}`」——
 *
 *   - 主题规则是 `#write{font-family:…;font-size:…}`，特异性 1,0,0；
 *   - 我们这条**同样是 1,0,0**，同特异性只比先后 → 只要排在主题 `<style>` 后面就赢；
 *   - 所以每次应用都要把 `<style id="jd-user-font">` **重新 append 到 head 末尾**
 *     （`append` 一个已存在的节点等于把它移过去）。主题切换时也要重排一次，
 *     见 main.ts 里对 `jd-theme-applied` 的处理。
 *
 * 不用 `!important`：一旦带上，用户以后想用主题自己的 `!important` 也没法翻盘，
 * 而且会把「谁赢」变成不可推理的。顺序能解决就别上 `!important`。
 *
 * 值是「空串 / 0 = 跟随主题」，不是「默认成某个字体」。写死一个默认字体等于
 * 把主题换掉了 —— 换个主题观感就散，那不是用户想要的。
 */

export const FONT_APPLIED_EVENT = 'jd-font-applied'

let current = { family: '', size: 0 }

function styleEl(): HTMLStyleElement {
  let el = document.getElementById('jd-user-font') as HTMLStyleElement | null
  if (!el) {
    el = document.createElement('style')
    el.id = 'jd-user-font'
  }
  // 每次都挪到末尾：主题的 <style> 是运行时才注入的，顺序不能假设
  document.head.append(el)
  return el
}

/** 族名带空格/中文时必须加引号，否则 CSS 解析成多个族名 */
function quoteFamily(family: string): string {
  const f = family.trim()
  if (!f) return ''
  const main = /[\s,']/.test(f) ? `"${f}"` : f
  // 再加两个兜底：用户写的字体没装时不至于退化成衬线宋体
  return `${main}, "Microsoft YaHei", "PingFang SC", sans-serif`
}

export function applyTypography(family: string, size: number): void {
  current = { family: family ?? '', size: Number(size) > 0 ? Math.round(Number(size)) : 0 }
  const el = styleEl()
  const decls: string[] = []
  const fam = quoteFamily(current.family)
  if (fam) decls.push(`font-family: ${fam};`)
  if (current.size > 0) decls.push(`font-size: ${current.size}px;`)
  // 两项都空 → 清空规则，完全交还给主题
  el.textContent = decls.length > 0 ? `#write {\n  ${decls.join('\n  ')}\n}` : ''
  // 字号一变，CM6 的行高/行宽全变 —— 必须让上层重新测量（见 main.ts）
  window.dispatchEvent(new CustomEvent(FONT_APPLIED_EVENT))
}

/** 主题刚注入完：把覆盖样式再挪到末尾，重新生效 */
export function reapplyTypography(): void {
  if (!current.family && current.size === 0) return
  applyTypography(current.family, current.size)
}

/** 启动时从配置读一次并应用 */
export async function loadAndApplyTypography(): Promise<void> {
  try {
    const f = await window.api.getFont()
    applyTypography(f.family, f.size)
  } catch {
    /* 读不到就跟随主题，不该因为字体配置挡住启动 */
  }
}
