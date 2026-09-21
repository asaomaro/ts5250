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
  // Delete Word（ACS の既定 Ctrl+Delete＝`[deleteword]`。`20260922-delete-word`）
  "delete-word",
  // **符号付き数値欄で負値を入れる主経路**（実機は数値キーパッドの `-` / `+`。`numpadFieldSign`）。
  // ~~打鍵の `-` / `+` も数値欄ではここへ横流しする（ScreenGrid）~~ → メイン行の `-` `+` は文字
  // （ACS。`20260921-numpad-field-sign`）
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

/**
 * **テンキーの − / ＋ か**（ACS の既定の割り当て `AcsMapFunctions.MAP_5250` の `B109 = [field-]`・`B107 = [field+]`。
 * `20260921-numpad-field-sign`）。当てはまれば Field− / Field+、でなければ `undefined`。
 *
 * - **5250 のときだけ**（`fieldSignKeys`）。3270 に Field± は無く、テンキーの − は文字（節目の独立点検の指摘）
 * - 物理キー（`code`）と**文字（`key`）の両方**で見る。IME の変換中は `key` が `"Process"` になるので当たらない
 *   （変換の途中で欄を出ないため。同じ指摘）
 * - 修飾なし（`B`）。Shift 付きは割り当てない
 */
export function numpadFieldSign(
  ev: { key: string; code?: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean; isComposing?: boolean },
  fieldSignKeys: boolean
): "field-minus" | "field-plus" | undefined {
  if (!fieldSignKeys || ev.isComposing === true || ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey) return undefined;
  if (ev.code === "NumpadSubtract" && ev.key === "-") return "field-minus";
  if (ev.code === "NumpadAdd" && ev.key === "+") return "field-plus";
  return undefined;
}

/** キーイベントを AID キー・ローカル操作・null（非対象）に分類する（純関数・テスト可能） */
export function classifyKey(
  ev: {
    key: string;
    /** 物理キー（`KeyboardEvent.code`）。テンキーの − / ＋ をメイン行と見分けるのに使う */
    code?: string;
    shiftKey: boolean;
    ctrlKey: boolean;
    altKey: boolean;
    metaKey: boolean;
    isComposing?: boolean;
  },
  /** テンキーの ± を Field± に振り分けるか（5250 のときだけ true。`numpadFieldSign`） */
  opts: { fieldSignKeys?: boolean } = {}
): { aid?: AidKey; local?: LocalAction } {
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
  // **テンキーの − / ＋ は Field− / Field+**（メイン行の `-` `+` は文字として欄の型の規則に従う。
  // ~~以前は物理キーを見分けられず、数値欄の `-` `+` をすべて Field± にしていた~~）
  const sign = numpadFieldSign(ev, opts.fieldSignKeys === true);
  if (sign) return { local: sign };
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
  /** テンキーの ± を Field± にするか（5250 のときだけ true。未指定は false＝文字） */
  fieldSignKeys?(): boolean;
  /**
   * そのセッションが送れる AID か（未指定は送れる）。**汎用機の 3270 は Attn・SysReq・Help・Print を送れない**ので、
   * それへのキーの割り当て（ACS の既定の Esc＝Attn ほか）は何もしない——送るたびにエラーにしない（節目の点検の指摘）
   */
  canSendAid?(key: AidKey): boolean;
}

/**
 * **そのキーは「固まった要求から抜ける」ためのものか**（5250 のフラグレコード = Attn / SysReq）。
 *
 * 通信中の入力プロテクトは**この 2 つだけ通す**（`EmulatorPane.onKeydown`）。応答待ちの最中に
 * こそ使うキーで、そこで止めると**待たされている時だけ逃げ道が消える**——core と ws は既に
 * 施錠中でも通すようにしてある（`session.sendAid` / `ws-handler.onKey`）のに、画面側の門で
 * 止まっていた（`20260726-attn-sysreq-cancel-invite` の方針 5 の積み残し）。
 *
 * ~~**既定の割り当ては無い**~~ → ACS と同じ既定（Esc＝Attn・Shift+Esc＝SysReq）が付いた（`20260921-acs-default-keys`）。
 * `classifyKey` は Attn / SysReq を返さないので、割り当て（既定を含む）経由の道になる。`classifyKey` まで見るのは、
 * 素のキーに割り当てが付いた日にここだけ古くならないようにするため。
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
 * **このキーがローカル編集キー（Field Exit / Erase EOF / Erase Input / Delete Word / Field± / Dup）に割り当てられているか**。
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

/**
 * **利用者の割り当て（既定を含む）があるキーか**。欄の input が自分で処理するキー（End・Insert）でも、
 * 割り当てがあればペインのキーマップへ委ねる（ACS の既定 Shift+Insert = Dup や、利用者が End に付けた割り当てを効かせるため）
 */
export function hasKeyBinding(ev: { key: string; shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): boolean {
  return keybindingsStore.resolve(ev) !== undefined;
}

export function makeKeydownHandler(h: KeymapHandlers): (ev: KeyboardEvent) => void {
  return (ev: KeyboardEvent) => {
    if (!h.isFocused()) return;
    // **IME の変換中のキーは拾わない**（変換を取り消す Esc が Attn に、変換中のテンキーが Field± になる）。
    // Safari は確定・取り消しのキーを compositionend の後に isComposing=false・keyCode 229 で送ってくることがあるので 229 も見る
    // （節目の点検の懸念。実ブラウザでは未確認）
    if (ev.isComposing || ev.key === "Process" || ev.keyCode === 229) return;
    // カスタムキーバインドを既定より優先。`view:*`（表示設定の順送り）・`macro:*`（マクロ再生）・
    // `local:*`（ローカル編集キー）は**ホストへ送らない**ローカル処理。
    const custom = keybindingsStore.resolve(ev);
    if (custom) {
      // 送れない AID への割り当ては何もしない（ブラウザの既定も止めない。割り当てが無かったときと同じ）
      if (!isViewBinding(custom) && !isMacroBinding(custom) && !isLocalBinding(custom) && h.canSendAid?.(custom) === false) return;
      ev.preventDefault();
      if (isViewBinding(custom)) h.viewCycle(viewKeyOf(custom));
      else if (isMacroBinding(custom)) h.playMacro(macroIdOf(custom));
      else if (isLocalBinding(custom)) h.local(localActionOf(custom));
      else h.sendAid(custom);
      return;
    }
    const { aid, local } = classifyKey(ev, { fieldSignKeys: h.fieldSignKeys?.() === true });
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
