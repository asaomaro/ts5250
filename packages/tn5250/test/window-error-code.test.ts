import { describe, it, expect } from "vitest";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import { ESC, COMMAND, ORDER } from "../src/protocol/constants.js";

/**
 * **WRITE ERROR CODE TO WINDOW（0x22）のメッセージを ACS と同じ位置に重ねる**（`20260926-window-error-code`）。
 * 実機の ACS のコア（`scripts/acs-probe/window-error-code.txt`。DSM の `dscmd.c` WINERR* で 0x22〔開始桁 12・終了桁 29〕を出させた）:
 * - メッセージ行が最下行（既定 24）: 桁 1 に属性・桁 2 から本文（開始桁は捨てられる。書き始め＋桁数が画面を超えるので行頭へ戻す）。桁 1〜28 が空になる
 * - SOH でメッセージ行を 22 に申告: 桁 12 に属性・桁 13 から本文。桁 12〜28 が空、桁 29 は本文で上書き
 * - 30 字の本文は 17 字（属性と合わせて 18 バイト＝終了桁 − 開始桁 ＋ 1）で切れる
 */
const codec = codecForCcsid(37);
const WTD = [ESC, COMMAND.WRITE_TO_DISPLAY, 0x00, 0x00];
const soh = (msgRow: number): number[] => [ORDER.SOH, 7, 0x00, 0x00, 0x00, msgRow, 0x00, 0x00, 0x00];
const text = (s: string): number[] => [...codec.encode(s).bytes];
const apply = (buf: ScreenBuffer, stream: number[]): void => applyDataStream(Uint8Array.from(stream), buf, codec, () => {});
const ORIGINAL = "MSGLINE ORIGINAL TEXT TO BE RESTORED";

/** 背景（メッセージ行の桁 2 から ORIGINAL）を書いた画面。`msgRow` が 0 なら SOH の申告なし（既定 24） */
function screen(msgRow = 0): ScreenBuffer {
  const buf = new ScreenBuffer();
  apply(buf, [...WTD, ...(msgRow ? soh(msgRow) : []), ORDER.SBA, 2, 2, ...text("BACKGROUND"), ORDER.SBA, msgRow || 24, 2, ...text(ORIGINAL)]);
  return buf;
}
const wec22 = (start: number, end: number, body: number[]): number[] => [ESC, COMMAND.WRITE_ERROR_CODE_WINDOW, start, end, ...body];
const rowText = (buf: ScreenBuffer, row: number): string => buf.snapshot().cells[row - 1]!.map((c) => c.char).join("");

describe("0x22 の位置（ACS の実測 4 通り）", () => {
  it("**最下行（既定）: 開始桁を捨てて桁 1 から。重ねる幅は空にする桁 1〜28**", () => {
    const buf = screen();
    apply(buf, wec22(12, 29, [0x22, ...text("ERR IN WINDOW")]));
    const snap = buf.snapshot();
    expect(snap.systemMessage).toBe("ERR IN WINDOW");
    expect(snap.systemMessageArea).toEqual({ row: 24, col: 1, width: 28 });
  });

  it("**最下行・長い本文: 17 字で切れる**（属性と合わせて 18 バイト）", () => {
    const buf = screen();
    apply(buf, wec22(12, 29, [0x22, ...text("ABCDEFGHIJKLMNOPQRSTUVWXYZ1234")]));
    expect(buf.snapshot().systemMessage).toBe("ABCDEFGHIJKLMNOPQ");
    expect(buf.snapshot().systemMessageArea).toEqual({ row: 24, col: 1, width: 28 });
  });

  it("**SOH でメッセージ行 22: 開始桁 12 から。重ねる幅は空にする桁 12〜28**", () => {
    const buf = screen(22);
    apply(buf, wec22(12, 29, [0x22, ...text("ERR IN WINDOW")]));
    expect(buf.snapshot().systemMessage).toBe("ERR IN WINDOW");
    expect(buf.snapshot().systemMessageArea).toEqual({ row: 22, col: 12, width: 17 });
  });

  it("**22 行・長い本文: 17 字で切れ、終了桁 29 まで書くので重ねる幅は 18**", () => {
    const buf = screen(22);
    apply(buf, wec22(12, 29, [0x22, ...text("ABCDEFGHIJKLMNOPQRSTUVWXYZ1234")]));
    expect(buf.snapshot().systemMessage).toBe("ABCDEFGHIJKLMNOPQ");
    expect(buf.snapshot().systemMessageArea).toEqual({ row: 22, col: 12, width: 18 });
  });
});

describe("0x22 の読み方", () => {
  it("上限を超えた本文は次の ESC まで読み飛ばし、**後続のコマンドは読む**", () => {
    const buf = screen(22);
    apply(buf, [...wec22(12, 29, [0x22, ...text("ABCDEFGHIJKLMNOPQRSTUVWXYZ1234")]), ...WTD, ORDER.SBA, 5, 5, ...text("NEXT")]);
    expect(rowText(buf, 5).slice(4, 8)).toBe("NEXT");
  });

  it("先頭が IC（0x13）なら上限を 3 増やす（ACS と同じ。IC の 3 バイトぶん）", () => {
    const buf = screen(22);
    apply(buf, wec22(12, 29, [ORDER.IC, 22, 12, 0x22, ...text("ABCDEFGHIJKLMNOPQRSTUVWXYZ1234")]));
    expect(buf.snapshot().systemMessage).toBe("ABCDEFGHIJKLMNOPQ");
  });

  it("**開始桁が 4（ESC と同じ値）でも桁として読む**（22 行・桁 4〜21）", () => {
    const buf = screen(22);
    apply(buf, [...wec22(4, 21, [0x22, ...text("ERR")]), ...WTD, ORDER.SBA, 5, 5, ...text("NEXT")]);
    expect(buf.snapshot().systemMessage).toBe("ERR");
    expect(buf.snapshot().systemMessageArea).toEqual({ row: 22, col: 4, width: 17 });
    expect(rowText(buf, 5).slice(4, 8)).toBe("NEXT");
  });

  it("IC はセルを書かないので幅に数えない（上限いっぱいの本文でも終了桁 29 まで＝幅 18）", () => {
    const buf = screen(22);
    apply(buf, wec22(12, 29, [ORDER.IC, 22, 12, 0x22, ...text("ABCDEFGHIJKLMNOPQRSTUVWXYZ1234")]));
    expect(buf.snapshot().systemMessageArea).toEqual({ row: 22, col: 12, width: 18 });
  });

  it("終了桁が桁数を超えても、重ねる幅は行末まで", () => {
    const buf = screen(22);
    apply(buf, wec22(70, 200, [0x22, ...text("ERR")]));
    expect(buf.snapshot().systemMessageArea).toEqual({ row: 22, col: 70, width: 11 });
  });

  it("**1 バイトも無いレコードは否定応答 0x10050121**（ACS は 0x21 と同じ長さの検査。`20260927-short-command-sense`）", () => {
    const buf = screen();
    const before = rowText(buf, 24);
    const r = applyDataStream(Uint8Array.from([ESC, COMMAND.WRITE_ERROR_CODE_WINDOW]), buf, codec, () => {});
    expect(r.senseCode).toBe(0x10050121);
    // その場で戻る: メッセージも位置も付かず、メッセージ行もそのまま
    expect(buf.snapshot().systemMessage).toBeUndefined();
    expect(buf.snapshot().systemMessageArea).toBeUndefined();
    expect(rowText(buf, 24)).toBe(before);
  });

  it("開始桁だけあって終了桁が欠けるレコード（1 バイト）でも例外にしない", () => {
    const buf = screen();
    expect(() => apply(buf, [ESC, COMMAND.WRITE_ERROR_CODE_WINDOW, 12])).not.toThrow();
    expect(buf.snapshot().systemMessageArea).toEqual({ row: 24, col: 1, width: 80 });
  });

  it("**上限は SO/SI・DBCS の 2 バイトも 1 バイトずつ数える**（930。開始桁 12・終了桁 18＝7 バイト: 属性＋SO＋あ＋い＋SI で尽きる）", () => {
    const c930 = codecForCcsid(930);
    const buf = new ScreenBuffer();
    applyDataStream(Uint8Array.from([...WTD, ...soh(22)]), buf, c930, () => {});
    const body = [0x22, ...c930.encode("あい").bytes, ...c930.encode("XYZ").bytes];
    applyDataStream(Uint8Array.from(wec22(12, 18, body)), buf, c930, () => {});
    expect(buf.snapshot().systemMessage).toBe("あい");
  });

  it("開始桁と終了桁が逆転（22 行）: 本文を読まず、位置は 0x21 と同じメッセージ行の 1 行全体（decisions D4）", () => {
    const buf = screen(22);
    apply(buf, wec22(29, 12, [0x22, ...text("ERR")]));
    expect(buf.snapshot().systemMessage).toBe("");
    expect(buf.snapshot().systemMessageArea).toEqual({ row: 22, col: 1, width: 80 });
  });

  it("**範囲の外のセルは変わらない**（セルには書かない。重ねるのは UI）", () => {
    const buf = screen(22);
    const before = rowText(buf, 22);
    apply(buf, wec22(12, 29, [0x22, ...text("ERR IN WINDOW")]));
    expect(rowText(buf, 22)).toBe(before);
    expect(rowText(buf, 2).slice(1, 11)).toBe("BACKGROUND");
  });
});

describe("エラー状態の入り方・寿命（0x21 と同じ経路）", () => {
  it("0x22 でも通し番号が振られる（UI はこれでエラー状態に入る）", () => {
    const buf = screen();
    apply(buf, wec22(12, 29, [0x22, ...text("E1")]));
    const s1 = buf.snapshot().systemMessageSeq;
    apply(buf, wec22(12, 29, [0x22, ...text("E1")]));
    expect(s1).toBeDefined();
    expect(buf.snapshot().systemMessageSeq).not.toBe(s1);
  });

  it("0x22 の後に 0x21 が来たら、位置は 0x21 のもの（メッセージ行の 1 行全体）に替わる", () => {
    const buf = screen(22);
    apply(buf, wec22(12, 29, [0x22, ...text("IN WINDOW")]));
    apply(buf, [ESC, COMMAND.WRITE_ERROR_CODE, 0x22, ...text("FULL LINE")]);
    expect(buf.snapshot().systemMessage).toBe("FULL LINE");
    expect(buf.snapshot().systemMessageArea).toEqual({ row: 22, col: 1, width: 80 });
  });

  it("CLEAR UNIT で本文も位置も消える（ACS `processClearUnit`）", () => {
    const buf = screen(22);
    apply(buf, wec22(12, 29, [0x22, ...text("ERR")]));
    apply(buf, [ESC, COMMAND.CLEAR_UNIT]);
    expect(buf.snapshot().systemMessage).toBeUndefined();
    expect(buf.snapshot().systemMessageArea).toBeUndefined();
  });

  it("SAVE SCREEN で本文も位置も消える（ACS `processSaveScreen`）", () => {
    const buf = screen(22);
    apply(buf, wec22(12, 29, [0x22, ...text("ERR")]));
    apply(buf, [ESC, COMMAND.SAVE_SCREEN]);
    expect(buf.snapshot().systemMessage).toBeUndefined();
    expect(buf.snapshot().systemMessageArea).toBeUndefined();
  });

  it("メッセージ行への WTD で消える（当 PJ の既存の規則。ACS の見え方は未確認——decisions D2）", () => {
    const buf = screen(22);
    apply(buf, wec22(12, 29, [0x22, ...text("ERR")]));
    apply(buf, [...WTD, ORDER.SBA, 22, 2, ...text("NEXT")]);
    expect(buf.snapshot().systemMessageArea).toBeUndefined();
  });
});

/**
 * **WRITE ERROR CODE（0x21）は SOH が申告したメッセージ行に重ねる**（`20260926-wec-msgline-row`）。
 * 実機の ACS のコア（`scripts/acs-probe/wec-msgline-row.txt`。DSM の `dscmd.c` WEC* で出させた）:
 * - 申告なし: 24 行の桁 1 に属性・桁 2 から本文（24 行全体が書き換わる）
 * - SOH で 22 行を申告: 22 行の桁 1 に属性・桁 2 から本文。他の行は変わらない
 * - 90 字の本文: 22 行に 79 字、ACS は続きを 23 行へ上書きする——情報を捨てるので合わせない（decisions D2。当 PJ は 1 行で切る）
 */
describe("0x21 の位置（ACS の実測 3 通り）", () => {
  const wec21 = (body: number[]): number[] => [ESC, COMMAND.WRITE_ERROR_CODE, ...body];

  it("**申告なし: 24 行の 1 行全体**", () => {
    const buf = screen();
    apply(buf, wec21([0x22, ...text("ERR ON MSG LINE")]));
    expect(buf.snapshot().systemMessage).toBe("ERR ON MSG LINE");
    expect(buf.snapshot().systemMessageArea).toEqual({ row: 24, col: 1, width: 80 });
  });

  it("**SOH で 22 行を申告: 22 行の 1 行全体**", () => {
    const buf = screen(22);
    apply(buf, wec21([0x22, ...text("ERR ON MSG LINE")]));
    expect(buf.snapshot().systemMessageArea).toEqual({ row: 22, col: 1, width: 80 });
  });

  it("**90 字の本文は全部残し、重ねる範囲は 22 行の 1 行**（1 行で切るのは UI。23 行のセルにも書かない。decisions D2）", () => {
    const buf = screen(22);
    apply(buf, [...WTD, ORDER.SBA, 23, 2, ...text("ROW 23 KEEP")]);
    const long = "L".repeat(90);
    apply(buf, wec21([0x22, ...text(long)]));
    expect(buf.snapshot().systemMessage).toBe(long);
    expect(buf.snapshot().systemMessageArea).toEqual({ row: 22, col: 1, width: 80 });
    expect(rowText(buf, 23).slice(1, 12)).toBe("ROW 23 KEEP");
  });

  it("**メッセージ行も含めてセルには書かない**（重ねるのは UI）", () => {
    const buf = screen(22);
    const before = rowText(buf, 22);
    apply(buf, wec21([0x22, ...text("ERR ON MSG LINE")]));
    expect(rowText(buf, 22)).toBe(before);
    expect(rowText(buf, 2).slice(1, 11)).toBe("BACKGROUND");
  });

  it("**27×132 の画面では最下行（27）・幅 132**（ACS `processClearFMT` がメッセージ行を画面の行数に戻す。decisions D5）", () => {
    const buf = new ScreenBuffer({ alternate: "27x132" });
    apply(buf, [ESC, COMMAND.CLEAR_UNIT_ALTERNATE, 0x00]);
    apply(buf, wec21([0x22, ...text("WIDE")]));
    expect(buf.snapshot().systemMessageArea).toEqual({ row: 27, col: 1, width: 132 });
  });

  it("**CLEAR UNIT でメッセージ行の申告は最下行へ戻る**（前の画面の SOH を持ち越さない。decisions D5）", () => {
    const buf = screen(22);
    apply(buf, [ESC, COMMAND.CLEAR_UNIT]);
    apply(buf, wec21([0x22, ...text("AFTER CLEAR")]));
    expect(buf.snapshot().systemMessageArea).toEqual({ row: 24, col: 1, width: 80 });
  });

  it("**CLEAR FORMAT TABLE でも最下行へ戻る**", () => {
    const buf = screen(22);
    apply(buf, [ESC, COMMAND.CLEAR_FORMAT_TABLE]);
    apply(buf, wec21([0x22, ...text("AFTER CLEAR")]));
    expect(buf.snapshot().systemMessageArea).toEqual({ row: 24, col: 1, width: 80 });
  });

  it("**出した後に SOH（申告なし）でメッセージ行が最下行へ戻っても、消えるのはメッセージを出した 22 行を書いたとき**（ACS は 22 行のセルに書いている）", () => {
    const buf = screen(22);
    apply(buf, wec21([0x22, ...text("ON ROW 22")]));
    apply(buf, [...WTD, ORDER.SOH, 3, 0x00, 0x00, 0x00, ORDER.SBA, 24, 2, ...text("ROW 24")]);
    expect(buf.snapshot().systemMessage).toBe("ON ROW 22");
    apply(buf, [...WTD, ORDER.SBA, 22, 2, ...text("NEW ROW 22")]);
    expect(buf.snapshot().systemMessage).toBeUndefined();
  });

  it("**SOH の申告は SOH が消すフォーマットテーブルの後に採る**（同じ SOH の申告が残る）。申告の無い SOH は最下行へ戻す", () => {
    const buf = screen(22);
    expect(buf.messageLineRow).toBe(22);
    apply(buf, [...WTD, ORDER.SOH, 3, 0x00, 0x00, 0x00]);
    expect(buf.messageLineRow).toBe(24);
  });
});
