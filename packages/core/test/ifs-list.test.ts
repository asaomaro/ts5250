import { describe, it, expect } from "vitest";
import {
  FILE_REQ,
  REPLY_LIST_ENTRY,
  buildListFilesRequest,
  buildCreateDirRequest,
  buildDeleteRequest,
  parseListEntry,
  listReplyKind,
  canRestartFrom
} from "../src/hostserver/ifs/ifs-datastream.js";
import { Tn5250Error } from "../src/errors.js";

/**
 * 固定データは**実機（PUB400）から採ったダンプそのもの**（research F1-3）。
 * 手で組み立てた期待値ではないので、原典と食い違う箇所もここに写っている。
 */
function bytes(hex: string): Uint8Array {
  const parts = hex.trim().split(/\s+/);
  return Uint8Array.from(parts.map((h) => parseInt(h, 16)));
}

/** /home/USER/ifsdemo/hello.txt（30 バイト・通常ファイル）の一覧応答 137 バイト */
const HELLO_FRAME = bytes(`
  00 00 00 89 00 00 e0 02 00 00 00 00 00 00 00 00
  00 5d 80 05 00 01 6a 5e 1d 2d 00 05 95 70 6a 5e
  1d 2d 00 09 d8 1a 6a 5e 1d 2d 00 05 98 81 00 00
  00 00 00 00 00 20 00 01 00 00 00 00 00 00 00 00
  00 00 78 74 b6 76 00 00 00 04 b0 01 f4 00 00 00
  03 00 00 00 00 00 00 00 1e 00 00 00 00 00 00 00
  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
  00 00 00 00 18 00 02 00 68 00 65 00 6c 00 6c 00
  6f 00 2e 00 74 00 78 00 74
`);

/** /home/USER/ifsdemo/subdir（ディレクトリ）の一覧応答 131 バイト */
const SUBDIR_FRAME = bytes(`
  00 00 00 83 00 00 e0 02 00 00 00 00 00 00 00 00
  00 5d 80 05 00 01 6a 5e 1d 34 00 0c dc 9f 6a 5e
  1d 34 00 0c dc 9f 6a 5e 1d 34 00 0c dc 9f 00 00
  00 00 00 00 00 10 00 02 00 00 00 00 00 00 00 00
  00 00 78 74 d3 37 00 00 00 04 b0 01 f4 00 00 00
  04 00 00 00 00 00 00 20 00 00 00 00 00 00 00 00
  00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
  00 00 00 00 12 00 02 00 73 00 75 00 62 00 64 00
  69 00 72
`);

/** 一覧の終端（rc=18 = No more files）24 バイト */
const END_FRAME = bytes(`
  00 00 00 18 00 00 e0 02 00 00 00 00 00 00 00 00
  00 04 80 01 00 00 00 12
`);

/**
 * `maxCount` で打ち切られたときの終端 24 バイト。**rc は 18 ではなく 0**。
 * 原典にこの区別の記述は見当たらず、実機に maxCount=2 を投げて初めて分かった。
 */
const TRUNCATED_FRAME = bytes(`
  00 00 00 18 00 00 e0 02 00 00 00 00 00 00 00 00
  00 04 80 01 00 00 00 00
`);

describe("listFiles 要求", () => {
  it("テンプレート長は 20、全長は 46 + 名前", () => {
    const path = "/a/*";
    const req = buildListFilesRequest(path);
    const v = new DataView(req.buffer);
    expect(v.getUint16(16)).toBe(20);
    expect(v.getUint16(18)).toBe(FILE_REQ.listFiles);
    expect(req.length).toBe(46 + path.length * 2);
    expect(v.getUint32(0)).toBe(req.length);
  });

  it("空パスは受け付けない", () => {
    expect(() => buildListFilesRequest("")).toThrow(Tn5250Error);
  });

  it("restartId を渡すと名前の後ろに LL/CP/値の 10 バイトが付く", () => {
    const path = "/a/*";
    const plain = buildListFilesRequest(path);
    const withRestart = buildListFilesRequest(path, { restartId: 42 });
    expect(withRestart.length).toBe(plain.length + 10);

    const v = new DataView(withRestart.buffer);
    const at = plain.length; // 名前の直後
    expect(v.getUint32(at)).toBe(10);
    expect(v.getUint16(at + 4)).toBe(0x000e);
    expect(v.getUint32(at + 6)).toBe(42);
    // 全長ヘッダも伸びていること
    expect(v.getUint32(0)).toBe(withRestart.length);
  });

  it("maxCount を指定できる（巨大ディレクトリの打ち切りに使う）", () => {
    const req = buildListFilesRequest("/a/*", { maxCount: 1000 });
    expect(new DataView(req.buffer).getUint16(34)).toBe(1000);
  });
});

describe("ディレクトリ作成要求", () => {
  it("テンプレート長は 8、要求 ID は 0x000D、全長は 34 + 名前", () => {
    const path = "/a/b";
    const req = buildCreateDirRequest(path);
    const v = new DataView(req.buffer);
    expect(v.getUint16(16)).toBe(8);
    expect(v.getUint16(18)).toBe(FILE_REQ.createDir);
    expect(v.getUint16(18)).toBe(0x000d);
    expect(req.length).toBe(34 + path.length * 2);
    expect(v.getUint32(0)).toBe(req.length);
  });

  /**
   * **ここが最も間違えやすい。** 形がほぼ同じ削除要求はファイル名の 0x0002 を使うが、
   * ディレクトリ作成は 0x0001。コピペで作ると気づかないまま実機で失敗する。
   */
  it("ディレクトリ名のコードポイントは 0x0001（ファイル名の 0x0002 ではない）", () => {
    const mkdir = buildCreateDirRequest("/a/b");
    expect(new DataView(mkdir.buffer).getUint16(32)).toBe(0x0001);

    const del = buildDeleteRequest("/a/b");
    expect(new DataView(del.buffer).getUint16(32)).toBe(0x0002);
  });

  it("名前は UTF-16BE で入る", () => {
    const req = buildCreateDirRequest("/ab");
    const v = new DataView(req.buffer);
    expect(v.getUint32(28)).toBe(3 * 2 + 6);
    expect(v.getUint16(34)).toBe("/".charCodeAt(0));
    expect(v.getUint16(36)).toBe("a".charCodeAt(0));
    expect(v.getUint16(38)).toBe("b".charCodeAt(0));
  });

  it("空パスは受け付けない", () => {
    expect(() => buildCreateDirRequest("")).toThrow(Tn5250Error);
  });
});

describe("一覧応答の種類（終端は連鎖指示では判定できない）", () => {
  it("0x8005 はエントリ", () => {
    expect(listReplyKind(HELLO_FRAME)).toBe("entry");
  });

  it("rc=18 は全件返しきった終端", () => {
    expect(listReplyKind(END_FRAME)).toBe("end");
  });

  /**
   * 打ち切りと全件終了は**同じ 0x8001 で rc だけが違う**。
   * rc=0 を「エラーなし＝正常終了」と扱うと、続きがあるのに終わったことにしてしまう。
   */
  it("rc=0 は件数上限での打ち切り（続きがある）", () => {
    expect(listReplyKind(TRUNCATED_FRAME)).toBe("truncated");
    expect(listReplyKind(TRUNCATED_FRAME)).not.toBe("end");
  });

  /**
   * 実機では**最後のエントリでも連鎖指示が 0x0001 のまま**で 0 に落ちない。
   * 連鎖ビットで終端を判定する実装はここで気づけないまま、実行時にハングする。
   */
  it("エントリ側の連鎖指示は終端でも 0 にならない（だから終端判定に使えない）", () => {
    expect(new DataView(HELLO_FRAME.buffer).getUint16(20)).toBe(0x0001);
    expect(new DataView(SUBDIR_FRAME.buffer).getUint16(20)).toBe(0x0001);
    // 終端フレームだけが 0
    expect(new DataView(END_FRAME.buffer).getUint16(20)).toBe(0x0000);
  });
});

/**
 * 続きを辿れるかの判定。**本体の関数をそのまま呼ぶ**。
 *
 * 以前はこのテストが判定式をコピーして検証していたため、本体を壊しても緑のままだった
 * （review M3）。実機（`/QSYS.LIB`）で全エントリの Restart ID が 0 になり
 * 無限ループしたのを受けて入れたガードなので、本物の回帰資産にしておく。
 * 連鎖ループを含む経路は `ifs-listfiles.test.ts` が偽接続で駆動している。
 */
describe("ページング継続の可否（無限ループのガード）", () => {
  it("Restart ID が前に進んでいれば続けられる", () => {
    expect(canRestartFrom(1401, 6)).toBe(true);
  });

  /** /QSYS.LIB は全エントリ 0 を返す。渡し続けると毎回先頭の数件が返る */
  it("Restart ID が 0 なら続けられない", () => {
    expect(canRestartFrom(0, undefined)).toBe(false);
  });

  /** 進んでいない値をそのまま返すと、同じページを取り続ける */
  it("渡した値から進んでいなければ続けられない", () => {
    expect(canRestartFrom(42, 42)).toBe(false);
  });

  /** 単調増加を条件にすれば、後戻りや 2-cycle もまとめて弾ける */
  it("後戻りしていれば続けられない", () => {
    expect(canRestartFrom(3, 9)).toBe(false);
  });

  it("エントリが 1 件も無ければ続けられない", () => {
    expect(canRestartFrom(undefined, 6)).toBe(false);
  });
});

describe("一覧エントリの解析（実機ダンプ）", () => {
  it("通常ファイルを解く", () => {
    const e = parseListEntry(HELLO_FRAME);
    expect(e.name).toBe("hello.txt");
    expect(e.isDirectory).toBe(false);
    expect(e.isSymlink).toBe(false);
    expect(e.size).toBe(30);
    expect(e.restartId).toBe(3);
    // 1784552749 秒 = ダンプを採った時刻
    expect(Math.floor(e.modifiedAt / 1000)).toBe(1784552749);
  });

  it("ディレクトリを解く", () => {
    const e = parseListEntry(SUBDIR_FRAME);
    expect(e.name).toBe("subdir");
    expect(e.isDirectory).toBe(true);
    expect(e.isSymlink).toBe(false);
    expect(e.size).toBe(8192);
    expect(e.restartId).toBe(4);
  });

  /**
   * 宣言テンプレート長は実機で **93**。原典（jtopenlite）は 92 を暗黙に仮定しており、
   * 92 を固定値で埋め込むと LL を 1 バイトずれて読んで名前が空になる。
   */
  it("名前の位置は宣言テンプレート長から求める（実機は 93）", () => {
    expect(new DataView(HELLO_FRAME.buffer).getUint16(16)).toBe(93);
    // 20 + 93 = 113 に LL、119 から UTF-16BE の名前
    expect(new DataView(HELLO_FRAME.buffer).getUint32(113)).toBe(9 * 2 + 6);
    expect(parseListEntry(HELLO_FRAME).name).toBe("hello.txt");
  });

  /**
   * 固定属性は offset 50 の **4 バイト**。2 バイトで読むと上位だけを見ることになり、
   * 全エントリが 0 になってディレクトリ判定が常に false に倒れる。
   */
  it("固定属性は 4 バイトで読む", () => {
    const dirAttrs = new DataView(SUBDIR_FRAME.buffer).getUint32(50);
    expect(dirAttrs & 0x10).toBe(0x10);
    // 2 バイトで読むと 0 になってしまう（この誤りを固定化する）
    expect(new DataView(SUBDIR_FRAME.buffer).getUint16(50)).toBe(0);
  });

  /**
   * **これだけは実機ダンプではなく派生データ**——採取したのは通常ファイル・ディレクトリ・終端の
   * 3 フレームで、シンボリックリンクの生バイトは手元に無い。
   * 実機では `link.txt` だけ offset 91 が 01 になることを確認済み（research F1-3）なので、
   * ここでは「その 1 バイトを読んでいること」だけを固定する。
   */
  it("offset 91 が 1 ならシンボリックリンク（派生データ）", () => {
    const linked = Uint8Array.from(HELLO_FRAME);
    linked[91] = 1;
    expect(parseListEntry(linked).isSymlink).toBe(true);
    expect(parseListEntry(HELLO_FRAME).isSymlink).toBe(false);
  });

  it("短すぎるフレームは PROTOCOL_ERROR", () => {
    expect(() => parseListEntry(HELLO_FRAME.subarray(0, 40))).toThrow(Tn5250Error);
  });

  it("REPLY_LIST_ENTRY は 0x8005", () => {
    expect(REPLY_LIST_ENTRY).toBe(0x8005);
  });
});
