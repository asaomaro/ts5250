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

/**
 * 出荷時の既定バインド。ACS で使い慣れた表示切り替えを最初から使えるようにする。
 * **消したら消えたまま**（下の load / persist 参照）。「初期設定に戻す」で復元できる。
 */
export const DEFAULT_BINDINGS: Record<string, BindingTarget> = {
  "ctrl+F1": "view:kana", // 半角カナ ⇄ 英
  "ctrl+F3": "view:sosi", // SO/SI 表示 ⇄ 非表示
};

// 既定バインドを導入した版。保存済みデータへ一度だけ混ぜるための印。
const VERSION_KEY = "as400.keybindings.version";
const VERSION = 1;

function load(): Record<string, BindingTarget> {
  if (typeof localStorage === "undefined") return { ...DEFAULT_BINDINGS };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return { ...DEFAULT_BINDINGS }; // 初回起動
    const saved = JSON.parse(raw) as Record<string, BindingTarget>;
    // 既定バインド導入前の保存値には一度だけ混ぜる（以後はユーザーの削除を尊重する）。
    // 保存済みの割り当てが優先＝同じキーを別用途に使っていても奪わない。
    if (Number(localStorage.getItem(VERSION_KEY) ?? 0) < VERSION) {
      const merged = { ...DEFAULT_BINDINGS, ...saved };
      localStorage.setItem(KEY, JSON.stringify(merged));
      localStorage.setItem(VERSION_KEY, String(VERSION));
      return merged;
    }
    return saved;
  } catch {
    return { ...DEFAULT_BINDINGS };
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
  /** 保存値から読み直す（= 次回起動時と同じ状態にする）。既定バインドの混ぜ込み規則もここを通る。 */
  reload(): void {
    const next = load();
    for (const k of Object.keys(this.bindings)) delete this.bindings[k];
    Object.assign(this.bindings, next);
  },
  /** カスタム分を捨てて**出荷時の既定バインドへ戻す**（空にはしない） */
  reset(): void {
    for (const k of Object.keys(this.bindings)) delete this.bindings[k];
    Object.assign(this.bindings, DEFAULT_BINDINGS);
    this.persist();
  },
  /** イベントに対応するカスタム割当先を返す（無ければ undefined） */
  resolve(ev: { key: string; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): BindingTarget | undefined {
    return this.bindings[comboOf(ev)];
  },
  persist(): void {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(KEY, JSON.stringify(this.bindings));
    // 版も一緒に印を付ける。付けないと「既定を削除 → 次回読み込みで混ぜ直されて復活」になる。
    localStorage.setItem(VERSION_KEY, String(VERSION));
  }
});
