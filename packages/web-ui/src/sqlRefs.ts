/**
 * SQL から**表の参照**（ライブラリー・表・別名）を拾い、`別名.` の別名がどの表かを解く。
 *
 * 列の候補を出すのに要る。**構文解析器は書かない**——`FROM` / `JOIN` / `UPDATE` /
 * `INSERT INTO` の直後に来る「表名（＋別名）」を拾えば、候補出しには足りる。
 * 完全な SQL パーサーを持ち込むより、外したときに**候補が出ないだけ**で済む形にする。
 *
 * IBM i は `LIB.TABLE` と `LIB/TABLE` の両方を書けるので、どちらも受ける。
 */

export interface TableRef {
  /** ライブラリー（スキーマ）。書かれていなければ未指定 */
  schema?: string;
  name: string;
  /** `FROM T1 A` の `A`。無ければ表名そのものが別名の代わりになる */
  alias?: string;
}

/** 引用符つきの名前は**大文字化しない**（`"mixedCase"` はそのままが正しい） */
function unquote(raw: string): { name: string; quoted: boolean } {
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return { name: raw.slice(1, -1), quoted: true };
  }
  return { name: raw.toUpperCase(), quoted: false };
}

/** 別名になり得ない語（表名の直後に来ても別名として拾わない） */
const NOT_ALIAS = new Set([
  "ON",
  "USING",
  "WHERE",
  "GROUP",
  "ORDER",
  "HAVING",
  "JOIN",
  "INNER",
  "LEFT",
  "RIGHT",
  "FULL",
  "CROSS",
  "OUTER",
  "UNION",
  "EXCEPT",
  "INTERSECT",
  "SET",
  "VALUES",
  "FETCH",
  "LIMIT",
  "OFFSET",
  "FOR",
  "WITH",
  "AS"
]);

/** 名前 1 つ ぶんの並び（`"quoted"` / 素の識別子） */
const NAME = String.raw`(?:"[^"]+"|[A-Za-z_#$@][\w#$@]*)`;
/**
 * 表の参照。`FROM` / `JOIN` / `UPDATE` / `INSERT INTO` の直後を見る。
 * 別名は `AS` 付き・無しの両方。
 */
const REF = new RegExp(
  String.raw`\b(?:FROM|JOIN|UPDATE|INSERT\s+INTO)\s+` +
    String.raw`(${NAME})(?:\s*[./]\s*(${NAME}))?` +
    // **予約語は別名の位置でも読み飛ばさない。** ここを単に「拾わない」だけにすると
    // `FROM A JOIN B` の `JOIN` を食べてしまい、**次の表が見つからなくなる**
    String.raw`(?:\s+(?:AS\s+)?(?!(?:${[...NOT_ALIAS].join("|")})\b)(${NAME}))?`,
  "giu"
);

/**
 * 文に出てくる表の参照を拾う。
 *
 * **重複は落とさない**——同じ表を 2 回結合していれば別名ごとに 1 つずつ要る。
 */
export function tableRefsOf(sql: string): TableRef[] {
  const out: TableRef[] = [];
  for (const m of sql.matchAll(REF)) {
    const first = m[1];
    const second = m[2];
    const third = m[3];
    if (!first) continue;
    const qualified = second !== undefined;
    const table = unquote(qualified ? second : first);
    const ref: TableRef = { name: table.name };
    if (qualified) ref.schema = unquote(first).name;
    if (third !== undefined) {
      const alias = unquote(third);
      // **予約語は別名ではない**（`FROM T WHERE …` の `WHERE` を別名にしない）
      if (!NOT_ALIAS.has(alias.name.toUpperCase())) ref.alias = alias.name;
    }
    out.push(ref);
  }
  return out;
}

/** キャレット直前の `修飾子.途中まで` */
export interface Qualifier {
  /** `.` の前の語（別名・表名・ライブラリー） */
  qualifier: string;
  /** 修飾子が始まる位置。**表を書く位置かどうかの判定**に使う */
  start: number;
  /** `.` の後ろにすでに打たれている文字（候補の絞り込みに使う） */
  prefix: string;
  /** 置き換えを始める位置（`.` の次） */
  from: number;
  /** 置き換えを終える位置（＝キャレット） */
  to: number;
}

/** `修飾子.` の直後にキャレットがあるか。無ければ `undefined` */
const QUALIFIER = new RegExp(String.raw`(${NAME})\s*\.\s*([\w#$@]*)$`, "u");

export function qualifierAt(text: string, caret: number): Qualifier | undefined {
  // **手前 200 文字だけ見る**。長い SQL で毎打鍵に全文を走らせない
  const headFrom = Math.max(0, caret - 200);
  const head = text.slice(headFrom, caret);
  const m = QUALIFIER.exec(head);
  if (!m || m[1] === undefined) return undefined;
  const prefix = m[2] ?? "";
  return {
    qualifier: m[1],
    start: headFrom + (m.index ?? 0),
    prefix,
    from: caret - prefix.length,
    to: caret
  };
}

/** 表を書く位置（この直後に来るのは表名）。ここの修飾子は**ライブラリー** */
const TABLE_POSITION = new RegExp(String.raw`\b(?:FROM|JOIN|UPDATE|INSERT\s+INTO|INTO)\s*$`, "iu");

/**
 * その位置が「表を書くところ」か。
 *
 * `SELECT * FROM TESTLIB.` の `TESTLIB` は**ライブラリー**であって表ではない。
 * ところが `tableRefsOf` から見ると `FROM TESTLIB` は表 1 つに見えるので、
 * 素直に解くと「`TESTLIB` という表の列」を引きに行って空振りする。
 * **書く位置で先に判別する**（純粋に手前の語だけ見れば決まる）。
 */
export function isTablePosition(text: string, at: number): boolean {
  return TABLE_POSITION.test(text.slice(Math.max(0, at - 60), at));
}

/**
 * 修飾子（別名 or 表名）がどの表かを解く。
 *
 * **別名を先に見る。** `FROM TESTLIB.M_MENU M_MENUTR` のように、別名が
 * 別の表と同じ名前でも、書いた人の意図は別名の方。
 */
export function resolveQualifier(refs: readonly TableRef[], qualifier: string): TableRef | undefined {
  const want = unquote(qualifier).name;
  const eq = (a: string | undefined): boolean => a !== undefined && a.toUpperCase() === want.toUpperCase();
  return refs.find((r) => eq(r.alias)) ?? refs.find((r) => eq(r.name));
}
