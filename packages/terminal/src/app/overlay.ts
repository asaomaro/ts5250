/**
 * 欄の編集値を画面（`ScreenSnapshot`）へ重ねる純関数。
 *
 * サーバーの WebSocket 経由では、打った値は AID を送るまでサーバーへ渡らない（web-ui と同じ約束）。
 * 端末側は編集中の値を手元で持ち、描画と次の編集の入力には「重ねた画面」を使う。
 * `Session5250.setField` が内部バッファへすることと同じ見え方を、スナップショット上で作る。
 */
import type { Cell, Field, ScreenSnapshot } from "@ts5250/tn5250";
import { fieldSlices } from "@ts5250/tn5250/edit/fieldSlices";
import { SO_MARK, SI_MARK, isWideForDbcs } from "@ts5250/tn5250/edit/fieldValidate";

/** 編集値 1 つ分の桁の並び。O 欄の SO/SI の印・全角（2 桁）・空き（NUL）を桁へ展開する */
function toCells(value: string, proto: Cell, width: number): Cell[] {
  const out: Cell[] = [];
  const mk = (kind: Cell["kind"], char: string): Cell => {
    const c: Cell = { ...proto, kind, char };
    delete c.rawByte;
    delete c.dead;
    delete c.keep;
    return c;
  };
  for (const ch of value) {
    if (ch === SO_MARK) out.push(mk("so", " "));
    else if (ch === SI_MARK) out.push(mk("si", " "));
    else if (ch === "\u0000") out.push(mk("sbcs", " "));
    else if (isWideForDbcs(ch)) out.push(mk("dbcs-lead", ch), mk("dbcs-tail", " "));
    else out.push(mk("sbcs", ch));
  }
  while (out.length < width) out.push(mk("sbcs", " "));
  return out.slice(0, width);
}

/** 欄 `f` の値を `value` にした画面を返す（元は変えない） */
export function overlayField(snap: ScreenSnapshot, f: Field, value: string): ScreenSnapshot {
  const slices = fieldSlices(f, snap.cols, snap.rows);
  const total = slices.reduce((n, s) => n + s.width, 0);
  const first = snap.cells[f.row - 1]?.[f.col - 1];
  if (!first) return snap;
  const cells = toCells(f.hidden ? " ".repeat(value.length) : value, first, total);
  const rows = snap.cells.map((r) => r);
  for (const sl of slices) {
    const row = rows[sl.row - 1];
    if (!row) continue;
    const copy = [...row];
    for (let i = 0; i < sl.width; i++) {
      const old = copy[sl.col - 1 + i];
      const next = cells[sl.offset + i];
      if (old && next) copy[sl.col - 1 + i] = { ...next, color: old.color, reverse: old.reverse, underline: old.underline, blink: old.blink, columnSeparator: old.columnSeparator, nonDisplay: old.nonDisplay };
    }
    rows[sl.row - 1] = copy;
  }
  return { ...snap, cells: rows, fields: snap.fields.map((x) => (x.index === f.index ? { ...x, value } : x)) };
}
