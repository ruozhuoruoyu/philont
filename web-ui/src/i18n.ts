/**
 * 轻量中英双语。
 *
 * 用法:
 *   · 内联:`t('中文', 'English')` —— 按当前语言返回其一,字符串与代码就近放,无需大字典。
 *   · 组件接入:类里加 `private lang = new LangController(this);`,语言一变就 requestUpdate 重渲染。
 *   · 切换:`toggleLang()` / `setLang('en')`,持久化到 localStorage。
 *
 * 设计:单一模块级 `current` + 监听器集合;所有挂了 LangController 的组件同步重渲染。
 */
import type { ReactiveController, ReactiveControllerHost } from 'lit';

export type Lang = 'zh' | 'en';

const STORAGE_KEY = 'philont_lang';
const listeners = new Set<() => void>();

function readInitial(): Lang {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'en' || v === 'zh') return v;
  } catch { /* localStorage 不可用时回退 */ }
  return 'zh';
}

let current: Lang = readInitial();

export function getLang(): Lang {
  return current;
}

export function setLang(lang: Lang): void {
  if (lang === current) return;
  current = lang;
  try { localStorage.setItem(STORAGE_KEY, lang); } catch { /* 忽略 */ }
  listeners.forEach((fn) => fn());
}

export function toggleLang(): void {
  setLang(current === 'zh' ? 'en' : 'zh');
}

/** 内联双语取词。 */
export function t(zh: string, en: string): string {
  return current === 'en' ? en : zh;
}

/** 双语词条对象(用于 FIELDS 等在模块加载期就构造、渲染期才取词的数据)。 */
export interface Msg { zh: string; en: string }
export function tr(m: Msg | string | undefined): string {
  if (m == null) return '';
  return typeof m === 'string' ? m : t(m.zh, m.en);
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Lit 反应式控制器:语言切换时触发宿主组件重渲染。 */
export class LangController implements ReactiveController {
  private readonly host: ReactiveControllerHost;
  private off?: () => void;
  constructor(host: ReactiveControllerHost) {
    this.host = host;
    host.addController(this);
  }
  hostConnected(): void {
    this.off = subscribe(() => this.host.requestUpdate());
  }
  hostDisconnected(): void {
    this.off?.();
    this.off = undefined;
  }
}
