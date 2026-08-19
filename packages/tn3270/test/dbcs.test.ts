import { describe, it, expect } from "vitest";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import { Screen3270 } from "../src/screen/buffer.js";
import { applyInbound } from "../src/protocol/inbound.js";
import { snapshot } from "../src/screen/snapshot.js";
import { encodeAddress } from "../src/protocol/address.js";
import { CMD3270, ORDER, WCC, SO, SI } from "../src/protocol/constants.js";

/**
 * DBCS（日本語）の桁勘定。
 *
 * **実測に基づく**（research F5。`s3270 -codepage cp930` の `ReadBuffer(Ebcdic)` で確認）:
 * ```
 * 0e | 45 62 | 45 66 | 48 e7 | 46 c0 | 48 53 | 0f
 * SO |  日   |  本   |  語   |  表   |  示   | SI
 * ```
 * **DBCS 1 文字はバッファ 2 桁**、**SO / SI もそれぞれ 1 桁**を占める。
 */

const sba = (a: number): number[] => [ORDER.SBA, ...encodeAddress(a)];

/** 自前のコーデックで符号化した文字列を含む画面を作る */
function screenWith(text: string, ccsid = 930, addr = 0): Screen3270 {
  const codec = codecForCcsid(ccsid);
  const { bytes } = codec.encode(text);
  const s = new Screen3270(2);
  applyInbound(
    s,
    Uint8Array.from([
      CMD3270.ERASE_WRITE, WCC.RESTORE,
      ...sba(addr), ORDER.SF, 0x20,
      ...bytes
    ])
  );
  return s;
}

describe("符号化（自前テーブル）", () => {
  it("cp930 で日本語が SO/SI で囲まれた DBCS になる", () => {
    const { bytes, substituted } = codecForCcsid(930).encode("日本語表示");
    expect(substituted).toBe(0);
    expect(bytes[0]).toBe(SO);
    expect(bytes[bytes.length - 1]).toBe(SI);
    // 5 文字 × 2 バイト + SO + SI
    expect(bytes.length).toBe(5 * 2 + 2);
  });

  it("混在は SO/SI が内側に入る", () => {
    const { bytes } = codecForCcsid(930).encode("ABあいうDEF");
    const hex = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(hex).toMatch(/^.{4}0e.{12}0f.{6}$/); // AB SO ×3 SI DEF
  });
});

describe("バッファ上の桁勘定", () => {
  it("DBCS 1 文字が 2 桁、SO/SI が各 1 桁を占める", () => {
    const s = screenWith("日本", 930, 0);
    const snap = snapshot(s, { ccsid: 930 });
    const row = snap.cells[0]!;
    // 桁1 = 属性桁、桁2 = SO、桁3-4 = 日、桁5-6 = 本、桁7 = SI
    expect(row[0]!.kind).toBe("attr");
    expect(row[1]!.kind).toBe("so");
    expect(row[2]!.kind).toBe("dbcs-lead");
    expect(row[2]!.char).toBe("日");
    expect(row[3]!.kind).toBe("dbcs-tail");
    expect(row[3]!.char).toBe("");
    expect(row[4]!.kind).toBe("dbcs-lead");
    expect(row[4]!.char).toBe("本");
    expect(row[5]!.kind).toBe("dbcs-tail");
    expect(row[6]!.kind).toBe("si");
  });

  it("SO / SI は画面上も 1 桁ぶん空く（実測どおり）", () => {
    const s = screenWith("日", 930, 0);
    const snap = snapshot(s, { ccsid: 930 });
    expect(snap.cells[0]![1]!.char).toBe(" "); // SO
    expect(snap.cells[0]![4]!.char).toBe(" "); // SI
  });

  it("混在行で SBCS と DBCS が正しく並ぶ", () => {
    const s = screenWith("ABあいうDEF", 930, 0);
    const snap = snapshot(s, { ccsid: 930 });
    const chars = snap.cells[0]!.slice(0, 14).map((c) => c.char).join("|");
    // 属性 A B SO あ (tail) い (tail) う (tail) SI D E F
    expect(chars).toBe(" |A|B| |あ||い||う|| |D|E|F");
  });

  it("欄の value は DBCS を 1 文字として持つ", () => {
    const s = screenWith("日本語", 930, 0);
    const snap = snapshot(s, { ccsid: 930 });
    expect(snap.fields.length).toBe(1);
    // 欄の中身は SO(1 桁) + 日本語 + SI(1 桁)。SO/SI は空白として現れる
    expect(snap.fields[0]!.value.startsWith(" 日本語 ")).toBe(true);
    // **DBCS は 1 文字として数える**（tail 桁は value に入れない）
    expect([...snap.fields[0]!.value.trim()].length).toBe(3);
  });
});

describe("cp939（japanese-latin）", () => {
  it("同じ日本語が cp939 でも往復する", () => {
    const s = screenWith("日本語", 939, 0);
    const snap = snapshot(s, { ccsid: 939 });
    const text = snap.cells[0]!.map((c) => c.char).join("");
    expect(text).toContain("日本語");
  });
});

describe("異常系", () => {
  it("SI が来ないまま行末に達しても壊れない", () => {
    const s = new Screen3270(2);
    applyInbound(
      s,
      Uint8Array.from([
        CMD3270.ERASE_WRITE, WCC.RESTORE,
        ...sba(0), ORDER.SF, 0x20,
        SO, 0x45, 0x62, 0x45, 0x66 // SO のあと SI が来ない
      ])
    );
    const snap = snapshot(s, { ccsid: 930 });
    expect(snap.cells[0]![2]!.char).toBe("日");
    // 行が変わったら DBCS 区間は解除される（行ごとに判定するため）
    expect(snap.cells[1]![0]!.kind).toBe("sbcs");
  });

  it("DBCS を SBCS の CCSID で読んでも落ちない", () => {
    const s = screenWith("日本", 930, 0);
    const snap = snapshot(s, { ccsid: 37 }); // 37 は SBCS
    expect(snap.cells[0]!.length).toBe(80); // 落ちずに描ける
  });

  it("対応しないコードポイントは substituted に数えられる", () => {
    const r = codecForCcsid(930).encode("日\u{20BB7}"); // サロゲートペアの漢字
    expect(r.substituted).toBeGreaterThan(0);
  });
});

describe("入力側の DBCS", () => {
  it("type() で日本語を打つと SO/SI 込みでバッファに入る", async () => {
    const { Tn3270Session } = await import("../src/session/session.js");
    const { IAC, CMD, OPT, TT_SEND } = await import("../src/telnet/constants.js");
    type T = import("../src/transport/types.js").Transport;

    const sent: number[][] = [];
    let dataFn: ((d: Uint8Array) => void) | undefined;
    const t: T = {
      send: (d) => sent.push([...d]),
      close: () => undefined,
      onData: (fn) => (dataFn = fn),
      onClose: () => undefined,
      onError: () => undefined
    };
    const s = new Tn3270Session({ host: "x", model: 2, ccsid: 930 });
    s.attach(t);
    const recv = (...b: number[]): void => dataFn?.(Uint8Array.from(b));
    recv(IAC, CMD.DO, OPT.TERMINAL_TYPE);
    recv(IAC, CMD.SB, OPT.TERMINAL_TYPE, TT_SEND, IAC, CMD.SE);
    recv(IAC, CMD.DO, OPT.END_OF_RECORD, IAC, CMD.WILL, OPT.END_OF_RECORD);
    recv(IAC, CMD.DO, OPT.BINARY, IAC, CMD.WILL, OPT.BINARY);
    // 非保護欄を 1 つ置いた画面
    recv(
      CMD3270.ERASE_WRITE, WCC.RESTORE,
      ...sba(0), ORDER.SF, 0x00,
      ...sba(40), ORDER.SF, 0x20,
      ...sba(1), ORDER.IC,
      IAC, CMD.EOR
    );

    s.setCursor(1, 2);
    s.type("日本");

    const snap = s.snapshot();
    const row = snap.cells[0]!;
    expect(row[1]!.kind).toBe("so");
    expect(row[2]!.char).toBe("日");
    expect(row[4]!.char).toBe("本");
    expect(row[6]!.kind).toBe("si");
    // **MDT が立ち、送信バイトに DBCS がそのまま乗る**
    expect(snap.fields[0]!.modified).toBe(true);
    s.send("enter");
    const last = (sent[sent.length - 1] ?? []).map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(last).toMatch(/0e4562456{1,2}6.*0f/); // SO … SI が含まれる
  });

  it("欄からあふれた入力は次の欄の属性桁で止まる（**現状の挙動を固定**）", () => {
    // **既知の制限**: 欄の桁数チェックは持っていない。カーソルを進めた先が
    // 属性桁なら FIELD_PROTECTED で止まる、という副作用的な防御しかない。
    // 「欄あふれ」を明示的に扱うかは後続 work で決める（review に残した）
    const s = new Screen3270(2);
    applyInbound(
      s,
      Uint8Array.from([
        CMD3270.ERASE_WRITE, WCC.RESTORE,
        ...sba(0), ORDER.SF, 0x00,   // 非保護（中身は 1〜4 の 4 桁）
        ...sba(5), ORDER.SF, 0x20    // 桁 5 が次の属性桁
      ])
    );
    // 中身 4 桁に 5 バイト書こうとすると 5 バイト目が属性桁に当たる
    expect(s.isAttrPos(5)).toBe(true);
    expect(s.isProtectedAt(6)).toBe(true);
  });
});
