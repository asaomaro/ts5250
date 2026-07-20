import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:net";
import { openHostConnection, type HostConnection } from "../src/transport/host-connection.js";
import { Tn5250Error } from "../src/errors.js";

/**
 * 連鎖応答（listFiles のように 1 要求へ複数フレームが返る形）の受け取りを、
 * 偽ホストサーバーを立てて確かめる。
 *
 * ここで守りたいのは**フレームのずれ**——連鎖を途中で抜けると残りが飛んできて、
 * それを次の要求の応答として読んでしまう。症状が別の場所に出るため追跡が難しい。
 */
let server: Server | undefined;
let conn: HostConnection | undefined;

afterEach(async () => {
  conn?.close();
  conn = undefined;
  if (server) {
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
});

/** 先頭 4 バイトが全長のフレームを作る。中身は識別用の 1 バイトだけ */
function frame(tag: number): Buffer {
  const b = Buffer.alloc(5);
  b.writeUInt32BE(5, 0);
  b.writeUInt8(tag, 4);
  return b;
}

/** 要求を受けるたびに、渡されたフレーム列を送り返す偽サーバー */
function fakeHost(replies: Buffer[][]): Promise<number> {
  return new Promise((resolve) => {
    let turn = 0;
    server = createServer((sock) => {
      sock.on("data", () => {
        const batch = replies[turn++] ?? [];
        for (const f of batch) sock.write(f);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve((server!.address() as { port: number }).port);
    });
  });
}

async function connect(port: number): Promise<HostConnection> {
  conn = await openHostConnection({ host: "127.0.0.1", port, timeoutMs: 2000 });
  return conn;
}

describe("requestStream（連鎖応答）", () => {
  it("連鎖した全フレームを順に受け取る", async () => {
    const port = await fakeHost([[frame(1), frame(2), frame(3)]]);
    const c = await connect(port);

    const seen: number[] = [];
    await c.requestStream(frame(0), (f) => {
      seen.push(f[4] as number);
      return (f[4] as number) !== 3; // 3 が終端の約束
    });
    expect(seen).toEqual([1, 2, 3]);
  });

  it("1 フレームで終わる連鎖も扱える", async () => {
    const port = await fakeHost([[frame(9)]]);
    const c = await connect(port);
    const seen: number[] = [];
    await c.requestStream(frame(0), (f) => {
      seen.push(f[4] as number);
      return false;
    });
    expect(seen).toEqual([9]);
  });

  it("onFrame の例外はそのまま reject される", async () => {
    const port = await fakeHost([[frame(1), frame(2), frame(3)]]);
    const c = await connect(port);
    await expect(
      c.requestStream(frame(0), () => {
        throw new Error("解析に失敗");
      })
    ).rejects.toThrow("解析に失敗");
  });

  /**
   * **この工程で塞ぎたかった穴。**
   * 連鎖の途中で抜けると残りのフレームが飛んでくる。以前は「対応する要求の無いフレーム」として
   * 捨てられ、次の要求が前の連鎖の残骸を応答として受け取りうる状態だった。
   * いまは接続が使えなくなるので、ずれる代わりに即座に失敗する。
   */
  it("連鎖を途中で放棄した接続は、以後の要求を受け付けない", async () => {
    const port = await fakeHost([[frame(1), frame(2), frame(3)], [frame(7)]]);
    const c = await connect(port);

    await expect(
      c.requestStream(frame(0), (f) => {
        if ((f[4] as number) === 2) throw new Error("途中で失敗");
        return true;
      })
    ).rejects.toThrow("途中で失敗");

    // 残骸を次の応答として読まず、はっきり失敗する
    await expect(c.request(frame(0))).rejects.toThrow(Tn5250Error);
    await expect(c.request(frame(0))).rejects.toThrow(/abandoned mid-chain/);
  });

  it("正常に終わった連鎖の後は、次の要求を普通に出せる", async () => {
    const port = await fakeHost([[frame(1), frame(2)], [frame(7)]]);
    const c = await connect(port);

    await c.requestStream(frame(0), (f) => (f[4] as number) !== 2);
    const reply = await c.request(frame(0));
    expect(reply[4]).toBe(7);
  });

  /**
   * このプロトコルに非同期通知は無いので、**対応する要求の無いフレームが届くこと自体がずれの証拠**。
   * 以前は黙って捨てており、次の要求がこの残骸を応答として読む余地があった。
   */
  it("要求していないフレームが届いたら、以後その接続を使わせない", async () => {
    // 1 回目の要求に 2 フレーム返す偽サーバー（2 枚目が孤児になる）
    const port = await fakeHost([[frame(1), frame(99)], [frame(7)]]);
    const c = await connect(port);

    expect((await c.request(frame(0)))[4]).toBe(1);
    // 2 枚目が到着するまで待つ
    await new Promise((r) => setTimeout(r, 50));

    await expect(c.request(frame(0))).rejects.toThrow(/abandoned mid-chain/);
  });

  /**
   * 実行中の要求を諦めた時点で、その応答はまだ飛んでくるかもしれない。
   * 「届いてから気づく」のでは、先に次の要求を出された場合に間に合わない。
   */
  it("実行中の要求が失敗したら、その時点で接続を使えなくする", async () => {
    // 応答を返さない偽サーバー。タイムアウトさせる
    const port = await fakeHost([[]]);
    const c = await openHostConnection({ host: "127.0.0.1", port, timeoutMs: 100 });
    conn = c;

    await expect(c.request(frame(0))).rejects.toThrow(Tn5250Error);
    await expect(c.request(frame(0))).rejects.toThrow(/abandoned mid-chain/);
  });

  it("要求が同時に 2 つ走ることは許さない", async () => {
    const port = await fakeHost([[frame(1)]]);
    const c = await connect(port);
    const first = c.requestStream(frame(0), () => false);
    await expect(c.request(frame(0))).rejects.toThrow(/already in flight/);
    await first;
  });
});
