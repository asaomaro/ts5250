import { describe, it, expect } from "vitest";
import {
  FILE_SERVER_ID,
  FILE_REQ,
  FILE_ACCESS,
  FILE_DUPLICATE,
  REPLY_ERROR,
  REPLY_READ,
  buildFileExchangeAttributes,
  buildOpenFileRequest,
  buildReadRequest,
  buildWriteRequest,
  buildCloseRequest,
  buildDeleteRequest,
  replyId,
  replyReturnCode,
  replyFileHandle,
  readReplyData,
  fileErrorText
} from "../src/hostserver/ifs/ifs-datastream.js";
import { Tn5250Error } from "../src/errors.js";

/**
 * テンプレート長と項目位置は実機で確かめたもの。
 * **誤ると全体の配置がずれ、rc=17 で失敗する**（コンパイルでは気づけない）。
 */
describe("テンプレート長（実機で確定した値）", () => {
  it("OPEN は 36、全体は 26 + template + 名前", () => {
    const req = buildOpenFileRequest({ path: "/a", access: FILE_ACCESS.read, create: false });
    const v = new DataView(req.buffer);
    expect(v.getUint16(16)).toBe(36);
    expect(req.length).toBe(26 + 36 + 2 * 2); // "/a" は UTF-16 で 4 バイト
    expect(v.getUint32(0)).toBe(req.length);
  });

  it("WRITE は 18、全体は 26 + template + データ長", () => {
    const data = Uint8Array.from([1, 2, 3]);
    const req = buildWriteRequest(7, 0, data);
    const v = new DataView(req.buffer);
    expect(v.getUint16(16)).toBe(18);
    expect(req.length).toBe(26 + 18 + 3);
  });

  it("READ は 22", () => {
    expect(new DataView(buildReadRequest(1, 0, 100).buffer).getUint16(16)).toBe(22);
  });

  it("DELETE は 8、全体は 34 + 名前", () => {
    const req = buildDeleteRequest("/ab");
    expect(new DataView(req.buffer).getUint16(16)).toBe(8);
    expect(req.length).toBe(34 + 6);
  });
});

describe("要求の組み立て", () => {
  it("すべてサーバー ID 0xE002 を使う", () => {
    for (const req of [
      buildFileExchangeAttributes(),
      buildOpenFileRequest({ path: "/a", access: FILE_ACCESS.read, create: false }),
      buildReadRequest(1, 0, 10),
      buildCloseRequest(1),
      buildDeleteRequest("/a")
    ]) {
      expect(new DataView(req.buffer).getUint16(6)).toBe(FILE_SERVER_ID);
    }
  });

  it("要求 ID が正しい", () => {
    const id = (r: Uint8Array): number => new DataView(r.buffer).getUint16(18);
    expect(id(buildFileExchangeAttributes())).toBe(FILE_REQ.exchangeAttributes);
    expect(id(buildOpenFileRequest({ path: "/a", access: 1, create: false }))).toBe(FILE_REQ.open);
    expect(id(buildReadRequest(1, 0, 10))).toBe(FILE_REQ.read);
    expect(id(buildCloseRequest(1))).toBe(FILE_REQ.close);
    expect(id(buildDeleteRequest("/a"))).toBe(FILE_REQ.delete);
  });

  it("ファイル名は UTF-16BE", () => {
    const req = buildOpenFileRequest({ path: "/a", access: 1, create: false });
    // 名前は template の後、LL(4) + CP(2) の後ろ
    expect([...req.subarray(62, 66)]).toEqual([0x00, 0x2f, 0x00, 0x61]); // "/a"
  });

  it("create で既存ファイルの扱いが変わる", () => {
    const v = (create: boolean): number =>
      new DataView(buildOpenFileRequest({ path: "/a", access: 1, create }).buffer).getUint16(36);
    expect(v(true)).toBe(FILE_DUPLICATE.createOrOpen);
    expect(v(false)).toBe(FILE_DUPLICATE.openExisting);
  });

  it("空のパスを拒否する", () => {
    expect(() => buildOpenFileRequest({ path: "", access: 1, create: false })).toThrow(/empty/);
  });
});

/** 応答を組み立てる（テスト用） */
function reply(reqRepId: number, template: number[], trailing: number[] = []): Uint8Array {
  const out = new Uint8Array(20 + template.length + trailing.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, out.length);
  v.setUint16(6, FILE_SERVER_ID);
  v.setUint16(16, template.length);
  v.setUint16(18, reqRepId);
  out.set(template, 20);
  out.set(trailing, 20 + template.length);
  return out;
}

describe("応答の解釈（取り違えやすい）", () => {
  it("エラー応答の戻りコードは連鎖指示(2)の【次】", () => {
    // 20-21 が連鎖指示、22-23 が戻りコード。20 を読むと常に 0 に見える
    const r = reply(REPLY_ERROR, [0, 0, 0, 17]);
    expect(replyId(r)).toBe(REPLY_ERROR);
    expect(replyReturnCode(r)).toBe(17);
  });

  it("成功応答は戻りコードを持たない（0 を返す）", () => {
    expect(replyReturnCode(reply(0x8002, [0, 0, 0, 0, 0, 5]))).toBe(0);
  });

  it("OPEN 応答のハンドルは連鎖指示の次から 4 バイト", () => {
    expect(replyFileHandle(reply(0x8002, [0, 0, 0, 0, 0, 17]))).toBe(17);
  });

  it("READ 応答からデータを取り出す（LL/CP 形式ではない）", () => {
    // 連鎖指示(2) CCSID(2) データ長(4) LL/CP(6) データ
    // 連鎖指示(2) CCSID(2) データ長(4) の後、LL/CP 相当の 2 バイトを挟んでデータ
    const data = [0x41, 0x42, 0x43];
    const r = reply(REPLY_READ, [0, 0, 0, 0, 0, 0, 0, 3 + 6, 0, 0], data);
    expect([...(readReplyData(r) ?? [])]).toEqual(data);
  });

  it("READ 以外の応答からはデータを取り出さない", () => {
    expect(readReplyData(reply(REPLY_ERROR, [0, 0, 0, 2]))).toBeUndefined();
  });

  it("短すぎる応答を拒否する", () => {
    expect(() => replyId(new Uint8Array(10))).toThrow(Tn5250Error);
  });
});

describe("fileErrorText", () => {
  it("主要な戻りコード", () => {
    expect(fileErrorText(2)).toBe("File not found");
    expect(fileErrorText(6)).toBe("Invalid handle");
    expect(fileErrorText(13)).toBe("Access denied");
  });

  it("未知のコードも情報を落とさない", () => {
    expect(fileErrorText(99)).toBe("error 99");
  });
});
