/**
 * **PCML（Program Call Markup Language）の解析。**
 *
 * ## なぜ要るのか
 *
 * `program-args.ts` は**位置指定**——`args[0]`, `args[1]`…。構造体は `bytes` に
 * base64 で手詰めするしかなく、**桁ずれが型で止まらない**。
 * PCML はその上に載る「記述」で、構造体と配列を名前で扱えるようにする。
 *
 * ## 出どころは IFS（ホスト API ではない）
 *
 * jt400 の `ProgramCallDocument` は構築子を 8 つ持つが、**どれもホストへ問い合わせない**
 * （原典を全て読んだ）。CL の `QCDRCMDD` に当たるものは RPG には無い。
 * PCML はコンパイラが吐く——`CRTBNDRPG ... PGMINFO(*PCML) INFOSTMF('/…')`。
 * 実機で吐かせ、**タグが 819** であることも確かめてある。
 *
 * ## 意味は原典に合わせる
 *
 * 推測を混ぜない。以下は全て JTOpen のソースで確かめた値である。
 *
 * - バイト長: `packed` は `⌊length/2⌋+1`、`zoned` は `length`、他は `length`
 * - `int` の符号: `precision` が 16/32/64 なら符号なし、15/31/63 なら符号つき
 * - `usage`: 属性が無い or `inherit` なら親から継ぐ。根なら `inputoutput`
 * - `struct=` は**根の平坦表を完全名で直に引く**（相対解決ではない）
 * - `count=` は整数、または**相対名**（親から根へ遡って `<段>.<名>` を引く）
 *
 * ## 解析器を手書きにした理由
 *
 * PCML は属性つきの単純な木で、名前空間も CDATA も要らない。
 * 依存を増やさない方針（`AGENTS.md`）に従い、XML ライブラリは足さない。
 * **壊れた記述は行番号つきで拒否する**——どこが悪いか言えないと直せない。
 */
import { As400Error } from "@ts5250/base";

/** 引数の向き。`inherit` は解析の時点で解いてしまう */
export type PcmlUsage = "input" | "output" | "inputoutput";

/** 扱える型。`date` / `time` / `timestamp` / `varchar` は**まだ扱えない**（明示的に拒否する） */
export type PcmlType = "char" | "int" | "packed" | "zoned" | "float" | "byte" | "struct";

/** 記述 1 項目。`struct` 参照と `usage` の継承は**解決済み** */
export interface PcmlField {
  /** 名前なしの予約域は `""`。バイトは占めるが、名前では触れない */
  name: string;
  type: PcmlType;
  usage: PcmlUsage;
  /**
   * `char`/`byte`/`int`/`float` はバイト数、`packed`/`zoned` は桁数。
   *
   * **整数とは限らない**——長さを持つ別の項目の完全名でもよい（原典の `m_LengthId`）。
   * 指す先が出力なら、呼ぶ前には決まらない。
   */
  length?: number | string;
  /** `packed`/`zoned` は小数位、`int` は符号の別 */
  precision?: number;
  /** 整数、または**完全名**（`ccsid="ccsidOfTheReturnedHomeDirectoryName"`） */
  ccsid?: number | string;
  init?: string;
  passby?: "reference" | "value";
  /** 整数、または**完全名**（相対名は解決済み） */
  count?: number | string;
  /**
   * **受け取る長さ**。整数、または長さを持つ入力項目の完全名。
   *
   * IBM の取得系 API は「受取域」と「受取域の長さ」を組で渡す。
   * 送る量より受け取る量の方が大きいので、算出値とは別に持つ。
   */
  outputsize?: number | string;
  /**
   * **飛び先**。整数、または完全名。基点は `offsetfrom`。
   *
   * IBM の書式は「前詰め＋末尾に可変長」で、可変長の位置を頭の整数で知らせる。
   * 長さ 0 の名前なし項目が「しおり」として置かれることが多い。
   */
  offset?: number | string;
  /** 飛び先の基点。整数（`0` は引数の先頭）、完全名、または省略（＝親の開始位置） */
  offsetfrom?: number | string;
  /** `type === "struct"` のときのメンバー */
  fields?: PcmlField[];
  /** 完全名（`PCMLTST.REC.NM`）。名前で引くときの鍵。**予約域は `""`** */
  path: string;
}

export interface PcmlProgram {
  name: string;
  /** `/QSYS.LIB/TESTLIB.LIB/PCMLTST.PGM` の形 */
  path?: string;
  /** サービスプログラムの手続き名 */
  entrypoint?: string;
  threadsafe?: boolean;
  fields: PcmlField[];
}

export interface PcmlDocument {
  version?: string;
  /** 根に置かれた `<struct>`（参照用の定義） */
  structs: Map<string, PcmlField[]>;
  programs: Map<string, PcmlProgram>;
}

/* ------------------------------------------------------------------ */
/* 字句解析                                                             */
/* ------------------------------------------------------------------ */

interface RawNode {
  tag: string;
  attrs: Map<string, string>;
  children: RawNode[];
  line: number;
}

const bad = (line: number, msg: string): never => {
  throw new As400Error("CONFIG_ERROR", `PCML ${line} 行目: ${msg}`);
};

const ENTITIES = new Map([
  ["lt", "<"],
  ["gt", ">"],
  ["amp", "&"],
  ["quot", '"'],
  ["apos", "'"]
]);

/** XML の実体参照をほどく。**知らない実体はそのまま残す**（壊すより残す） */
function unescapeXml(text: string): string {
  return text.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/gu, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const n = Number.parseInt(body.slice(2), 16);
      return Number.isNaN(n) ? whole : String.fromCodePoint(n);
    }
    if (body.startsWith("#")) {
      const n = Number.parseInt(body.slice(1), 10);
      return Number.isNaN(n) ? whole : String.fromCodePoint(n);
    }
    return ENTITIES.get(body) ?? whole;
  });
}

/**
 * タグだけを拾って木にする。**要素の外側の文字は捨てる**——
 * PCML に文字内容を持つ要素は無い（DTD の `<!ELEMENT data EMPTY>`）。
 */
function tokenize(text: string): RawNode[] {
  const roots: RawNode[] = [];
  const stack: RawNode[] = [];
  let at = 0;
  let line = 1;

  /** `at` を `to` まで進めながら行を数える */
  const advance = (to: number): void => {
    for (let i = at; i < to; i++) if (text[i] === "\n") line++;
    at = to;
  };

  while (at < text.length) {
    const lt = text.indexOf("<", at);
    if (lt < 0) break;
    advance(lt);

    // 宣言・コメント・DTD は読み飛ばす（中身に用は無い）
    if (text.startsWith("<?", at)) {
      const end = text.indexOf("?>", at);
      if (end < 0) return bad(line, "XML 宣言が閉じていません") as never;
      advance(end + 2);
      continue;
    }
    if (text.startsWith("<!--", at)) {
      const end = text.indexOf("-->", at);
      if (end < 0) return bad(line, "コメントが閉じていません") as never;
      advance(end + 3);
      continue;
    }
    if (text.startsWith("<!", at)) {
      // `<!DOCTYPE pcml [ … ]>` のように内部部分集合を持つことがある
      const gt = text.indexOf(">", at);
      const br = text.indexOf("[", at);
      if (br >= 0 && gt >= 0 && br < gt) {
        const end = text.indexOf("]>", br);
        if (end < 0) return bad(line, "DOCTYPE が閉じていません") as never;
        advance(end + 2);
      } else {
        if (gt < 0) return bad(line, "宣言が閉じていません") as never;
        advance(gt + 1);
      }
      continue;
    }

    // 終了タグ
    if (text.startsWith("</", at)) {
      const gt = text.indexOf(">", at);
      if (gt < 0) return bad(line, "終了タグが閉じていません") as never;
      const name = text.slice(at + 2, gt).trim();
      const top = stack.pop();
      if (!top) return bad(line, `対応する開始タグがありません: </${name}>`) as never;
      if (top.tag !== name) return bad(line, `<${top.tag}> に対して </${name}> が来ました`) as never;
      advance(gt + 1);
      continue;
    }

    // 開始タグ
    const startLine = line;
    let i = at + 1;
    while (i < text.length && /[A-Za-z0-9_:.-]/u.test(text[i] ?? "")) i++;
    const tag = text.slice(at + 1, i);
    if (tag === "") return bad(line, "タグ名がありません") as never;

    const attrs = new Map<string, string>();
    let selfClose = false;
    for (;;) {
      while (i < text.length && /\s/u.test(text[i] ?? "")) i++;
      if (i >= text.length) return bad(startLine, `<${tag}> が閉じていません`) as never;
      if (text.startsWith("/>", i)) {
        selfClose = true;
        i += 2;
        break;
      }
      if (text[i] === ">") {
        i += 1;
        break;
      }
      const nameFrom = i;
      while (i < text.length && /[A-Za-z0-9_:.-]/u.test(text[i] ?? "")) i++;
      const name = text.slice(nameFrom, i);
      if (name === "") return bad(startLine, `<${tag}> の属性が読めません`) as never;
      while (i < text.length && /\s/u.test(text[i] ?? "")) i++;
      if (text[i] !== "=") return bad(startLine, `属性 ${name} に値がありません`) as never;
      i++;
      while (i < text.length && /\s/u.test(text[i] ?? "")) i++;
      const quote = text[i];
      if (quote !== '"' && quote !== "'") {
        return bad(startLine, `属性 ${name} の値が引用符で囲まれていません`) as never;
      }
      const valueFrom = i + 1;
      const valueTo = text.indexOf(quote, valueFrom);
      if (valueTo < 0) return bad(startLine, `属性 ${name} の値が閉じていません`) as never;
      attrs.set(name, unescapeXml(text.slice(valueFrom, valueTo)));
      i = valueTo + 1;
    }

    const node: RawNode = { tag, attrs, children: [], line: startLine };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
    if (!selfClose) stack.push(node);
    advance(i);
  }

  const unclosed = stack[stack.length - 1];
  if (unclosed) return bad(unclosed.line, `<${unclosed.tag}> が閉じていません`) as never;
  return roots;
}

/* ------------------------------------------------------------------ */
/* 意味づけ                                                             */
/* ------------------------------------------------------------------ */

const TYPES = new Set(["char", "int", "packed", "zoned", "float", "byte", "struct"]);
/** 型としては正しいが**まだ扱えない**もの。黙って落とさず、名指しで断る */
const NOT_YET = new Set(["date", "time", "timestamp", "varchar"]);



/**
 * `VvRrMm` を数にする。**`(V << 16) + (R << 8) + M`**——原典の `AS400.generateVRM` と同じ。
 * signon サーバーが返す `rawVersion` と同じ符号化なので、そのまま比べられる。
 */
function parseVrm(node: RawNode, name: string): number | undefined {
  const raw = node.attrs.get(name);
  if (raw === undefined || raw === "") return undefined;
  const m = /^V(\d+)R(\d+)M(\d+)$/iu.exec(raw.trim());
  if (!m) return bad(node.line, `${name}="${raw}" は VvRrMm の形ではありません`) as never;
  return (Number(m[1]) << 16) + (Number(m[2]) << 8) + Number(m[3]);
}

function intAttr(node: RawNode, name: string): number | undefined {
  const raw = node.attrs.get(name);
  if (raw === undefined || raw === "") return undefined;
  if (!/^\d+$/u.test(raw)) bad(node.line, `${name}="${raw}" は整数ではありません`);
  return Number.parseInt(raw, 10);
}

function usageAttr(node: RawNode, inherited: PcmlUsage): PcmlUsage {
  const raw = node.attrs.get("usage");
  // **属性が無い / inherit なら親から継ぐ**（`PcmlDocNode.getUsage`）
  if (raw === undefined || raw === "" || raw === "inherit") return inherited;
  if (raw === "input" || raw === "output" || raw === "inputoutput") return raw;
  return bad(node.line, `usage="${raw}" は使えません`) as never;
}

/** 名前つきの節を集めた平坦表を作りながら、木を組む */
interface BuildContext {
  /** 完全名 → 項目。`count` / `outputsize` の相対解決に使う */
  flat: Map<string, PcmlField>;
  /** 根の `<struct>` 定義（`struct=` は**完全名で直に引く**） */
  defs: Map<string, RawNode>;
  /** ホストの版。無ければ `minvrm` / `maxvrm` を持つ記述は断る */
  vrm: number | undefined;
}

/**
 * その項目がホストの版で使えるか。
 *
 * 原典（`PcmlData.isSupportedAtHostVRM`）は使えない要素を**引数の列から丸ごと落とす**——
 * 並びがずれるのではなく**本数が変わる**。だから版が分からないまま通してはならない。
 */
function supportedAtVrm(node: RawNode, ctx: BuildContext): boolean {
  const min = parseVrm(node, "minvrm");
  const max = parseVrm(node, "maxvrm");
  if (min === undefined && max === undefined) return true;
  if (ctx.vrm === undefined) {
    bad(node.line, "minvrm / maxvrm がありますが、ホストの版が分かりません（接続を指定してください）");
  }
  if (min !== undefined && min > ctx.vrm!) return false;
  if (max !== undefined && max < ctx.vrm!) return false;
  return true;
}

/** 子を項目にする。**版に合わないものは落ちる**（本数が変わる） */
function toFields(
  nodes: readonly RawNode[],
  parentPath: string,
  addressable: boolean,
  inherited: PcmlUsage,
  ctx: BuildContext,
  seen: readonly string[]
): PcmlField[] {
  const out: PcmlField[] = [];
  for (const node of nodes) {
    if (!supportedAtVrm(node, ctx)) continue;
    out.push(toField(node, parentPath, addressable, inherited, ctx, seen));
  }
  return out;
}

/** `<data>` / `<struct>` を 1 項目に変換する（`struct=` の展開を含む） */
function toField(
  node: RawNode,
  parentPath: string,
  addressable: boolean,
  inherited: PcmlUsage,
  ctx: BuildContext,
  seen: readonly string[]
): PcmlField {
  const name = node.attrs.get("name") ?? "";
  if (name.includes(".") || name.includes(" ")) {
    bad(node.line, `name="${name}" に "." や空白は使えません`);
  }
  // **名前が無ければ予約域**——バイトは占めるが、名前では触れない
  // （原典の `getQualifiedName` は名前が空なら完全名を付けない）。
  // 親が触れないなら、子も触れない
  const mine = addressable && name !== "";
  const path = mine ? (parentPath === "" ? name : `${parentPath}.${name}`) : "";
  const usage = usageAttr(node, inherited);

  const countRaw = node.attrs.get("count");
  let count: number | string | undefined;
  if (countRaw !== undefined && countRaw !== "") {
    count = /^\d+$/u.test(countRaw) ? Number.parseInt(countRaw, 10) : countRaw;
  }
  const outRaw = node.attrs.get("outputsize");
  let outputsize: number | string | undefined;
  if (outRaw !== undefined && outRaw !== "") {
    outputsize = /^\d+$/u.test(outRaw) ? Number.parseInt(outRaw, 10) : outRaw;
  }

  // **飛び先**。整数、または他の項目の値。基点は `offsetfrom`（省略時は親の開始位置）
  const offsetRaw = node.attrs.get("offset");
  const offsetFromRaw = node.attrs.get("offsetfrom");

  const field: PcmlField = { name, path, type: "struct", usage };
  if (count !== undefined) field.count = count;
  if (outputsize !== undefined) field.outputsize = outputsize;
  if (offsetRaw !== undefined && offsetRaw !== "") {
    field.offset = /^\d+$/u.test(offsetRaw) ? Number.parseInt(offsetRaw, 10) : offsetRaw;
  }
  if (offsetFromRaw !== undefined && offsetFromRaw !== "") {
    field.offsetfrom = /^\d+$/u.test(offsetFromRaw)
      ? Number.parseInt(offsetFromRaw, 10)
      : offsetFromRaw;
  }

  if (node.tag === "struct") {
    // **その場に書かれた構造体**。子がそのままメンバーになる
    field.fields = toFields(node.children, path, mine, usage, ctx, seen);
    if (mine) ctx.flat.set(path, field);
    return field;
  }

  const type = node.attrs.get("type") ?? "";
  if (NOT_YET.has(type)) bad(node.line, `type="${type}" はまだ扱えません`);
  if (!TYPES.has(type)) bad(node.line, `type="${type}" は使えません`);
  field.type = type as PcmlType;

  // **`length` も名前でありうる**（`length="bytesReturned"`。原典の `m_LengthId`）
  const lengthRaw = node.attrs.get("length");
  if (lengthRaw !== undefined && lengthRaw !== "") {
    field.length = /^\d+$/u.test(lengthRaw) ? Number.parseInt(lengthRaw, 10) : lengthRaw;
  }
  const precision = intAttr(node, "precision");
  if (precision !== undefined) field.precision = precision;
  // **`ccsid` も名前でありうる**（`ccsid="ccsidOfTheReturnedHomeDirectoryName"`）
  const ccsidRaw = node.attrs.get("ccsid");
  if (ccsidRaw !== undefined && ccsidRaw !== "") {
    field.ccsid = /^\d+$/u.test(ccsidRaw) ? Number.parseInt(ccsidRaw, 10) : ccsidRaw;
  }
  const init = node.attrs.get("init");
  if (init !== undefined) field.init = init;
  const passby = node.attrs.get("passby");
  if (passby === "reference" || passby === "value") field.passby = passby;
  else if (passby !== undefined && passby !== "") bad(node.line, `passby="${passby}" は使えません`);

  if (field.type === "struct") {
    const ref = node.attrs.get("struct") ?? "";
    if (ref === "") bad(node.line, `type="struct" には struct= が要ります`);
    if (seen.includes(ref)) {
      bad(node.line, `構造体 ${ref} が自分自身を含んでいます（${[...seen, ref].join(" → ")}）`);
    }
    const def = ctx.defs.get(ref);
    if (!def) bad(node.line, `struct="${ref}" に当たる <struct> がありません`);
    // **定義を複製して差し込む**（`PcmlSAXParser.augmentTree` と同じ）。
    // 継承元は「参照した側の usage」——定義側の親ではない
    field.fields = toFields(def!.children, path, mine, usage, ctx, [...seen, ref]);
  }

  if (mine) ctx.flat.set(path, field);
  return field;
}

const NUMERIC = new Set(["int", "packed", "zoned"]);

/**
 * 相対名を**完全名**に解く。
 *
 * 規則（`PcmlDocNode.resolveRelativeNode`）: **自分の親から根に向かって遡り**、
 * 各段で `<その段の完全名>.<相対名>` を平坦表に引く。**最初に当たったもの**を採る。
 */
type RefAttr = "count" | "outputsize" | "length" | "ccsid" | "offset" | "offsetfrom";

/**
 * 相対名を**完全名**に解く。
 *
 * 規則（`PcmlDocNode.resolveRelativeNode`）: **親から根に向かって遡り**、
 * 各段で `<その段の完全名>.<相対名>` を平坦表に引く。**最初に当たったもの**を採る。
 *
 * **起点は親**であって自分ではない。名前の無い項目（しおり）は完全名を持たないので、
 * 自分の名前から遡ろうとすると起点が消える——`RUser.pcml` のしおりで実際に踏み、
 * 無関係な `<struct>` 定義の項目を拾っていた。
 */
function resolveRef(field: PcmlField, attr: RefAttr, parentPath: string, ctx: BuildContext): string {
  const relative = field[attr] as string;
  const parts = parentPath === "" ? [] : parentPath.split(".");
  for (let depth = parts.length; depth >= 0; depth--) {
    const prefix = parts.slice(0, depth).join(".");
    const candidate = prefix === "" ? relative : `${prefix}.${relative}`;
    if (ctx.flat.has(candidate)) return candidate;
  }
  // **末尾一致で拾わない。** 似た名前の別の定義を黙って掴むより、読めないと言う方が安全
  throw new As400Error(
    "CONFIG_ERROR",
    `${field.path === "" ? `${parentPath} の中の名前なしの項目` : field.path} の ${attr}="${relative}" に当たる項目がありません`
  );
}

function resolveRefs(fields: readonly PcmlField[], parentPath: string, ctx: BuildContext): void {
  for (const f of fields) {
    for (const attr of ["count", "outputsize", "length", "ccsid", "offset", "offsetfrom"] as const) {
      if (typeof f[attr] !== "string") continue;
      const resolved = resolveRef(f, attr, parentPath, ctx);
      const target = ctx.flat.get(resolved);
      // **`offsetfrom` だけは数を指さない**——先祖の**開始位置**を指す（構造体でよい）。
      // 実測（IBM 同梱 16 本）では 17 件すべて `offsetfrom="0"` だが、
      // 原典は名前も許すので同じにしておく
      if (attr !== "offsetfrom" && target && !NUMERIC.has(target.type)) {
        throw new As400Error(
          "CONFIG_ERROR",
          `${f.path} の ${attr} が指す ${resolved} は ${target.type} で、${attr === "count" ? "件数" : "長さ"}になりません`
        );
      }
      (f as Record<RefAttr, number | string>)[attr] = resolved;
    }
    if (f.fields) resolveRefs(f.fields, f.path === "" ? parentPath : f.path, ctx);
  }
}

export interface PcmlParseOptions {
  /**
   * ホストの版（`(V << 16) + (R << 8) + M`）。`CommandConnection.hostVrm` をそのまま渡す。
   * **`minvrm` / `maxvrm` を持つ記述にはこれが要る**——引数の本数が変わるため。
   */
  vrm?: number;
}

/**
 * **ホストの版が要る記述か**を、解析する前に安く見分ける。
 *
 * `minvrm` / `maxvrm` は引数の本数を変えるので、版が要る。版を得るには接続が要り、
 * 接続は安くない——だから「要るときだけ開く」ための前もっての当たりを付ける。
 *
 * 文字面で見るので**空振り（注釈の中の語）はありうる**。空振りの代償は
 * 「要らない接続を 1 つ開く」だけで、**取りこぼしはしない**（属性は必ずこの綴りで書かれる）。
 */
export function pcmlNeedsHostVersion(text: string): boolean {
  return /\b(?:minvrm|maxvrm)\s*=/iu.test(text);
}

/** `.pcml` の本文を読んで記述にする */
export function parsePcml(text: string, opts: PcmlParseOptions = {}): PcmlDocument {
  const roots = tokenize(text);
  const root = roots.find((n) => n.tag === "pcml");
  if (!root) throw new As400Error("CONFIG_ERROR", "PCML: <pcml> がありません");

  const ctx: BuildContext = { flat: new Map(), defs: new Map(), vrm: opts.vrm };
  for (const child of root.children) {
    if (child.tag === "struct") {
      const name = child.attrs.get("name") ?? "";
      if (name === "") bad(child.line, "<struct> に name がありません");
      ctx.defs.set(name, child);
    } else if (child.tag !== "program") {
      bad(child.line, `<pcml> の直下に <${child.tag}> は置けません`);
    }
  }

  const structs = new Map<string, PcmlField[]>();
  for (const [name, def] of ctx.defs) {
    // 定義そのものは「参照されるまで向きが決まらない」ので、既定の inputoutput で組む
    structs.set(name, toFields(def.children, name, true, "inputoutput", ctx, [name]));
  }

  const programs = new Map<string, PcmlProgram>();
  for (const child of root.children) {
    if (child.tag !== "program") continue;
    const name = child.attrs.get("name") ?? "";
    if (name === "") bad(child.line, "<program> に name がありません");
    if (programs.has(name)) bad(child.line, `<program name="${name}"> が重複しています`);
    const program: PcmlProgram = {
      name,
      // **根まで遡ると inputoutput**（`PcmlDocNode.getUsage`）
      fields: toFields(child.children, name, true, "inputoutput", ctx, [])
    };
    const path = child.attrs.get("path");
    if (path !== undefined && path !== "") program.path = path;
    const entry = child.attrs.get("entrypoint");
    if (entry !== undefined && entry !== "") program.entrypoint = entry;
    const safe = child.attrs.get("threadsafe");
    if (safe === "true" || safe === "false") program.threadsafe = safe === "true";
    programs.set(name, program);
  }

  if (programs.size === 0) throw new As400Error("CONFIG_ERROR", "PCML: <program> がありません");

  for (const program of programs.values()) resolveRefs(program.fields, program.name, ctx);

  const doc: PcmlDocument = { structs, programs };
  const version = root.attrs.get("version");
  if (version !== undefined && version !== "") doc.version = version;
  return doc;
}
