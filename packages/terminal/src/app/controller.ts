/**
 * キー事象 → 5250 の操作。**純ロジック**（セッションは構造的な型 `SessionLike` で受ける＝試験は偽物で足りる）。
 *
 * カーソル移動・フィールド移動・AID 送信と、欄の編集（挿入／上書き・Delete・Backspace・Field Exit・型の検査・
 * O 欄の SO/SI 補完）。**編集の規則は `editing.ts` が `@ts5250/tn5250/edit/*` を呼んで行う**——ここへ写し直さない
 * （web-ui と結果が食い違うため。`.aidev/works/20261014-terminal-ui` decisions D7）。
 *
 * 5250 の専用キーは文字端末に無いものがある（research F9b）。**接頭キーの次の 1 文字**で割り当てる:
 *   a Attn / s SysReq / h Help / p Print / c Clear / r Reset / e Field Exit / i 挿入切替 / 1 2 3 PA1〜PA3 / q 終了
 * 画面表示の切替（`view.ts`）も同じ接頭キーで行う:
 *   g 罫線 / o SO/SI / k カナ・英 / u カーソルの形 / b 明滅 / l ルーラー / m ルーラーの形 / f ルーラーの固定 / v 桁区切り / w パネル
 */
import type { AidKey, Field, ScreenSnapshot, SendAidOptions } from "@ts5250/tn5250";
import { typeInto, deleteAt, backspaceAt, exitAt, MSG_FIELD_EXIT_KEY, type EditEnv, type EditOutcome } from "./editing.js";
import { offsetOfPos } from "@ts5250/tn5250/edit/fieldSlices";
import { isTabStopField } from "@ts5250/tn5250/edit/continuedRun";
import type { KeyEvent } from "../input/decode.js";
import { DEFAULT_VIEW, toggleView, viewNote, type TermView } from "./view.js";

export interface SessionLike {
  snapshot(): ScreenSnapshot;
  sendAid(key: AidKey, opts?: SendAidOptions): Promise<unknown>;
  setField(target: { index: number }, value: string): void;
  dismissHostError(): boolean;
  disconnect(): void;
}

export interface ControllerOptions {
  /** 接頭キーの文字（Ctrl+この文字）。既定は `]`（tmux の Ctrl+B・screen の Ctrl+A と衝突しない） */
  prefix?: string;
  /** DBCS の CCSID でないセッションか（幅の検査を SBCS 向けにする） */
  sbcsOnly?: boolean;
  /** 画面表示の初期設定（省略時は `DEFAULT_VIEW`） */
  view?: TermView;
}

export const PREFIX_DEFAULT = "]";

const MOVE: Record<string, [number, number]> = { Up: [-1, 0], Down: [1, 0], Left: [0, -1], Right: [0, 1] };

/** 接頭キーの次の文字 → AID */
const PREFIXED: Record<string, AidKey> = {
  a: "Attn", s: "SysReq", h: "Help", p: "Print", c: "Clear", "1": "PA1", "2": "PA2", "3": "PA3"
};

export class TerminalController {
  cursor: { row: number; col: number };
  note = "";
  quit = false;
  private prefixed = false;
  /** 挿入モード（Insert キーまたは接頭キーの `i` で切り替え。AID 送信後は上書きへ戻る——5250 の挿入は 1 入力ごと） */
  insertMode = false;
  /** 最終桁まで打って「出た」状態の欄の番号（次の文字はエラー。ACS の fieldExited） */
  private exitedIndex: number | undefined;
  private readonly sbcsOnly: boolean;
  /** E 欄の全角・半角の状態（空にしても保つ。AID の送信で捨てる） */
  private readonly either = new Map<number, boolean>();
  private readonly jeErased = new Set<number>();
  /** 自分の `setField` が起こす screen 事象で、カーソルをホストの位置へ戻さないための印 */
  private local = 0;
  readonly prefix: string;
  /** 画面表示の設定。切替は接頭キーの次の文字（`toggleView`） */
  view: TermView;
  /** ルーラーを固定にしたときの位置（出した時点のカーソル。web-ui の `ruleAnchor` と同じ規則） */
  private ruleAnchor: { row: number; col: number } | undefined;

  constructor(private readonly session: SessionLike, opts: ControllerOptions = {}) {
    this.prefix = opts.prefix ?? PREFIX_DEFAULT;
    this.sbcsOnly = opts.sbcsOnly ?? true;
    this.view = opts.view ?? DEFAULT_VIEW;
    this.cursor = { ...session.snapshot().cursor };
  }

  /** セッションの screen 事象で呼ぶ。自分の入力による更新ではカーソルを動かさない */
  onScreen(snap: ScreenSnapshot): void {
    if (this.local > 0) return;
    this.cursor = { ...snap.cursor };
  }

  async handle(ev: KeyEvent): Promise<void> {
    const snap = this.session.snapshot();
    this.note = "";
    // 「出た」状態は、欄の外へ動く・別の操作をすると下りる。打鍵の分岐だけが見る
    if (!(ev.kind === "char" && !ev.ctrl && !ev.alt)) this.exitedIndex = undefined;
    if (this.prefixed) {
      this.prefixed = false;
      if (ev.kind !== "char") return;
      return this.prefixedKey(ev.ch, snap);
    }
    if (ev.kind === "char") {
      if (ev.ctrl && ev.ch === this.prefix) {
        this.prefixed = true;
        this.note = `接頭キー: a=Attn s=SysReq h=Help p=Print c=Clear r=Reset e=FieldExit i=挿入 1-3=PA q=終了 / 表示 g o k u b l m f v w`;
        return;
      }
      if (ev.ctrl && ev.ch === "c") {
        this.quit = true;
        return;
      }
      if (ev.ctrl || ev.alt) return;
      return this.type(ev.ch, snap);
    }
    switch (ev.name) {
      case "Up": case "Down": case "Left": case "Right": {
        const [dr, dc] = MOVE[ev.name]!;
        this.move(snap, dr, dc);
        return;
      }
      case "Tab": return this.toField(snap, +1);
      case "BackTab": return this.toField(snap, -1);
      case "Home": return this.toFirstField(snap);
      case "Escape": return this.reset(snap);
      case "Backspace": return this.backspace(snap);
      case "Delete": return this.delete(snap);
      case "Insert": this.insertMode = !this.insertMode; return;
      case "Enter": return this.aid("Enter", snap);
      case "PageUp": return this.aid("PageUp", snap);
      case "PageDown": return this.aid("PageDown", snap);
      default: {
        const m = /^F(\d+)$/.exec(ev.name);
        if (!m) return;
        // Shift+F1〜F12 = F13〜F24（端末は F13 以上を出さない。5250 の慣習）
        const n = Number(m[1]) + (ev.shift && Number(m[1]) <= 12 ? 12 : 0);
        if (n >= 1 && n <= 24) return this.aid(`F${n}` as AidKey, snap);
      }
    }
  }

  private async prefixedKey(ch: string, snap: ScreenSnapshot): Promise<void> {
    if (ch === "q") {
      this.quit = true;
      return;
    }
    if (ch === "r") return this.reset(snap);
    if (ch === "e") return this.fieldExit(snap);
    if (ch === "i") {
      this.insertMode = !this.insertMode;
      return;
    }
    const aid = PREFIXED[ch];
    if (aid) return this.aid(aid, snap);
    const v = toggleView(this.view, ch);
    if (v) {
      this.setView(v, ch, snap);
      return;
    }
    this.note = `接頭キーの割り当てが無い: ${ch}`;
  }

  /** ルーラーを引く位置。従わない設定なら固定した位置（画面が縮んでも画面の中に収める） */
  ruleAt(snap: ScreenSnapshot = this.session.snapshot()): { row: number; col: number } {
    const a = this.view.ruleFollow ? undefined : this.ruleAnchor;
    if (!a) return this.cursor;
    return { row: Math.min(a.row, snap.rows), col: Math.min(a.col, snap.cols) };
  }

  private setView(v: TermView, key: string, snap: ScreenSnapshot): void {
    // 従う→固定、またはルーラーを出す時に固定なら、この時点のカーソルで固める。従うへ戻したら解く
    if (v.ruleFollow) this.ruleAnchor = undefined;
    else if (!this.ruleAnchor || (!this.view.rule && v.rule) || this.view.ruleFollow) this.ruleAnchor = { ...this.cursor };
    this.view = v;
    void snap;
    this.note = viewNote(v, key);
  }

  private async aid(key: AidKey, snap: ScreenSnapshot): Promise<void> {
    if (snap.keyboardLocked && key !== "SysReq" && key !== "Attn") {
      this.note = "入力禁止中です（Esc でリセット）";
      return;
    }
    try {
      await this.session.sendAid(key, { cursor: this.cursor });
    } catch (e) {
      this.note = e instanceof Error ? e.message : String(e);
    }
    // 送信後の画面はホストが決めたカーソルから始める。挿入は 1 入力ごと（ACS）
    this.insertMode = false;
    this.either.clear();
    this.jeErased.clear();
    this.exitedIndex = undefined;
    this.cursor = { ...this.session.snapshot().cursor };
  }

  private reset(snap: ScreenSnapshot): void {
    if (!this.session.dismissHostError() && snap.keyboardLocked) this.note = "リセットできる状態ではありません";
  }

  private move(snap: ScreenSnapshot, dr: number, dc: number): void {
    // 端は反対側へ巻く（ACS の画面全体の自由カーソルと同じ）
    const rows = snap.rows, cols = snap.cols;
    let row = this.cursor.row + dr, col = this.cursor.col + dc;
    if (col < 1) { col = cols; row--; } else if (col > cols) { col = 1; row++; }
    if (row < 1) row = rows; else if (row > rows) row = 1;
    this.cursor = { row, col };
  }

  private inputFields(snap: ScreenSnapshot): Field[] {
    // 継続欄（EDTMSK の区間の並び）は先頭の区間だけが停止点（ACS は並び全体で 1 つの欄）
    return snap.fields.filter((f) => !f.protected && isTabStopField(f)).sort((a, b) => a.row - b.row || a.col - b.col);
  }

  private fieldAt(snap: ScreenSnapshot, p = this.cursor): Field | undefined {
    return snap.fields.find((f) => !f.protected && offsetOfPos(f, p.row, p.col, snap.cols, snap.rows) !== undefined);
  }

  private toField(snap: ScreenSnapshot, dir: 1 | -1): void {
    const fs = this.inputFields(snap);
    if (fs.length === 0) return;
    const key = (f: { row: number; col: number }): number => f.row * 1000 + f.col;
    const c = key(this.cursor);
    const hit = dir === 1 ? fs.find((f) => key(f) > c) ?? fs[0]! : [...fs].reverse().find((f) => key(f) < c) ?? fs[fs.length - 1]!;
    this.cursor = { row: hit.row, col: hit.col };
  }

  private toFirstField(snap: ScreenSnapshot): void {
    const f = this.inputFields(snap)[0];
    if (f) this.cursor = { row: f.row, col: f.col };
  }

  private env(snap: ScreenSnapshot): EditEnv {
    return { cols: snap.cols, rows: snap.rows, insertMode: this.insertMode, sbcsOnly: this.sbcsOnly, eitherMemory: this.either, jeErased: this.jeErased };
  }

  /** 編集の結果を反映する。値を `setField` へ渡し、カーソルを置く。成功なら true */
  private apply(f: Field, r: EditOutcome): boolean {
    if (!r.ok) {
      if (r.note) this.note = r.note;
      return false;
    }
    this.local++;
    try {
      this.session.setField({ index: f.index }, r.value);
      for (const o of r.also ?? []) this.session.setField({ index: o.index }, o.value);
    } catch (e) {
      this.note = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      this.local--;
    }
    this.cursor = r.cursor;
    if (r.note) this.note = r.note;
    return true;
  }

  private locked(snap: ScreenSnapshot): boolean {
    if (snap.keyboardLocked) this.note = "入力禁止中です（Esc でリセット）";
    return snap.keyboardLocked;
  }

  private type(ch: string, snap: ScreenSnapshot): void {
    if (this.locked(snap)) return;
    const f = this.fieldAt(snap);
    if (!f) {
      this.note = "ここには入力できません";
      return;
    }
    if (this.exitedIndex === f.index) {
      this.note = MSG_FIELD_EXIT_KEY;
      return;
    }
    const r = typeInto(f, snap, this.cursor, ch, this.env(snap));
    if (!this.apply(f, r) || !r.ok) return;
    if (r.filled === true) {
      // 満杯: Field Exit が必須の欄は留まり「出た」状態にする。そうでなければ次の入力欄へ（ACS）
      if (f.fieldExitRequired) this.exitedIndex = f.index;
      else this.toField(this.session.snapshot(), +1);
    }
  }

  private backspace(snap: ScreenSnapshot): void {
    if (this.locked(snap)) return;
    const f = this.fieldAt(snap);
    // 継続欄は並びの先頭までは前の区間を消す（`backspaceAt` が並びの先頭で 0005）
    if (!f || (f.continued === undefined && f.row === this.cursor.row && this.cursor.col <= f.col)) {
      this.move(snap, 0, -1);
      return;
    }
    this.apply(f, backspaceAt(f, snap, this.cursor, this.env(snap)));
  }

  private delete(snap: ScreenSnapshot): void {
    if (this.locked(snap)) return;
    const f = this.fieldAt(snap);
    if (!f) return;
    this.apply(f, deleteAt(f, snap, this.cursor, this.env(snap)));
  }

  /** Field Exit: カーソル以降を消し、右寄せ（ADJUST）を掛けて次の入力欄へ */
  private fieldExit(snap: ScreenSnapshot): void {
    if (this.locked(snap)) return;
    const f = this.fieldAt(snap);
    if (!f) return;
    if (this.apply(f, exitAt(f, snap, this.cursor, this.env(snap)))) this.toField(this.session.snapshot(), +1);
  }
}
