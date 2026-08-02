/**
 * 結果セット → CSV。
 *
 * **サーバーではなくブラウザで作る**（spec D3）。サーバーで作ると「表示用に 1 回・CSV 用に
 * もう 1 回」同じ SQL を実行するか、結果をサーバーに保持するかになる。前者は 1 回 4〜7 秒
 * かかるうえ 2 回目が違う結果を返しうる。**画面に出ている表をそのまま落とす**のが利用者の
 * 期待とも一致する。
 */

// 型は**実体（`@ts5250/hostserver`）から取る**。以前はここに同じ構造型を書き写しており、
// `value?: string`（実際は `string | Uint8Array`）・`unavailable?: string`（実際は 3 値の union）と
// **実態から食い違っていた**。食い違うと型ガードが信用できず、呼び出し側が `as` で読み直す。
// `import type` なので実行時にもバンドルにも入らない（`@ts5250/hostserver` は devDependencies）
import type { LobPlaceholder } from "@ts5250/hostserver";

/** LOB のプレースホルダか（値ではなくロケーターしか来ていない列） */
export function isLob(value: unknown): value is LobPlaceholder {
  return typeof value === "object" && value !== null && (value as { kind?: string }).kind === "lob";
}

/** RFC 4180: `"` を `""` にし、`,` `"` 改行のいずれかを含むならクォートで囲む */
function escapeField(value: unknown): string {
  if (value === null || value === undefined) return "";
  // LOB は値そのものを取得していない。**空欄にすると NULL と混ざる**ので明示する
  if (isLob(value)) {
    if (typeof value.value === "string") {
      // 打ち切りは**画面と同じ印**を付ける。この表は「画面に出ているものをそのまま落とす」
      // のが趣旨（冒頭参照）なのに、CSV だけ無印だと**完全な値のように見えていた**。
      // 印のために本文を捨てない——持ち出しが CSV の目的なので取れた分は必ず残す。
      // エスケープは印を付けた後に掛ける（マーカーを変えても壊れないように）
      const text = value.unavailable === "too-large" ? `${value.value}…（以降省略）` : value.value;
      return escapeField(text);
    }
    // ここに来るのは「取れていない」か「バイナリ（Uint8Array）」。
    // **取りに行って失敗した**のは「取りに行っていない」と別物——同じ (LOB) にすると、
    // 取得を指定して落とした CSV が、指定しなかった CSV と見分けられない。
    // ⚠ 取得に成功したバイナリ LOB も (LOB) になり未取得と区別が付かない（画面も同じ）。
    //    BLOB の実機検証（backlog）で実物を見てから決める
    return value.unavailable === "failed" ? "(LOB: 取得失敗)" : "(LOB)";
  }
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
