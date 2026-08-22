/**
 * 端末タイプ名の決定。
 *
 * SBCS 24x80 = IBM-3179-2、SBCS 27x132 = IBM-3477-FC（RFC 1205 の一覧どおり）。
 * DBCS 24x80 = IBM-5555-G02、DBCS 27x132 = IBM-5555-C01。
 *
 * DBCS 側は RFC 1205 に載っておらず、IBM のドキュメントも 5555 系を一律
 * 「24x80 または 27x132」と書くだけでサイズを型番に紐づけていない（tn5250 は DBCS 自体が
 * 未実装で先例にならない）。そのため PUB400 実機で総当たりして決めた:
 *
 *   IBM-5555-B01  モノクロ  24x80    …… 色が落ちる（青/桃/黄が出ない）
 *   IBM-5555-C01  カラー    27x132
 *   IBM-5555-G01  モノクロ  24x80    …… 同上
 *   IBM-5555-G02  カラー    24x80
 *   IBM-5555-A01 / D01 / E01 / F01   …… ホストが交渉を拒否（telnet の名前ではない）
 *
 * 当エミュレーターはカラー表示なので、カラーの 2 つ（24x80=G02 / 27x132=C01）を使う。
 * G02 は定義上「グラフィックス表示」だが、グラフィックス非対応は Query Reply（t[53]=0）で
 * 別途申告しており、実機でも表示は正常。
 */
const DBCS_CCSIDS = new Set([930, 939, 1399, 931, 5035, 5026]);

export function terminalTypeFor(ccsid: number, screenSize: "24x80" | "27x132"): string {
  const dbcs = DBCS_CCSIDS.has(ccsid);
  if (dbcs) return screenSize === "27x132" ? "IBM-5555-C01" : "IBM-5555-G02";
  return screenSize === "27x132" ? "IBM-3477-FC" : "IBM-3179-2";
}

export function isDbcsCcsid(ccsid: number): boolean {
  return DBCS_CCSIDS.has(ccsid);
}

/**
 * プリンターセッションの端末タイプ名。
 *
 * SBCS/DBCS とも IBM-3812-1（tn5250 lp5250d が使う唯一のプリンター型番）。
 * DBCS でも別型番（IBM-5553 系）は不要で、Japanese の扱いは NEW-ENVIRON の
 * KBDTYPE/CODEPAGE/CHARSET（`deviceEnvFor`）でホストに申告する。
 *
 * PUB400 実機で確認済み: SBCS(CCSID 37) / DBCS(CCSID 1399) いずれも IBM-3812-1 で I902＝
 * 「Session successfully started」で接続でき、DBCS スプールは SCS 中に SO/SI 付きの全角が
 * 正しく届く（`scripts/verify-printer.mjs` / `verify-printer-dbcs.mjs`）。
 */
export function printerTerminalTypeFor(ccsid: number): string {
  void ccsid; // 現状 SBCS/DBCS とも IBM-3812-1（CCSID は deviceEnvFor で申告）
  return "IBM-3812-1";
}
