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
  name: string;
  type: PcmlType;
  usage: PcmlUsage;
  /** `char`/`byte`/`int`/`float` はバイト数、`packed`/`zoned` は桁数 */
  length?: number;
  /** `packed`/`zoned` は小数位、`int` は符号の別 */
  precision?: number;
  ccsid?: number;
  init?: string;
  passby?: "reference" | "value";
  /** 整数、または**完全名**（相対名は解決済み） */
  count?: number | string;
  /** `type === "struct"` のときのメンバー */
  fields?: PcmlField[];
  /** 完全名（`PCMLTST.REC.NM`）。名前で引くときの鍵 */
  path: string;
}

export interface PcmlProgram {
  name: string;
  /** `/QSYS.LIB/ASAOLIB.LIB/PCMLTST.PGM` の形 */
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
 * **並びを変える属性。** 無視すると**黙って別のバイト列を組む**ので、断る。
 *
 * - `minvrm` / `maxvrm` … その OS 版にだけ在る項目。無視すると在るはずのない項目を数えてしまう
 * - `offset` / `offsetfrom` … 順に詰めるのではなく明示位置に置く
 * - `outputsize` … 出力領域の大きさを別に決める
 *
 * どれも「読めたつもりで位置がずれる」形の失敗になる。**読めないと言う方が安全**。
 */
const LAYOUT_ATTRS = ["minvrm", "maxvrm", "offset", "offsetfrom", "outputsize"] as const;

function rejectLayoutAttrs(node: RawNode): void {
  for (const name of LAYOUT_ATTRS) {
    const raw = node.attrs.get(name);
    if (raw !== undefined && raw !== "") {
      bad(node.line, `${name}="${raw}" はまだ扱えません（並びが変わるため、黙って読みません）`);
    }
  }
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
  /** 完全名 → 項目。`count` の相対解決に使う */
  flat: Map<string, PcmlField>;
  /** 根の `<struct>` 定義（`struct=` は**完全名で直に引く**） */
  defs: Map<string, RawNode>;
}

/** `<data>` / `<struct>` を 1 項目に変換する（`struct=` の展開を含む） */
function toField(
  node: RawNode,
  parentPath: string,
  inherited: PcmlUsage,
  ctx: BuildContext,
  seen: readonly string[]
): PcmlField {
  rejectLayoutAttrs(node);
  const name = node.attrs.get("name") ?? "";
  if (name === "") bad(node.line, `<${node.tag}> に name がありません`);
  if (name.includes(".") || name.includes(" ")) {
    bad(node.line, `name="${name}" に "." や空白は使えません`);
  }
  const path = parentPath === "" ? name : `${parentPath}.${name}`;
  const usage = usageAttr(node, inherited);

  const countRaw = node.attrs.get("count");
  let count: number | string | undefined;
  if (countRaw !== undefined && countRaw !== "") {
    count = /^\d+$/u.test(countRaw) ? Number.parseInt(countRaw, 10) : countRaw;
  }

  const field: PcmlField = { name, path, type: "struct", usage };
  if (count !== undefined) field.count = count;

  if (node.tag === "struct") {
    // **その場に書かれた構造体**。子がそのままメンバーになる
    field.fields = node.children.map((c) => toField(c, path, usage, ctx, seen));
    ctx.flat.set(path, field);
    return field;
  }

  const type = node.attrs.get("type") ?? "";
  if (NOT_YET.has(type)) bad(node.line, `type="${type}" はまだ扱えません`);
  if (!TYPES.has(type)) bad(node.line, `type="${type}" は使えません`);
  field.type = type as PcmlType;

  const length = intAttr(node, "length");
  if (length !== undefined) field.length = length;
  const precision = intAttr(node, "precision");
  if (precision !== undefined) field.precision = precision;
  const ccsid = intAttr(node, "ccsid");
  if (ccsid !== undefined) field.ccsid = ccsid;
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
    field.fields = def!.children.map((c) => toField(c, path, usage, ctx, [...seen, ref]));
  }

  ctx.flat.set(path, field);
  return field;
}

/**
 * `count` の相対名を**完全名**に解く。
 *
 * 規則（`PcmlDocNode.resolveRelativeNode`）: **自分の親から根に向かって遡り**、
 * 各段で `<その段の完全名>.<相対名>` を平坦表に引く。**最初に当たったもの**を採る。
 */
function resolveCounts(fields: readonly PcmlField[], ctx: BuildContext): void {
  for (const f of fields) {
    if (typeof f.count === "string") {
      const parts = f.path.split(".");
      let resolved: string | undefined;
      // parts の末尾は自分自身。親から順に短くしていく
      for (let depth = parts.length - 1; depth >= 0; depth--) {
        const prefix = parts.slice(0, depth).join(".");
        const candidate = prefix === "" ? f.count : `${prefix}.${f.count}`;
        if (ctx.flat.has(candidate)) {
          resolved = candidate;
          break;
        }
      }
      if (resolved === undefined) {
        throw new As400Error("CONFIG_ERROR", `${f.path} の count="${f.count}" に当たる項目がありません`);
      }
      const target = ctx.flat.get(resolved);
      if (target && target.type !== "int" && target.type !== "packed" && target.type !== "zoned") {
        throw new As400Error(
          "CONFIG_ERROR",
          `${f.path} の count が指す ${resolved} は ${target.type} で、件数になりません`
        );
      }
      f.count = resolved;
    }
    if (f.fields) resolveCounts(f.fields, ctx);
  }
}

/** `.pcml` の本文を読んで記述にする */
export function parsePcml(text: string): PcmlDocument {
  const roots = tokenize(text);
  const root = roots.find((n) => n.tag === "pcml");
  if (!root) throw new As400Error("CONFIG_ERROR", "PCML: <pcml> がありません");

  const ctx: BuildContext = { flat: new Map(), defs: new Map() };
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
    structs.set(
      name,
      def.children.map((c) => toField(c, name, "inputoutput", ctx, [name]))
    );
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
      fields: child.children.map((c) => toField(c, name, "inputoutput", ctx, []))
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

  for (const program of programs.values()) resolveCounts(program.fields, ctx);

  const doc: PcmlDocument = { structs, programs };
  const version = root.attrs.get("version");
  if (version !== undefined && version !== "") doc.version = version;
  return doc;
}
