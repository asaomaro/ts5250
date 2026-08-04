import { describe, it, expect } from "vitest";
import {
  buildServiceProgramParams,
  splitServiceProgramOutputs,
  MAX_PASS_BY_VALUE_BYTES
} from "../src/command/service-program.js";
import { codecForCcsid } from "@ts5250/ebcdic";

/**
 * **`QZRUCLSP` へ渡す形。**
 *
 * 配置は実機で組み合わせを試して確定した（2026-08-04）。**間違えても失敗しない**
 * 取り違えが 2 つあるので、そこを固定する:
 *
 * - **値渡し=1 / 参照渡し=2** を逆にすると、呼べてしまい**戻り値が 0 になる**
 * - **値渡しは 4 バイトまで**。超えると呼べてしまい**結果が壊れる**
 */
const O = { ccsid: 37 };
const dec = (b: Uint8Array): string => codecForCcsid(37).decode(b);
const i32 = (b: Uint8Array, at = 0): number => new DataView(b.buffer, b.byteOffset, b.byteLength).getInt32(at);

const build = (over: Partial<Parameters<typeof buildServiceProgramParams>[0]> = {}) =>
  buildServiceProgramParams({
    serviceProgram: "SRVTST",
    library: "TESTLIB",
    procedure: "SRVADD",
    args: [],
    ...O,
    ...over
  });

describe("QZRUCLSP へ渡す形", () => {
  it("**修飾名は 10 桁ずつ空白詰め**", () => {
    const p = build()[0]!;
    expect(p.type).toBe("in");
    if (p.type !== "in") return;
    expect(p.data).toHaveLength(20);
    expect(dec(p.data.slice(0, 10))).toBe("SRVTST    ");
    expect(dec(p.data.slice(10))).toBe("TESTLIB   ");
  });

  it("**手続き名はヌル終端**（C の文字列として読まれる）", () => {
    const p = build({ procedure: "SRVADD" })[1]!;
    if (p.type !== "in") throw new Error("in のはず");
    expect(p.data[p.data.length - 1]).toBe(0);
    expect(dec(p.data.slice(0, -1))).toBe("SRVADD");
  });

  it("**値渡し=1 / 参照渡し=2**（逆だと戻り値が 0 になる。失敗しない）", () => {
    const p = build({
      args: [
        { param: { type: "in", data: new Uint8Array(4) }, pass: "value" },
        { param: { type: "in", data: new Uint8Array(4) }, pass: "reference" }
      ]
    })[3]!;
    if (p.type !== "in") throw new Error("in のはず");
    expect(i32(p.data, 0)).toBe(1);
    expect(i32(p.data, 4)).toBe(2);
  });

  it("**渡し方の既定は参照渡し**", () => {
    const p = build({ args: [{ param: { type: "in", data: new Uint8Array(4) } }] })[3]!;
    if (p.type !== "in") throw new Error("in のはず");
    expect(i32(p.data)).toBe(2);
  });

  it("**戻り値の器は戻り値が無くても渡す**（省くと MCH3601）", () => {
    const params = build({ returns: "none" });
    expect(params[6]).toEqual({ type: "out", length: 4 });
  });

  it("引数が 0 個でも形式の欄を空にしない（ヌルポインタにしない）", () => {
    const p = build({ args: [] })[3]!;
    if (p.type !== "in") throw new Error("in のはず");
    expect(p.data).toHaveLength(4);
  });

  it("**値渡しが 4 バイトを超えたら断る**（通すと結果が静かに壊れる）", () => {
    expect(() =>
      build({ args: [{ param: { type: "in", data: new Uint8Array(8) }, pass: "value" }] })
    ).toThrowError(/参照渡し/u);
    expect(MAX_PASS_BY_VALUE_BYTES).toBe(4);
  });

  it("**参照渡しなら 4 バイトを超えても通る**（大きい型はこちらで受ける）", () => {
    const params = build({ args: [{ param: { type: "out", length: 8 }, pass: "reference" }] });
    expect(params[7]).toEqual({ type: "out", length: 8 });
  });

  it("実引数は 7 番目から並ぶ", () => {
    const params = build({
      args: [{ param: { type: "in", data: Uint8Array.of(1, 2, 3, 4) } }, { param: { type: "out", length: 8 } }]
    });
    expect(params).toHaveLength(9);
    expect(params[7]).toEqual({ type: "in", data: Uint8Array.of(1, 2, 3, 4) });
  });
});

describe("実機で確かめた制約", () => {
  it("**戻り値は 4 バイトの器**（ポインタは運べない）", () => {
    // 器を 16 バイトにしても書かれるのは先頭 4 バイトだけで、呼ぶたびに違う値になる。
    // IBM i のポインタは 16 バイトのタグ付きなので、そもそも運べない（実機で確認）
    expect(build({ returns: "int" })[6]).toEqual({ type: "out", length: 4 });
  });

  it("**手続き名の長さに上限を設けていない**（API 側に上限が無い）", () => {
    // 4007 バイトの器で渡しても通ることを実機で確認した。
    // C++ の装飾名などは 255 を超えうるので、ここで切らない
    const long = "P".repeat(3000);
    const p = build({ procedure: long })[1]!;
    if (p.type !== "in") throw new Error("in のはず");
    expect(p.data).toHaveLength(3001); // 名前 ＋ ヌル終端
  });
});

describe("応答の切り出し", () => {
  it("戻り値は 6 番目、実引数は 7 番目から", () => {
    const outputs = [
      undefined, undefined, undefined, undefined, undefined, undefined,
      Uint8Array.of(0, 0, 0, 42),
      Uint8Array.of(1),
      Uint8Array.of(2)
    ];
    const r = splitServiceProgramOutputs(outputs, 2);
    expect(r.returnValue).toBe(42);
    expect(r.args).toEqual([Uint8Array.of(1), Uint8Array.of(2)]);
  });

  it("戻り値が無ければ undefined", () => {
    expect(splitServiceProgramOutputs([], 0).returnValue).toBeUndefined();
  });
});
