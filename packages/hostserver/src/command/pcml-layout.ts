/**
 * **PCML の記述を、既存の引数の列に平らにする。**
 *
 * ## なぜ平らにするのか
 *
 * IBM i の引数は**ポインタの配列**で、構造体は 1 本のポインタとして渡る。
 * だから「1 引数 = 1 バイト列」は崩せない——分割すると引数の本数が変わり `MCH0802` になる。
 *
 * 構造体と配列の実体は**実機で測ってある**（`research.md` C）:
 *
 * - 構造体は**メンバーを順に連結しただけ**（詰め物も境界合わせも無い）
 * - 配列は**同じ型を count 回並べただけ**
 *
 * だから新しい電文も新しい変換も要らない。木を平らにして `bytes` 1 本に畳み、
 * 中身の詰め方／解き方だけをこの層が持つ。
 *
 * ## 利用者には平らに見せない
 *
 * 入れるときも読むときも**名前**（`PCMLTST.REC.NM` / `PCMLTST.ITEMS(2)`）。
 * base64 の手詰めはここで吸収する——それが無いと桁ずれが型で止まらない。
 */
import { As400Error } from "@ts5250/base";
import type { PcmlDocument, PcmlField, PcmlProgram, PcmlUsage } from "./pcml-parse.js";
import {
  argByteLength,
  decodeArgValue,
  encodeArgValue,
  type ArgCodecOptions,
  type ProgramArg
} from "./program-args.js";

/** 葉 1 つ。**どの引数の、どこから何バイトか** */
export interface PcmlSlot {
  /** 完全名。配列は `PCMLTST.ITEMS(2)`（**1 始まり**——PCML の慣習） */
  path: string;
  /** 何番目の引数か */
  arg: number;
  /** その引数の中の位置 */
  offset: number;
  byteLength: number;
  usage: PcmlUsage;
  /** 読み書きに使うひな形（`value` は入っていない） */
  spec: ProgramArg;
  /** この葉の CCSID（項目指定が無ければ接続のもの） */
  ccsid: number;
}

export interface PcmlCall {
  program: string;
  library: string;
  /** サービスプログラムのときの手続き名 */
  entrypoint?: string;
  args: ProgramArg[];
  slots: PcmlSlot[];
}

/* ------------------------------------------------------------------ */

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** `Buffer` を使わない（この層は純粋ロジックという規約） */
function toBase64(data: Uint8Array): string {
  let out = "";
  for (let i = 0; i < data.length; i += 3) {
    const a = data[i]!;
    const b = data[i + 1];
    const c = data[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | ((b ?? 0) >> 4)];
    out += b === undefined ? "=" : B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    out += c === undefined ? "=" : B64[c & 63];
  }
  return out;
}

/**
 * `path="/QSYS.LIB/ASAOLIB.LIB/PCMLTST.PGM"` を分解する。
 * 書かれていなければ `*LIBL` から探す（`<program name>` をそのまま使う）。
 */
export function pcmlTarget(program: PcmlProgram): { program: string; library: string } {
  const path = program.path;
  if (path === undefined || path === "") return { program: program.name, library: "*LIBL" };
  const parts = path.split("/").filter((p) => p !== "");
  const last = parts[parts.length - 1] ?? "";
  const name = last.replace(/\.(PGM|SRVPGM)$/iu, "");
  const libPart = parts[parts.length - 2] ?? "";
  const library = /\.LIB$/iu.test(libPart) ? libPart.replace(/\.LIB$/iu, "") : "*LIBL";
  if (name === "") {
    throw new As400Error("CONFIG_ERROR", `path="${path}" からプログラム名を取れません`);
  }
  return { program: name.toUpperCase(), library: library.toUpperCase() };
}

/** 葉 1 つのひな形と、そのバイト長 */
function templateOf(field: PcmlField): ProgramArg {
  const need = (what: string): number => {
    if (field.length === undefined) {
      throw new As400Error("CONFIG_ERROR", `${field.path}: ${what} には length が要ります`);
    }
    return field.length;
  };
  switch (field.type) {
    case "char":
      return { type: "char", length: need("char") };
    case "byte":
      return { type: "bytes", length: need("byte") };
    case "packed":
      return { type: "packed", digits: need("packed"), decimals: field.precision ?? 0 };
    case "zoned":
      return { type: "zoned", digits: need("zoned"), decimals: field.precision ?? 0 };
    case "int": {
      const bytes = need("int");
      if (bytes !== 2 && bytes !== 4 && bytes !== 8) {
        throw new As400Error("CONFIG_ERROR", `${field.path}: int の length は 2 / 4 / 8 です（${bytes}）`);
      }
      // **符号は precision で決まる**——16/32/64 が符号なし（`pcml-parse.ts` の注記）
      const unsigned = field.precision === bytes * 8;
      return { type: "bin", bytes, signed: !unsigned };
    }
    case "float": {
      const bytes = need("float");
      if (bytes !== 4 && bytes !== 8) {
        throw new As400Error("CONFIG_ERROR", `${field.path}: float の length は 4 / 8 です（${bytes}）`);
      }
      return { type: "float", bytes };
    }
    case "struct":
      throw new As400Error("CONFIG_ERROR", `${field.path}: 構造体は葉ではありません`);
  }
}

/** `count` を件数に解く。**決まらなければ呼ばない**（0 件にすると領域外を壊す） */
function countOf(
  field: PcmlField,
  values: Readonly<Record<string, string>>,
  program: PcmlProgram
): number {
  if (field.count === undefined) return 1;
  if (typeof field.count === "number") return field.count;
  // 入力値が無ければ、指している項目の `init`（記述が持つ既定）に落ちる
  const raw = values[field.count] ?? fieldInit(program, field.count);
  if (raw === undefined || raw.trim() === "") {
    throw new As400Error(
      "CONFIG_ERROR",
      `${field.path} の件数は ${field.count} で決まります。呼ぶ前に ${field.count} を入れてください`
    );
  }
  if (!/^\d+$/u.test(raw.trim())) {
    throw new As400Error("CONFIG_ERROR", `${field.count} = ${JSON.stringify(raw)} は件数になりません`);
  }
  return Number.parseInt(raw.trim(), 10);
}

/** 木を葉に開く。戻りは消費したバイト数 */
function planField(
  field: PcmlField,
  path: string,
  values: Readonly<Record<string, string>>,
  program: PcmlProgram,
  arg: number,
  offset: number,
  ccsid: number,
  out: PcmlSlot[]
): number {
  const n = countOf(field, values, program);
  let at = offset;
  for (let i = 0; i < n; i++) {
    // **配列は 1 始まり**（PCML の慣習）。件数 1 の非配列は添字を付けない
    const here = field.count === undefined ? path : `${path}(${i + 1})`;
    if (field.type === "struct") {
      for (const member of field.fields ?? []) {
        at += planField(member, `${here}.${member.name}`, values, program, arg, at, member.ccsid ?? ccsid, out);
      }
    } else {
      const spec = templateOf(field);
      const byteLength = argByteLength(spec);
      out.push({ path: here, arg, offset: at, byteLength, usage: field.usage, spec, ccsid });
      at += byteLength;
    }
  }
  return at - offset;
}

/** 引数 1 本の向きを、中の葉から決める */
function dirOfLeaves(leaves: readonly PcmlSlot[]): "in" | "out" | "inout" {
  if (leaves.length === 0) return "in";
  if (leaves.every((l) => l.usage === "output")) return "out";
  if (leaves.every((l) => l.usage === "input")) return "in";
  return "inout";
}

/**
 * 記述と入力値から**呼び出し 1 回ぶん**を組む。
 *
 * `values` の鍵は**プログラム名から始まる完全名**（`PCMLTST.REC.NM`）。
 */
export function buildPcmlCall(
  doc: PcmlDocument,
  programName: string,
  values: Readonly<Record<string, string>>,
  opts: ArgCodecOptions
): PcmlCall {
  const program = doc.programs.get(programName);
  if (!program) {
    const known = [...doc.programs.keys()].join(", ");
    throw new As400Error("CONFIG_ERROR", `<program name="${programName}"> がありません（あるのは: ${known}）`);
  }

  const args: ProgramArg[] = [];
  const slots: PcmlSlot[] = [];

  for (const field of program.fields) {
    const argIndex = args.length;
    const mine: PcmlSlot[] = [];
    const length = planField(field, field.path, values, program, argIndex, 0, field.ccsid ?? opts.ccsid, mine);
    const dir = dirOfLeaves(mine);

    if (dir === "out") {
      // 送るものが無い。**長さだけ**渡す
      args.push({ type: "bytes", dir, length });
    } else {
      const buf = new Uint8Array(length);
      for (const slot of mine) {
        if (slot.usage === "output") continue; // ホストが書く場所。触らない
        // **空文字は「値がある」**——`char` にとって空文字は全空白という正当な入力。
        // 未指定（`undefined`）だけを「無い」とみなす
        const given = values[slot.path];
        const use = given ?? fieldInit(program, slot.path);
        if (use === undefined) {
          // **黙って埋めない。** 空白や 0 を勝手に送ると、ホストはそれを正当な入力として扱う
          throw new As400Error("CONFIG_ERROR", `${slot.path} は ${slot.usage} なので値が要ります`);
        }
        const bytes = encodeArgValue({ ...slot.spec, value: use } as ProgramArg, slot.path, {
          ccsid: slot.ccsid
        });
        buf.set(bytes.subarray(0, slot.byteLength), slot.offset);
      }
      args.push({ type: "bytes", dir, length, value: toBase64(buf) });
    }
    slots.push(...mine);
  }

  const target = pcmlTarget(program);
  const call: PcmlCall = { ...target, args, slots };
  if (program.entrypoint !== undefined) call.entrypoint = program.entrypoint;
  return call;
}

/** その葉の `init`。**配列の添字は落として**元の記述を引く */
function fieldInit(program: PcmlProgram, slotPath: string): string | undefined {
  const bare = slotPath.replace(/\(\d+\)/gu, "");
  const parts = bare.split(".");
  if (parts[0] !== program.name) return undefined;
  let fields: readonly PcmlField[] = program.fields;
  let found: PcmlField | undefined;
  for (const part of parts.slice(1)) {
    found = fields.find((f) => f.name === part);
    if (!found) return undefined;
    fields = found.fields ?? [];
  }
  return found?.init;
}

/** 呼んだ結果を**名前つき**で読む */
export function readPcmlOutputs(
  call: PcmlCall,
  outputs: readonly (Uint8Array | undefined)[]
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const slot of call.slots) {
    if (slot.usage === "input") continue;
    const raw = outputs[slot.arg];
    if (raw === undefined) continue;
    if (slot.offset + slot.byteLength > raw.length) continue;
    const value = decodeArgValue(slot.spec, raw.subarray(slot.offset, slot.offset + slot.byteLength), {
      ccsid: slot.ccsid
    });
    if (value !== undefined) out[slot.path] = value;
  }
  return out;
}
