/**
 * キー事象 → 5250 の操作。**純ロジック**（セッションは構造的な型 `SessionLike` で受ける＝試験は偽物で足りる）。
 *
 * 第 1 段の範囲（`.aidev/works/20261014-terminal-ui`）: カーソル移動・フィールド移動・AID 送信・
 * **SBCS の上書き入力だけ**。挿入モード・DBCS の SO/SI 補完・Field Exit の整形・検証は第 2 段
 * （編集ロジックを web-ui から切り出してから）。ここへ編集を写し直さない——web-ui と結果が食い違うため。
 *
 * 5250 の専用キーは文字端末に無いものがある（research F9b）。**接頭キーの次の 1 文字**で割り当てる:
 *   a Attn / s SysReq / h Help / p Print / c Clear / r Reset / e Field Exit(簡易) / 1 2 3 PA1〜PA3 / q 終了
 */
import type { AidKey, Field, ScreenSnapshot, SendAidOptions } from "@ts5250/tn5250";
import { isFullWidth } from "@ts5250/base";
import type { KeyEvent } from "../input/decode.js";

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
  /** 自分の `setField` が起こす screen 事象で、カーソルをホストの位置へ戻さないための印 */
  private local = 0;
  private readonly prefix: string;

  constructor(private readonly session: SessionLike, opts: ControllerOptions = {}) {
    this.prefix = opts.prefix ?? PREFIX_DEFAULT;
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
    if (this.prefixed) {
      this.prefixed = false;
      if (ev.kind !== "char") return;
      return this.prefixedKey(ev.ch, snap);
    }
    if (ev.kind === "char") {
      if (ev.ctrl && ev.ch === this.prefix) {
        this.prefixed = true;
        this.note = `接頭キー: a=Attn s=SysReq h=Help p=Print c=Clear r=Reset e=FieldExit 1-3=PA q=終了`;
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
      case "Delete": return this.blank(snap, this.cursor.col);
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
    const aid = PREFIXED[ch];
    if (aid) return this.aid(aid, snap);
    this.note = `接頭キーの割り当てが無い: ${ch}`;
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
    // 送信後の画面はホストが決めたカーソルから始める
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
    return snap.fields.filter((f) => !f.protected).sort((a, b) => a.row - b.row || a.col - b.col);
  }

  private fieldAt(snap: ScreenSnapshot, p = this.cursor): Field | undefined {
    return snap.fields.find((f) => !f.protected && f.row === p.row && p.col >= f.col && p.col < f.col + f.length);
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

  /** 値を桁の並びとして取り出す（`value` は末尾の空白が落ちている） */
  private chars(f: Field): string[] {
    return [...f.value.padEnd(f.length, " ")].slice(0, f.length);
  }

  private write(f: Field, chars: string[]): boolean {
    this.local++;
    try {
      this.session.setField({ index: f.index }, chars.join("").replace(/ +$/, ""));
      return true;
    } catch (e) {
      this.note = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      this.local--;
    }
  }

  private type(ch: string, snap: ScreenSnapshot): void {
    const f = this.fieldAt(snap);
    if (!f || snap.keyboardLocked) {
      this.note = snap.keyboardLocked ? "入力禁止中です（Esc でリセット）" : "ここには入力できません";
      return;
    }
    // 第 1 段は SBCS の上書きだけ。全角・DBCS 欄は、編集ロジックの切り出し（第 2 段）まで受けない
    if (isFullWidth(ch) || f.dbcsType !== undefined) {
      this.note = "全角・DBCS 欄の入力は未対応です";
      return;
    }
    if (f.keyboardInhibited) {
      this.note = "この欄はキーボードから入力できません";
      return;
    }
    const v = this.chars(f);
    const off = this.cursor.col - f.col;
    v[off] = f.monocase ? ch.toUpperCase() : ch;
    if (!this.write(f, v)) return;
    if (off + 1 < f.length) this.cursor = { ...this.cursor, col: this.cursor.col + 1 };
    else if (!f.fieldExitRequired) this.toField(this.session.snapshot(), +1); // 満杯で次の入力欄へ（ACS。FER の欄は留まる）
  }

  private backspace(snap: ScreenSnapshot): void {
    const f = this.fieldAt(snap);
    if (!f || this.cursor.col <= f.col) {
      this.move(snap, 0, -1);
      return;
    }
    this.cursor = { ...this.cursor, col: this.cursor.col - 1 };
    this.blank(snap, this.cursor.col);
  }

  private blank(snap: ScreenSnapshot, col: number): void {
    const f = this.fieldAt(snap, { row: this.cursor.row, col });
    if (!f || snap.keyboardLocked) return;
    const v = this.chars(f);
    v[col - f.col] = " ";
    this.write(f, v);
  }

  /** 簡易の Field Exit: カーソルから欄末までを空にして次の入力欄へ（右寄せ・符号の整形は第 2 段） */
  private fieldExit(snap: ScreenSnapshot): void {
    const f = this.fieldAt(snap);
    if (!f) return;
    const v = this.chars(f);
    for (let i = this.cursor.col - f.col; i < v.length; i++) v[i] = " ";
    if (this.write(f, v)) this.toField(this.session.snapshot(), +1);
  }
}
