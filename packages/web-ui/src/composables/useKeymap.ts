import type { AidKey } from "@ts5250/tn5250";
import {
  keybindingsStore,
  isViewBinding,
  viewKeyOf,
  isMacroBinding,
  macroIdOf,
  isLocalBinding,
  localActionOf
} from "../stores/keybindings.js";

/**
 * キー設定から割り当てられる**ローカル編集キー**（5250 の端末内操作。ホストへは送らない）。
 * ナビゲーション（tab / 矢印 等）は素のキーに固定なので、ここには含めない。
 */
export const LOCAL_EDIT_ACTIONS = [
  "field-exit",
  "erase-eof",
  "erase-input",
  // **符号付き数値欄で負値を入れる主経路**（実機は数値キーパッドの `-` / `+`）。
  // 打鍵の `-` / `+` も数値欄ではここへ横流しする（ScreenGrid）。
  "field-minus",
  "field-plus",
  // Dup: カーソルから欄末尾までを 0x1C で埋める（FFW の DUP_ENABLE が立つ欄だけ）
  "dup"
] as const;
export type LocalEditAction = (typeof LOCAL_EDIT_ACTIONS)[number];

export type LocalAction =
  | "home"
  | "end"
  | "tab"
  | "shift-tab"
  // Newline: 次の行の先頭から見て最初の入力欄へ移る（**ホストへは送らない**）
  | "newline"
  | "left"
  | "right"
  | "up"
  | "down"
  | "word-left"
  | "word-right"
  | "word-up"
  | "word-down"
  | LocalEditAction;

/** キーイベントを AID キー・ローカル操作・null（非対象）に分類する（純関数・テスト可能） */
export function classifyKey(ev: {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}): { aid?: AidKey; local?: LocalAction } {
  // Ctrl+矢印 = 語頭ジャンプ（ACS のカーソル頭出し。入力欄に限らず画面全体で動く）。
  // 左右は前後の語頭へ、上下は内容のある近接行の先頭語（行の頭）へ。
  // 他の修飾つき（Alt+PageUp/Down のタブ切替・Alt+矢印のペイン移動）は App 側の
  // グローバルハンドラが担うため、ここでは対象外（{} を返して素通しさせる）。
  if (ev.ctrlKey && !ev.altKey && !ev.metaKey && !ev.shiftKey) {
    if (ev.key === "ArrowLeft") return { local: "word-left" };
    if (ev.key === "ArrowRight") return { local: "word-right" };
    if (ev.key === "ArrowUp") return { local: "word-up" };
    if (ev.key === "ArrowDown") return { local: "word-down" };
  }
  if (ev.ctrlKey || ev.altKey || ev.metaKey) return {};
  const k = ev.key;

  // F1–F12（Shift で F13–F24）
  const fm = /^F([1-9]|1[0-2])$/.exec(k);
  if (fm) {
    const n = Number(fm[1]);
    return { aid: `F${ev.shiftKey ? n + 12 : n}` as AidKey };
  }
  switch (k) {
    case "Enter":
      // **Shift+Enter は送信ではなく Newline**（`20260921-shift-enter-newline`）。
      // ACS の既定割り当て `AcsMapFunctions.MAP_5250` が `S10 = [newline]` を持ち、
      // `PS5250.processNewline` はホストへ送らない。以前は Shift を見ずに Enter を送っており、
      // サブファイルの入力中に ACS の癖で Shift+Enter を押すと**入力途中のまま送信**されていた
      return ev.shiftKey ? { local: "newline" } : { aid: "Enter" };
    case "PageUp":
      return { aid: "PageUp" };
    case "PageDown":
      return { aid: "PageDown" };
    case "Home":
      return { local: "home" };
    case "End":
      return { local: "end" };
    case "Tab":
      return { local: ev.shiftKey ? "shift-tab" : "tab" };
    case "ArrowLeft":
      return { local: "left" };
    case "ArrowRight":
      return { local: "right" };
    case "ArrowUp":
      return { local: "up" };
    case "ArrowDown":
      return { local: "down" };
    default:
      return {};
  }
}

export interface KeymapHandlers {
  /** AID キー送信（カーソル位置を伴う）。F プロンプト等のため現在カーソルを渡す */
  sendAid(key: AidKey): void;
  /** ローカルのカーソル/フィールド操作 */
  local(action: LocalAction): void;
  /** 表示設定（SO/SI・配色・質感 等）を次の値へ順送りする（キー設定で割り当て可能） */
  viewCycle(key: string): void;
  /** マクロを再生する（キー設定で割り当て可能）。**ホストへは送らない** */
  playMacro(macroId: string): void;
  /** このペインがフォーカス中か（捕捉はフォーカスペインのみ） */
  isFocused(): boolean;
}

/**
 * **そのキーは「固まった要求から抜ける」ためのものか**（5250 のフラグレコード = Attn / SysReq）。
 *
 * 通信中の入力プロテクトは**この 2 つだけ通す**（`EmulatorPane.onKeydown`）。応答待ちの最中に
 * こそ使うキーで、そこで止めると**待たされている時だけ逃げ道が消える**——core と ws は既に
 * 施錠中でも通すようにしてある（`session.sendAid` / `ws-handler.onKey`）のに、画面側の門で
 * 止まっていた（`20260726-attn-sysreq-cancel-invite` の方針 5 の積み残し）。
 *
 * **既定の割り当ては無い**（`classifyKey` は Attn / SysReq を返さない）ので、実質はキー設定で
 * 割り当てた人だけが通る道になる。それでも `classifyKey` まで見るのは、既定が付いた日に
 * ここだけ古くならないようにするため。
 */
export function isEscapeAidEvent(ev: {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}): boolean {
  const isFlag = (t: string): boolean => t === "Attn" || t === "SysReq";
  const custom = keybindingsStore.resolve(ev);
  if (custom !== undefined) {
    // ローカル処理（表示切替・マクロ・編集キー）はホストへ行かないので対象外
    if (isViewBinding(custom) || isMacroBinding(custom) || isLocalBinding(custom)) return false;
    return isFlag(custom);
  }
  const { aid } = classifyKey(ev);
  return aid !== undefined && isFlag(aid);
}

/**
 * **このキーがローカル編集キー（Field Exit / Erase EOF / Erase Input / Field± / Dup）に割り当てられているか**。
 * 割り当てはキー設定にしか無い（`classifyKey` は素のキーを編集キーへ写さない）。
 *
 * 使う側は 2 つ——操作員エラーの間に**拒否するキー**の判定（ACS `PS5250.keyDown` はこれらを拒否する）と、
 * 満杯の欄の「出た」状態（ACS `fieldExited`）を**これらのキーの手前で下ろさない**判定（Field Exit は
 * その状態を見て最終桁を消さない）。
 */
export function localEditActionOf(ev: {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}): LocalEditAction | undefined {
  const custom = keybindingsStore.resolve(ev);
  if (custom === undefined || !isLocalBinding(custom)) return undefined;
  return localActionOf(custom);
}

/**
 * キーダウンを捕捉し、対象キーは preventDefault してブラウザ既定動作より 5250 操作を優先する
 * （spec: F1 ヘルプ・F5 リロード・PageUp スクロール等を抑止）。フォーカスペインのみ作用。
 */
/**
 * **施錠中の打鍵（先打ち）の扱い**（`20260921-type-ahead`）。純関数で分類だけを返す。
 *
 * ACS は施錠中・応答待ちの打鍵を溜めて、解錠で再生する（`ECLPS.SendKeys` の `keyBuffer`。
 * 実機でも文字・AID・Enter の連打が解錠後に効いた）。**Attn / SysReq / Help / Reset で溜めを捨てる**。
 *  - `hold`: 端末のキー（修飾なしの文字・Enter・Tab・矢印・F キー・編集キー、割り当てた AID・編集キー、Ctrl+矢印）
 *  - `flag`: Attn / SysReq——溜めを捨てて、**そのまま通す**（応答待ちの逃げ道。`isEscapeAidEvent`）
 *  - `help`: Help——溜めを捨てる（キー自身は送らない。ACS がこの間に Help を送るかは未確認）
 *  - `pass`: 端末のキーではない（修飾キー単独・IME・表示切替やマクロの割り当て・Ctrl+C 等のアプリの操作）
 */
export type TypeAheadKind = "hold" | "flag" | "help" | "pass";
export function typeAheadKind(ev: {
  key: string;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  isComposing?: boolean;
}): TypeAheadKind {
  if (ev.isComposing === true || ev.key === "Process") return "pass"; // IME は溜めない（未確認・decisions）
  if (ev.key === "Shift" || ev.key === "Control" || ev.key === "Alt" || ev.key === "Meta" || ev.key === "CapsLock") {
    return "pass";
  }
  if (isEscapeAidEvent(ev)) return "flag";
  const custom = keybindingsStore.resolve(ev);
  if (custom !== undefined) {
    if (isViewBinding(custom) || isMacroBinding(custom)) return "pass";
    if (custom === "Help") return "help";
    return "hold"; // AID・ローカル編集キー
  }
  const { aid, local } = classifyKey(ev);
  if (aid === "Help") return "help";
  if (aid !== undefined || local !== undefined) return "hold";
  // 修飾なしの印字文字（Backspace / Delete / Insert 等の名前付きキーも端末のキー）
  if (!ev.ctrlKey && !ev.altKey && !ev.metaKey) return "hold";
  return "pass";
}

export function makeKeydownHandler(h: KeymapHandlers): (ev: KeyboardEvent) => void {
  return (ev: KeyboardEvent) => {
    if (!h.isFocused()) return;
    // カスタムキーバインドを既定より優先。`view:*`（表示設定の順送り）・`macro:*`（マクロ再生）・
    // `local:*`（ローカル編集キー）は**ホストへ送らない**ローカル処理。
    const custom = keybindingsStore.resolve(ev);
    if (custom) {
      ev.preventDefault();
      if (isViewBinding(custom)) h.viewCycle(viewKeyOf(custom));
      else if (isMacroBinding(custom)) h.playMacro(macroIdOf(custom));
      else if (isLocalBinding(custom)) h.local(localActionOf(custom));
      else h.sendAid(custom);
      return;
    }
    const { aid, local } = classifyKey(ev);
    if (aid) {
      ev.preventDefault();
      h.sendAid(aid);
    } else if (local) {
      // Tab・矢印・Home/End はブラウザ既定（フォーカス移動・スクロール）より 5250 操作を優先
      ev.preventDefault();
      h.local(local);
    }
  };
}
