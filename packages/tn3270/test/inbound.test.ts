import { describe, it, expect } from "vitest";
import { Screen3270 } from "../src/screen/buffer.js";
import { applyInbound } from "../src/protocol/inbound.js";
import { snapshot } from "../src/screen/snapshot.js";
import { encodeAddress } from "../src/protocol/address.js";
import { CMD3270, ORDER, WCC, XA, COLOR, HILITE } from "../src/protocol/constants.js";

/** テスト用のデータストリーム組み立て */
function ds(...parts: (number | number[])[]): Uint8Array {
  const out: number[] = [];
  for (const p of parts) {
    if (Array.isArray(p)) out.push(...p);
    else out.push(p);
  }
  return Uint8Array.from(out);
}
const sba = (addr: number): number[] => [ORDER.SBA, ...encodeAddress(addr)];
/** "AB" のような ASCII を CCSID 37 の EBCDIC に（テストの読みやすさのため簡易表） */
const E: Record<string, number> = { A: 0xc1, B: 0xc2, C: 0xc3, D: 0xc4, E: 0xc5, "*": 0x5c };
const txt = (s: string): number[] => [...s].map((c) => E[c] ?? 0x40);

describe("コマンド", () => {
  it("Erase/Write は標準サイズにして消す（spec D5）", () => {
    const s = new Screen3270(5);
    s.resize(true);
    expect(s.rows).toBe(27);
    applyInbound(s, ds(CMD3270.ERASE_WRITE, 0x00));
    expect([s.rows, s.cols]).toEqual([24, 80]);
    expect(s.alternate).toBe(false);
  });

  it("Erase/Write Alternate は代替サイズにする（spec D5）", () => {
    const s = new Screen3270(5);
    applyInbound(s, ds(CMD3270.ERASE_WRITE_ALTERNATE, 0x00));
    expect([s.rows, s.cols]).toEqual([27, 132]);
    expect(s.alternate).toBe(true);
  });

  it("Write はサイズも内容も消さない", () => {
    const s = new Screen3270(2);
    applyInbound(s, ds(CMD3270.ERASE_WRITE, 0x00, sba(0), ORDER.SF, 0x00, txt("AB")));
    applyInbound(s, ds(CMD3270.WRITE, 0x00, sba(10), txt("C")));
    expect(s.charAt(1)).toBe(E["A"]);
    expect(s.charAt(10)).toBe(E["C"]);
  });

  it("読み取り要求はそのまま返す（応答は subtask 03）", () => {
    const s = new Screen3270(2);
    expect(applyInbound(s, ds(CMD3270.READ_BUFFER)).read).toBe("read-buffer");
    expect(applyInbound(s, ds(CMD3270.READ_MODIFIED)).read).toBe("read-modified");
    expect(applyInbound(s, ds(CMD3270.READ_MODIFIED_ALL)).read).toBe("read-modified-all");
  });

  it("未知のコマンドは落とさず記録する", () => {
    const s = new Screen3270(2);
    const r = applyInbound(s, ds(0x99, 0x00));
    expect(r.unknown).toEqual([{ kind: "command", byte: 0x99, offset: 0 }]);
  });
});

describe("WCC（実測: 01=resetMDT / 02=restore / 04=alarm）", () => {
  it("restore でキーボードのロックが解ける", () => {
    const s = new Screen3270(2);
    s.setKeyboardLocked(true);
    const r = applyInbound(s, ds(CMD3270.WRITE, WCC.RESTORE));
    expect(r.keyboardRestored).toBe(true);
    expect(s.keyboardLocked).toBe(false);
  });

  it("resetMDT で全欄の MDT が落ちる", () => {
    const s = new Screen3270(2);
    applyInbound(s, ds(CMD3270.ERASE_WRITE, 0x00, sba(0), ORDER.SF, 0x01));
    const r = applyInbound(s, ds(CMD3270.WRITE, WCC.RESET_MDT));
    expect(r.resetMdt).toBe(true);
    expect(s.attrAt(0) & 0x01).toBe(0);
  });

  it("alarm を拾う", () => {
    const s = new Screen3270(2);
    expect(applyInbound(s, ds(CMD3270.WRITE, WCC.ALARM)).alarm).toBe(true);
  });
});

describe("オーダー", () => {
  it("SBA でアドレスを移し、データを順に置く", () => {
    const s = new Screen3270(2);
    applyInbound(s, ds(CMD3270.ERASE_WRITE, 0x00, sba(80), txt("ABC")));
    expect(s.charAt(80)).toBe(E["A"]);
    expect(s.charAt(82)).toBe(E["C"]);
  });

  it("SF は属性桁を置き、**1 桁進む**", () => {
    const s = new Screen3270(2);
    applyInbound(s, ds(CMD3270.ERASE_WRITE, 0x00, sba(0), ORDER.SF, 0x20, txt("A")));
    expect(s.isAttrPos(0)).toBe(true);
    expect(s.charAt(1)).toBe(E["A"]); // 属性の次から中身
  });

  it("SFE は基本属性と拡張属性を同時に置く", () => {
    const s = new Screen3270(2);
    applyInbound(
      s,
      ds(
        CMD3270.ERASE_WRITE,
        0x00,
        sba(0),
        ORDER.SFE,
        0x02,
        XA.BASIC,
        0x20,
        XA.FOREGROUND,
        COLOR.RED,
        txt("A")
      )
    );
    expect(s.isAttrPos(0)).toBe(true);
    expect(s.attrAt(0)).toBe(0x20);
    expect(s.extAt(1).color).toBe(COLOR.RED);
  });

  it("SA は以降の文字に効く", () => {
    const s = new Screen3270(2);
    applyInbound(
      s,
      ds(CMD3270.ERASE_WRITE, 0x00, sba(0), ORDER.SA, XA.HIGHLIGHT, HILITE.REVERSE, txt("AB"))
    );
    expect(s.extAt(0).hilite).toBe(HILITE.REVERSE);
    expect(s.extAt(1).hilite).toBe(HILITE.REVERSE);
  });

  it("IC はカーソルを現在アドレスに置く", () => {
    const s = new Screen3270(2);
    applyInbound(s, ds(CMD3270.ERASE_WRITE, 0x00, sba(85), ORDER.IC));
    expect(s.cursor).toBe(85);
    expect(s.rowColOf(s.cursor)).toEqual({ row: 2, col: 6 });
  });

  it("RA は指定アドレスの手前まで繰り返す", () => {
    const s = new Screen3270(2);
    applyInbound(s, ds(CMD3270.ERASE_WRITE, 0x00, sba(0), ORDER.RA, ...encodeAddress(5), E["*"]!));
    for (let i = 0; i < 5; i++) expect(s.charAt(i)).toBe(E["*"]);
    expect(s.charAt(5)).toBe(0x00); // 手前まで
  });

  it("EUA は非保護欄だけ消す", () => {
    const s = new Screen3270(2);
    applyInbound(
      s,
      ds(CMD3270.ERASE_WRITE, 0x00, sba(0), ORDER.SF, 0x00, txt("ABC"))
    );
    expect(s.charAt(1)).toBe(E["A"]);
    applyInbound(s, ds(CMD3270.WRITE, 0x00, sba(1), ORDER.EUA, ...encodeAddress(4)));
    expect(s.charAt(1)).toBe(0x00);
  });

  it("PT は次の非保護欄の先頭へ飛ぶ", () => {
    const s = new Screen3270(2);
    applyInbound(
      s,
      ds(
        CMD3270.ERASE_WRITE,
        0x00,
        sba(0),
        ORDER.SF, 0x20,       // 保護欄
        sba(10),
        ORDER.SF, 0x00,       // 非保護欄
        sba(0),
        ORDER.PT,
        txt("A")
      )
    );
    expect(s.charAt(11)).toBe(E["A"]); // 非保護欄の先頭に書かれた
  });

  it("GE の次の 1 文字はそのまま置く", () => {
    const s = new Screen3270(2);
    applyInbound(s, ds(CMD3270.ERASE_WRITE, 0x00, sba(0), ORDER.GE, E["A"]!));
    expect(s.charAt(0)).toBe(E["A"]);
  });

  it("未知のオーダーは落とさず記録して読み飛ばす", () => {
    const s = new Screen3270(2);
    const r = applyInbound(s, ds(CMD3270.ERASE_WRITE, 0x00, sba(0), 0x1a, txt("A")));
    expect(r.unknown).toEqual([{ kind: "order", byte: 0x1a, offset: 5 }]);
    expect(s.charAt(0)).toBe(E["A"]); // 後続は普通に処理される
  });
});

describe("フィールド導出（snapshot）", () => {
  it("属性桁の次から次の属性桁の直前までが 1 欄", () => {
    const s = new Screen3270(2);
    applyInbound(
      s,
      ds(
        CMD3270.ERASE_WRITE, 0x00,
        sba(0), ORDER.SF, 0x20, txt("AB"),   // 保護欄（中身 2 桁 + 空白）
        sba(10), ORDER.SF, 0x00, txt("CD")   // 非保護欄
      )
    );
    const snap = snapshot(s);
    expect(snap.fields.length).toBe(2);
    const [f1, f2] = snap.fields;
    expect(f1!.protected).toBe(true);
    expect(f1!.row).toBe(1);
    expect(f1!.col).toBe(2); // 属性桁(1)の次
    expect(f1!.length).toBe(9); // 桁 1..9（次の属性桁は 10）
    expect(f1!.value.startsWith("AB")).toBe(true);
    expect(f2!.protected).toBe(false);
    expect(f2!.value.startsWith("CD")).toBe(true);
  });

  it("非表示欄は value を出さない", () => {
    const s = new Screen3270(2);
    applyInbound(s, ds(CMD3270.ERASE_WRITE, 0x00, sba(0), ORDER.SF, 0x0c, txt("AB")));
    const snap = snapshot(s);
    expect(snap.fields[0]!.hidden).toBe(true);
    expect(snap.fields[0]!.value).toBe("");
  });

  it("属性桁が無ければ非フォーマット画面", () => {
    const s = new Screen3270(2);
    applyInbound(s, ds(CMD3270.ERASE_WRITE, 0x00, sba(0), txt("AB")));
    const snap = snapshot(s);
    expect(snap.unformatted).toBe(true);
    expect(snap.fields).toEqual([]);
    expect(snap.cells[0]![0]!.char).toBe("A");
  });

  it("属性桁は空白として描かれる", () => {
    const s = new Screen3270(2);
    applyInbound(s, ds(CMD3270.ERASE_WRITE, 0x00, sba(0), ORDER.SF, 0x20, txt("A")));
    const snap = snapshot(s);
    expect(snap.cells[0]![0]!.kind).toBe("attr");
    expect(snap.cells[0]![0]!.char).toBe(" ");
    expect(snap.cells[0]![1]!.char).toBe("A");
  });
});
