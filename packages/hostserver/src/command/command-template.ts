import { As400Error } from "@ts5250/base";
import type { CommandConnection } from "./command-connection.js";

/**
 * **CL コマンドの定義（テンプレート）を取ってくる。**
 *
 * 原典: JTOpen `com.ibm.as400.access.Command#getXML()`（`refreshXML()`）。
 * あちらは `/QSYS.LIB/QCDRCMDD.PGM` を **2 回**呼び、コマンド定義の XML を UTF-8 で受け取る。
 * ここはその手順を**事実として**書き起こしたもので、コードは移していない（AGENTS.md）。
 *
 * ## なぜ要るか
 *
 * `CommandConnection.run()` は**文字列を投げるだけ**なので、キーワードの綴り・引用符・
 * 必須の抜け・許される値を**呼ぶ側が全部知っている**必要がある。間違いは実行するまで分からない。
 * テンプレートがあれば**打つ前に**言い切れる。
 */

/** `QCDRCMDD` の受信変数は先頭 8 バイトが長さ 2 つ。XML はその後ろ */
const HEADER_LEN = 8;
/** 1 回目の呼び出しで渡す長さ。**必要な長さを聞くためだけ**なので最小でよい */
const PROBE_LEN = HEADER_LEN;

export interface CommandParam {
  /** キーワード（`LIB` など）。コマンド文字列で `LIB(...)` と書くときの名前 */
  keyword: string;
  /** `NAME` / `CHAR` / `DEC` / `QUAL` / `ELEM` / `*` 系 */
  type: string;
  /** 位置指定の番号（`PosNbr`）。位置で書けるパラメータにだけ付く */
  position?: number;
  /** `Min >= 1`＝必須 */
  required: boolean;
  /** `Max`。2 以上なら `KWD(A B C)` のように繰り返せる */
  maxValues: number;
  /** `Len`。桁数の上限 */
  length?: number;
  /** `Rstd="YES"`＝**`specialValues` の値しか許されない** */
  restricted: boolean;
  /** `Dft`。**こちらでは付けない**——省略すればホストが使う */
  default?: string;
  prompt?: string;
  /** `SpcVal` の `Val`（`*PROD` など） */
  specialValues: string[];
  /** `Type="QUAL"` のときの各段（オブジェクト名・ライブラリー…） */
  qualifiers?: CommandParam[];
}

export interface CommandTemplate {
  name: string;
  library: string;
  prompt?: string;
  /** `MaxPos`。位置指定で書ける個数 */
  maxPositional: number;
  parameters: CommandParam[];
  /**
   * **生の XML。**
   *
   * こちらが解いていない属性（`ELEM` の入れ子・`PmtCtl`・`Choice` の但し書き等）を
   * 利用者が自分で読めるように残す。**取りこぼしを「無かったこと」にしない。**
   */
  xml: string;
}

export interface RetrieveOptions {
  /** コマンドのライブラリー。既定は `*LIBL`（見つからなければホストが `CPF` で言う） */
  library?: string;
}

/** EBCDIC 037 の英数字だけを詰める（API 名・書式名はすべて英大文字） */
function ebcdicName(s: string, len: number): Uint8Array {
  const out = new Uint8Array(len).fill(0x40); // 空白詰め
  const up = s.toUpperCase();
  for (let i = 0; i < up.length && i < len; i++) {
    const c = up.charCodeAt(i);
    if (c >= 0x41 && c <= 0x49) out[i] = 0xc1 + (c - 0x41); // A-I
    else if (c >= 0x4a && c <= 0x52) out[i] = 0xd1 + (c - 0x4a); // J-R
    else if (c >= 0x53 && c <= 0x5a) out[i] = 0xe2 + (c - 0x53); // S-Z
    else if (c >= 0x30 && c <= 0x39) out[i] = 0xf0 + (c - 0x30); // 0-9
    else if (up[i] === "*") out[i] = 0x5c;
    else if (up[i] === "_") out[i] = 0x6d;
    else if (up[i] === ".") out[i] = 0x4b;
    else if (up[i] === "$") out[i] = 0x5b;
    else if (up[i] === "#") out[i] = 0x7b;
    else if (up[i] === "@") out[i] = 0x7c;
    else {
      throw new As400Error("CONFIG_ERROR", `command name has an unsupported character: ${up[i]}`);
    }
  }
  return out;
}

function int32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, n);
  return b;
}

/**
 * コマンド定義を引く。
 *
 * **2 回呼ぶ**——1 回目は「必要な長さ」を聞くためだけ。コマンドによって XML の量が
 * 桁違いに違う（`CRTLIB` は 3.5KB、`CPYF` は 12KB）ので、当て推量の初期値を送らない。
 * これは JTOpen も同じ作りで、理由も同じ。
 */
export async function retrieveCommandTemplate(
  conn: CommandConnection,
  command: string,
  opts: RetrieveOptions = {}
): Promise<CommandTemplate> {
  const library = opts.library ?? "*LIBL";
  const qualified = new Uint8Array(20);
  qualified.set(ebcdicName(command, 10), 0);
  qualified.set(ebcdicName(library, 10), 10);

  const callOnce = async (receiveLength: number): Promise<Uint8Array> => {
    const { outputs } = await conn.call("QCDRCMDD", "QSYS", [
      { type: "in", data: qualified },
      { type: "in", data: int32(receiveLength) },
      { type: "in", data: ebcdicName("DEST0100", 8) },
      { type: "out", length: receiveLength },
      { type: "in", data: ebcdicName("CMDD0100", 8) },
      // エラーコードは長さ 0＝「例外で返せ」。メッセージは呼び出しの戻りに載る
      { type: "inout", data: int32(0), length: 4 }
    ]);
    const received = outputs.find((o) => o !== undefined && o.length >= HEADER_LEN);
    if (received === undefined) {
      throw new As400Error("HOST_SERVER_UNSUPPORTED", `QCDRCMDD returned no data for ${command}`);
    }
    return received;
  };

  const probe = await callOnce(PROBE_LEN);
  const pv = new DataView(probe.buffer, probe.byteOffset, probe.byteLength);
  const available = pv.getInt32(4);
  if (available <= 0) {
    throw new As400Error("NOT_FOUND", `command ${library}/${command} was not found`);
  }

  const full = await callOnce(available + HEADER_LEN);
  const fv = new DataView(full.buffer, full.byteOffset, full.byteLength);
  const returned = fv.getInt32(0);
  // **XML は UTF-8**（CCSID 1208）。ホストの CCSID とは無関係に固定
  const xml = new TextDecoder("utf-8").decode(full.subarray(HEADER_LEN, HEADER_LEN + returned));
  return parseCommandTemplate(xml);
}

/**
 * コマンド定義の XML を解く。**依存を増やさないために自前で読む。**
 *
 * 相手は `QCDRCMDD` が吐く固定の形（属性は必ず `名前="値"`、要素は `Cmd` / `Parm` /
 * `SpcVal` / `Value` / `Qual` / `Elem`）なので、汎用の XML 解析は要らない。
 */
export function parseCommandTemplate(xml: string): CommandTemplate {
  const cmd = firstTag(xml, "Cmd");
  if (cmd === undefined) {
    throw new As400Error("PROTOCOL_ERROR", "command definition XML has no <Cmd> element");
  }
  const a = cmd.attrs;
  return {
    name: a["CmdName"] ?? "",
    library: a["CmdLib"] ?? "",
    ...(a["Prompt"] !== undefined ? { prompt: a["Prompt"] } : {}),
    maxPositional: Number(a["MaxPos"] ?? 0),
    parameters: parseParams(cmd.body),
    xml
  };
}

interface Tag {
  attrs: Record<string, string>;
  body: string;
}

/** `<name …>…</name>` か `<name …/>` を 1 つ取り出す（入れ子は body ごと返す） */
function firstTag(src: string, name: string, from = 0): (Tag & { end: number }) | undefined {
  const open = new RegExp(`<${name}(\\s[^>]*?)?(/?)>`, "g");
  open.lastIndex = from;
  const m = open.exec(src);
  if (m === null) return undefined;
  const attrs = parseAttrs(m[1] ?? "");
  if (m[2] === "/") return { attrs, body: "", end: open.lastIndex };
  // **入れ子を数える**——`Parm` の中に `Parm` は来ないが、`Elem` の中に `Elem` は来る
  let depth = 1;
  let i = open.lastIndex;
  const scan = new RegExp(`<(/?)${name}(\\s[^>]*?)?(/?)>`, "g");
  scan.lastIndex = i;
  let s: RegExpExecArray | null;
  while ((s = scan.exec(src)) !== null) {
    if (s[1] === "/") depth--;
    else if (s[3] !== "/") depth++;
    if (depth === 0) return { attrs, body: src.slice(i, s.index), end: scan.lastIndex };
    i = scan.lastIndex;
  }
  return { attrs, body: src.slice(open.lastIndex), end: src.length };
}

function parseAttrs(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) out[m[1]!] = unescapeXml(m[2]!);
  return out;
}

/** 実体参照を戻す。`Prompt` に `&amp;` が入る（`&` を含む説明文がある） */
function unescapeXml(s: string): string {
  return s.includes("&")
    ? s
        .replaceAll("&lt;", "<")
        .replaceAll("&gt;", ">")
        .replaceAll("&quot;", '"')
        .replaceAll("&apos;", "'")
        .replaceAll("&amp;", "&")
    : s;
}

function parseParams(body: string): CommandParam[] {
  const out: CommandParam[] = [];
  let pos = 0;
  for (;;) {
    const t = firstTag(body, "Parm", pos);
    if (t === undefined) break;
    out.push(toParam(t.attrs, t.body));
    pos = t.end;
  }
  return out;
}

function toParam(attrs: Record<string, string>, body: string): CommandParam {
  const quals: CommandParam[] = [];
  let pos = 0;
  for (;;) {
    const q = firstTag(body, "Qual", pos);
    if (q === undefined) break;
    quals.push(toParam(q.attrs, q.body));
    pos = q.end;
  }
  const p: CommandParam = {
    keyword: attrs["Kwd"] ?? "",
    type: attrs["Type"] ?? "CHAR",
    required: Number(attrs["Min"] ?? 0) >= 1,
    maxValues: Number(attrs["Max"] ?? 1),
    restricted: attrs["Rstd"] === "YES",
    specialValues: specialValuesOf(body)
  };
  if (attrs["PosNbr"] !== undefined) p.position = Number(attrs["PosNbr"]);
  if (attrs["Len"] !== undefined) p.length = Number(attrs["Len"]);
  if (attrs["Dft"] !== undefined) p.default = attrs["Dft"];
  if (attrs["Prompt"] !== undefined) p.prompt = attrs["Prompt"];
  if (quals.length > 0) p.qualifiers = quals;
  return p;
}

/** `<SpcVal><Value Val="*PROD" …/></SpcVal>` の `Val` を集める（`Qual` の中の分は含めない） */
function specialValuesOf(body: string): string[] {
  const spc = firstTag(body, "SpcVal");
  if (spc === undefined) return [];
  const out: string[] = [];
  const re = /<Value\s[^>]*?Val="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(spc.body)) !== null) out.push(unescapeXml(m[1]!));
  return out;
}
