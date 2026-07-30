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
  buildListAttrsByHandleRequest,
  buildRemoveDirRequest,
  buildRenameRequest,
  parseContentCcsid,
  replyDatastreamLevel,
  replyId,
  replyReturnCode,
  replyFileHandle,
  readReplyData,
  fileErrorText,
  fileFailure
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

  // **replace を落とすと静かにファイルが壊れる**（開くだけだと元の方が長いとき末尾が残る）。
  // オフセット 36 の値そのものを見るのは、原典 `IFSOpenReq` の定数と対応が取れていることを
  // ここで固定するため（実機でしか気づけない類の退行を、単体で止める）
  it("replace で既存の中身を捨てて開く（create との 4 通り）", () => {
    const v = (create: boolean, replace: boolean): number =>
      new DataView(buildOpenFileRequest({ path: "/a", access: 1, create, replace }).buffer).getUint16(36);
    expect(v(true, true)).toBe(FILE_DUPLICATE.createOrReplace);
    expect(v(true, false)).toBe(FILE_DUPLICATE.createOrOpen);
    expect(v(false, true)).toBe(FILE_DUPLICATE.replaceExisting);
    expect(v(false, false)).toBe(FILE_DUPLICATE.openExisting);
  });

  it("duplicate file option は原典 IFSOpenReq の値", () => {
    expect(FILE_DUPLICATE).toEqual({
      createOrOpen: 1,
      createOrReplace: 2,
      openExisting: 8,
      replaceExisting: 16
    });
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

/**
 * ファイル内容の CCSID タグ（OA2）。
 * ここのバイト列は **PUB400 で実際に捕えたフレーム**（research F2・F3）。
 * レイアウトを変えるときは、この実物が通ることを必ず確かめること。
 */
describe("内容の CCSID タグ（OA2）", () => {
  /** 実機の交換属性応答（0x8009・38 バイト）。offset 22 が報告レベル = 24 */
  const EXCHANGE_REPLY = Uint8Array.from([
    0x00, 0x00, 0x00, 0x26, 0x00, 0x00, 0xe0, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x0a, 0x80, 0x09, 0x00, 0x00, 0x00, 0x18, 0x00, 0x00, 0x40, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x08, 0x00, 0x0a, 0x04, 0xb0
  ]);

  /**
   * 実機の OA2 応答（0x8005・194 バイト）。`/home/USER/ifsdemo/hello.txt` のタグは 850。
   * 宣言テンプレート長は 8（一覧応答の 93 とは別レイアウト）。
   */
  function oa2Reply(ccsid = 850): Uint8Array {
    const out = new Uint8Array(194);
    const v = new DataView(out.buffer);
    v.setUint32(0, 194);
    v.setUint16(6, FILE_SERVER_ID);
    v.setUint16(16, 8); // 宣言テンプレート長
    v.setUint16(18, 0x8005);
    v.setUint16(20, 0); // 連鎖指示 0 = このフレームで終わり
    v.setUint32(28, 166); // 可変部 LL
    v.setUint16(32, 0x000f); // CP = OA2
    v.setUint16(34 + 134, ccsid); // OA2b/OA2c の「CCSID of object」
    return out;
  }

  it("交換属性応答から、サーバーが報告したレベルを読む（要求値ではない）", () => {
    // 我々は 8 を要求しているが、PUB400 は 24 を返す。要求値で決め打ちにしないこと
    expect(new DataView(buildFileExchangeAttributes().buffer).getUint16(22)).toBe(8);
    expect(replyDatastreamLevel(EXCHANGE_REPLY)).toBe(24);
  });

  it("要求は 40 バイト・テンプレート長 20・属性リストレベル 0x44（名前は送らない）", () => {
    const req = buildListAttrsByHandleRequest(9);
    const v = new DataView(req.buffer);
    expect(req.length).toBe(40);
    expect(v.getUint32(0)).toBe(40);
    expect(v.getUint16(16)).toBe(20);
    expect(v.getUint16(18)).toBe(FILE_REQ.listFiles);
    expect(v.getUint32(22)).toBe(9); // ファイルハンドル
    expect(v.getUint32(28)).toBe(1); // 作業ディレクトリハンドル
    expect(v.getUint16(36)).toBe(0x44); // OA2 ＋ 開いたインスタンス
  });

  it("実機の OA2 応答から 850 が取れる", () => {
    expect(parseContentCcsid(oa2Reply(), 24)).toBe(850);
  });

  it("CCSID の位置は報告レベルで変わる（126 / 142 / 134）", () => {
    const frame = oa2Reply();
    const v = new DataView(frame.buffer);
    v.setUint16(34 + 126, 1111); // OA2（レベル 0）のコードページ位置
    v.setUint16(34 + 142, 2222); // OA2a（0xF4F4）のコードページ位置
    expect(parseContentCcsid(frame, 0)).toBe(1111);
    expect(parseContentCcsid(frame, 0xf4f4)).toBe(2222);
    expect(parseContentCcsid(frame, 24)).toBe(850);
    expect(parseContentCcsid(frame, 8)).toBe(850);
  });

  it("OA2 が付かない応答（一覧と同じ形）では undefined", () => {
    // 属性リストレベル 0x01 の応答。テンプレート長 93 で可変部は名前だけ
    const frame = new Uint8Array(113);
    const v = new DataView(frame.buffer);
    v.setUint32(0, 113);
    v.setUint16(16, 93);
    v.setUint16(18, 0x8005);
    v.setUint32(113 - 24, 24); // 名前の LL
    v.setUint16(113 - 20, 0x0002); // CP = ファイル名
    expect(parseContentCcsid(frame, 24)).toBeUndefined();
  });

  it("エラー応答・壊れた LL では undefined（無限ループしない）", () => {
    expect(parseContentCcsid(reply(REPLY_ERROR, [0, 0, 0, 6]), 24)).toBeUndefined();
    const broken = oa2Reply();
    new DataView(broken.buffer).setUint32(28, 0); // LL = 0
    expect(parseContentCcsid(broken, 24)).toBeUndefined();
  });

  it("OA2 が宣言より短ければ、無関係なバイトを CCSID として読まない", () => {
    const short = oa2Reply();
    new DataView(short.buffer).setUint32(28, 100); // LL を縮める（CCSID 位置が構造体の外に出る）
    expect(parseContentCcsid(short, 24)).toBeUndefined();
  });
});

/**
 * リネームとディレクトリ削除。**ファイル削除からのコピーで作らない**——
 * ディレクトリ削除はフラグ 2 バイト分テンプレートが長く（10 と 8）、名前の位置がずれる（research F2）。
 */
describe("rename（0x000F）と rmdir（0x000E）", () => {
  it("rename は元・先の 2 つの名前を CP 0x0003 / 0x0004 で並べる", () => {
    const req = buildRenameRequest("/a", "/bc");
    const v = new DataView(req.buffer);
    expect(v.getUint16(18)).toBe(FILE_REQ.rename);
    expect(v.getUint16(16)).toBe(16); // テンプレート長
    expect(req.length).toBe(20 + 16 + 6 + 4 + 6 + 6); // "/a"=4 バイト, "/bc"=6 バイト
    expect(v.getUint32(0)).toBe(req.length);
    expect(v.getUint32(26)).toBe(1); // 元の作業ディレクトリハンドル
    expect(v.getUint32(30)).toBe(1); // 先の作業ディレクトリハンドル
    expect(v.getUint16(34)).toBe(0); // 置換しない
    expect(v.getUint32(36)).toBe(4 + 6); // 元の LL
    expect(v.getUint16(40)).toBe(0x0003); // 元の CP
    expect(v.getUint16(42)).toBe("/".charCodeAt(0)); // 元の名前（UTF-16BE）
    expect(v.getUint32(46)).toBe(6 + 6); // 先の LL（42 + 元 4 バイト）
    expect(v.getUint16(50)).toBe(0x0004); // 先の CP
    expect(v.getUint16(52)).toBe("/".charCodeAt(0));
  });

  it("replace を指定したときだけ置換フラグが立つ", () => {
    expect(new DataView(buildRenameRequest("/a", "/b", { replace: true }).buffer).getUint16(34)).toBe(1);
    expect(new DataView(buildRenameRequest("/a", "/b", { replace: false }).buffer).getUint16(34)).toBe(0);
  });

  it("rmdir はテンプレート長 10。フラグの分だけ名前が後ろにずれる", () => {
    const req = buildRemoveDirRequest("/ab");
    const v = new DataView(req.buffer);
    expect(v.getUint16(18)).toBe(FILE_REQ.removeDir);
    expect(v.getUint16(16)).toBe(10);
    expect(req.length).toBe(20 + 10 + 6 + 6);
    expect(v.getUint32(24)).toBe(1); // 作業ディレクトリハンドル
    expect(v.getUint16(28)).toBe(0); // フラグ（ファイル削除には無い）
    expect(v.getUint32(30)).toBe(6 + 6); // 名前 LL
    expect(v.getUint16(34)).toBe(0x0001); // ディレクトリ名の CP（ファイルは 0x0002）
    expect(v.getUint16(36)).toBe("/".charCodeAt(0)); // 名前は 36 から（ファイル削除は 34）
  });

  it("ファイル削除とはテンプレート長も名前の位置も違う", () => {
    const dir = new DataView(buildRemoveDirRequest("/ab").buffer);
    const file = new DataView(buildDeleteRequest("/ab").buffer);
    expect([dir.getUint16(16), file.getUint16(16)]).toEqual([10, 8]);
    expect([dir.getUint16(34), file.getUint16(32)]).toEqual([0x0001, 0x0002]);
  });

  it("空のパスを拒否する", () => {
    expect(() => buildRemoveDirRequest("")).toThrow(Tn5250Error);
    expect(() => buildRenameRequest("", "/b")).toThrow(Tn5250Error);
    expect(() => buildRenameRequest("/a", "")).toThrow(Tn5250Error);
  });

  it("「空ではない」(rc=9) は専用のコードにする（502 に落とさない）", () => {
    expect(fileFailure("x", 9, REPLY_ERROR).code).toBe("NOT_EMPTY");
    // 既存の写像は変わっていない
    expect(fileFailure("x", 4, REPLY_ERROR).code).toBe("ALREADY_EXISTS");
    expect(fileFailure("x", 2, REPLY_ERROR).code).toBe("NOT_FOUND");
    expect(fileFailure("x", 13, REPLY_ERROR).code).toBe("ACCESS_DENIED");
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
