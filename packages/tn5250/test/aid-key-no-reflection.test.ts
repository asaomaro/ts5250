import { describe, it, expect } from "vitest";
import { Session5250 } from "../src/session/session.js";
import { ReplayTransport } from "../src/trace/replay.js";
import { bytesToHex, type TraceEntry } from "../src/trace/trace.js";
import { buildRecord } from "../src/protocol/gds.js";
import { ByteWriter } from "../src/protocol/bytes.js";
import { ESC, COMMAND, ORDER, OPCODE, FFW } from "../src/protocol/constants.js";
import { IAC, CMD } from "../src/telnet/constants.js";
import type { AidKey } from "../src/session/types.js";

/**
 * **クライアントが送った文字列を、例外の文言へ反射しない**
 * （`20260920-field-error-no-value` AC9 / decisions D3）。
 *
 * `key` も `sysReqText` も ws の `type:"key"` から来る**任意の文字列**で、
 * `ws-handler` の catch は message をそのままクライアントへ返す。
 * 反射は値の漏れではない（送った本人が知っている）が、**サーバーを鏡にしない**
 * ——文言に何が入るかは、送った側ではなくこちらが決める。
 *
 * 対になる 3270 側は `packages/server/test/ws-tn3270.test.ts`、
 * 読み取り専用セッションは `packages/server/test/session-manager*.test.ts`。
 */

const MARKER = "LEAK_MARKER_XYZ";

function rx(record: Uint8Array): TraceEntry {
  const framed: number[] = [];
  for (const b of record) {
    framed.push(b);
    if (b === IAC) framed.push(IAC);
  }
  framed.push(IAC, CMD.EOR);
  return { ts: "t", dir: "rx", hex: bytesToHex(Uint8Array.from(framed)) };
}

/** 入力欄を 1 つ置いただけの画面（キーを受け付ける状態にするために要る） */
function screen(): Uint8Array {
  const w = new ByteWriter();
  w.u8(ESC).u8(COMMAND.CLEAR_UNIT);
  w.u8(ESC).u8(COMMAND.WRITE_TO_DISPLAY).u8(0x00).u8(0x18);
  w.u8(ORDER.SBA).u8(5).u8(24);
  w.u8(ORDER.SF).u16(FFW.ID_VALUE).u8(0x20).u16(20);
  w.u8(ESC).u8(COMMAND.READ_MDT_FIELDS).u8(0x00).u8(0x00);
  return buildRecord(OPCODE.PUT_GET, w.toUint8Array());
}

const openSession = (): Promise<Session5250> =>
  Session5250.connect({ transport: new ReplayTransport([rx(screen())]), id: "t" });

/**
 * `sendAid` は `Promise` を返すが `async` ではなく（`session/session.ts` の宣言）、
 * レコードの組み立ては**同期**なのでここの拒否は**同期 throw** で出る。
 * `try { await fn() }` は同期 throw も捕まえるが、**`expect(...).rejects` では捕まらない**
 * ——最初その形で書いて落ちた。
 */
async function caught(fn: () => Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await fn();
  } catch (e) {
    return e as { code?: string; message: string };
  }
  throw new Error("例外が投げられていない（この検査は空振りしている）");
}

describe("AID キーの拒否はクライアント由来の文字列を反射しない", () => {
  it("知らないキー名を文言に載せない", async () => {
    const session = await openSession();
    // ws からは**任意の文字列**が来る（`AidKey` は型の上での制約でしかない）
    const e = await caught(() => session.sendAid(MARKER as AidKey));
    expect(e.code).toBe("PROTOCOL_ERROR");
    expect(e.message, "キー名を反射しない").not.toContain(MARKER);
    expect(e.message).toBe("unsupported AID key");
  });

  it("sysReqText を別のキーに付けたとき、その中身もキー名も載せない", async () => {
    const session = await openSession();
    const e = await caught(() => session.sendAid("Enter", { sysReqText: MARKER }));
    expect(e.code).toBe("PROTOCOL_ERROR");
    expect(e.message, "sysReqText の中身を反射しない").not.toContain(MARKER);
    expect(e.message).toBe("sysReqText is only valid with SysReq");
  });
});
