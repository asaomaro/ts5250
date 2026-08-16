import { describe, it, expect } from "vitest";
import { Screen3270 } from "../src/screen/buffer.js";
import { applyInbound } from "../src/protocol/inbound.js";
import { buildReadModified, buildReadBuffer } from "../src/protocol/outbound.js";
import { encodeAddress, encodeAttribute } from "../src/protocol/address.js";
import { CMD3270, ORDER, XA } from "../src/protocol/constants.js";
import { AID, AID_NONE } from "../src/session/aid-keys.js";

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}
const sba = (a: number): number[] => [ORDER.SBA, ...encodeAddress(a)];

/** aid.trc の探針と同じ画面: 行1 に非保護、行1 桁21 に保護、カーソルは桁 2 */
function probeScreen(): Screen3270 {
  const s = new Screen3270(2);
  applyInbound(
    s,
    Uint8Array.from([
      CMD3270.ERASE_WRITE, 0xc3,
      ...sba(0), ORDER.SF, 0x00,
      ...sba(20), ORDER.SF, 0x20,
      ...sba(730), ORDER.SF, 0x00,
      ...sba(760), ORDER.SF, 0x20,
      ...sba(1), ORDER.IC
    ])
  );
  return s;
}

describe("AID コード（実測値・aid.trc）", () => {
  it("実測した 29 個と一致する", () => {
    expect(AID.enter).toBe(0x7d);
    expect(AID.pf1).toBe(0xf1);
    expect(AID.pf9).toBe(0xf9);
    expect(AID.pf10).toBe(0x7a);
    expect(AID.pf12).toBe(0x7c);
    expect(AID.pf13).toBe(0xc1);
    expect(AID.pf21).toBe(0xc9);
    expect(AID.pf22).toBe(0x4a);
    expect(AID.pf24).toBe(0x4c);
    expect(AID.pa1).toBe(0x6c);
    expect(AID.pa2).toBe(0x6e);
    expect(AID.pa3).toBe(0x6b);
    expect(AID.clear).toBe(0x6d);
    expect(AID_NONE).toBe(0x60);
  });
});

describe("Read Modified の形（実測と一致すること）", () => {
  it("入力なしの Enter は AID + カーソルだけ（実測 7d40c1）", () => {
    const s = probeScreen();
    expect(hex(buildReadModified(s, "enter"))).toBe("7d40c1");
  });

  it("PF キーも AID + カーソル（実測 f140c1 / 4c40c1）", () => {
    const s = probeScreen();
    expect(hex(buildReadModified(s, "pf1"))).toBe("f140c1");
    expect(hex(buildReadModified(s, "pf24"))).toBe("4c40c1");
  });

  it("**PA / Clear は AID 1 バイトだけ**（実測 6c / 6e / 6b / 6d）", () => {
    const s = probeScreen();
    // spec には「AID とカーソルアドレスのみ」と書いたが、実測ではカーソルすら無い
    expect(hex(buildReadModified(s, "pa1"))).toBe("6c");
    expect(hex(buildReadModified(s, "pa2"))).toBe("6e");
    expect(hex(buildReadModified(s, "pa3"))).toBe("6b");
    expect(hex(buildReadModified(s, "clear"))).toBe("6d");
  });

  it("**変更欄ごとに SBA を前置する**（実測: 7d 4b5d 1140c1 c1c2 114b5b e9e9）", () => {
    const s = probeScreen();
    // 行1 の欄（属性桁 0、中身 1〜）に "AB"、行10 の欄（属性桁 730、中身 731〜）に "ZZ"
    s.writeChar(1, 0xc1);
    s.writeChar(2, 0xc2);
    s.setMdtFor(1, true);
    s.writeChar(731, 0xe9);
    s.writeChar(732, 0xe9);
    s.setMdtFor(731, true);
    s.setCursor(733);
    expect(hex(buildReadModified(s, "enter"))).toBe(
      "7d" + hex(Uint8Array.from(encodeAddress(733))) +
      "11" + hex(Uint8Array.from(encodeAddress(1))) + "c1c2" +
      "11" + hex(Uint8Array.from(encodeAddress(731))) + "e9e9"
    );
  });

  it("**非フォーマット画面では SBA を出さない**（実測）", () => {
    // Clear の後など属性桁が 1 つも無い画面。ここを取り違えて
    // 「s3270 は SBA を出さない」と誤結論しかけた（outbound.ts のコメント参照）
    const s = new Screen3270(2);
    s.writeChar(0, 0xc1);
    s.writeChar(1, 0xc2);
    s.setCursor(2);
    const out = hex(buildReadModified(s, "enter"));
    expect(out.includes("11")).toBe(false);
    expect(out.endsWith("c1c2")).toBe(true);
  });

  it("MDT が立っていない欄は送らない", () => {
    const s = probeScreen();
    s.writeChar(1, 0xc1); // 書くだけで MDT は立てない
    expect(hex(buildReadModified(s, "enter"))).toBe("7d40c1");
  });

  it("ホスト起動の読み取りは AID 0x60（実測）", () => {
    const s = probeScreen();
    s.writeChar(1, 0xc1);
    s.setMdtFor(1, true);
    const out = buildReadModified(s, null);
    expect(out[0]).toBe(AID_NONE);
  });

  it("欄の中の NUL は詰めて送る（実測: 残り桁を埋めてこない）", () => {
    const s = probeScreen();
    s.writeChar(1, 0xc1);
    s.writeChar(3, 0xc2); // 桁 2 は NUL のまま
    s.setMdtFor(1, true);
    expect(hex(buildReadModified(s, "enter")).endsWith("c1c2")).toBe(true);
  });
});

describe("Read Buffer", () => {
  it("**属性桁は SF オーダー＋属性バイトで返す**（s3270 と突き合わせて確定）", () => {
    // 当初は属性バイトを裸で置いていたが、s3270 は `1d60` と SF を出していた。
    // TK4- も IBM i もこのコマンドを撃ってこないので、実ホストでは見つからない誤りだった
    const s = probeScreen();
    const out = buildReadBuffer(s);
    expect(out[0]).toBe(AID_NONE);
    // 桁 0 は属性桁 → SF(0x1d) + 属性(0x00) の 2 バイト
    expect(out[3]).toBe(ORDER.SF);
    // **属性バイトはそのまま返さない**——意味を持つ 6 ビットを CODE 表で引き直す。
    // 0x00 は 0x40 になる（s3270 と 256 通りで突き合わせ済み）
    expect(out[4]).toBe(encodeAttribute(0x00));
    expect(out[4]).toBe(0x40);
    // 全長 = AID(1) + カーソル(2) + 全桁 + 属性桁の数（SF の分だけ増える）
    const attrCount = s.attrPositions().length;
    expect(out.length).toBe(3 + s.size + attrCount);
  });

  it("属性桁以外は生バイトをそのまま並べる", () => {
    const s = probeScreen();
    s.writeChar(1, 0xc1);
    const out = buildReadBuffer(s);
    // 桁 0 が SF+attr の 2 バイトなので、桁 1 の文字は index 5
    expect(out[5]).toBe(0xc1);
  });
});

describe("応答モード（Set Reply Mode）", () => {
  /** 色・下線つきの欄と、途中で色を変えた文字を持つ画面 */
  function colored(): Screen3270 {
    const s = new Screen3270(2);
    applyInbound(
      s,
      Uint8Array.from([
        CMD3270.ERASE_WRITE, 0x00,
        ORDER.SBA, ...encodeAddress(0),
        ORDER.SFE, 0x03, XA.BASIC, 0x60, XA.FOREGROUND, 0xf2, XA.HIGHLIGHT, 0xf4,
        0xc1, 0xc2,
        ORDER.SA, XA.FOREGROUND, 0xf1, 0xc3,
        ORDER.SBA, ...encodeAddress(20), ORDER.SF, 0x00
      ])
    );
    return s;
  }
  const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

  it("**欄モードは SF ＋属性だけ**（拡張属性を載せない）", () => {
    const out = hex(buildReadBuffer(colored(), null, { reply: { mode: 0, types: [] } }));
    expect(out).toContain("1d60");
    expect(out).not.toContain("29");
  });

  it("**拡張欄モードは SFE で返す**——並びは基本→前景→背景→ハイライト→文字セット", () => {
    const out = hex(buildReadBuffer(colored(), null, { reply: { mode: 1, types: [] } }));
    expect(out).toContain("2903c06042f241f4"); // 3 組。値が 0 の背景と文字セットは載らない
    expect(out).toContain("2901c040"); // 拡張属性の無い欄は基本だけ
    expect(out).not.toContain("28"); // 文字ごとの SA は出さない
  });

  it("**文字モードは SA を挟む**——ただしホストが並べた種類だけ", () => {
    const s = colored();
    const withFg = hex(buildReadBuffer(s, null, { reply: { mode: 2, types: [XA.FOREGROUND] } }));
    expect(withFg).toContain("2842f1"); // 色が変わった桁で 1 度だけ
    expect(withFg.match(/2842/g)?.length).toBe(2); // 変わったときと 0 に戻ったとき

    const noTypes = hex(buildReadBuffer(s, null, { reply: { mode: 2, types: [] } }));
    expect(noTypes).not.toContain("28"); // 種類が並んでいなければ何も載せない
  });

  it("**`GE` で置いた桁は `GE` を前置して返す**（s3270 と突き合わせ済み）", () => {
    const s = new Screen3270(2);
    applyInbound(
      s,
      Uint8Array.from([
        CMD3270.ERASE_WRITE, 0x00,
        ORDER.SBA, ...encodeAddress(0), ORDER.SF, 0x60, ORDER.GE, 0xc1
      ])
    );
    const out = hex(buildReadBuffer(s));
    expect(out).toContain("08c1"); // GE ＋ バイト
  });
});
