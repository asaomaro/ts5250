/**
 * DB モニター表の**列の論理名**をホストの catalog から読む。
 *
 * ## なぜホストから読むのか
 *
 * ACS の詳細ダイアログは列に日本語のラベルを付けている。そのラベルは
 * **ACS の中に埋め込まれていて、こちらからは取れない**——`QSYS2.QQQ3000` 系の
 * ビューは存在せず（実測 0 件）、IBM の記録種別ごとの文書もホストには無い。
 *
 * ただし**モニター表そのものの列説明**（`QSYS2.SYSCOLUMNS` の `COLUMN_TEXT`）には
 * IBM が書いた論理名が入っている。282 列中 **71 列**——「照会されたテーブルの名前」
 * 「副選択番号」のように、列名（`QQTFN` / `QQQDTN`）よりずっと読める。
 * 残り（`QQI9` / `QQF1` / `QVC13` …）は**説明そのものが空**なので、
 * どこにも論理名が無い。**そこは列名のまま出すしかない**（推測で名付けない）。
 *
 * ## 日本語のテキストが壊れて届く（ホスト側の問題を客側で戻す）
 *
 * 日本語システムでは `COLUMN_TEXT` が**壊れた形**で入っている。実測:
 *
 * ```
 * QQTFN の COLUMN_TEXT = "｣ﾃ｣ｰ｣J…"   （半角カナの羅列）
 * ```
 *
 * DBCS 混在の文字列が**SBCS（カタカナ）表で 1 バイトずつ変換**されていて、
 * SO(`U+000E`)/SI(`U+000F`) がそのまま文字として残っている。
 * つまり **1 文字 = 元の 1 バイト**なので、カタカナ表を逆に引けばバイト列へ戻せる。
 * 戻したうえで CCSID 5026 の混在として読み直すと「照会されたテーブルの名前」になる。
 *
 * ⚠ **完全には戻らない。** ホストが変換に失敗したバイトは `U+001A` に潰れていて、
 * 元の値が残っていない（実測で 71 列中 33 列に 1〜2 文字）。**戻せない文字がある行は
 * 論理名として採用しない**——半端に欠けた日本語より、列名そのものの方が誤解が無い。
 *
 * 英語システムでは SO/SI が無く、そのまま読めるので何もしない（PUB400 で確認）。
 */
import { codecForCcsid, katakanaChar } from "@ts5250/ebcdic";
import { childLog } from "@ts5250/base";
import type { DbConnection } from "./db-connection.js";
import { queryLimited } from "./query.js";

const log = childLog({ component: "hostserver-plan-column-text" });

/** SO / SI が文字として残っている（＝潰された日本語）ことの目印 */
const SO = "\u000E";
const SI = "\u000F";

/** カタカナ表の逆引き。**1 度だけ組む**（256 通りしかない） */
let reverseKatakana: Map<string, number> | undefined;

function reverseTable(): Map<string, number> {
  if (reverseKatakana) return reverseKatakana;
  const map = new Map<string, number>();
  for (let b = 0; b < 256; b++) {
    const ch = katakanaChar(b);
    // **表に無いバイトは `\uFFFD` が返る**（29 バイトある）。これを鍵にすると
    // 別々のバイトが同じ文字に潰れて、逆引きが嘘のバイトを返す
    if (!ch || ch === "\uFFFD") continue;
    // 同じ文字に複数のバイトが当たったら**引かない**（どちらか決められない）
    if (map.has(ch)) {
      map.set(ch, -1);
      continue;
    }
    map.set(ch, b);
  }
  for (const [ch, b] of map) if (b < 0) map.delete(ch);
  reverseKatakana = map;
  return map;
}

/**
 * 潰された日本語を戻す。戻しきれない文字が 1 つでもあれば `undefined`。
 *
 * @returns 読める論理名、または戻せないとき `undefined`
 */
export function unmangleColumnText(text: string): string | undefined {
  if (!text.includes(SO)) return text.trim() || undefined;
  const rev = reverseTable();
  const codec = codecForCcsid(5026);
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] !== SO) {
      out += text[i];
      i += 1;
      continue;
    }
    const bytes: number[] = [];
    let j = i + 1;
    while (j < text.length && text[j] !== SI) {
      const b = rev.get(text[j]!);
      // **戻せない文字があったら諦める。** 欠けた日本語を論理名として出さない
      if (b === undefined) return undefined;
      bytes.push(b);
      j += 1;
    }
    // 奇数個は 1 バイト失われている（ホストが変換できずに落とした）
    if (bytes.length % 2 !== 0) return undefined;
    const decoded = codec.decode(Uint8Array.from([0x0e, ...bytes, 0x0f]));
    // 表に無い組み合わせも諦める（置換文字を混ぜたまま見出しにしない）
    if (decoded.includes("\uFFFD")) return undefined;
    out += decoded;
    i = j + 1;
  }
  // 見出し（`COLUMN_HEADING`）は 20 桁 × 3 段で、段の隙間が空白として残る。
  // 連続する空白は 1 つに潰す（「作成              時刻」→「作成 時刻」）
  const trimmed = out.replace(/\s+/gu, " ").trim();
  return trimmed === "" ? undefined : trimmed;
}

/** 接続ごとに 1 度だけ引いて使い回す（列は変わらない） */
const cache = new WeakMap<DbConnection, ReadonlyMap<string, string>>();

/**
 * モニター表の列 → 論理名。**引けなければ空の表**を返す（列名のまま出るだけ）。
 *
 * `COLUMN_TEXT` が空なら `COLUMN_HEADING` を見る。見出しは列名そのものが入っている
 * ことがある（`QQI1` の見出しが `QQI1`）ので、**列名と同じなら採用しない**。
 */
export async function monitorColumnLabels(conn: DbConnection): Promise<ReadonlyMap<string, string>> {
  const cached = cache.get(conn);
  if (cached) return cached;
  const out = new Map<string, string>();
  try {
    const res = await queryLimited(
      conn,
      "SELECT COLUMN_NAME, COLUMN_TEXT, COLUMN_HEADING FROM QSYS2.SYSCOLUMNS " +
        "WHERE TABLE_SCHEMA = 'QSYS' AND TABLE_NAME = 'QAQQDBMN'",
      { limit: 400 }
    );
    for (const row of res.rows) {
      const name = typeof row["COLUMN_NAME"] === "string" ? row["COLUMN_NAME"].trim() : "";
      if (name === "") continue;
      for (const key of ["COLUMN_TEXT", "COLUMN_HEADING"]) {
        const raw = row[key];
        if (typeof raw !== "string") continue;
        const label = unmangleColumnText(raw);
        if (label === undefined || label === name) continue;
        out.set(name, label);
        break;
      }
    }
  } catch (e) {
    // **論理名が無くても計画は出せる。** 失敗で採取ごと落とさない
    log.debug(`column label lookup failed; showing column names as-is: ${String(e)}`);
  }
  cache.set(conn, out);
  return out;
}
