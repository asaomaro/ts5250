import { describe, it, expect } from "vitest";
import {
  parseMessages,
  classifySeverity,
  describeMessage
} from "../src/hostserver/command/command-message.js";

/**
 * 実機（PUB400 / IBM i 7.5・データストリームレベル 11）は CP 0x1106 を返す。
 * CP 0x1102（固定長・古いサーバー）は**実機で観測できていない**ため合成バイト列で担保する。
 */

/** 実機の `DSPLIB LIB(NOSUCHLIB)` 失敗応答（先頭 + メッセージ 1 件） */
const REAL_FAILURE = Buffer.from(
  "000003480000e008000000000000000000048002040000010000033011060000ffff0000ffff002800000002f1f500000007c3d7c6f2f1f1f00000000ad8c3d7c6d4e2c74040400000000ad8e2e8e24040404040400000001cd38982998199a840d5d6e2e4c3c8d3c9c2409596a3408696a495844b0000000ad5d6e2e4c3c8d3c9c240000002c1c381a4a285404b404b404b404b404b407a404040d38982998199a840d5d6e2e4c3c8d3c9c240849685a2409596a34085a789a2a340899540a388854081a4a78993898199a840a2a396998187854097969693a2404dc1e2d7a25d4081838385a2a285844082a840a38885408396949481958440969940c1d7c94b40d9858396a58599a840404b404b404b407a404040c589a38885994083998581a38540a3888540938982998199a8404dc3d9e3d3c9c240839694948195845d6b40839699998583a340a3888540938982998199a840958194856b409699409481928540a3888540979989948199a840969940a285839695848199a84081a4a78993898199a840a2a396998187854097969693404dc1e2d75d40a68885998540a2a396998187854086969940a3888540938982998199a84089a240819393968381a385844081838385a2a28982938540a39640a38885408396949481958440969940c1d7c94b40e388859540a399a840a3888540998598a485a2a34081878189954b40e396409481928540a3888540c1e2d74081838385a2a2898293856b40838885839240a38881a340a3888540c1e2d7408485a5898385408881a240a3888540a2a381a3a4a240998598a4899985844082a840a38885408396949481958440969940c1d7c9404de6d9d2c3c6c7e2e3e240839694948195845d4b40e38885956b40898640a38885408396949481958440969940c1d7c9408881a24081954081a4a78993898199a840a2a39699818785409796969340978199819485a385996b40a4a2854089a340a39640a29785838986a840a3888540c1e2d74b40d6a3888599a689a2856b40a285a340a3888540c1e2d740879996a49740839695a381899589958740a3888540c1e2d74081a240a3888540c1e2d740879996a4974086969940a388854083a499998595a340a38899858184404de2c5e3c1e2d7c7d9d740839694948195845d4b",
  "hex"
);

describe("parseMessages（実機の応答・CP 0x1106）", () => {
  const messages = parseMessages(new Uint8Array(REAL_FAILURE));

  it("メッセージを取り出す", () => {
    expect(messages).toHaveLength(1);
  });

  it("メッセージ ID を EBCDIC から復号する", () => {
    expect(messages[0]!.id).toBe("CPF2110");
  });

  it("重大度と分類を返す", () => {
    expect(messages[0]!.severity).toBe(40);
    expect(messages[0]!.kind).toBe("severe");
  });

  it("テキストを復号する", () => {
    expect(messages[0]!.text).toContain("NOSUCHLIB");
  });

  it("メッセージファイルとライブラリも取れる", () => {
    expect(messages[0]!.file).toBe("QCPFMSG");
    expect(messages[0]!.library).toBe("QSYS");
  });

  it("ヘルプテキストも取れる", () => {
    expect(messages[0]!.help).toBeTruthy();
  });
});

describe("classifySeverity（境界）", () => {
  it("0 は info", () => {
    expect(classifySeverity(0)).toBe("info");
  });
  it("1-19 は warning", () => {
    expect(classifySeverity(1)).toBe("warning");
    expect(classifySeverity(19)).toBe("warning");
  });
  it("20-39 は error", () => {
    expect(classifySeverity(20)).toBe("error");
    expect(classifySeverity(30)).toBe("error");
    expect(classifySeverity(39)).toBe("error");
  });
  it("40 以上は severe", () => {
    expect(classifySeverity(40)).toBe("severe");
    expect(classifySeverity(99)).toBe("severe");
  });
  it("実機で観測した 0 / 30 / 40 が期待どおり分類される", () => {
    expect(classifySeverity(0)).toBe("info");
    expect(classifySeverity(30)).toBe("error");
    expect(classifySeverity(40)).toBe("severe");
  });
});

describe("CP 0x1102（固定長・実機では観測できていない）", () => {
  /** 合成した固定長メッセージ 1 件を含む応答フレーム */
  function frame(): Uint8Array {
    const idBytes = [0xc3, 0xd7, 0xc6, 0xf0, 0xf0, 0xf0, 0xf1]; // "CPF0001"
    const fileBytes = new Array(10).fill(0x40);
    const libBytes = new Array(10).fill(0x40);
    const textBytes = [0xd6, 0xd2]; // "OK"
    const body = [
      ...idBytes,
      0x00, 0x02, // 種別
      0x00, 0x1e, // 重大度 30
      ...fileBytes,
      ...libBytes,
      0x00, 0x00, // 置換データ長
      0x00, 0x02, // テキスト長
      ...textBytes
    ];
    const ll = 6 + body.length;
    const out = new Uint8Array(24 + ll);
    const v = new DataView(out.buffer);
    v.setUint16(22, 1); // メッセージ件数
    v.setUint32(24, ll);
    v.setUint16(28, 0x1102);
    out.set(body, 30);
    return out;
  }

  it("固定長の形式も解析できる", () => {
    const m = parseMessages(frame());
    expect(m).toHaveLength(1);
    expect(m[0]!.id).toBe("CPF0001");
    expect(m[0]!.severity).toBe(30);
    expect(m[0]!.kind).toBe("error");
    expect(m[0]!.text).toBe("OK");
  });
});

describe("異常系（解析全体を落とさない）", () => {
  it("メッセージが無い応答は空配列", () => {
    expect(parseMessages(new Uint8Array(24))).toEqual([]);
  });

  it("短すぎるフレームでも例外にしない", () => {
    expect(parseMessages(new Uint8Array(4))).toEqual([]);
  });

  it("LL が 6 未満なら打ち切る（無限ループ防止）", () => {
    const b = new Uint8Array(40);
    const v = new DataView(b.buffer);
    v.setUint16(22, 5);
    v.setUint32(24, 3);
    expect(parseMessages(b)).toEqual([]);
  });

  it("未知のコードポイントは読み飛ばす", () => {
    const b = new Uint8Array(24 + 10);
    const v = new DataView(b.buffer);
    v.setUint16(22, 1);
    v.setUint32(24, 10);
    v.setUint16(28, 0x9999);
    expect(parseMessages(b)).toEqual([]);
  });

  it("件数が実際より多くても壊れない", () => {
    const b = new Uint8Array(24);
    new DataView(b.buffer).setUint16(22, 99);
    expect(parseMessages(b)).toEqual([]);
  });
});

describe("describeMessage", () => {
  it("ID・分類・重大度・本文を並べる", () => {
    const m = parseMessages(new Uint8Array(REAL_FAILURE))[0]!;
    expect(describeMessage(m)).toMatch(/^CPF2110 \[severe\/40\] /);
  });
});
