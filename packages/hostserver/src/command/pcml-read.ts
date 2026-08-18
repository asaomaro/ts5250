/**
 * **返ってきたバイトを、先頭から順に解く。**
 *
 * ## なぜ順に解くのか
 *
 * 組み立て（`pcml-layout.ts`）は呼ぶ前にすべて決まるので、静的な割り付けでよい。
 * だが**読み取りは違う**——IBM の書式は「前詰め＋末尾に可変長」で、
 * 可変長の位置・件数・長さ・CCSID を**頭の整数で知らせる**。
 *
 * ```xml
 * <data name="offsetToHomeDirectory" type="int"  length="4"/>   ← ホストが書く値
 * <data                              type="byte" length="0"
 *       offset="offsetToHomeDirectory" offsetfrom="0"/>          ← 長さ 0 の「しおり」
 * <data name="homeDirectory"         type="struct" struct="homeDirectory"/>
 * ```
 *
 * 飛び先は**読むまで分からない**。だから割り付けを当てはめるのではなく、
 * 読みながら決める。
 *
 * ## 算法は原典に合わせた
 *
 * `PcmlDataValues.parseBytes` / `PcmlData.parseBytes` / `PcmlStruct.parseBytes` の
 * 3 か所に同じものがある。
 *
 * - 基点は `offsetfrom`——整数（`0` は引数の先頭）／先祖の名前／省略（＝**親**の開始位置）
 * - **前には戻らない**（飛び先が現在位置より前なら何もしない）
 * - 開始位置は**スタック**で持ち、子を解き終えたら外す（見えるのは先祖だけ）
 * - **名前の無い節は積まない**（完全名が無い）
 */
import { As400Error } from "@ts5250/base";
import { codecForCcsid } from "@ts5250/ebcdic";
import type { PcmlField, PcmlProgram } from "./pcml-parse.js";
import { argByteLength, decodeArgValue, type ProgramArg } from "./program-args.js";

/** 読み取りに要るもの一式 */
export interface PcmlReadInput {
  spec: PcmlProgram;
  /** 呼ぶときに使った入力値（件数などが入力で決まる形のため） */
  values: Readonly<Record<string, string>>;
  /** 接続の CCSID（項目に指定が無いときに使う） */
  ccsid: number;
}

interface ReadState extends PcmlReadInput {
  /** 読めた値。**これ自身が解決の材料になる**（後ろの項目が前の値で決まる） */
  out: Record<string, string>;
  /** 完全名 → その節の開始位置。先祖だけが見える */
  stack: Map<string, number>;
}

/** 完全名から記述の項目を引く（配列の添字は落とす） */
function findField(spec: PcmlProgram, path: string): PcmlField | undefined {
  const parts = path.replace(/\(\d+\)/gu, "").split(".");
  if (parts[0] !== spec.name) return undefined;
  let fields: readonly PcmlField[] = spec.fields;
  let found: PcmlField | undefined;
  for (const part of parts.slice(1)) {
    found = fields.find((f) => f.name === part);
    if (!found) return undefined;
    fields = found.fields ?? [];
  }
  return found;
}

/**
 * 名前で指された数を解く。
 *
 * 引きの順は **読めた出力 → 入力値 → 記述の `init`**。
 * 出力を先に見るのが肝で、可変長は「直前に読んだ整数」で決まる。
 */
function numberAt(state: ReadState, ref: string, what: string, whose: string): number {
  const raw = state.out[ref] ?? state.values[ref] ?? findField(state.spec, ref)?.init;
  if (raw === undefined || raw.trim() === "") {
    throw new As400Error("CONFIG_ERROR", `${whose} の${what}を決める ${ref} が読めませんでした`);
  }
  if (!/^-?\d+$/u.test(raw.trim())) {
    throw new As400Error("CONFIG_ERROR", `${ref} = ${JSON.stringify(raw)} は${what}になりません`);
  }
  return Number.parseInt(raw.trim(), 10);
}

const numeric = (state: ReadState, v: number | string, what: string, whose: string): number =>
  typeof v === "number" ? v : numberAt(state, v, what, whose);

/**
 * **EBCDIC ではない CCSID**の読み方。
 *
 * 実機の QSYRUSRI（`USRI0300`）はホームディレクトリ名を **CCSID 1200（UTF-16）**で返す
 * ——`ccsid="ccsidOfTheReturnedHomeDirectoryName"` の実測値。IFS の道は Unicode で持たれるので、
 * EBCDIC の表だけでは読めない。**測って初めて分かった**ので、ここに限って足す。
 *
 * ここに無い CCSID は EBCDIC 側（`codecForCcsid`）に渡す——扱えなければそちらが断る。
 */
const TEXT_DECODERS = new Map<number, string>([
  [1200, "utf-16be"],
  [13488, "utf-16be"],
  [17584, "utf-16be"],
  [1208, "utf-8"],
  [819, "iso-8859-1"],
  [367, "iso-8859-1"],
  [1252, "windows-1252"]
]);

function decodeText(bytes: Uint8Array, ccsid: number): string | undefined {
  const label = TEXT_DECODERS.get(ccsid);
  if (label === undefined) return undefined;
  return new TextDecoder(label).decode(bytes);
}

/** 葉 1 つのひな形。`length` は解決済み */
function templateOf(field: PcmlField, length: number | undefined, whose: string): ProgramArg {
  const need = (what: string): number => {
    if (length === undefined) {
      throw new As400Error("CONFIG_ERROR", `${whose}: ${what} には length が要ります`);
    }
    return length;
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
        throw new As400Error("CONFIG_ERROR", `${whose}: int の length は 2 / 4 / 8 です（${bytes}）`);
      }
      return { type: "bin", bytes, signed: field.precision !== bytes * 8 };
    }
    case "float": {
      const bytes = need("float");
      if (bytes !== 4 && bytes !== 8) {
        throw new As400Error("CONFIG_ERROR", `${whose}: float の length は 4 / 8 です（${bytes}）`);
      }
      return { type: "float", bytes };
    }
    case "struct":
      throw new As400Error("CONFIG_ERROR", `${whose}: 構造体は葉ではありません`);
  }
}

/** 飛ばすバイト数。原典と同じく**前には戻らない** */
function skipFor(
  field: PcmlField,
  bytes: Uint8Array,
  at: number,
  parentPath: string,
  state: ReadState,
  whose: string
): number {
  if (field.offset === undefined) return 0;
  const offset = numeric(state, field.offset, "飛び先", whose);
  if (offset <= 0) return 0;

  let base: number;
  if (field.offsetfrom === undefined) {
    // 基点の省略は**親の開始位置**（原典 `offsetStack.get(parent.getQualifiedName())`）
    const found = state.stack.get(parentPath);
    if (found === undefined) {
      throw new As400Error("CONFIG_ERROR", `${whose} の飛び先の基点（${parentPath}）が分かりません`);
    }
    base = found;
  } else if (typeof field.offsetfrom === "number") {
    base = field.offsetfrom;
  } else {
    const found = state.stack.get(field.offsetfrom);
    if (found === undefined) {
      // 先祖でないものを指している。原典も同じところで止まる
      throw new As400Error(
        "CONFIG_ERROR",
        `${whose} の offsetfrom="${field.offsetfrom}" は先祖ではありません`
      );
    }
    base = found;
  }

  const target = base + offset;
  if (target < 0 || target > bytes.length) {
    // **黙って空を返さない**——空文字は「値が無い」と読めてしまい、原因にたどり着けない
    throw new As400Error(
      "CONFIG_ERROR",
      `${whose} の飛び先 ${target} が受け取った ${bytes.length} バイトの外です`
    );
  }
  return target > at ? target - at : 0;
}

/** 1 項目を読む。戻りは**飛んだ分を含めて**消費したバイト数 */
function readField(
  field: PcmlField,
  bytes: Uint8Array,
  at: number,
  path: string,
  parentPath: string,
  addressable: boolean,
  state: ReadState
): number {
  const whose = field.path === "" ? `（名前なしの項目）` : field.path;
  const mine = addressable && field.path !== "";
  const count = field.count === undefined ? 1 : numeric(state, field.count, "件数", whose);
  if (count < 0) {
    throw new As400Error("CONFIG_ERROR", `${whose} の件数 ${count} が負です`);
  }
  const skip = skipFor(field, bytes, at, parentPath, state, whose);

  let used = 0;
  for (let i = 0; i < count; i++) {
    const here = !mine || field.count === undefined ? path : `${path}(${i + 1})`;
    const start = at + skip + used;
    if (field.type === "struct") {
      // **名前の無い節は積まない**（原典と同じ）
      if (field.path !== "") state.stack.set(field.path, start);
      let inner = 0;
      for (const member of field.fields ?? []) {
        inner += readField(
          member,
          bytes,
          start + inner,
          mine ? `${here}.${member.name}` : "",
          field.path,
          mine,
          state
        );
      }
      if (field.path !== "") state.stack.delete(field.path);
      used += inner;
    } else {
      const length = field.length === undefined ? undefined : numeric(state, field.length, "長さ", whose);
      const spec = templateOf(field, length, whose);
      const byteLength = argByteLength(spec);
      if (start + byteLength > bytes.length) {
        throw new As400Error(
          "CONFIG_ERROR",
          `${whose} は ${start} から ${byteLength} バイト要りますが、受け取ったのは ${bytes.length} バイトです`
        );
      }
      if (mine && byteLength > 0) {
        const ccsid = field.ccsid === undefined ? state.ccsid : numeric(state, field.ccsid, "CCSID", whose);
        const use = ccsid > 0 ? ccsid : state.ccsid;
        let value: string | undefined;
        try {
          // **文字だけは EBCDIC 以外もありうる**（実機は IFS の道を CCSID 1200 で返す）
          value =
            spec.type === "char"
              ? (decodeText(bytes.subarray(start, start + byteLength), use) ??
                 codecForCcsid(use).decode(bytes.subarray(start, start + byteLength)))
              : decodeArgValue(spec, bytes.subarray(start, start + byteLength), { ccsid: use });
        } catch (e) {
          // **どの項目のどの CCSID か**を言う。値だけ見せられても直しようがない
          throw new As400Error("CONFIG_ERROR", `${whose}（CCSID ${ccsid}）を読めませんでした: ${(e as Error).message}`);
        }
        if (value !== undefined) state.out[here] = value;
      }
      used += byteLength;
    }
  }
  return used + skip;
}

/**
 * 引数 1 本ぶんのバイト列を、記述に従って読む。
 *
 * `outputs` の並びは `program.fields` と 1 対 1（組み立てが 1 項目 = 1 引数で作る）。
 */
export function readProgramOutputs(
  input: PcmlReadInput,
  outputs: readonly (Uint8Array | undefined)[]
): Record<string, string> {
  const state: ReadState = { ...input, out: {}, stack: new Map() };
  input.spec.fields.forEach((field, i) => {
    if (field.usage === "input") return;
    const bytes = outputs[i];
    if (bytes === undefined) return;
    readField(field, bytes, 0, field.path, input.spec.name, true, state);
  });
  return state.out;
}
