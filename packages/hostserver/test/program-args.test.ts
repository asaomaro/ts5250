import { describe, it, expect } from "vitest";
import { toProgramParameters, fromProgramOutputs, argByteLength } from "../src/command/program-args.js";
import type { ProgramArg } from "../src/command/program-args.js";

/**
 * **型付き引数 ↔ 生バイト。**
 *
 * `CommandConnection.call()` は生バイトしか扱わないので、ここが無いと
 * 利用者は自分でバイト列を組むことになる——**実装済みなのに届かない**の中身がこれ。
 */
const O = { ccsid: 37 };

/** 入力パラメータのバイト列を取り出す（検査を読みやすくするため） */
const inBytes = (a: ProgramArg): Uint8Array => {
  const p = toProgramParameters([a], O)[0]!;
  if (p.type === "in" || p.type === "inout") return p.data;
  throw new Error("入力ではない");
};

describe("入力の変換", () => {
  it("**文字は空白で埋める**（NUL ではない。IBM i の作法）", () => {
    const b = inBytes({ type: "char", value: "AB", length: 5 });
    expect(b).toHaveLength(5);
    expect([...b.slice(2)]).toEqual([0x40, 0x40, 0x40]); // EBCDIC の空白
  });

  it("**長すぎれば拒否**（黙って切らない）", () => {
    expect(() => inBytes({ type: "char", value: "ABCDEF", length: 5 })).toThrowError();
  });

  it("**表せない文字は拒否**（黙って化けさせない）", () => {
    expect(() => inBytes({ type: "char", value: "日本", length: 20 })).toThrowError();
  });

  it("**入力に value が無ければ拒否**（空で送らない）", () => {
    expect(() => toProgramParameters([{ type: "char", length: 5 }], O)).toThrowError();
  });

  it("パック 10 進（`QCMDEXC` の長さ引数の形）", () => {
    const b = inBytes({ type: "packed", value: "7", digits: 15, decimals: 5 });
    expect(b).toHaveLength(8);
    expect(b[b.length - 1]! & 0x0f).toBe(0x0f); // 正の符号
  });

  it("2 進整数（符号つき・ビッグエンディアン）", () => {
    expect([...inBytes({ type: "bin", value: "1", bytes: 4 })]).toEqual([0, 0, 0, 1]);
    expect([...inBytes({ type: "bin", value: "-1", bytes: 2 })]).toEqual([0xff, 0xff]);
    expect(() => inBytes({ type: "bin", value: "70000", bytes: 2 })).toThrowError();
  });

  it("**生バイトの逃げ道**（型で表せない構造体のため）", () => {
    const b = inBytes({ type: "bytes", value: Buffer.from([1, 2, 3]).toString("base64"), length: 5 });
    expect([...b]).toEqual([1, 2, 3, 0, 0]);
  });

  it("**向きの既定は in**", () => {
    expect(toProgramParameters([{ type: "char", value: "A", length: 1 }], O)[0]!.type).toBe("in");
  });

  it("out は長さだけ渡す（値は要らない）", () => {
    const p = toProgramParameters([{ type: "char", dir: "out", length: 30 }], O)[0]!;
    expect(p).toEqual({ type: "out", length: 30 });
  });

  it("inout は値と長さの両方", () => {
    const p = toProgramParameters([{ type: "packed", dir: "inout", value: "1", digits: 5, decimals: 2 }], O)[0]!;
    expect(p.type).toBe("inout");
  });

  it("null はそのまま", () => {
    expect(toProgramParameters([{ type: "null" }], O)[0]).toEqual({ type: "null" });
  });

  it("バイト長が型どおり", () => {
    expect(argByteLength({ type: "char", length: 10 })).toBe(10);
    expect(argByteLength({ type: "packed", digits: 15 })).toBe(8);
    expect(argByteLength({ type: "zoned", digits: 7 })).toBe(7);
    expect(argByteLength({ type: "bin", bytes: 4 })).toBe(4);
  });
});

describe("出力の変換", () => {
  const roundTrip = (a: ProgramArg): string | undefined => {
    // 入力として作ったバイト列を、出力として読み戻す
    const src: ProgramArg = { ...a, dir: "in" } as ProgramArg;
    const bytes = inBytes(src);
    return fromProgramOutputs([{ ...a, dir: "out" } as ProgramArg], [bytes], O)[0];
  };

  it("**往復して値が変わらない**（文字・数値とも）", () => {
    expect(roundTrip({ type: "char", value: "HELLO", length: 10 })).toBe("HELLO     ");
    expect(roundTrip({ type: "packed", value: "-123.45", digits: 7, decimals: 2 })).toBe("-123.45");
    // 読む向きは**先頭の 0 を落とす**（`zonedDecimalToString` の既存の振る舞い）
    expect(roundTrip({ type: "zoned", value: "42", digits: 5, decimals: 0 })).toBe("42");
    expect(roundTrip({ type: "bin", value: "-70000", bytes: 4 })).toBe("-70000");
  });

  it("**入力専用の位置は undefined**（読むものが無い）", () => {
    const args: ProgramArg[] = [
      { type: "char", value: "A", length: 1 },
      { type: "char", dir: "out", length: 3 }
    ];
    const out = fromProgramOutputs(args, [undefined, Uint8Array.from([0xc1, 0xc2, 0xc3])], O);
    expect(out[0]).toBeUndefined();
    expect(out[1]).toBe("ABC");
  });

  it("生バイトは base64 で返る", () => {
    const out = fromProgramOutputs(
      [{ type: "bytes", dir: "out", length: 3 }],
      [Uint8Array.from([1, 2, 3])],
      O
    );
    expect(out[0]).toBe(Buffer.from([1, 2, 3]).toString("base64"));
  });
});
