/**
 * 結果セット → CSV。
 *
 * **サーバーではなくブラウザで作る**（spec D3）。サーバーで作ると「表示用に 1 回・CSV 用に
 * もう 1 回」同じ SQL を実行するか、結果をサーバーに保持するかになる。前者は 1 回 4〜7 秒
 * かかるうえ 2 回目が違う結果を返しうる。**画面に出ている表をそのまま落とす**のが利用者の
 * 期待とも一致する。
 */

/** RFC 4180: `"` を `""` にし、`,` `"` 改行のいずれかを含むならクォートで囲む */
function escapeField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * CSV 本文を組み立てる。改行は **CRLF**（RFC 4180 準拠。Excel が確実に行を分ける）。
 * BOM はここでは付けない——文字列としての比較をテストしやすくするため、Blob 化する側で付ける。
 */
export function toCsv(columns: string[], rows: Record<string, unknown>[]): string {
  const lines = [columns.map(escapeField).join(",")];
  for (const row of rows) {
    lines.push(columns.map((c) => escapeField(row[c])).join(","));
  }
  return lines.join("\r\n");
}

/**
 * CSV の Blob を作る。**UTF-8 BOM を付ける**——Excel は BOM が無いと UTF-8 CSV を
 * ローカルコードページとして開き、DBCS（このプロジェクトの中心的関心事）が化けるため。
 */
export function csvBlob(csv: string): Blob {
  return new Blob(["﻿", csv], { type: "text/csv;charset=utf-8" });
}

/** `query-20260719-134501.csv` の形。`now` を注入可能にしてテストで固定する */
export function csvFileName(now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  const d = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  const t = `${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `query-${d}-${t}.csv`;
}
