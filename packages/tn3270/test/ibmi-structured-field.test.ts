import { describe, it, expect } from "vitest";
import { Screen3270 } from "../src/screen/buffer.js";
import { applyInbound } from "../src/protocol/inbound.js";
import { snapshot } from "../src/screen/snapshot.js";
import { normalizeCommand, CMD3270, ORDER, WCC } from "../src/protocol/constants.js";
import { encodeAddress } from "../src/protocol/address.js";
import {
  splitStructuredFields,
  asQueryRequest,
  buildQueryReply,
  SF_TYPE,
  QR,
  AID_STRUCTURED_FIELD
} from "../src/protocol/query-reply.js";

/**
 * IBM i 接続に要る 3 点の回帰。**どれも TK4-（MVS 3.8j）だけでは見つからなかった**
 * ——Hercules は EBCDIC 系のコマンドコードを使い、Query も撃ってこないため。
 */

const sba = (a: number): number[] => [ORDER.SBA, ...encodeAddress(a)];

describe("コマンドコードの 2 系統（実測: cmd.trc）", () => {
  it("SNA 系が EBCDIC 系に正規化される", () => {
    expect(normalizeCommand(0x01)).toBe(CMD3270.WRITE);
    expect(normalizeCommand(0x05)).toBe(CMD3270.ERASE_WRITE);
    expect(normalizeCommand(0x0d)).toBe(CMD3270.ERASE_WRITE_ALTERNATE);
    expect(normalizeCommand(0x02)).toBe(CMD3270.READ_BUFFER);
    expect(normalizeCommand(0x06)).toBe(CMD3270.READ_MODIFIED);
    expect(normalizeCommand(0x0e)).toBe(CMD3270.READ_MODIFIED_ALL);
    expect(normalizeCommand(0x0f)).toBe(CMD3270.ERASE_ALL_UNPROTECTED);
    expect(normalizeCommand(0x11)).toBe(CMD3270.WRITE_STRUCTURED_FIELD);
  });

  it("EBCDIC 系はそのまま通る", () => {
    for (const c of Object.values(CMD3270)) expect(normalizeCommand(c)).toBe(c);
  });

  it("未知の値は変えない（呼び出し側が未知として記録する）", () => {
    expect(normalizeCommand(0x99)).toBe(0x99);
  });

  it("**SNA 系の Erase/Write が実際に適用される**", () => {
    const s = new Screen3270(2);
    // 0x05 = SNA 系の Erase/Write
    applyInbound(s, Uint8Array.from([0x05, WCC.RESTORE, ...sba(0), ORDER.SF, 0x20, 0xc1]));
    expect(s.isAttrPos(0)).toBe(true);
    expect(s.charAt(1)).toBe(0xc1);
  });
});

describe("構造化フィールドの走査", () => {
  it("IBM i の Query 要求を読み取る（実測バイト: 11 00 00 01 ff 02）", () => {
    const rec = Uint8Array.from([0x11, 0x00, 0x00, SF_TYPE.READ_PARTITION, 0xff, 0x02]);
    const sfs = splitStructuredFields(rec);
    expect(sfs.length).toBe(1);
    expect(asQueryRequest(sfs[0]!)).toEqual({ kind: "query", partition: 0xff });
  });

  it("**長さ 0 は「レコード末尾まで」**（IBM i はこの形で送ってくる）", () => {
    const rec = Uint8Array.from([0x11, 0x00, 0x00, SF_TYPE.READ_PARTITION, 0xff, 0x02, 0xaa]);
    expect(splitStructuredFields(rec)[0]!.body.length).toBe(3); // ff 02 aa
  });

  it("**1 レコードに複数の SF が並ぶ**（画面の後ろに Set Reply Mode が続く形を実測）", () => {
    const inner = [CMD3270.ERASE_WRITE, WCC.RESTORE, ...sba(0), ORDER.SF, 0x20, 0xc1];
    const ds = [0x00, ...inner]; // パーティション ID + データストリーム
    const rec = Uint8Array.from([
      0x11,
      ...[0x00, ds.length + 3], SF_TYPE.OUTBOUND_3270DS, ...ds,
      ...[0x00, 0x05], SF_TYPE.SET_REPLY_MODE, 0x00, 0x02
    ]);
    const sfs = splitStructuredFields(rec);
    expect(sfs.map((s) => s.type)).toEqual([SF_TYPE.OUTBOUND_3270DS, SF_TYPE.SET_REPLY_MODE]);
  });
});

describe("Outbound 3270DS の展開", () => {
  it("**封筒を開けて中の画面が適用される**（IBM i は画面をこれで包んで送る）", () => {
    const inner = [CMD3270.ERASE_WRITE, WCC.RESTORE, ...sba(0), ORDER.SF, 0x20, 0xc1, 0xc2];
    const ds = [0x00, ...inner];
    const rec = Uint8Array.from([
      0x11, 0x00, ds.length + 3, SF_TYPE.OUTBOUND_3270DS, ...ds
    ]);
    const s = new Screen3270(2);
    const r = applyInbound(s, rec);
    expect(r.unknown).toEqual([]);
    expect(r.keyboardRestored).toBe(true); // 中の WCC も効く
    const snap = snapshot(s);
    expect(snap.fields.length).toBe(1);
    expect(snap.cells[0]![1]!.char).toBe("A");
    expect(snap.cells[0]![2]!.char).toBe("B");
  });

  it("Set Reply Mode は黙って受ける（返すものが無い）", () => {
    const rec = Uint8Array.from([0x11, 0x00, 0x05, SF_TYPE.SET_REPLY_MODE, 0x00, 0x02]);
    expect(applyInbound(new Screen3270(2), rec).unknown).toEqual([]);
  });

  it("未知の構造化フィールドは記録して読み飛ばす", () => {
    const rec = Uint8Array.from([0x11, 0x00, 0x05, 0x77, 0x00, 0x00]);
    const r = applyInbound(new Screen3270(2), rec);
    expect(r.unknown).toEqual([{ kind: "structured-field", byte: 0x77, offset: 0 }]);
  });
});

describe("Query Reply", () => {
  it("AID 0x88 で始まり Summary が先頭に来る（実測の形）", () => {
    const qr = buildQueryReply({ model: 2 });
    expect(qr[0]).toBe(AID_STRUCTURED_FIELD);
    expect(qr[3]).toBe(SF_TYPE.QUERY_REPLY);
    expect(qr[4]).toBe(QR.SUMMARY);
  });

  it("Summary が後続の種別をすべて列挙している（自己整合）", () => {
    const qr = buildQueryReply({ model: 2 });
    const kinds: number[] = [];
    let i = 1;
    while (i + 3 <= qr.length) {
      const len = (qr[i]! << 8) | qr[i + 1]!;
      if (len === 0) break;
      kinds.push(qr[i + 3]!);
      i += len;
    }
    // Summary の中身（種別の列挙）と、実際に並んでいる種別が一致すること
    const summaryLen = (qr[1]! << 8) | qr[2]!;
    const listed = [...qr.subarray(5, 1 + summaryLen)];
    expect(listed).toEqual(kinds);
  });

  it("**DBCS を申告すると CharacterSets が DBCS 記述子を持つ**", () => {
    // 日本語 IBM i は DBCS 申告が無いと画面を出さない（実測）
    const plain = buildQueryReply({ model: 2, dbcs: false });
    const dbcs = buildQueryReply({ model: 2, dbcs: true });
    expect(dbcs.length).toBeGreaterThan(plain.length);
    const csOf = (b: Uint8Array): number[] => {
      let i = 1;
      while (i + 3 <= b.length) {
        const len = (b[i]! << 8) | b[i + 1]!;
        if (len === 0) break;
        if (b[i + 3] === QR.CHARACTER_SETS) return [...b.subarray(i + 4, i + len)];
        i += len;
      }
      return [];
    };
    const cs = csOf(dbcs);
    expect(cs[0]).toBe(0x8e); // GE 可 ＋ DBCS 有り
    expect(cs[8]).toBe(0x0b); // 記述子 1 件 11 バイト
    // 3 件目が全角セル（SW=18）の DBCS 記述子
    expect(cs.slice(9 + 22, 9 + 22 + 5)).toEqual([0x80, 0x20, 0xf8, 0x12, 0x0c]);
    expect(csOf(plain)[0]).toBe(0x82);
  });

  it("モデルごとに UsableArea のサイズが変わる", () => {
    const ua = (m: 2 | 5): number[] => {
      const b = buildQueryReply({ model: m });
      let i = 1;
      while (i + 3 <= b.length) {
        const len = (b[i]! << 8) | b[i + 1]!;
        if (len === 0) break;
        if (b[i + 3] === QR.USABLE_AREA) return [...b.subarray(i + 4, i + len)];
        i += len;
      }
      return [];
    };
    expect(ua(2).slice(2, 6)).toEqual([0x00, 80, 0x00, 24]);
    expect(ua(5).slice(2, 6)).toEqual([0x00, 132, 0x00, 27]);
  });
});

describe("CCSID → デバイス属性（RFC 2877）", () => {
  it("英語と日本語で申告値が変わる", async () => {
    const { deviceEnvFor } = await import("@ts5250/base");
    expect(deviceEnvFor(37)).toEqual({ kbdType: "USB", codePage: 37, charSet: 697 });
    // 日本語 DBCS は **SBCS 部**を申告する（930 はカタカナ 290）
    expect(deviceEnvFor(930)).toEqual({ kbdType: "JKB", codePage: 290, charSet: 1172 });
    expect(deviceEnvFor(939)).toEqual({ kbdType: "JPB", codePage: 1027, charSet: 1172 });
  });

  it("未知の CCSID は申告しない", async () => {
    const { deviceEnvFor } = await import("@ts5250/base");
    expect(deviceEnvFor(1234)).toBeUndefined();
  });
});
