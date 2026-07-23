import { describe, it, expect } from "vitest";
import {
  buildAttributeIdList,
  buildAttributeList,
  parseAttributeList,
  NP_ATTR,
  NP_RC,
  NP_CP
} from "../src/hostserver/spool/netprint-datastream.js";
import { decodeNpString } from "../src/hostserver/spool/netprint-connection.js";

/**
 * MSGW（メッセージ待ち）の検出・応答。
 *
 * 日本語実機で検証済み——用紙タイプを上書きして CPA3394 を誘発し、`answerMessage("I")` で
 * 応答して帳票が印刷されるところまで確認した。ここでは要求の組み立て・応答の解析に加え、
 * そのとき実際に踏んだ 2 つの落とし穴（NUL 終端の送信と受信）を固定する。
 */
describe("buildAttributeIdList（欲しい属性を指定する）", () => {
  const ids = [NP_ATTR.messageId, NP_ATTR.messageText];
  const data = buildAttributeIdList(ids);

  it("件数(2) ＋ 要素長(2) ＋ ID×n", () => {
    const v = new DataView(data.buffer);
    expect(data).toHaveLength(4 + 2 * 2);
    expect(v.getUint16(0)).toBe(2); // 件数
    expect(v.getUint16(2)).toBe(2); // 要素長は常に 2
    expect(v.getUint16(4)).toBe(NP_ATTR.messageId);
    expect(v.getUint16(6)).toBe(NP_ATTR.messageText);
  });

  it("空でも壊れない", () => {
    expect(buildAttributeIdList([])).toHaveLength(4);
  });
});

describe("parseAttributeList（buildAttributeList の逆）", () => {
  it("組み立てた属性リストを解析し直せる（往復）", () => {
    const built = buildAttributeList([
      { id: NP_ATTR.messageId, type: "string", value: "CPA3394", length: 7 },
      { id: NP_ATTR.messageText, type: "string", value: "LOAD FORM", length: 9 }
    ]);
    const parsed = parseAttributeList(built);
    expect(parsed.size).toBe(2);
    expect(parsed.get(NP_ATTR.messageId)).toHaveLength(7);
    expect(parsed.get(NP_ATTR.messageText)).toHaveLength(9);
  });

  it("値オフセットがコードポイントヘッダー 6 を含むことを踏まえて読む", () => {
    const built = buildAttributeList([
      { id: NP_ATTR.messageId, type: "string", value: "AB", length: 2 }
    ]);
    // 書き出し側は +6 して書く。読み取り側は -6 して戻す
    const v = new DataView(built.buffer);
    expect(v.getUint32(4 + 8)).toBe(4 + 12 + 6);
    expect(parseAttributeList(built).get(NP_ATTR.messageId)).toHaveLength(2);
  });

  it("短すぎるデータは空", () => {
    expect(parseAttributeList(new Uint8Array(2)).size).toBe(0);
  });

  it("要素長が不正なら空（誤った位置を読まない）", () => {
    const bad = new Uint8Array(20);
    const v = new DataView(bad.buffer);
    v.setUint16(0, 1);
    v.setUint16(2, 4); // 12 未満
    expect(parseAttributeList(bad).size).toBe(0);
  });

  it("値が範囲外を指すエントリは飛ばす", () => {
    const bad = new Uint8Array(4 + 12);
    const v = new DataView(bad.buffer);
    v.setUint16(0, 1);
    v.setUint16(2, 12);
    v.setUint16(4, NP_ATTR.messageId);
    v.setUint32(8, 100); // 長さ 100（範囲外）
    v.setUint32(12, 6);
    expect(parseAttributeList(bad).size).toBe(0);
  });
});

describe("メッセージ関連の定数", () => {
  it("属性 ID", () => {
    expect(NP_ATTR.messageText).toBe(0x0080);
    expect(NP_ATTR.messageHelp).toBe(0x0081);
    expect(NP_ATTR.messageReply).toBe(0x0082);
    expect(NP_ATTR.messageId).toBe(0x0093);
  });

  it("メッセージが無いことを表す戻りコード（実機で観測）", () => {
    expect(NP_RC.spooledFileNoMessage).toBe(0x000e);
  });

  it("メッセージハンドルのコードポイント", () => {
    expect(NP_CP.messageHandle).toBe(0x000d);
  });
});

/**
 * **NP サーバーの文字列属性は NUL 終端で返る。**
 *
 * `trimEnd()` は空白しか落とさないので NUL が残り、`message.id === "CPA3394"` のような
 * 比較が必ず外れる。実機で `codes=67,80,65,51,51,57,52,0` と末尾 0 を観測した。
 */
describe("decodeNpString（受信側の NUL 終端）", () => {
  /** EBCDIC "CPA3394" + NUL（ホストが実際に返す形） */
  const CPA3394_Z = Uint8Array.from([0xc3, 0xd7, 0xc1, 0xf3, 0xf3, 0xf9, 0xf4, 0x00]);

  it("NUL 終端を落とす（残ると ID 比較が外れる）", () => {
    const id = decodeNpString(CPA3394_Z);
    expect(id).toBe("CPA3394");
    expect(id === "CPA3394", "厳密比較が通る").toBe(true);
  });

  it("NUL より後ろは捨てる（詰め物を値に混ぜない）", () => {
    const withJunk = Uint8Array.from([...CPA3394_Z, 0xe9, 0xe9, 0xe9]);
    expect(decodeNpString(withJunk)).toBe("CPA3394");
  });

  it("NUL が無ければ従来どおり末尾の空白だけ落とす", () => {
    const noNul = Uint8Array.from([0xc1, 0xc2, 0x40, 0x40]);
    expect(decodeNpString(noNul)).toBe("AB");
  });

  it("未設定・空でも壊れない", () => {
    expect(decodeNpString(undefined)).toBe("");
    expect(decodeNpString(new Uint8Array(0))).toBe("");
    expect(decodeNpString(Uint8Array.from([0x00]))).toBe("");
  });
});
