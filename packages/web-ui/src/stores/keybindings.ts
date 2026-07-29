import { reactive } from "vue";
import type { AidKey } from "@as400web/core";
import type { LocalEditAction } from "../composables/useKeymap.js";

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
 * 割当先。AID キー（ホストへ送る）のほか、`view:<項目>` で**表示設定の順送り**、
 * `macro:<id>` で**マクロの再生**、`local:<操作>` で**ローカル編集キー**（Field Exit 等）も
 * 割り当てられる（例 "view:surface" / "macro:m-1" / "local:field-exit"）。
 * 旧データは AID 文字列のみなのでそのまま読める。
 *
 * `view:` / `macro:` / `local:` はいずれも**ホストへ送らない**ローカル処理
 * （`useKeymap.ts` で分岐する）。
 */
export type BindingTarget = AidKey | `view:${string}` | `macro:${string}` | `local:${LocalEditAction}`;
/** 表示設定の順送り割当か。 */
export function isViewBinding(t: string): t is `view:${string}` {
  return t.startsWith("view:");
}
/** `view:surface` → `surface` */
export function viewKeyOf(t: string): string {
  return t.slice("view:".length);
}
/** マクロ再生の割当か（ACS の「マクロをキーに割り当てる」相当。spec D10）。 */
export function isMacroBinding(t: string): t is `macro:${string}` {
  return t.startsWith("macro:");
}
/** `macro:m-1` → `m-1` */
export function macroIdOf(t: string): string {
  return t.slice("macro:".length);
}
/** ローカル編集キー（Field Exit / Erase EOF / Erase Input）の割当か。ホストへは送らない。 */
export function isLocalBinding(t: string): t is `local:${LocalEditAction}` {
  return t.startsWith("local:");
}
/** `local:field-exit` → `field-exit` */
export function localActionOf(t: string): LocalEditAction {
  return t.slice("local:".length) as LocalEditAction;
}

/**
 * **版ごとに「その版で追加した既定」だけ**を持つ。保存済みデータへ混ぜるときは差分だけを足す。
 *
 * 全既定を毎回混ぜ直すと、**利用者が消した既定まで復活する**（下の「消したら消えたまま」を破る）。
 * 実際、既定を 1 つ足すために版を上げると既存利用者の削除が巻き戻る作りになっていた。
 */
const ADDED_BY_VERSION: Record<number, Record<string, BindingTarget>> = {
  1: {
    "ctrl+F1": "view:kana", // 表示コード（自動 → カナ → 英）
    "ctrl+F3": "view:sosi" // SO/SI 表示 ⇄ 非表示
  },
  2: {
    // ローカル編集キー。ブラウザ既定（単語削除・履歴戻る）は捕捉時に preventDefault で抑える
    "ctrl+Enter": "local:field-exit",
    "ctrl+Delete": "local:erase-eof",
    "ctrl+Backspace": "local:erase-input"
  },
  3: {
    // 符号確定と Dup。実機は数値キーパッドの `-` / `+` / Dup キーだが PC には無いので
    // 既存のローカル編集キーと同じ ctrl 系で揃える。ブラウザ既定（拡大縮小・ブックマーク）は
    // 捕捉時に preventDefault で抑える
    "ctrl+-": "local:field-minus",
    // **`+` は数値キーパッドなら単独、メイン行なら Shift 併用**でコンボ名が変わる
    // （`comboOf` は shift も名前に入れる）。実機の Field+ は数値キーパッドの `+` なので
    // `ctrl++` が本命だが、キーパッドの無い機械でも押せるよう両方を既定にする
    "ctrl++": "local:field-plus",
    "ctrl+shift++": "local:field-plus",
    "ctrl+d": "local:dup"
  }
};

/**
 * 出荷時の既定バインド（全版の合算）。ACS で使い慣れた操作を最初から使えるようにする。
 * **消したら消えたまま**（下の load / persist 参照）。「初期設定に戻す」で復元できる。
 */
export const DEFAULT_BINDINGS: Record<string, BindingTarget> = Object.assign(
  {},
  ...Object.values(ADDED_BY_VERSION)
) as Record<string, BindingTarget>;

// 既定バインドの版。保存済みデータへ「増えた分だけ」混ぜるための印。
const VERSION_KEY = "as400.keybindings.version";
/** いまの既定バインドの版。**テストが版番号を直書きしないよう公開する**
 *  （直書きすると既定を 1 つ足して版を上げるたびに無関係なテストが落ちる）。 */
export const BINDINGS_VERSION = Math.max(...Object.keys(ADDED_BY_VERSION).map(Number));
const VERSION = BINDINGS_VERSION;

function load(): Record<string, BindingTarget> {
  if (typeof localStorage === "undefined") return { ...DEFAULT_BINDINGS };
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return { ...DEFAULT_BINDINGS }; // 初回起動
    const saved = JSON.parse(raw) as Record<string, BindingTarget>;
    const savedVersion = Number(localStorage.getItem(VERSION_KEY) ?? 0);
    if (savedVersion < VERSION) {
      // **保存済み版より後に追加された既定だけ**を足す（以前から在った既定は、
      // 消されていれば消えたまま）。保存済みの割り当てが優先＝同じキーを別用途に
      // 使っていても奪わない。
      const added: Record<string, BindingTarget> = {};
      for (let v = savedVersion + 1; v <= VERSION; v++) Object.assign(added, ADDED_BY_VERSION[v] ?? {});
      const merged = { ...added, ...saved };
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
