/**
 * `--名前 値` 形式の引数を、MCP ツールの入力スキーマに合わせて型付きの object にする（純関数）。
 *
 * スキーマの `type` が分かればそれで変換する（number/integer → 数、boolean → 真偽、array/object → JSON）。
 * 分からない名前は文字列のまま渡す——ツール側の検証（zod）が正しく断る。値を取らない `--名前` は `true`。
 */

export interface PropSchema {
  type?: string | string[];
}

export interface ParsedArgs {
  /** 名前なしの引数（サブコマンド・ツール名・位置引数） */
  positional: string[];
  /** `--名前 値` の組。値は文字列のまま（型付けは `coerce`） */
  options: Map<string, string | true>;
}

/** `--k v`・`--k=v`・`--flag`・`--` 以降はすべて位置引数 */
export function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  const options = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf("=");
    if (eq > 0) {
      options.set(a.slice(2, eq), a.slice(eq + 1));
      continue;
    }
    const name = a.slice(2);
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      options.set(name, next);
      i++;
    } else options.set(name, true);
  }
  return { positional, options };
}

const typeOf = (p: PropSchema | undefined): string | undefined =>
  Array.isArray(p?.type) ? p.type.find((t) => t !== "null") : p?.type;

/** 1 つの値をスキーマの型へ。変換できなければ例外（利用者へそのまま見せる） */
export function coerce(name: string, raw: string | true, prop: PropSchema | undefined): unknown {
  const t = typeOf(prop);
  if (t === "boolean") {
    if (raw === true || raw === "true") return true;
    if (raw === "false") return false;
    throw new Error(`--${name} は true か false で指定してください`);
  }
  if (raw === true) throw new Error(`--${name} には値が要ります`);
  if (t === "number" || t === "integer") {
    const n = Number(raw);
    if (raw.trim() === "" || Number.isNaN(n)) throw new Error(`--${name} は数で指定してください: ${raw}`);
    return n;
  }
  if (t === "array" || t === "object") {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new Error(`--${name} は JSON で指定してください`);
    }
  }
  return raw;
}

/** オプション群 → ツールへ渡す引数。`--json` があれば土台にして、個別の `--名前` で上書きする */
export function buildToolArgs(
  options: ReadonlyMap<string, string | true>,
  props: Readonly<Record<string, PropSchema>> | undefined,
  reserved: ReadonlySet<string> = new Set(["json", "url"])
): Record<string, unknown> {
  let base: Record<string, unknown> = {};
  const j = options.get("json");
  if (j !== undefined) {
    if (j === true) throw new Error("--json には JSON が要ります");
    try {
      const v = JSON.parse(j) as unknown;
      if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error();
      base = v as Record<string, unknown>;
    } catch {
      throw new Error("--json はオブジェクトの JSON で指定してください");
    }
  }
  for (const [k, v] of options) {
    if (reserved.has(k)) continue;
    base[k] = coerce(k, v, props?.[k]);
  }
  return base;
}
