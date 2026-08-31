import { codecForCcsid, SO, SI, type Codec } from "@ts5250/ebcdic";

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
  /**
   * 桁ごとの生 EBCDIC バイト（**SBCS だけ**。全角・その継続桁・オーダー由来は `undefined`）。
   * `raw[r][c-1]` が `lines[r]` の c 桁目に対応する。
   *
   * **表示コード切替（カナ ⇄ 英）のために持つ。** 復号済みの `lines` からは、
   * CP290 と CP1027 のどちらの表で読むべきかを後から選び直せない
   * （両表はカタカナと英小文字の位置が入れ替わった鏡像で、元のバイトが要る）。
   *
   * **`lines` は 1 文字も変えない。** ここは並走する追加情報であって、
   * PDF・テキスト・検索がこれまでどおり `lines` を使い続けられるようにしてある。
   */
  raw?: (number | undefined)[][];
  /**
   * SO/SI が現れた位置。`col` は**その直後に来る桁**（1 起点）で、SO/SI 自身は桁を占めない
   * （この復号器は昔からシフトで桁を進めない。`lines` の桁位置はそのまま）。
   *
   * **SO/SI 表示のために持つ。** 印をどう描くか——桁を 1 つ使うのか、`lines` の桁を
   * 動かさずに見せるのか——は描く側の判断なので、ここでは位置だけを渡す。
   */
  shifts?: ShiftMark[][];
}

/** SO/SI の位置（`LogicalPage.shifts`） */
export interface ShiftMark {
  /** その直後に来る桁（1 起点） */
  col: number;
  kind: "so" | "si";
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
  private readonly codec: Codec;
  private readonly isDbcs: boolean;

  constructor(ccsid: number, private readonly warn?: (msg: string) => void) {
    this.codec = codecForCcsid(ccsid);
    this.isDbcs = this.codec.isDbcs;
  }

  /**
   * 1 ジョブ分の SCS バイト列を論理ページ列にデコードする。ジョブ境界（Job Complete）は
   * 呼び出し側（PrinterSession）が切って渡す。未知のオーダーに当たったら安全に打ち切り、
   * それまでのページを返す（帳票は読める範囲で描く）。
   */
  decode(scs: Uint8Array): LogicalPage[] {
    const pages: LogicalPage[] = [];
    let grid: string[][] = []; // grid[r-1][c-1]
    // 桁ごとの生バイトと SO/SI 位置。**grid と同じ添字**で並走させる（`LogicalPage.raw` の注記）
    let rawGrid: (number | undefined)[][] = [];
    let shiftGrid: ShiftMark[][] = [];
    let row = 1;
    let col = 1;
    let maxRow = 0;
    let maxCol = 0;
    let dbcsMode = false; // SO/SI シフト状態（DBCS コーデックのみ）

    const cellAt = (c: number): void => {
      // grid[row-1] を c 桁まで空白で伸ばす
      let line = grid[row - 1];
      if (!line) {
        line = [];
        grid[row - 1] = line;
      }
      while (line.length < c) line.push(" ");
    };
    const put = (ch: string, rawByte?: number): void => {
      if (row < 1 || col < 1 || row > MAX_ROW || col > MAX_COL) return;
      cellAt(col);
      grid[row - 1]![col - 1] = ch;
      // 生バイトは SBCS の桁にだけ残す（読み直せるのはこれだけ）
      (rawGrid[row - 1] ??= [])[col - 1] = rawByte;
      if (row > maxRow) maxRow = row;
      if (col > maxCol) maxCol = col;
      col += 1;
    };
    // 全角グリフ（2 桁を占める）。後半桁は継続（空文字列）にして join で桁を保つ
    const putWide = (ch: string): void => {
      if (row < 1 || col < 1 || row > MAX_ROW || col + 1 > MAX_COL) return;
      cellAt(col + 1);
      grid[row - 1]![col - 1] = ch;
      grid[row - 1]![col] = ""; // 継続桁
      if (row > maxRow) maxRow = row;
      if (col + 1 > maxCol) maxCol = col + 1;
      col += 2;
    };
    /** いまの桁の直前に SO/SI があった、と記録する（SO/SI 自身は桁を占めない） */
    const markShift = (kind: "so" | "si"): void => {
      if (row < 1 || col < 1 || row > MAX_ROW || col > MAX_COL) return;
      (shiftGrid[row - 1] ??= []).push({ col, kind });
    };

    const flushPage = (): void => {
      if (maxRow === 0 && maxCol === 0) return; // 空ページは出さない
      const lines: string[] = [];
      const raw: (number | undefined)[][] = [];
      const shifts: ShiftMark[][] = [];
      for (let r = 0; r < maxRow; r++) {
        const line = grid[r] ?? [];
        lines.push(line.join("").replace(/\s+$/, "")); // 行末の空白は落とす
        raw.push(rawGrid[r] ?? []);
        shifts.push(shiftGrid[r] ?? []);
      }
      pages.push({ rows: maxRow, cols: maxCol, lines, raw, shifts });
      grid = [];
      rawGrid = [];
      shiftGrid = [];
      maxRow = 0;
      maxCol = 0;
    };

    let i = 0;
    const n = scs.length;
    const next = (): number => (i < n ? scs[i++]! : -1);

    while (i < n) {
      const b = scs[i++]!;
      // DBCS モード中はバイトを 2 個ずつ全角として消費する（制御コード値と衝突しないよう switch より前で処理）。
      // SI で SBCS へ戻る。SO は冗長として読み飛ばす。
      //
      // **0x40 未満は全角の先行バイトにしない**（`wtd-applier` の `applyWtd` と同じ判定）。
      // SCS の制御はすべて 0x40 未満（NOOP 0x00 / TRANSPARENT 0x03 / HT 0x05 / RNL 0x06 /
      // FF 0x0C / CR 0x0D / NL 0x15 / 0x2B オーダー / PP 0x34 / RFF 0x3A）なので、
      // ここで除外しないと**ホストが行末で SI を閉じない帳票**で改行・改ページごと食われる
      // ——制御バイトが先行バイト扱いになって次の 1 バイトまで巻き込み、U+FFFD が並んだうえ
      // 行が繋がってしまう（利用者報告の「一部の DBCS が化ける」）。除外すれば下の switch が
      // 制御として処理し、シフトが開いたままでも表示だけが欠けて同期は保たれる。
      if (this.isDbcs && dbcsMode) {
        if (b === SI) {
          dbcsMode = false;
          markShift("si");
          continue;
        }
        if (b === SO) {
          continue; /* 冗長 SO */
        }
        if (b >= 0x40) {
          const b2 = next();
          if (b2 < 0) break;
          putWide(String.fromCodePoint(this.codec.decodeDbcsPair!(b, b2)));
          continue;
        }
        // 0x40 未満＝制御。DBCS モードは維持したまま下の switch で処理する
      }
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
            put(String.fromCodePoint(this.codec.decodeByte(rb)), rb);
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
          // SBCS モード: SO で DBCS モードへ、それ以外は SBCS 1 バイト
          if (this.isDbcs && b === SO) {
            dbcsMode = true;
            markShift("so");
          } else put(String.fromCodePoint(this.codec.decodeByte(b)), b);
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
      case 0xd2:
      // **0xFD は DBCS（IGC）制御。** 長さ前置で 0xD2 と同じ構造。
      // これを知らないと DBCS 帳票の先頭で「未知の 2B オーダー」と判定して打ち切り、
      // ページが 1 枚も取れなかった（日本語実機のスプールで確認）。
      case 0xfd: {
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
