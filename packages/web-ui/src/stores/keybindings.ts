import { reactive } from "vue";
import type { AidKey } from "@as400web/core";

/** キーコンボ文字列（例 "ctrl+3", "shift+F1", "Enter"）を正規化して作る */
export function comboOf(ev: { key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): string {
  const parts: string[] = [];
  if (ev.ctrlKey) parts.push("ctrl");
  if (ev.altKey) parts.push("alt");
  if (ev.shiftKey) parts.push("shift");
  parts.push(ev.key.length === 1 ? ev.key.toLowerCase() : ev.key);
  return parts.join("+");
}

const KEY = "as400.keybindings";

/**
 * 割当先。AID キー（ホストへ送る）のほか、`view:<項目>` で**表示設定の順送り**も割り当てられる
 * （例 "view:surface"）。旧データは AID 文字列のみなのでそのまま読める。
 */
export type BindingTarget = AidKey | `view:${string}`;
/** 表示設定の順送り割当か。 */
export function isViewBinding(t: string): t is `view:${string}` {
  return t.startsWith("view:");
}
/** `view:surface` → `surface` */
export function viewKeyOf(t: string): string {
  return t.slice("view:".length);
}

function load(): Record<string, BindingTarget> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, BindingTarget>) : {};
  } catch {
    return {};
  }
}

export const keybindingsStore = reactive({
  /** カスタムキーコンボ → 割当先（AID キー or 表示設定の順送り）。既定マッピングより優先 */
  bindings: load() as Record<string, BindingTarget>,

  set(combo: string, target: BindingTarget): void {
    this.bindings[combo] = target;
    this.persist();
  },
  remove(combo: string): void {
    delete this.bindings[combo];
    this.persist();
  },
  reset(): void {
    for (const k of Object.keys(this.bindings)) delete this.bindings[k];
    this.persist();
  },
  /** イベントに対応するカスタム割当先を返す（無ければ undefined） */
  resolve(ev: { key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): BindingTarget | undefined {
    return this.bindings[comboOf(ev)];
  },
  persist(): void {
    if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(this.bindings));
  }
});
