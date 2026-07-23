import { describe, it, expect } from "vitest";
import { IfsConnection } from "../src/hostserver/ifs/ifs-connection.js";
import type { HostConnection } from "../src/transport/host-connection.js";
import { Tn5250Error } from "../src/errors.js";

/**
 * `readTextFile`（内容 ＋ CCSID タグ）を偽の接続で駆動する。
 *
 * 確かめたいのは**手順**そのもの——open → 属性(OA2) → read → close を
 * **1 ハンドルで**通すこと、タグが取れなくても読み取りを止めないこと。
 * ハンドルを開き直す実装に「整理」されると往復が倍になるので、順序ごと固定する。
 */

function header(out: Uint8Array, reqrep: number, templateLength: number): DataView {
  const v = new DataView(out.buffer);
  v.setUint32(0, out.length);
  v.setUint16(6, 0xe002);
  v.setUint16(16, templateLength);
  v.setUint16(18, reqrep);
  return v;
}

/** OPEN 応答（0x8002）。連鎖指示の次から 4 バイトがハンドル */
function openReply(handle: number): Uint8Array {
  const out = new Uint8Array(26);
  header(out, 0x8002, 6).setUint32(22, handle);
  return out;
}

/** OA2 付きの属性応答（0x8005・テンプレート長 8）。実機と同じ配置 */
function oa2Reply(ccsid: number): Uint8Array {
  const out = new Uint8Array(194);
  const v = header(out, 0x8005, 8);
  v.setUint32(28, 166); // 可変部 LL
  v.setUint16(32, 0x000f); // CP = OA2
  v.setUint16(34 + 134, ccsid);
  return out;
}

/** エラー応答（0x8001） */
function errorReply(rc: number): Uint8Array {
  const out = new Uint8Array(24);
  header(out, 0x8001, 4).setUint16(22, rc);
  return out;
}

/** READ 応答（0x8003）。データは offset 30 から */
function readReply(bytes: number[]): Uint8Array {
  const out = new Uint8Array(30 + bytes.length);
  header(out, 0x8003, 10).setUint32(24, bytes.length + 6);
  out.set(bytes, 30);
  return out;
}

/** 要求 ID ごとに応答を返す偽接続。送られた要求 ID の並びを記録する */
function fakeConn(replies: {
  attrs: Uint8Array;
  data: number[];
}): HostConnection & { ids: number[]; handles: number[] } {
  const conn = {
    ids: [] as number[],
    handles: [] as number[],
    async request(f: Uint8Array): Promise<Uint8Array> {
      const v = new DataView(f.buffer, f.byteOffset, f.byteLength);
      const id = v.getUint16(18);
      conn.ids.push(id);
      switch (id) {
        case 0x0002: // OPEN
          return openReply(7);
        case 0x000a: // ListAttrs（ハンドル指定）
          conn.handles.push(v.getUint32(22));
          return replies.attrs;
        case 0x0003: {
          // READ: 1 回目だけデータ、2 回目は終端（エラー応答）
          const first = conn.ids.filter((x) => x === 0x0003).length === 1;
          return first ? readReply(replies.data) : errorReply(22);
        }
        case 0x0009: // CLOSE
          return openReply(0);
        default:
          throw new Error(`unexpected request 0x${id.toString(16)}`);
      }
    },
    async requestStream(): Promise<void> {
      throw new Error("readTextFile must not use requestStream (終端フレームが来ないため)");
    },
    close(): void {}
  };
  return conn;
}

describe("readTextFile", () => {
  it("open → 属性(OA2) → read → close を 1 ハンドルで通す", async () => {
    const conn = fakeConn({ attrs: oa2Reply(1399), data: [0xc1, 0xc2] });
    const ifs = IfsConnection.forTesting(conn);
    const result = await ifs.readTextFile("/home/x.txt");

    expect(result.ccsid).toBe(1399);
    expect([...result.data]).toEqual([0xc1, 0xc2]);
    // OPEN → ListAttrs → READ …（終端まで）→ CLOSE
    expect(conn.ids[0]).toBe(0x0002);
    expect(conn.ids[1]).toBe(0x000a);
    expect(conn.ids[2]).toBe(0x0003);
    expect(conn.ids.at(-1)).toBe(0x0009);
    // 属性要求は **read と同じハンドル**（開き直していない）
    expect(conn.handles).toEqual([7]);
    expect(conn.ids.filter((id) => id === 0x0002)).toHaveLength(1);
  });

  it("タグが取れなくても読み取りは続ける", async () => {
    // OA2 が付かない応答（権限や種別で属性が返らない場合）
    const conn = fakeConn({ attrs: errorReply(6), data: [0x41] });
    const ifs = IfsConnection.forTesting(conn);
    const result = await ifs.readTextFile("/home/x.txt");

    expect(result.ccsid).toBeUndefined();
    expect([...result.data]).toEqual([0x41]);
    expect(conn.ids.at(-1)).toBe(0x0009); // 閉じている
  });

  it("報告レベルが違えば CCSID の読み位置も変わる", async () => {
    const attrs = oa2Reply(850);
    new DataView(attrs.buffer).setUint16(34 + 126, 273); // レベル 0 の位置に別の値
    const ifs = IfsConnection.forTesting(fakeConn({ attrs, data: [0x41] }), 0);
    expect((await ifs.readTextFile("/home/x.txt")).ccsid).toBe(273);
  });

  it("readFile は従来どおりバイト列だけを返す（属性を引かない）", async () => {
    const conn = fakeConn({ attrs: oa2Reply(1208), data: [0x41, 0x42] });
    const ifs = IfsConnection.forTesting(conn);
    expect([...(await ifs.readFile("/home/x.txt"))]).toEqual([0x41, 0x42]);
    expect(conn.ids).not.toContain(0x000a);
  });

  it("rename と removeDirectory はそれぞれの要求 ID を使う（種別を取り違えない）", async () => {
    const sent: number[] = [];
    const conn = {
      async request(f: Uint8Array): Promise<Uint8Array> {
        sent.push(new DataView(f.buffer, f.byteOffset, f.byteLength).getUint16(18));
        return errorReply(0); // rc=0 = 成功
      },
      async requestStream(): Promise<void> {},
      close(): void {}
    } as unknown as HostConnection;
    const ifs = IfsConnection.forTesting(conn);
    await ifs.rename("/a/x.txt", "/a/y.txt");
    await ifs.removeDirectory("/a/dir");
    await ifs.deleteFile("/a/y.txt");
    // rename=0x000F / rmdir=0x000E / delete=0x000C
    expect(sent).toEqual([0x000f, 0x000e, 0x000c]);
  });

  it("閉じた接続では呼べない", async () => {
    const ifs = IfsConnection.forTesting(fakeConn({ attrs: oa2Reply(37), data: [] }));
    ifs.close();
    await expect(ifs.readTextFile("/home/x.txt")).rejects.toThrow(Tn5250Error);
  });
});
