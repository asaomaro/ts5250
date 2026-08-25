import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { ScreenBuffer } from "../src/screen/buffer.js";
import { codecForCcsid } from "@ts5250/ebcdic/codec";
import { ESC, COMMAND, OPCODE } from "../src/protocol/constants.js";
import { buildRecord } from "../src/protocol/gds.js";
import { ByteWriter } from "../src/protocol/bytes.js";
import { Session5250 } from "../src/session/session.js";
import { ReplayTransport } from "../src/trace/replay.js";
import { parseTraceJsonl, bytesToHex, type TraceEntry } from "../src/trace/trace.js";
import { IAC, CMD } from "../src/telnet/constants.js";

/**
 * **WRITE ERROR CODE（0x21）のメッセージは `systemMessage` に入れる。画面セルには書かない。**
 *
 * 参照実装 2 つ（tn5250 / tn5250j）は画面バッファのエラー行へ直接書く。当方は書かない——
 * **その差が外から見える結果を変えないか**を実機で確かめたうえでの判断（2026-08-25）。
 *
 * ## 実機で採った材料（実機 / IBM i 7.3）
 *
 * `ASAOLIB/DTMPGM` の 8 桁日付欄 `D8W`（`EDTWRD('    /  /  ')`・EDTMSK なし）へ
 * 10 桁ぶんの数字を送って桁あふれを起こすと、ホストは 0x21 を返す:
 *
 * ```
 * 受信 04 21 13 12 18 22 0e 45 5d 46 cc …   ← IC(18,24) ＋ 属性 ＋ SO 付き DBCS 本文
 * snapshot.systemMessage = "小数部分の使用法が正しくないか，あるいは入力した数字が多すぎる。"
 * cells に「小数」「正しくない」は無し（23・24 行目は空）
 * ```
 *
 * **MCP からは読める。** `screenToText`（`get_screen` / `wait_screen` の本文）は
 * `=== Message ===` 節を付けて `systemMessage` を出し、構造化出力にも `systemMessage` が載る。
 * Web UI も `screen-html.ts` が `<span class="msg">` で描く。**外から見える結果は変わらない**
 * ので、セルへ書く改修はしない（書くならエラー行の退避・復元＝次の AID で元へ戻す仕組みが要り、
 * 自動化が突き合わせている画面テキストを変えてしまう）。
 *
 * ただし **`wait_screen` の `until` はセルしか見ていなかった**——これだけは
 * 「エラーを待てない」という実害になるので、`systemMessage` も見るようにした（下のテスト）。
 */

const codec = codecForCcsid(37);
const here = dirname(fileURLToPath(import.meta.url));

/** 実機のバイト並びに合わせた WEC（IC ＋ 属性 ＋ 本文）。後ろに READ を置いて解錠させる */
function wecRecord(text: string): Uint8Array {
  const w = new ByteWriter();
  w.u8(ESC).u8(COMMAND.WRITE_ERROR_CODE);
  w.u8(0x13).u8(18).u8(24); // IC(18,24)＝実機と同じ
  w.u8(0x22); // 属性
  w.bytes(codec.encode(text).bytes);
  w.u8(ESC).u8(COMMAND.READ_MDT_FIELDS).u8(0x00).u8(0x08);
  return buildRecord(OPCODE.PUT_GET, w.toUint8Array());
}

describe("WRITE ERROR CODE（0x21）", () => {
  it("メッセージは systemMessage に入る", () => {
    const buf = new ScreenBuffer();
    applyDataStream(wecRecord("TOO MANY DIGITS").subarray(10), buf, codec, () => undefined);
    expect(buf.systemMessage).toBe("TOO MANY DIGITS");
  });

  it("**画面セルは書き換えない**（参照実装との差。実機でもセルは空だった）", () => {
    const buf = new ScreenBuffer();
    applyDataStream(wecRecord("TOO MANY DIGITS").subarray(10), buf, codec, () => undefined);
    const cells = buf
      .snapshot("t", false)
      .cells.map((r) => r.map((c) => c.char).join(""))
      .join("\n");
    expect(cells).not.toContain("TOO MANY DIGITS");
    expect(cells.trim()).toBe("");
  });
});

describe("wait_screen は WRITE ERROR CODE のメッセージを待てる", () => {
  function rxRecord(record: Uint8Array): TraceEntry {
    const framed: number[] = [];
    for (const b of record) {
      framed.push(b);
      if (b === IAC) framed.push(IAC);
    }
    framed.push(IAC, CMD.EOR);
    return { ts: "t", dir: "rx", hex: bytesToHex(Uint8Array.from(framed)) };
  }

  async function connectWithError(): Promise<Session5250> {
    const entries: TraceEntry[] = [
      ...parseTraceJsonl(readFileSync(join(here, "fixtures", "pub400-signon.jsonl"), "utf8")),
      { ts: "t", dir: "tx", masked: true, len: 0 },
      rxRecord(wecRecord("TOO MANY DIGITS"))
    ];
    const session = await Session5250.connect({ transport: new ReplayTransport(entries), id: "wec" });
    await session.sendAid("Enter", { timeoutMs: 500 });
    return session;
  }

  it("セルに無くても `until` が成立する（セルだけ見ていたら待てない）", async () => {
    const session = await connectWithError();
    expect(session.snapshot().systemMessage).toBe("TOO MANY DIGITS");
    const r = await session.waitForScreen({ until: { text: "MANY DIGITS" }, timeoutMs: 200 });
    expect(r.timedOut).toBe(false);
    session.disconnect();
  });

  it("**行を指定したときはその行のセルだけ**を見る（メッセージは行を持たない）", async () => {
    const session = await connectWithError();
    const r = await session.waitForScreen({ until: { text: "MANY DIGITS", row: 24 }, timeoutMs: 30 });
    expect(r.timedOut).toBe(true);
    session.disconnect();
  });
});
