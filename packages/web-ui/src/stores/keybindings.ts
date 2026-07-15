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

function load(): Record<string, AidKey> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, AidKey>) : {};
  } catch {
    return {};
  }
}

export const keybindingsStore = reactive({
  /** カスタムキーコンボ → AID キー（既定マッピングより優先） */
  bindings: load() as Record<string, AidKey>,

  set(combo: string, aid: AidKey): void {
    this.bindings[combo] = aid;
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
  /** イベントに対応するカスタム AID を返す（無ければ undefined） */
  resolve(ev: { key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): AidKey | undefined {
    return this.bindings[comboOf(ev)];
  },
  persist(): void {
    if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(this.bindings));
  }
});
