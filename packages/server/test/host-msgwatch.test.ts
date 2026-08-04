/**
 * メッセージ待ち行列の待ち受け。
 *
 * ここで守りたいのは 3 つ:
 *
 * - **同じものが二度出ない**（カーソルが進む）
 * - **消さない**（`*SAME` 固定）
 * - **始める前からあったものは流さない**（`QSYSOPR` の数百件が押し寄せない）
 */
import { describe, it, expect } from "vitest";
import { As400Error } from "@ts5250/base";
import type { CommandConnection } from "@ts5250/hostserver";
import { codecForCcsid } from "@ts5250/ebcdic";
import { msgqSource } from "../src/host-msgwatch.js";
import type { MsgWatchSpec } from "../src/config-types.js";

// 本文は **CCSID 37 で表せる字だけ**にしてある。ここで見たいのは
// 順序・カーソル・絞り込みで、符号化は `message-receive.test.ts` の担当
const CCSID = 37;
const codec = codecForCcsid(CCSID);

interface FakeMsg {
  key: string;
  text: string;
  type?: string;
  id?: string;
}

/** `RCVM0200` の受け取り域を組む（実機と同じ並び） */
function encode(m: FakeMsg | undefined): Uint8Array {
  const buf = new Uint8Array(4096).fill(0x40);
  const view = new DataView(buf.buffer);
  if (!m) {
    view.setInt32(0, 8);
    view.setInt32(4, 8);
    return buf;
  }
  const text = codec.encode(m.text).bytes;
  view.setInt32(0, 176 + text.length);
  view.setInt32(4, 176 + text.length);
  view.setInt32(8, 0);
  buf.set(codec.encode((m.id ?? "").padEnd(7)).bytes, 12);
  buf.set(codec.encode(m.type ?? "04").bytes, 19);
  for (let i = 0; i < 4; i++) buf[21 + i] = Number.parseInt(m.key.slice(i * 2, i * 2 + 2), 16);
  view.setInt32(152, 0);
  view.setInt32(160, text.length);
  view.setInt32(164, text.length);
  view.setInt32(168, 0);
  buf.set(text, 176);
  return buf;
}

interface Call {
  selector: string;
  key: string;
  wait: number;
  action: string;
}

/**
 * 偽のコマンド接続。**呼ばれた引数をそのまま記録する**——
 * `*SAME` で呼んでいるか、カーソルが進んでいるかは、ここでしか確かめられない
 * （結果だけ見ても、消す呼び出しと区別が付かない）。
 */
function fakeConn(queue: FakeMsg[]): { conn: CommandConnection; calls: Call[]; closed: () => number } {
  const calls: Call[] = [];
  let closes = 0;
  const conn = {
    async call(_program: string, _library: string, params: readonly unknown[]) {
      const at = (i: number): Uint8Array => (params[i] as { data: Uint8Array }).data;
      const selector = codec.decode(at(4)).trim();
      const key = [...at(5)].map((b) => b.toString(16).padStart(2, "0")).join("");
      const call: Call = {
        selector,
        key,
        wait: new DataView(at(6).buffer, at(6).byteOffset, 4).getInt32(0),
        action: codec.decode(at(7)).trim()
      };
      calls.push(call);
      let found: FakeMsg | undefined;
      if (selector === "*FIRST") found = queue[0];
      else if (selector === "*LAST") found = queue.at(-1);
      else if (selector === "*NEXT") {
        const at2 = queue.findIndex((m) => m.key === key);
        found = at2 < 0 ? undefined : queue[at2 + 1];
      }
      return { result: { success: true, returnCode: 0, messages: [] }, outputs: [encode(found)] };
    },
    close() {
      closes++;
    }
  } as unknown as CommandConnection;
  return { conn, calls, closed: () => closes };
}

const SPEC: MsgWatchSpec = { library: "QSYS", name: "QSYSOPR" };
const open = (queue: FakeMsg[], spec: MsgWatchSpec = SPEC) => {
  const fake = fakeConn(queue);
  const source = msgqSource({
    spec,
    connect: { host: "h", user: "u", password: "p", ccsid: CCSID } as never,
    open: async () => fake.conn
  });
  return { source, ...fake };
};

describe("msgqSource", () => {
  it("**消さない**——動作は常に `*SAME`", async () => {
    const q = [{ key: "00000100", text: "one" }];
    const { source, calls } = open(q);
    const link = await source.open();
    q.push({ key: "00000200", text: "two" });
    await link.next();
    expect(calls.every((c) => c.action === "*SAME")).toBe(true);
  });

  it("**始める前からあったものは流さない**（末尾までカーソルを進める）", async () => {
    const q = [
      { key: "00000100", text: "old-1" },
      { key: "00000200", text: "old-2" }
    ];
    const { source, calls } = open(q);
    const link = await source.open();
    // 開いた時点で `*LAST` を 1 回引いている
    expect(calls[0]).toMatchObject({ selector: "*LAST", wait: 0 });
    q.push({ key: "00000300", text: "fresh" });
    expect((await link.next())?.text).toBe("fresh");
  });

  it("`includeExisting` なら先頭から流す", async () => {
    const q = [{ key: "00000100", text: "old-1" }];
    const { source, calls } = open(q, { ...SPEC, includeExisting: true });
    const link = await source.open();
    expect(calls).toHaveLength(0); // 位置合わせをしない
    expect((await link.next())?.text).toBe("old-1");
  });

  it("**同じものが二度出ない**（カーソルが進む）", async () => {
    const q = [{ key: "00000100", text: "0" }];
    const { source } = open(q, { ...SPEC, includeExisting: true });
    const link = await source.open();
    q.push({ key: "00000200", text: "1" }, { key: "00000300", text: "2" });
    expect((await link.next())?.text).toBe("0");
    expect((await link.next())?.text).toBe("1");
    expect((await link.next())?.text).toBe("2");
  });

  it("**無限には待たない**（掴んだままだと待ち行列が消せなくなる）", async () => {
    const q = [{ key: "00000100", text: "x" }];
    const { source, calls } = open(q, { ...SPEC, includeExisting: true });
    const link = await source.open();
    await link.next();
    const waits = calls.filter((c) => c.selector !== "*LAST").map((c) => c.wait);
    expect(waits.every((w) => w > 0 && w <= 300)).toBe(true);
  });

  it("時間切れは空で返す（掛け直してもらう）", async () => {
    const { source } = open([], { ...SPEC, includeExisting: true });
    const link = await source.open();
    expect(await link.next()).toBeUndefined();
  });

  it("`onlyInquiry` は照会でないものを捨てる。**それでもカーソルは進む**", async () => {
    const q = [
      { key: "00000100", text: "just info", type: "04" },
      { key: "00000200", text: "please reply", type: "05" }
    ];
    const { source } = open(q, { ...SPEC, includeExisting: true, onlyInquiry: true });
    const link = await source.open();
    // 1 回目は捨てる（＝空が返る）が、次で止まらない——
    // カーソルが進まないと同じものを永久に読み続ける
    expect(await link.next()).toBeUndefined();
    expect((await link.next())?.message?.inquiry).toBe(true);
  });

  it("照会は付随情報つきで返る（キーがあるのでそのまま応答できる）", async () => {
    const q = [{ key: "0000abcd", text: "Attributes not supported.", type: "05", id: "CPA3303" }];
    const { source } = open(q, { ...SPEC, includeExisting: true });
    const link = await source.open();
    expect((await link.next())?.message).toMatchObject({
      key: "0000abcd",
      id: "CPA3303",
      type: "INQUIRY",
      inquiry: true
    });
  });

  it("**張り直してもカーソルは残る**（切れている間に届いたぶんを落とさない）", async () => {
    const q = [{ key: "00000100", text: "old" }];
    const fake1 = fakeConn(q);
    const fake2 = fakeConn(q);
    let nth = 0;
    const source = msgqSource({
      spec: SPEC,
      connect: { host: "h", user: "u", password: "p", ccsid: CCSID } as never,
      open: async () => (nth++ === 0 ? fake1.conn : fake2.conn)
    });
    const link1 = await source.open();
    q.push({ key: "00000200", text: "before-drop" });
    expect((await link1.next())?.text).toBe("before-drop");
    link1.close();
    // 切れている間に届いた
    q.push({ key: "00000300", text: "during-drop" });
    const link2 = await source.open();
    // **位置合わせをやり直さない**（やり直すと「切れている間」が消える）
    expect(fake2.calls.some((c) => c.selector === "*LAST")).toBe(false);
    expect((await link2.next())?.text).toBe("during-drop");
  });

  it("待っても直らない断りは**張り直させない**コードにする", async () => {
    const conn = {
      async call() {
        return {
          result: { success: false, returnCode: 1, messages: [{ id: "CPF2403", text: "queue not found" }] },
          outputs: []
        };
      },
      close() {}
    } as unknown as CommandConnection;
    const source = msgqSource({
      spec: SPEC,
      connect: { host: "h", user: "u", password: "p", ccsid: CCSID } as never,
      open: async () => conn
    });
    await expect(source.open()).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("知らない断りは**一時的**として扱う（安全側に倒す）", async () => {
    const conn = {
      async call() {
        return {
          result: { success: false, returnCode: 1, messages: [{ id: "CPF9999", text: "何かの都合" }] },
          outputs: []
        };
      },
      close() {}
    } as unknown as CommandConnection;
    const source = msgqSource({
      spec: SPEC,
      connect: { host: "h", user: "u", password: "p", ccsid: CCSID } as never,
      open: async () => conn
    });
    await expect(source.open()).rejects.toMatchObject({ code: "COMMAND_FAILED" });
  });

  it("**カーソルの先が消えたら末尾へ逃がす**（永久に同じ失敗を繰り返さない）", async () => {
    const q = [{ key: "00000100", text: "survivor" }];
    let gone = true;
    const calls: string[] = [];
    const conn = {
      async call(_p: string, _l: string, params: readonly unknown[]) {
        const at = (i: number): Uint8Array => (params[i] as { data: Uint8Array }).data;
        const selector = codec.decode(at(4)).trim();
        calls.push(selector);
        if (selector === "*NEXT" && gone) {
          gone = false;
          return {
            result: { success: false, returnCode: 1, messages: [{ id: "CPF2551", text: "key not valid" }] },
            outputs: []
          };
        }
        return {
          result: { success: true, returnCode: 0, messages: [] },
          outputs: [encode(selector === "*LAST" ? q.at(-1) : undefined)]
        };
      },
      close() {}
    } as unknown as CommandConnection;
    const source = msgqSource({
      spec: SPEC,
      connect: { host: "h", user: "u", password: "p", ccsid: CCSID } as never,
      open: async () => conn
    });
    const link = await source.open();
    expect(await link.next()).toBeUndefined(); // 逃がした回は空が返る
    expect(calls).toEqual(["*LAST", "*NEXT", "*LAST"]);
  });

  it("それ以外の失敗はそのまま投げる（握りつぶさない）", async () => {
    const conn = {
      async call() {
        throw new As400Error("SESSION_CLOSED", "切れた");
      },
      close() {}
    } as unknown as CommandConnection;
    const source = msgqSource({
      spec: { ...SPEC, includeExisting: true },
      connect: { host: "h", user: "u", password: "p", ccsid: CCSID } as never,
      open: async () => conn
    });
    const link = await source.open();
    await expect(link.next()).rejects.toMatchObject({ code: "SESSION_CLOSED" });
  });

  it("閉じると接続も閉じる", async () => {
    const { source, closed } = open([]);
    const link = await source.open();
    link.close();
    expect(closed()).toBe(1);
  });
});
