import { codecForCcsid, SO, SI, type Codec } from "@ts5250/ebcdic";

/**
 * SCS（SNA Character String）デコーダ。プリンターセッションでホストから届く印刷データを
 * 論理ページ（等幅グリッド）に展開する。
 *
 * **制御の表は ACS に合わせる**（`PrintSCS5250` のコンストラクタの `scs_proc`。`20260921-scs-controls-acs`）。
 * ~~tn5250 lib5250/scs.c の制御セット~~ は ACS と食い違っていた——0x03 を EBCDIC の透過として読み、
 * 表に無い制御（LF 0x25・IRS 0x1E・BS 0x16・TRN 0x35 ほか）を**印字文字として桁に置き**、長さの前置を持つ
 * 0x2B のオーダーを固定長で読んで、知らないオーダーで**帳票の残りを打ち切っていた**。
 *
 *   0x40 以上 … 印字文字（EBCDIC→Unicode）。DBCS は SO/SI で切り替え
 *   0x00 / 0x14 / 0x23 / 0x24 … Null（読み飛ばす）
 *   0x0D CR … 行頭へ / 0x25 LF … 次の行（桁はそのまま） / 0x15 NL・0x1E IRS … 次の行の頭
 *   0x0C FF … 改ページ / 0x0B VT … 垂直タブ（タブ位置を持たないので LF と同じ。ACS も停止位置が無ければ LF）
 *   0x16 BS … 1 桁戻る / 0x05 HT … 水平タブ（スタブ。タブ位置は未対応）
 *   0x34 PP … 位置決め（3 バイト） / 0x28 SA … 属性（3 バイト。読み飛ばす） / 0x04 VCS … 2 バイト
 *   0x08 GE … 2 バイト。ACS はグラフィック・エラー文字（既定 0x60＝`-`）を置く
 *   0x35 TRN … 透過（長さ＋本体。本体は文字として置く） / 0x03 ATRN … ASCII 透過（長さ＋本体。読み飛ばす）
 *   0x2B … オーダー（下の `skip2b`）
 *   0x06 RNL / 0x3A RFF / 0x09 SPS / 0x38 SBS / 0x36 NBS / 0x39 IT / 0x33 IR / 0x2F BEL … **ACS も何もしない**（1 バイト）
 *   それ以外の 0x40 未満 … 未定義の制御として 1 バイト読み飛ばす（印字しない）
 *   0xFF … 読み飛ばす（tn5250 由来。ACS は印字文字の範囲に入れる。未確認のまま据え置き）
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

// SCS 単バイト制御（ACS `PrintSCS5250` の表と同じ割り当て）
const NOOP = 0x00;
const ATRN = 0x03; // ASCII 透過（~~EBCDIC の透過~~ ではない）
const VCS = 0x04;
const HT = 0x05;
const GE = 0x08;
const VT = 0x0b;
const FF = 0x0c;
const CR = 0x0d;
const NL = 0x15;
const BS = 0x16;
const IRS = 0x1e;
const LF = 0x25;
const SA = 0x28;
const ORDER_2B = 0x2b;
const PP = 0x34;
const TRN = 0x35;
const IGNORE_FF = 0xff;
/** ACS の表で Null（読み飛ばすだけ） */
const NULLS = new Set([NOOP, 0x14, 0x23, 0x24]);
/** グラフィック・エラー文字の既定（ACS `GraphicErrorChar = 96`） */
const GRAPHIC_ERROR_BYTE = 0x60;

// PP（0x34）の副機能（scs.h）
const PP_RDPP = 0x4c; // 相対下移動（row += n）
const PP_AHPP = 0xc0; // 絶対水平（col = n）
const PP_AVPP = 0xc4; // 絶対垂直（row = n）
const PP_RRPP = 0xc8; // 相対右移動（col += n）

/** 長さの前置を持つ 0x2B のクラス（ACS の表: SHF・SVF・SLD・フォント選択・D2・STO・IGC・代替文字） */
const ORDERS_2B = new Set([0xc1, 0xc2, 0xc6, 0xd1, 0xd2, 0xd3, 0xfd, 0xfe]);

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
      if (NULLS.has(b) || b === IGNORE_FF) continue;
      switch (b) {
        case CR:
          col = 1;
          break;
        case NL:
        case IRS:
          row += 1;
          col = 1;
          break;
        case LF:
        case VT: // タブ位置を持たないので次の行へ（ACS も停止位置が無ければ LF）
          row += 1;
          break;
        case FF:
          flushPage();
          row = 1;
          col = 1;
          break;
        case BS:
          if (col > 1) col -= 1;
          break;
        case HT:
          break; // スタブ（水平タブ位置は未対応）
        case TRN: {
          // 透過: 長さ＋本体。本体は制御として読まずに文字として置く。**0x40 未満は空白にする**
          // （ACS `processTransparent` の TPO でない経路。TPO ならプリンターへ生で流すが、等幅の帳票には置けない）
          const count = next();
          if (count < 0) break;
          for (let k = 0; k < count; k++) {
            const rb = next();
            if (rb < 0) break;
            const shown = rb < 0x40 ? 0x40 : rb;
            put(String.fromCodePoint(this.codec.decodeByte(shown)), shown);
          }
          break;
        }
        case ATRN: {
          // ASCII 透過: 長さ＋本体。プリンターへ生で流すためのもので、等幅の帳票には置かない
          const count = next();
          for (let k = 0; k < count; k++) if (next() < 0) break;
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
        case SA:
          next(); // 属性の種類と値（2 バイト）は等幅の帳票では使わない
          next();
          break;
        case VCS:
          next();
          break;
        case GE:
          // グラフィック・エスケープ: 次の 1 バイトの代わりにグラフィック・エラー文字を置く（ACS `graphicEscape`）
          if (next() >= 0) put(String.fromCodePoint(this.codec.decodeByte(GRAPHIC_ERROR_BYTE)), GRAPHIC_ERROR_BYTE);
          break;
        case ORDER_2B:
          this.skip2b(next, () => i, (to) => (i = to));
          break;
        default:
          if (this.isDbcs && b === SO) {
            // SBCS モード: SO で DBCS モードへ
            dbcsMode = true;
            markShift("so");
          } else if (b >= 0x40) put(String.fromCodePoint(this.codec.decodeByte(b)), b);
          // それ以外の 0x40 未満は、ACS も何もしない制御（RNL・RFF ほか）か未定義の制御。印字しない
          break;
      }
    }

    flushPage();
    return pages;
  }

  /**
   * 0x2B のオーダーを読み飛ばす（ACS `PrintSCS5250` の表。`20260921-scs-controls-acs`）。
   * 幾何・フォントは等幅表示では使わないので、**同期のためにバイト数だけ**正しく消費する。
   *
   * - 表にあるクラス（C1 SHF・C2 SVF・C6 SLD・D1 フォント選択・D2 各種・D3 STO・FD IGC・FE 代替文字）は
   *   **クラスの次の 1 バイトが長さ**で、2B とクラスを含めて「長さ＋2」バイトを読む
   * - C8（SGEA）は 5 バイト固定
   * - **表に無いクラスは 0x2B の 1 バイトだけを読み飛ばす**（ACS は未定義の制御として扱い、次のバイトから読み直す）。
   *   ~~帳票の残りを打ち切る~~ と、知らないオーダーの後ろが全部消えていた
   *
   * ~~D1 のサブ 06（SCG）は 2B D1 06 01 の後ろを 2 バイト~~ だと、GCGID・CPGID の 4 バイトを取りこぼして
   * 同期がずれていた（長さ 06 どおりなら 8 バイト）。`read` は次の 1 バイト（EOF で -1）。
   */
  private skip2b(read: () => number, pos: () => number, seek: (to: number) => void): void {
    const at = pos(); // クラスの位置
    const cls = read();
    if (cls < 0) return;
    if (cls === 0xc8) {
      for (let k = 0; k < 3; k++) read(); // SGEA: 2B C8 と 3 バイト
      return;
    }
    if (!ORDERS_2B.has(cls)) {
      this.warn?.(`SCS: 未定義の 2B オーダー 0x${cls.toString(16)}（0x2B だけを読み飛ばす）`);
      seek(at); // 0x2B だけを捨てて、クラスのバイトから読み直す
      return;
    }
    const len = read(); // 長さ（自身を含み、2B とクラスを含まない）
    if (len < 0) return;
    for (let k = 0; k < len - 1; k++) if (read() < 0) return;
  }
}
