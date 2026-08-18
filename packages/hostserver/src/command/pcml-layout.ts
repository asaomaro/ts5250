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

/** 葉 1 つのひな形。`length` は**解決済みの整数**を受け取る（名前指定がありうるため） */
function templateOf(field: PcmlField, resolved: number | undefined): ProgramArg {
  const need = (what: string): number => {
    if (resolved === undefined) {
      throw new As400Error("CONFIG_ERROR", `${field.path}: ${what} には length が要ります`);
    }
    return resolved;
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

/**
 * 名前で指された数（`count` / `length`）を解く。
 *
 * **決まらなければ呼ばない。** 件数を 0 にするとホストが領域外に書き、
 * 長さを 0 にすると以降の位置が全部ずれる。
 *
 * 指す先が**出力**なら、呼ぶ前には決まらない——その旨を言って断る
 * （「入れてください」と言われても入れようがないため）。
 */
function numberFrom(
  field: PcmlField,
  ref: string,
  what: "件数" | "長さ",
  values: Readonly<Record<string, string>>,
  program: PcmlProgram
): number {
  const raw = values[ref] ?? fieldInit(program, ref);
  if (raw === undefined || raw.trim() === "") {
    const target = findField(program, ref);
    if (target?.usage === "output") {
      throw new As400Error(
        "CONFIG_ERROR",
        `${field.path} の${what}は ${ref} で決まりますが、${ref} は出力なので呼ぶ前には決まりません（この経路では扱えません）`
      );
    }
    throw new As400Error(
      "CONFIG_ERROR",
      `${field.path} の${what}は ${ref} で決まります。呼ぶ前に ${ref} を入れてください`
    );
  }
  if (!/^\d+$/u.test(raw.trim())) {
    throw new As400Error("CONFIG_ERROR", `${ref} = ${JSON.stringify(raw)} は${what}になりません`);
  }
  return Number.parseInt(raw.trim(), 10);
}

/** `count` を件数に解く */
function countOf(
  field: PcmlField,
  values: Readonly<Record<string, string>>,
  program: PcmlProgram
): number {
  if (field.count === undefined) return 1;
  if (typeof field.count === "number") return field.count;
  return numberFrom(field, field.count, "件数", values, program);
}

/** `length` をバイト長（`packed`/`zoned` は桁数）に解く */
function lengthOf(
  field: PcmlField,
  values: Readonly<Record<string, string>>,
  program: PcmlProgram
): number | undefined {
  if (field.length === undefined) return undefined;
  if (typeof field.length === "number") return field.length;
  return numberFrom(field, field.length, "長さ", values, program);
}

/**
 * 木を葉に開く。戻りは消費したバイト数。
 *
 * **名前の無い項目（予約域）はバイトだけ進めて `slots` に入れない**——
 * 原典も完全名を付けず、名前で触れない。入れ子ごと触れなくなる。
 */
function planField(
  field: PcmlField,
  path: string,
  addressable: boolean,
  values: Readonly<Record<string, string>>,
  program: PcmlProgram,
  arg: number,
  offset: number,
  ccsid: number,
  out: PcmlSlot[]
): number {
  const n = countOf(field, values, program);
  const mine = addressable && field.path !== "";
  let at = offset;
  for (let i = 0; i < n; i++) {
    // **配列は 1 始まり**（PCML の慣習）。件数 1 の非配列は添字を付けない
    const here = field.count === undefined ? path : `${path}(${i + 1})`;
    if (field.type === "struct") {
      for (const member of field.fields ?? []) {
        at += planField(
          member,
          mine ? `${here}.${member.name}` : "",
          mine,
          values,
          program,
          arg,
          at,
          member.ccsid ?? ccsid,
          out
        );
      }
    } else {
      const spec = templateOf(field, lengthOf(field, values, program));
      const byteLength = argByteLength(spec);
      if (mine) out.push({ path: here, arg, offset: at, byteLength, usage: field.usage, spec, ccsid });
      at += byteLength;
    }
  }
  return at - offset;
}

/**
 * **受け取る長さ**を決める。
 *
 * IBM の取得系 API は「受取域の長さ」を入力で渡し、記述は `outputsize` でそれを指す。
 * **算出値より小さければ断る**——ホストが書ける場所が足りず、返るバイトが途中で切れる。
 * 切れたことに気づけない形の失敗になる。
 */
function outLengthOf(
  field: PcmlField,
  computed: number,
  values: Readonly<Record<string, string>>,
  program: PcmlProgram
): number {
  if (field.outputsize === undefined) return computed;
  const want =
    typeof field.outputsize === "number"
      ? field.outputsize
      : numberFrom(field, field.outputsize, "長さ", values, program);
  if (want < computed) {
    throw new As400Error(
      "CONFIG_ERROR",
      `${field.path} の受け取る長さ ${want} は、記述が要る ${computed} より小さいです（ホストが書ける場所が足りません）`
    );
  }
  return want;
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
    const length = planField(
      field,
      field.path,
      true,
      values,
      program,
      argIndex,
      0,
      field.ccsid ?? opts.ccsid,
      mine
    );
    const outLength = outLengthOf(field, length, values, program);
    const dir = dirOfLeaves(mine.length > 0 ? mine : [{ usage: field.usage } as PcmlSlot]);

    if (dir === "out") {
      // 送るものが無い。**受け取る長さだけ**渡す
      args.push({ type: "bytes", dir, length, outLength });
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
      args.push({ type: "bytes", dir, length, outLength, value: toBase64(buf) });
    }
    slots.push(...mine);
  }

  const target = pcmlTarget(program);
  const call: PcmlCall = { ...target, args, slots };
  if (program.entrypoint !== undefined) call.entrypoint = program.entrypoint;
  return call;
}

/** 完全名から記述の項目を引く。**配列の添字は落とす**（記述には添字が無い） */
function findField(program: PcmlProgram, path: string): PcmlField | undefined {
  const parts = path.replace(/\(\d+\)/gu, "").split(".");
  if (parts[0] !== program.name) return undefined;
  let fields: readonly PcmlField[] = program.fields;
  let found: PcmlField | undefined;
  for (const part of parts.slice(1)) {
    found = fields.find((f) => f.name === part);
    if (!found) return undefined;
    fields = found.fields ?? [];
  }
  return found;
}

/** その葉の `init` */
function fieldInit(program: PcmlProgram, slotPath: string): string | undefined {
  return findField(program, slotPath)?.init;
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
