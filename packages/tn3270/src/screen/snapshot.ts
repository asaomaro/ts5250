import { codecForCcsid, type Codec } from "@ts5250/ebcdic/codec";
import { NUL, SO, SI } from "../protocol/constants.js";
import { DB, dbcsStates, validDbcsPair } from "./dbcs.js";
import { parseFieldAttr } from "./attributes.js";
import { graphicEscapeChar } from "./graphic-escape.js";
import { colorOf, highlightOf } from "./attributes.js";
import type { Screen3270 } from "./buffer.js";
import type { Cell, CellKind, Field, ScreenSnapshot } from "./types.js";

/**
 * バッファから表示用のスナップショットを導出する。
 *
 * **フィールドは保持していない**（design D8）——ここで属性桁を走査して組み立てる。
 * DBCS も**生バイトから導出**する: `SO` を見たら `SI` まで 2 バイトずつ 1 文字に畳む
 * （research F5 の実測どおり、DBCS 1 文字はバッファ 2 桁・SO/SI は各 1 桁）。
 *
 * `@ts5250/ebcdic` は**狭い入口（`/codec`）から取る**。バレル経由だと変換表 18,900 行が
 * 丸ごと付いてくる（AGENTS.md）。
 */

export interface SnapshotOptions {
  /** 画面文字の CCSID。既定 37。930 / 939 で DBCS */
  ccsid?: number;
}

export function snapshot(screen: Screen3270, opts: SnapshotOptions = {}): ScreenSnapshot {
  const codec = codecForCcsid(opts.ccsid ?? 37);
  const cells = buildCells(screen, codec);
  const fields = buildFields(screen, cells);
  const cur = screen.rowColOf(screen.cursor);
  return {
    rows: screen.rows,
    cols: screen.cols,
    alternate: screen.alternate,
    cursor: cur,
    cells,
    fields,
    keyboardLocked: screen.keyboardLocked,
    unformatted: screen.unformatted
  };
}

function buildCells(screen: Screen3270, codec: Codec): Cell[][] {
  const db = dbcsStates(screen, codec.isDbcs);
  const out: Cell[][] = [];
  for (let row = 0; row < screen.rows; row++) {
    const line: Cell[] = [];
    for (let col = 0; col < screen.cols; col++) {
      const addr = row * screen.cols + col;
      const byte = screen.charAt(addr);
      const ext = screen.extAt(addr);
      const ap = screen.fieldAttrPosFor(addr);
      const fa = ap >= 0 ? parseFieldAttr(screen.attrAt(ap)) : null;
      const hl = highlightOf(ext.hilite);
      const base = {
        color: colorOf(ext.color),
        intensified: fa?.intensified ?? false,
        reverse: hl.reverse,
        underline: hl.underline,
        blink: hl.blink,
        nonDisplay: fa?.hidden ?? false
      };

      if (screen.isAttrPos(addr)) {
        // 属性桁。**1 桁を占めるが文字は持たない**。
        //
        // **見た目は欄から引き継がない。** 原典は属性桁を `xattrset(defattr)` ——
        // 既定の属性——で空白として描く（`c3270/screen.c` の描画）。
        // 引き継ぐと、下線つきの入力欄の**手前の桁に下線が 1 つ描かれる**。
        // 実機（IBM i のサインオン）で `_` として見えた: 入力欄が 53 桁目から始まり、
        // 52 桁目の属性桁に下線が乗っていた。5250 側は同じ場面で落としている
        // （`tn5250/src/screen/buffer.ts` の属性桁）。**色だけは残す**のも 5250 と同じ。
        line.push({
          char: " ",
          kind: "attr",
          ...base,
          intensified: false,
          nonDisplay: false,
          reverse: false,
          underline: false,
          blink: false
        });
        continue;
      }
      if (byte === SO) {
        line.push({ char: " ", kind: "so", ...base });
        continue;
      }
      if (byte === SI) {
        line.push({ char: " ", kind: "si", ...base });
        continue;
      }
      if (db[addr] === DB.LEAD) {
        // DBCS は 2 桁で 1 文字。lead 側にだけ文字を入れる。
        // **相方は次のアドレス**——行末なら次の行の 1 桁目になる
        const tail = screen.charAt((addr + 1) % screen.size);
        // **DBCS として成立しない対は空白 2 桁として描く**（s3270 と同じ）。
        // 画面の残りが NUL のまま DBCS 区間が続くと、ここが効いて空白になる
        const ok = validDbcsPair(byte, tail);
        const cp = ok ? codec.decodeDbcsPair?.(byte, tail) : codec.decodeDbcsPair?.(0x40, 0x40);
        line.push({
          char: cp !== undefined && cp > 0 ? String.fromCodePoint(cp) : " ",
          kind: "dbcs-lead",
          ...base
        });
        continue;
      }
      if (db[addr] === DB.TAIL) {
        line.push({ char: "", kind: "dbcs-tail", ...base });
        continue;
      }
      if (db[addr] === DB.DEAD) {
        // 相方の来なかった左半分。**文字にはしない**
        line.push({ char: " ", kind: "sbcs", ...base, rawByte: byte });
        continue;
      }
      const kind: CellKind = "sbcs";
      // **`GE` で置かれた桁は代替文字集合で読む**（通常の EBCDIC ではない）
      const ge = screen.isGe(addr) ? graphicEscapeChar(byte) : undefined;
      const ch = ge ?? (byte === NUL ? " " : codec.decode(Uint8Array.of(byte)));
      line.push({
        char: base.nonDisplay ? " " : ch,
        kind,
        ...base,
        rawByte: byte
      });
    }
    out.push(line);
  }
  return out;
}

function buildFields(screen: Screen3270, cells: Cell[][]): Field[] {
  const positions = screen.attrPositions();
  if (positions.length === 0) return []; // 非フォーマット画面にフィールドは無い

  const out: Field[] = [];
  const n = screen.size;
  for (let i = 0; i < positions.length; i++) {
    const ap = positions[i]!;
    const nextAp = positions[(i + 1) % positions.length]!;
    // **次の属性桁の直前まで**が中身（環状）
    const length = nextAp > ap ? nextAp - ap - 1 : n - ap - 1 + nextAp;
    const start = screen.wrap(ap + 1);
    const fa = parseFieldAttr(screen.attrAt(ap));
    const apRc = screen.rowColOf(ap);
    const stRc = screen.rowColOf(start);

    let value = "";
    for (let k = 0; k < length; k++) {
      const p = screen.wrap(start + k);
      const rc = screen.rowColOf(p);
      const cell = cells[rc.row - 1]?.[rc.col - 1];
      if (cell && cell.kind !== "dbcs-tail") value += cell.char;
    }

    out.push({
      index: i + 1,
      attrRow: apRc.row,
      attrCol: apRc.col,
      row: stRc.row,
      col: stRc.col,
      length,
      protected: fa.protected,
      numeric: fa.numeric,
      autoSkip: fa.autoSkip,
      hidden: fa.hidden,
      intensified: fa.intensified,
      modified: fa.modified,
      value: fa.hidden ? "" : value
    });
  }
  return out;
}
