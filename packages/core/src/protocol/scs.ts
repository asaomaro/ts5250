import { codecForCcsid } from "../codec/codec.js";

/**
 * SCS（SNA Character String）デコーダ。プリンターセッションでホストから届く印刷データを
 * 論理ページ（等幅グリッド）に展開する。tn5250 lib5250/scs.c の制御セット・バイト消費を移植した。
 *
 * 制御バイト（scs.c scs_main のディスパッチが唯一の真実）:
 *   0x00 NOOP / 0x03 TRANSPARENT(+count+N) / 0x05 HT(stub) / 0x06 RNL / 0x0C FF / 0x0D CR /
 *   0x15 NL / 0x34 PP(+fn+val) / 0x3A RFF / 0x2B 多バイトオーダー / 0xFF 無視。
 *   これ以外のバイトはすべてデータ文字（EBCDIC→Unicode 変換）。SO/SI(0x0E/0x0F) は SBCS では
 *   出現しない前提（DBCS 対応時にシフト処理を追加する）。
 */

/** 論理ページ（1 ページ分の等幅グリッド）。lines[r] は桁詰めした 1 行。 */
export interface LogicalPage {
  rows: number;
  cols: number;
  lines: string[];
}

// SCS 単バイト制御（scs.h の定数）
const NOOP = 0x00;
const TRANSPARENT = 0x03;
const HT = 0x05;
const RNL = 0x06;
const FF = 0x0c;
const CR = 0x0d;
const NL = 0x15;
const PP = 0x34;
const RFF = 0x3a;
const ORDER_2B = 0x2b;
const IGNORE_FF = 0xff;

// PP（0x34）の副機能（scs.h）
const PP_RDPP = 0x4c; // 相対下移動（row += n）
const PP_AHPP = 0xc0; // 絶対水平（col = n）
const PP_AVPP = 0xc4; // 絶対垂直（row = n）
const PP_RRPP = 0xc8; // 相対右移動（col += n）

const MAX_ROW = 32767; // 暴走データでの過大確保を防ぐ安全上限
const MAX_COL = 32767;

export class ScsDecoder {
  private readonly decodeByte: (b: number) => number;

  constructor(ccsid: number, private readonly warn?: (msg: string) => void) {
    this.decodeByte = (b) => codecForCcsid(ccsid).decodeByte(b);
  }

  /**
   * 1 ジョブ分の SCS バイト列を論理ページ列にデコードする。ジョブ境界（Job Complete）は
   * 呼び出し側（PrinterSession）が切って渡す。未知のオーダーに当たったら安全に打ち切り、
   * それまでのページを返す（帳票は読める範囲で描く）。
   */
  decode(scs: Uint8Array): LogicalPage[] {
    const pages: LogicalPage[] = [];
    let grid: string[][] = []; // grid[r-1][c-1]
    let row = 1;
    let col = 1;
    let maxRow = 0;
    let maxCol = 0;

    const put = (ch: string): void => {
      if (row < 1 || col < 1 || row > MAX_ROW || col > MAX_COL) return;
      let line = grid[row - 1];
      if (!line) {
        line = [];
        grid[row - 1] = line;
      }
      while (line.length < col) line.push(" ");
      line[col - 1] = ch;
      if (row > maxRow) maxRow = row;
      if (col > maxCol) maxCol = col;
      col += 1;
    };
    const flushPage = (): void => {
      if (maxRow === 0 && maxCol === 0) return; // 空ページは出さない
      const lines: string[] = [];
      for (let r = 0; r < maxRow; r++) {
        const line = grid[r] ?? [];
        lines.push(line.join("").replace(/\s+$/, "")); // 行末の空白は落とす
      }
      pages.push({ rows: maxRow, cols: maxCol, lines });
      grid = [];
      maxRow = 0;
      maxCol = 0;
    };

    let i = 0;
    const n = scs.length;
    const next = (): number => (i < n ? scs[i++]! : -1);

    while (i < n) {
      const b = scs[i++]!;
      switch (b) {
        case NOOP:
        case IGNORE_FF:
          break;
        case CR:
          col = 1;
          break;
        case NL:
        case RNL:
          row += 1;
          col = 1;
          break;
        case FF:
        case RFF:
          flushPage();
          row = 1;
          col = 1;
          break;
        case HT:
          break; // tn5250 と同じくスタブ（タブ停止は未実装）
        case TRANSPARENT: {
          const count = next();
          if (count < 0) break;
          for (let k = 0; k < count; k++) {
            const rb = next();
            if (rb < 0) break;
            put(String.fromCodePoint(this.decodeByte(rb)));
          }
          break;
        }
        case PP: {
          const fn = next();
          const val = next();
          if (fn < 0 || val < 0) break;
          if (fn === PP_AHPP) col = val;
          else if (fn === PP_AVPP) row = val;
          else if (fn === PP_RRPP) col += val;
          else if (fn === PP_RDPP) row += val;
          break;
        }
        case ORDER_2B: {
          if (!this.skip2b(next)) {
            this.warn?.("SCS: 未知の 2B オーダーで打ち切り");
            i = n; // 同期が取れないので安全に終了
          }
          break;
        }
        default:
          put(String.fromCodePoint(this.decodeByte(b)));
          break;
      }
    }

    flushPage();
    return pages;
  }

  /**
   * 0x2B 多バイトオーダーのバイトを消費する（tn5250 の各ハンドラの読み取り数を移植）。
   * 幾何・フォントは等幅表示では不要なので値は使わず、**同期のためにバイト数だけ**正しく消費する。
   * 未知のオーダーは false を返す（呼び出し側が打ち切る）。read は次の 1 バイト（EOF で -1）。
   */
  private skip2b(read: () => number): boolean {
    const cls = read();
    if (cls < 0) return true;
    switch (cls) {
      case 0xd2: {
        // 長さ前置（len は自身を含む）。残り len-1 バイトを消費。
        const len = read();
        if (len < 0) return true;
        for (let k = 0; k < len - 1; k++) if (read() < 0) return true;
        return true;
      }
      case 0xd1: {
        const sub = read();
        if (sub === 0x03) {
          read(); // 81(SCGL) / 87(SFFC)
          read(); // 1 パラメータ
          return true;
        }
        if (sub === 0x06) {
          read(); // 01
          read();
          read(); // SCG: gcgid, cpgid
          return true;
        }
        if (sub === 0x07) {
          read(); // 05
          for (let k = 0; k < 5; k++) read(); // SFG: gfid(2)+width(2)+attr(1)
          return true;
        }
        return false; // 未知の D1 サブオーダー
      }
      case 0xd3: {
        read(); // curchar
        const nc = read(); // nextchar
        if (nc === 0xf6) {
          for (let k = 0; k < 4; k++) read(); // STO: charrot(2)+pagerot(2)
          return true;
        }
        return false;
      }
      case 0xc8: {
        for (let k = 0; k < 3; k++) read(); // SGEA
        return true;
      }
      case 0xc1:
      case 0xc2:
      case 0xc6: {
        // SHF / SVF / SLD: len を読み、len>0 なら 1 バイト（tn5250 の実装に合わせる）
        const len = read();
        if (len > 0) read();
        return true;
      }
      default:
        return false; // 未知のクラス
    }
  }
}
