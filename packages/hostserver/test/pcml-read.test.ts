import { describe, it, expect } from "vitest";
import { codecForCcsid } from "@ts5250/ebcdic";
import { parsePcml } from "../src/command/pcml-parse.js";
import { buildPcmlCall, readPcmlOutputs } from "../src/command/pcml-layout.js";

/**
 * **返ってきたバイトを先頭から順に解く。**
 *
 * IBM の書式は「前詰め＋末尾に可変長」で、可変長の位置・件数・長さ・CCSID を
 * **頭の整数で知らせる**。だから割り付けを当てはめるのではなく、読みながら決める。
 */
const O = { ccsid: 37 };
const cp = codecForCcsid(37);

const int32 = (v: number): number[] => [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
const ebcdic = (s: string): number[] => [...cp.encode(s).bytes];

const DOC = parsePcml(
  [
    '<pcml version="4.0">',
    ' <program name="P">',
    '  <data name="rcv" type="struct" struct="R" usage="output" outputsize="len"/>',
    '  <data name="len" type="int" length="4" usage="input" init="64"/>',
    " </program>",
    ' <struct name="R">',
    '  <data name="offGroups" type="int" length="4"/>',
    '  <data name="nGroups"   type="int" length="4"/>',
    '  <data name="offName"   type="int" length="4"/>',
    '  <data name="lenName"   type="int" length="4"/>',
    '  <data type="byte" length="0" offset="offGroups" offsetfrom="0"/>',
    '  <data name="groups" type="char" length="3" count="nGroups"/>',
    '  <data type="byte" length="0" offset="offName" offsetfrom="0"/>',
    '  <data name="name" type="char" length="lenName"/>',
    " </struct>",
    "</pcml>"
  ].join("\n")
);

/** ホストが返した受取域を組む（0-19 が頭、20 から群、32 から名前） */
function receiver(over: { offGroups?: number; nGroups?: number; offName?: number; lenName?: number } = {}): Uint8Array {
  const buf = new Uint8Array(40).fill(0x40);
  buf.set(int32(over.offGroups ?? 20), 0);
  buf.set(int32(over.nGroups ?? 2), 4);
  buf.set(int32(over.offName ?? 32), 8);
  buf.set(int32(over.lenName ?? 5), 12);
  buf.set(ebcdic("AAABBB"), 20);
  buf.set(ebcdic("HELLO"), 32);
  buf.set(ebcdic("ZZZ"), 37);
  return buf;
}

const read = (bytes: Uint8Array) => {
  const call = buildPcmlCall(DOC, "P", {}, O);
  return readPcmlOutputs(call, [bytes, undefined]);
};

describe("飛び先", () => {
  it("**`offsetfrom=\"0\"` は引数の先頭から数える**", () => {
    const got = read(receiver());
    expect(got["P.rcv.name"]).toBe("HELLO");
  });

  it("**出力で決まる件数**（読んだ整数が件数になる）", () => {
    const got = read(receiver());
    expect(got["P.rcv.groups(1)"]).toBe("AAA");
    expect(got["P.rcv.groups(2)"]).toBe("BBB");
    expect(got["P.rcv.groups(3)"]).toBeUndefined();
  });

  it("件数が変われば読む数も変わる", () => {
    const got = read(receiver({ nGroups: 1 }));
    expect(got["P.rcv.groups(1)"]).toBe("AAA");
    expect(got["P.rcv.groups(2)"]).toBeUndefined();
  });

  it("**出力で決まる長さ**", () => {
    expect(read(receiver({ lenName: 3 }))["P.rcv.name"]).toBe("HEL");
  });

  it("飛び先が変われば読む位置も変わる", () => {
    expect(read(receiver({ offName: 37, lenName: 3 }))["P.rcv.name"]).toBe("ZZZ");
  });

  it("**名前の無いしおりは値を持たない**", () => {
    const got = read(receiver());
    expect(Object.keys(got).every((k) => k !== "")).toBe(true);
    expect(Object.keys(got)).toEqual([
      "P.rcv.offGroups",
      "P.rcv.nGroups",
      "P.rcv.offName",
      "P.rcv.lenName",
      "P.rcv.groups(1)",
      "P.rcv.groups(2)",
      "P.rcv.name"
    ]);
  });

  it("**前には戻らない**（飛び先が現在位置より前なら何もしない）", () => {
    // 名前の飛び先を 0 にすると「戻れ」だが、原典と同じく戻らない。
    // その場で 5 バイト読むので、群のうしろ（26 バイト目）から読む
    const got = read(receiver({ offName: 1 }));
    expect(got["P.rcv.name"]).toBe("     ");
  });
});

describe("外を指したら断る", () => {
  it("飛び先が受け取ったバイト列の外", () => {
    expect(() => read(receiver({ offName: 9999 }))).toThrow(/飛び先 9999 が受け取った 40 バイトの外/u);
  });

  it("長さが受け取ったバイト列の外", () => {
    expect(() => read(receiver({ lenName: 99 }))).toThrow(/32 から 99 バイト要りますが、受け取ったのは 40/u);
  });

  it("件数が負", () => {
    expect(() => read(receiver({ nGroups: -1 }))).toThrow(/件数 -1 が負です/u);
  });
});

describe("基点を省略すると親の開始位置", () => {
  const NESTED = parsePcml(
    [
      '<pcml version="4.0">',
      ' <program name="Q">',
      '  <data name="rcv" type="struct" struct="H" usage="output"/>',
      " </program>",
      ' <struct name="H">',
      '  <data name="head" type="char" length="4"/>',
      '  <struct name="inner">',
      '   <data name="off"  type="int"  length="4"/>',
      '   <data name="here" type="char" length="3" offset="off"/>',
      "  </struct>",
      " </struct>",
      "</pcml>"
    ].join("\n")
  );

  it("**`inner` の先頭からの相対**として飛ぶ", () => {
    const buf = new Uint8Array(20).fill(0x40);
    buf.set(ebcdic("HEAD"), 0);
    buf.set(int32(10), 4); // inner は 4 から始まるので 4 + 10 = 14
    buf.set(ebcdic("XYZ"), 14);
    const call = buildPcmlCall(NESTED, "Q", {}, O);
    expect(readPcmlOutputs(call, [buf])["Q.rcv.inner.here"]).toBe("XYZ");
  });
});

describe("出力で決まる CCSID", () => {
  const CC = parsePcml(
    [
      '<pcml version="4.0">',
      ' <program name="R">',
      '  <data name="rcv" type="struct" struct="S" usage="output"/>',
      " </program>",
      ' <struct name="S">',
      '  <data name="cc"   type="int"  length="4"/>',
      '  <data name="text" type="char" length="4" ccsid="cc"/>',
      " </struct>",
      "</pcml>"
    ].join("\n")
  );

  /** 37 と 273 で割り当ての違うバイト */
  const RAW = [0x4a, 0x4b, 0x4c, 0x4d];

  it("**記述の指す CCSID で読む**（接続のものではない）", () => {
    const buf = new Uint8Array([...int32(273), ...RAW]);
    const call = buildPcmlCall(CC, "R", {}, O);
    const got = readPcmlOutputs(call, [buf]);
    expect(got["R.rcv.text"]).toBe(codecForCcsid(273).decode(new Uint8Array(RAW)));
    expect(got["R.rcv.text"]).not.toBe(codecForCcsid(37).decode(new Uint8Array(RAW)));
  });

  it("**扱えない CCSID は、どの項目のどれかを言って断る**（黙って別の符号で読まない）", () => {
    const buf = new Uint8Array([...int32(500), ...RAW]);
    const call = buildPcmlCall(CC, "R", {}, O);
    expect(() => readPcmlOutputs(call, [buf])).toThrow(/R\.rcv\.text（CCSID 500）を読めませんでした/u);
  });

  it("0 なら接続の CCSID に落ちる", () => {
    const buf = new Uint8Array([...int32(0), ...RAW]);
    const call = buildPcmlCall(CC, "R", {}, O);
    expect(readPcmlOutputs(call, [buf])["R.rcv.text"]).toBe(codecForCcsid(37).decode(new Uint8Array(RAW)));
  });
});

describe("入力側の飛び先は断る", () => {
  it("**実例が無く測っていない**ので、黙って通さない", () => {
    const doc = parsePcml(
      [
        '<pcml version="4.0"><program name="P">',
        '<data name="X" type="char" length="4" usage="input" offset="8" init="a" />',
        "</program></pcml>"
      ].join("\n")
    );
    expect(() => buildPcmlCall(doc, "P", {}, O)).toThrow(/入力に使う引数の offset はまだ扱えません/u);
  });
});

describe("EBCDIC ではない CCSID", () => {
  /**
   * **実機で踏んだ。** QSYRUSRI（`USRI0300`）はホームディレクトリ名を
   * **CCSID 1200（UTF-16）**で返す——IFS の道は Unicode で持たれるため。
   * EBCDIC の表だけでは読めない。
   */
  const U = parsePcml(
    [
      '<pcml version="4.0">',
      ' <program name="U">',
      // 受取域の大きさは記述が持つ（中身の長さは読むまで決まらないので、これが無いと呼べない）
      '  <data name="rcv" type="struct" struct="S" usage="output" outputsize="64"/>',
      " </program>",
      ' <struct name="S">',
      '  <data name="cc"  type="int"  length="4"/>',
      '  <data name="len" type="int"  length="4"/>',
      '  <data name="path" type="char" length="len" ccsid="cc"/>',
      " </struct>",
      "</pcml>"
    ].join("\n")
  );

  const utf16be = (s: string): number[] => {
    const out: number[] = [];
    for (const ch of s) {
      const c = ch.codePointAt(0)!;
      out.push((c >> 8) & 0xff, c & 0xff);
    }
    return out;
  };

  it("**CCSID 1200 は UTF-16 として読む**", () => {
    const text = "/home/USER";
    const buf = new Uint8Array([...int32(1200), ...int32(text.length * 2), ...utf16be(text)]);
    const call = buildPcmlCall(U, "U", {}, O);
    expect(readPcmlOutputs(call, [buf])["U.rcv.path"]).toBe(text);
  });

  it("CCSID 1208 は UTF-8 として読む", () => {
    const bytes = [...new TextEncoder().encode("日本語")];
    const buf = new Uint8Array([...int32(1208), ...int32(bytes.length), ...bytes]);
    const call = buildPcmlCall(U, "U", {}, O);
    expect(readPcmlOutputs(call, [buf])["U.rcv.path"]).toBe("日本語");
  });

  it("EBCDIC の CCSID はこれまでどおり", () => {
    const buf = new Uint8Array([...int32(37), ...int32(3), ...ebcdic("ABC")]);
    const call = buildPcmlCall(U, "U", {}, O);
    expect(readPcmlOutputs(call, [buf])["U.rcv.path"]).toBe("ABC");
  });
});
