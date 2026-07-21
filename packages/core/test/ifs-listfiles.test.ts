import { describe, it, expect } from "vitest";
import { IfsConnection } from "../src/hostserver/ifs/ifs-connection.js";
import type { HostConnection } from "../src/transport/host-connection.js";
import { Tn5250Error } from "../src/errors.js";

/**
 * `listFiles` の連鎖ループそのものを、偽の接続で駆動して確かめる。
 *
 * **これが無かったのが review の最大の指摘（M3）**。以前は判定式をテスト側に写して
 * そのコピーを検証していたため、本体のガードを消しても緑のままだった。
 * ここでは本体を通すので、壊せば落ちる。
 */

/** 先頭 4 バイトが全長のフレームを組む */
function frame(reqrep: number, templateLength: number, body: Uint8Array): Uint8Array {
  const out = new Uint8Array(20 + body.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, out.length);
  v.setUint16(6, 0xe002);
  v.setUint16(16, templateLength);
  v.setUint16(18, reqrep);
  out.set(body, 20);
  return out;
}

/** 一覧エントリ（0x8005）。実機と同じ templateLength=93 の配置で組む */
function entryFrame(opts: {
  name: string;
  isDir?: boolean;
  isSymlink?: boolean;
  size?: number;
  restartId: number;
  /** 種別と固定属性を**別々に**指定する（食い違う場合の検証に使う） */
  objectType?: number;
  fixedAttributes?: number;
}): Uint8Array {
  const nameBytes = opts.name.length * 2;
  // 20 バイトヘッダの後ろに 93 バイトのテンプレート、その後に LL(4)+CP(2)+名前
  const body = new Uint8Array(93 + 6 + nameBytes);
  const v = new DataView(body.buffer);
  const at = (absolute: number): number => absolute - 20; // body 内の位置
  v.setUint16(at(20), 0x0001); // 連鎖指示（実機は終端エントリでも 1 のまま）
  v.setUint32(at(30), 1_700_000_000); // 更新日時（秒）
  v.setUint32(at(34), 500_000); // 同（マイクロ秒）
  v.setUint32(at(50), opts.fixedAttributes ?? (opts.isDir ? 0x10 : 0x20)); // 固定属性（4 バイト）
  v.setUint16(at(54), opts.objectType ?? (opts.isDir ? 2 : 1)); // オブジェクト種別
  v.setUint32(at(77), opts.restartId);
  v.setBigUint64(at(81), BigInt(opts.size ?? 0));
  v.setUint8(at(91), opts.isSymlink ? 1 : 0);
  v.setUint32(at(113), nameBytes + 6); // 名前 LL
  v.setUint16(at(117), 0x0002); // 名前 CP
  for (let i = 0; i < opts.name.length; i++) {
    v.setUint16(at(119) + i * 2, opts.name.charCodeAt(i));
  }
  return frame(0x8005, 93, body);
}

/** 終端フレーム（0x8001）。rc=18 が全件、rc=0 が打ち切り、その他はエラー */
function endFrame(rc: number): Uint8Array {
  const body = new Uint8Array(4);
  new DataView(body.buffer).setUint16(2, rc); // 20:連鎖指示 / 22:rc
  return frame(0x8001, 4, body);
}

/** 指定したフレーム列を連鎖として返す偽接続 */
function fakeConn(frames: Uint8Array[]): HostConnection & { sent: Uint8Array[]; closed: boolean } {
  const conn = {
    sent: [] as Uint8Array[],
    closed: false,
    async request(f: Uint8Array): Promise<Uint8Array> {
      conn.sent.push(f);
      return frames[0] as Uint8Array;
    },
    async requestStream(f: Uint8Array, onFrame: (r: Uint8Array) => boolean): Promise<void> {
      conn.sent.push(f);
      for (const r of frames) if (!onFrame(r)) return;
    },
    close(): void {
      conn.closed = true;
    }
  };
  return conn;
}

const listOn = (frames: Uint8Array[]) => {
  const conn = fakeConn(frames);
  return { conn, ifs: IfsConnection.forTesting(conn) };
};

describe("listFiles: 一覧の組み立て", () => {
  it("`.` と `..` を除外する", async () => {
    const { ifs } = listOn([
      entryFrame({ name: ".", isDir: true, restartId: 1 }),
      entryFrame({ name: "..", isDir: true, restartId: 2 }),
      entryFrame({ name: "a.txt", size: 30, restartId: 3 }),
      endFrame(18)
    ]);
    const r = await ifs.listFiles("/d");
    expect(r.entries.map((e) => e.name)).toEqual(["a.txt"]);
  });

  it("種別を見分ける", async () => {
    const { ifs } = listOn([
      entryFrame({ name: "f", size: 30, restartId: 1 }),
      entryFrame({ name: "d", isDir: true, restartId: 2 }),
      entryFrame({ name: "l", isSymlink: true, restartId: 3 }),
      endFrame(18)
    ]);
    const r = await ifs.listFiles("/d");
    expect(r.entries.map((e) => [e.name, e.isDirectory, e.isSymlink])).toEqual([
      ["f", false, false],
      ["d", true, false],
      ["l", false, true]
    ]);
  });

  /**
   * ディレクトリ判定は**種別と固定属性の両方**を見る。
   * QSYS の LIB / PF は種別 2（ディレクトリ）で返るのに固定属性の 0x10 が立たない、
   * というのがこの 2 条件の存在理由（JTOpen `determineIsDirectory`）。
   *
   * このテストが無いと、片方の条件を消しても全件緑のままになる（実際そうだった。review R6）。
   */
  it("種別が 2 でも固定属性のビットが無ければディレクトリとしない", async () => {
    const { ifs } = listOn([
      entryFrame({ name: "QSYSLIB", objectType: 2, fixedAttributes: 0x20, restartId: 1 }),
      endFrame(18)
    ]);
    const r = await ifs.listFiles("/QSYS.LIB");
    expect(r.entries[0]?.isDirectory).toBe(false);
  });

  it("固定属性のビットがあっても種別が 1 ならディレクトリとしない", async () => {
    const { ifs } = listOn([
      entryFrame({ name: "odd", objectType: 1, fixedAttributes: 0x10, restartId: 1 }),
      endFrame(18)
    ]);
    const r = await ifs.listFiles("/d");
    expect(r.entries[0]?.isDirectory).toBe(false);
  });

  it("パターンが無ければ /* を付けて送る", async () => {
    const { conn, ifs } = listOn([endFrame(18)]);
    await ifs.listFiles("/home/x/");
    // 要求の名前は UTF-16BE。末尾が "/*" で終わること
    const sent = conn.sent[0] as Uint8Array;
    const v = new DataView(sent.buffer);
    let name = "";
    for (let i = 46; i < sent.length; i += 2) name += String.fromCharCode(v.getUint16(i));
    expect(name).toBe("/home/x/*");
  });

  it("空パスは受け付けない（素通しするとルートを一覧してしまう）", async () => {
    const { ifs } = listOn([endFrame(18)]);
    await expect(ifs.listFiles("")).rejects.toThrow(Tn5250Error);
  });
});

describe("listFiles: 打ち切りと継続", () => {
  it("rc=18 は全件。続きは無い", async () => {
    const { ifs } = listOn([entryFrame({ name: "a", restartId: 5 }), endFrame(18)]);
    const r = await ifs.listFiles("/d", { maxCount: 10 });
    expect(r.hasMore).toBe(false);
    expect(r.canContinue).toBe(false);
    expect(r.nextRestartId).toBeUndefined();
  });

  it("rc=0 は打ち切り。続きの起点を返す", async () => {
    const { ifs } = listOn([entryFrame({ name: "a", restartId: 5 }), endFrame(0)]);
    const r = await ifs.listFiles("/d", { maxCount: 1 });
    expect(r.hasMore).toBe(true);
    expect(r.canContinue).toBe(true);
    expect(r.nextRestartId).toBe(5);
  });

  /** D2: `.` と `..` だけで上限に達すると entries は空。それでも続きは辿れなければならない */
  it("除外だけで枠を使い切っても、続きの起点を失わない", async () => {
    const { ifs } = listOn([
      entryFrame({ name: ".", isDir: true, restartId: 1 }),
      entryFrame({ name: "..", isDir: true, restartId: 2 }),
      endFrame(0)
    ]);
    const r = await ifs.listFiles("/d", { maxCount: 2 });
    expect(r.entries).toEqual([]);
    expect(r.hasMore).toBe(true);
    expect(r.nextRestartId).toBe(2); // 除外した `..` の値
  });

  /**
   * D6: `/QSYS.LIB` は全エントリの Restart ID が 0。
   * ここが緩むと実機で無限ループする（実際に踏んだ）。
   */
  it("Restart ID が 0 なら継続を提供しない", async () => {
    const { ifs } = listOn([entryFrame({ name: "a", restartId: 0 }), endFrame(0)]);
    const r = await ifs.listFiles("/QSYS.LIB", { maxCount: 1 });
    expect(r.hasMore).toBe(true);
    expect(r.canContinue).toBe(false);
    expect(r.nextRestartId).toBeUndefined();
  });

  it("Restart ID が進んでいなければ継続を提供しない", async () => {
    const { ifs } = listOn([entryFrame({ name: "a", restartId: 7 }), endFrame(0)]);
    const r = await ifs.listFiles("/d", { maxCount: 1, restartId: 7 });
    expect(r.canContinue).toBe(false);
  });

  it("Restart ID が後戻りしていても継続を提供しない", async () => {
    const { ifs } = listOn([entryFrame({ name: "a", restartId: 3 }), endFrame(0)]);
    const r = await ifs.listFiles("/d", { maxCount: 1, restartId: 9 });
    expect(r.canContinue).toBe(false);
  });
});

describe("listFiles: 異常系", () => {
  it("存在しないパスは NOT_FOUND（502 ではなく 404 に写るコード）", async () => {
    const { ifs } = listOn([endFrame(3)]);
    await expect(ifs.listFiles("/nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("権限が無ければ ACCESS_DENIED", async () => {
    const { ifs } = listOn([endFrame(13)]);
    await expect(ifs.listFiles("/secret")).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });

  /**
   * M4: `0x8001` は終端フレームで後続が無い。
   * ここで接続を捨てると、1 ディレクトリの権限エラーで走査全体が死ぬ。
   */
  it("終端フレームのエラーでは接続を捨てない", async () => {
    const { conn, ifs } = listOn([endFrame(13)]);
    await expect(ifs.listFiles("/secret")).rejects.toThrow();
    expect(conn.closed).toBe(false);
    expect(ifs.isClosed).toBe(false);
  });

  /**
   * D5: 連鎖の途中で解析に失敗した場合は話が別。
   * 残りが何フレーム来るか分からないので、接続を捨てる。
   */
  it("連鎖の途中で解析に失敗したら接続を捨てる", async () => {
    const broken = entryFrame({ name: "a", restartId: 1 }).subarray(0, 40);
    const { conn, ifs } = listOn([broken, endFrame(18)]);
    await expect(ifs.listFiles("/d")).rejects.toThrow(Tn5250Error);
    expect(conn.closed).toBe(true);
    expect(ifs.isClosed).toBe(true);
  });

  it("想定外の応答 ID は ID を添えて報告する（「error 0」にしない）", async () => {
    const { ifs } = listOn([frame(0x8003, 4, new Uint8Array(4))]);
    await expect(ifs.listFiles("/d")).rejects.toThrow(/unexpected reply 0x8003/);
  });
});

/**
 * **成功応答の ReqRep ID は要求ごとに違う。**
 * 「同じ形に揃える」つもりで一律に 0x8001 を期待したところ、書き込みが実機で全部落ちた。
 * 揃っているという思い込みをここで固定する。
 */
describe("成功応答の ReqRep ID（要求ごとに違う）", () => {
  it("WRITE の成功は 0x800B で、0x8001 ではない", async () => {
    const conn = fakeConn([]);
    let call = 0;
    conn.request = async (f: Uint8Array): Promise<Uint8Array> => {
      conn.sent.push(f);
      call++;
      // 1 回目 OPEN → 0x8002 でハンドル、2 回目 WRITE → 0x800B、3 回目 CLOSE
      if (call === 1) {
        const body = new Uint8Array(8);
        new DataView(body.buffer).setUint32(2, 42); // 22 にハンドル
        return frame(0x8002, 8, body);
      }
      if (call === 2) return frame(0x800b, 4, new Uint8Array(4));
      return frame(0x8001, 4, new Uint8Array(4));
    };
    const ifs = IfsConnection.forTesting(conn);
    await expect(ifs.writeFile("/d/f", new Uint8Array([1, 2, 3]))).resolves.toBeUndefined();
  });

  it("OPEN の応答が 0x8002 でなければハンドルとして使わない", async () => {
    const { ifs } = listOn([frame(0x800f, 4, new Uint8Array(4))]);
    await expect(ifs.readFile("/d/f")).rejects.toThrow(/unexpected reply 0x800f/);
  });
});

describe("makeDirectory", () => {
  it("rc=0 は成功（0x8001 だがエラーではない）", async () => {
    const { ifs } = listOn([endFrame(0)]);
    await expect(ifs.makeDirectory("/d/new")).resolves.toBeUndefined();
  });

  it("既存なら ALREADY_EXISTS", async () => {
    const { ifs } = listOn([endFrame(4)]);
    await expect(ifs.makeDirectory("/d/dup")).rejects.toMatchObject({ code: "ALREADY_EXISTS" });
  });

  /**
   * `replyReturnCode()` は非 `0x8001` に対して 0 を返す仕様。
   * ID を確かめずに rc だけ見ると、**想定外の応答を成功と誤認する**。
   */
  it("応答 ID が 0x8001 でなければ成功にしない", async () => {
    const { ifs } = listOn([frame(0x8002, 4, new Uint8Array(4))]);
    await expect(ifs.makeDirectory("/d/x")).rejects.toThrow(/unexpected reply 0x8002/);
  });
});
