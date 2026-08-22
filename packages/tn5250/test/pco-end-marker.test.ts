import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { codecForCcsid } from "@ts5250/ebcdic";
import { parseRecord } from "../src/protocol/gds.js";
import { applyDataStream } from "../src/protocol/wtd-applier.js";
import { detectPcoMarker, PCO_END } from "../src/protocol/pc-command.js";
import { ScreenBuffer } from "../src/screen/buffer.js";

/**
 * **PC Organizer の終了標識を実機で押さえた**（2026-08-22・実機 / IBM i 7.3）。
 *
 * この値は xtn5250 の `ENDSTRPCCMD` 定数から採ったもので、**実機で見たことがなかった**
 * （`20260728-strpco-strpccmd` D6）。当時の結論は「実機に `ENDPCO` が無く誘発できない」。
 *
 * ## 前提を測り直したら道があった
 *
 * - `ENDPCO` は **7.3 / 7.5 のどちらにも無い**（`CHKOBJ` で `CPF9801`）——ここは当時どおり
 * - `STRPCO` は両機に在り、パラメータは **`PCTA(*YES|*NO)` の 1 つだけ**
 *   （`retrieveCommandTemplate` で確認）。**終了指定は無い**
 * - ⚠ **だが「コマンドで終わらせる」以外の道があった**——`STRPCO` したあと **`SIGNOFF`** すると、
 *   ホストはサインオン画面と一緒にこの標識を送ってくる
 *
 * 再現: `scripts/research-pco-end-marker.mjs`
 *
 * ## 届いたレコード（`fixtures/pc-command/pco-end-signoff.hex` は実機のバイト列そのもの）
 *
 * ```
 * … 43 41 0f 20 11 01 01 27 00 fc d7 c3 d6 40 83 80 82 00 00 00 …  04 52 00 00
 *              └ SBA(1,1) ┘ └──────── 終了標識 11 バイト ────────┘  └ READ MDT ┘
 * ```
 *
 * **位置は開始標識と同じ (1,1)**、末尾は `READ MDT FIELDS`——つまり**ホストは応答を待つ**。
 * 当方の「一致したら実行せず実行キーだけ返す」という扱いはこれで裏が取れた
 * （返さなければホストが待ち続ける）。
 */

const here = dirname(fileURLToPath(import.meta.url));
const RECORD = Uint8Array.from(
  readFileSync(join(here, "fixtures", "pc-command", "pco-end-signoff.hex"), "utf8")
    .replace(/\s/gu, "")
    .match(/../gu)!
    .map((h) => parseInt(h, 16))
);

const codec = codecForCcsid(939);

describe("PCO 終了標識（実機レコード）", () => {
  it("**定数は実機のバイト列と一致する**（xtn5250 から採った値が正しかった）", () => {
    const at = RECORD.findIndex((_, i) => PCO_END.every((b, k) => RECORD[i + k] === b));
    expect(at, "レコードに終了標識が含まれる").toBeGreaterThan(0);
  });

  it("**SBA(1,1) の直後にある**（開始標識と同じ位置）", () => {
    const at = RECORD.findIndex((_, i) => PCO_END.every((b, k) => RECORD[i + k] === b));
    // 0x11 = SBA、続く 2 バイトが行・桁
    expect([...RECORD.slice(at - 3, at)]).toEqual([0x11, 0x01, 0x01]);
  });

  it("**末尾は READ MDT FIELDS**——ホストは応答を待っている", () => {
    // 0x04 = ESC、0x52 = READ MDT FIELDS
    expect([...RECORD.slice(-4)]).toEqual([0x04, 0x52, 0x00, 0x00]);
  });

  it("標識として検出される", () => {
    const at = RECORD.findIndex((_, i) => PCO_END.every((b, k) => RECORD[i + k] === b));
    expect(detectPcoMarker(RECORD.slice(at))).toBe("end");
  });
});

describe("このレコードを流したときの振る舞い", () => {
  const applied = (): ReturnType<typeof applyDataStream> => {
    const buf = new ScreenBuffer({ alternate: "27x132" });
    return applyDataStream(parseRecord(RECORD).data, buf, codec);
  };

  it("**終了として扱い、コマンドとしては読まない**", () => {
    const r = applied();
    expect(r.pcCommandEnd).toBe(true);
    expect(r.pcCommand, "本文をコマンドと解釈しない").toBeUndefined();
  });

  it("**入力待ちに入る**（READ MDT FIELDS に応答する）", () => {
    expect(applied().readRequested).toBe(true);
  });

  it("未知のコマンドとして警告しない（素直に読み切れている）", () => {
    const buf = new ScreenBuffer({ alternate: "27x132" });
    const warns: string[] = [];
    applyDataStream(parseRecord(RECORD).data, buf, codec, (m) => warns.push(m));
    expect(warns.filter((w) => w.includes("unknown command"))).toEqual([]);
  });
});
