import { codecForCcsid, SO, SI, type Codec } from "@ts5250/ebcdic";

/**
 * SCS（SNA Character String）デコーダ。プリンターセッションでホストから届く印刷データを
 * 論理ページ（等幅グリッド）に展開する。
 *
 * **制御の表は ACS の Java 印刷（JPS）経路に合わせる**（`PrintSCS5250JPS` の `scs_proc`。`20260921-scs-controls-acs`）。
 * ACS は HPT を使わないとき、**既定で JPS 経路**で SCS を読む（`PD5250.getPrintHostDataIndex`: `jpsUse` の既定 true・
 * Windows では `usePDT` の既定 false）。~~PDT 経路（`PrintSCS5250` / `PrintSCS5250DB`）~~ に合わせた最初の版は、
 * GE・BS・TRN・HT・SGEA・2B CA / D4 の扱いが既定の経路と違った（独立点検の指摘）。
 * ~~tn5250 lib5250/scs.c の制御セット~~ はさらに違い、表に無い制御を印字文字として桁に置き、0x03 を EBCDIC の透過として
 * 読み、知らない 2B のオーダーで帳票の残りを打ち切っていた。
 *
 *   0x40 以上 … 印字文字（EBCDIC→Unicode）。DBCS は SO/SI で切り替え
 *   0x0D CR … 行頭へ / 0x25 LF・0x0B VT … 次の行（桁はそのまま。JPS の VT は LF） / 0x15 NL・0x1E IRS … 次の行の頭
 *   0x0C FF … 改ページ / 0x05 HT … 1 桁の空白（JPS の HT は空白 1 つ）
 *   0x0E SO / 0x0F SI … DBCS の切り替え。**空白を書かずに位置を進める**（SPCC。`spcc` の注記）
 *   0x34 PP … 位置決め（3 バイト） / 0x28 SA … 属性（3 バイト。読み飛ばす） / 0x04 VCS … 2 バイト（JPS は何もしない）
 *   0x08 GE … 2 バイト（JPS は何も置かない） / 0x16 BS … 何もしない（JPS）
 *   0x35 TRN … 透過（長さ＋本体。本体は 1 バイトごとに 0x40 なら空白、ほかは `-`。代替文字は未対応）
 *   0x03 ATRN … ASCII 透過（長さ＋本体。プリンターへ生で流すもので、帳票には置かない）
 *   0x2B … オーダー（下の `skip2b`）
 *   上に無い 0x40 未満（Null・RNL・RFF・BEL・IR・NBS・SBS・SPS・IT・RPT・ENP・INP・UBS・WUS・SW・SUB ほか）… 1 バイト読み飛ばす
 *   0xFF … 読み飛ばす（tn5250 由来。JPS は印字文字の範囲に入れる。未確認のまま据え置き）
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
   * SO/SI が現れた位置（1 起点）と、占める桁の数（`ShiftMark.width`）。**占めるときはその桁の頭**、占めないときは直後に来る桁。
   *
   * **SO/SI は ACS と同じく既定で 1 桁ずつ空白として占める**（`PrintSCS5250DB.shiftOut` / `shiftIn`。
   * `20260921-scs-sosi-columns`）。ホストが `2B FD .. 03`（SPCC）で「占めない」「SI だけ 2 桁」に切り替えられる。
   * ~~SO/SI 自身は桁を占めない（この復号器は昔からシフトで桁を進めない）~~——PUB400 の帳票で桁が揃って見えることを
   * 根拠にした決定（`20260728-scs-dbcs-column-align` D1）で、ACS の描き方と違った。
   *
   * **SO/SI 表示のために持つ。** 印をどう描くかは描く側の判断なので、ここでは位置だけを渡す。
   */
  shifts?: ShiftMark[][];
}

/** SO/SI の位置（`LogicalPage.shifts`） */
export interface ShiftMark {
  /** SO/SI が占める桁の頭（占めないときは直後に来る桁。1 起点） */
  col: number;
  /** SO/SI が占める桁の数（SPCC により 0 / 1 / 2）。印を桁の中に描くか、境目に描くかの判断に使う */
  width: number;
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


// PP（0x34）の副機能（scs.h）
const PP_RDPP = 0x4c; // 相対下移動（row += n）
const PP_AHPP = 0xc0; // 絶対水平（col = n）
const PP_AVPP = 0xc4; // 絶対垂直（row = n）
const PP_RRPP = 0xc8; // 相対右移動（col += n）

/** 長さの前置を持つ 0x2B のクラス（ACS JPS の表: SHF・SVF・SLD・SGEA・EPMP・D1・D2・D3・下線と重ね打ち・IGC・代替文字） */
const ORDERS_2B = new Set([0xc1, 0xc2, 0xc6, 0xc8, 0xca, 0xd1, 0xd2, 0xd3, 0xd4, 0xfd, 0xfe]);

const MAX_ROW = 32767; // 暴走データでの過大確保を防ぐ安全上限
const MAX_COL = 32767;

export class ScsDecoder {
  private readonly codec: Codec;
  private readonly isDbcs: boolean;

  /**
   * **SO/SI の描き方**（ACS `m_spccBehavior`。既定 1）: 0 = 桁を占めない / 1 = SO・SI とも 1 桁 /
   * 2 = SO は占めず SI が 2 桁（負の値は SO が 0・SI が 1）。ホストが `2B FD .. 03` で切り替える
   * （日本語機の帳票は `2B FD 04 03 00 01`＝1 を送ってきた）。**ジョブをまたいで残す**——ACS は印刷の
   * セッションごとに 1 回だけ初期化する（プリンターセッションは 1 つのデコーダーで全ジョブを読む）。
   */
  private spcc = 1;

  constructor(ccsid: number, private readonly warn?: (msg: string) => void) {
    this.codec = codecForCcsid(ccsid);
    this.isDbcs = this.codec.isDbcs;
  }

  /**
   * 1 ジョブ分の SCS バイト列を論理ページ列にデコードする。ジョブ境界（Job Complete）は
   * 呼び出し側（PrinterSession）が切って渡す。知らない 2B のオーダーは 0x2B だけ読み飛ばして続ける。
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
    /**
     * その桁に**すでに字がある**か（継続桁の空文字列も、全角の字の一部なので占有）。**空白は下の字を消さない**ために使う。
     */
    const occupied = (r: number, c: number): boolean => {
      const v = grid[r - 1]?.[c - 1];
      return v !== undefined && v !== " ";
    };
    const put = (ch: string, rawByte?: number): void => {
      if (row < 1 || col < 1 || row > MAX_ROW || col > MAX_COL) return;
      cellAt(col);
      // **空白（0x40）は下の字を消さない**——ACS の JPS は 1 字ずつ `drawString` するだけで何も消さず、空白は「空白のグリフを 1 桁ぶん描く」だけ。
      // CR で戻って同じ行へ重ね書きするとき、2 度目の空白は下の字の上を通り過ぎるだけ（`ABCDEF` CR `␠␠␠XY` は `ABCXYF`）。
      // `20260921-scs-blank-overprint`。書かないので、生バイトも下の字のまま残る。位置と `maxCol` は従来どおり進める
      if (!(ch === " " && occupied(row, col))) {
        grid[row - 1]![col - 1] = ch;
        // 生バイトは SBCS の桁にだけ残す（読み直せるのはこれだけ）
        (rawGrid[row - 1] ??= [])[col - 1] = rawByte;
      }
      if (row > maxRow) maxRow = row;
      if (col > maxCol) maxCol = col;
      col += 1;
    };
    // 全角グリフ（2 桁を占める）。後半桁は継続（空文字列）にして join で桁を保つ
    const putWide = (ch: string): void => {
      if (row < 1 || col < 1 || row > MAX_ROW || col + 1 > MAX_COL) return;
      cellAt(col + 1);
      // 全角空白も同じ（下の字を消さない）。下が半角 1 字だけでも、2 桁のどちらかに字があれば書かない
      if (!(ch === "\u3000" && (occupied(row, col) || occupied(row, col + 1)))) {
        grid[row - 1]![col - 1] = ch;
        grid[row - 1]![col] = ""; // 継続桁
      }
      if (row > maxRow) maxRow = row;
      if (col + 1 > maxCol) maxCol = col + 1;
      col += 2;
    };
    /**
     * SO/SI を記録し、**空白を書かずに位置を `width` 桁進める**（ACS `JPSShiftOut` / `JPSShiftIn` は `setX` で
     * 進めるだけ）。書かないので、CR で戻った重ね打ちの行で下の字を消さず、SO/SI だけのページも作らない。
     */
    const shift = (kind: "so" | "si", width: number): void => {
      if (row >= 1 && col >= 1 && row <= MAX_ROW && col <= MAX_COL) (shiftGrid[row - 1] ??= []).push({ col, kind, width });
      col += width;
    };
    /** SO・SI の桁数（ACS `JPSShiftOut(spcc == 1)` / `JPSShiftIn(spcc != 0, spcc == 2)`） */
    const soWidth = (): number => (this.spcc === 1 ? 1 : 0);
    const siWidth = (): number => (this.spcc === 0 ? 0 : this.spcc === 2 ? 2 : 1);

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
      // SI で SBCS へ戻る。**冗長な SO も毎回位置を進める**（ACS の JPS は状態に関わらず SO/SI を処理する）。
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
          shift("si", siWidth());
          continue;
        }
        if (b === SO) {
          shift("so", soWidth()); // 冗長な SO（~~読み飛ばす~~。ACS は毎回進める）
          continue;
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
        case VT: // JPS の VT は LF（`JPSVerticalTab extends JPSLineFeed`）
          row += 1;
          break;
        case FF:
          flushPage();
          row = 1;
          col = 1;
          break;
        case BS:
          break; // JPS の `processBackSpace` は何もしない（~~1 桁戻る~~ は PDT 経路）
        case HT:
          col += 1; // JPS の HT は空白 1 つ（`JPSHorizontalTab extends JPSSpace`。タブ位置は見ない）
          break;
        case TRN: {
          // 透過: 長さ＋本体。本体は 1 バイトごとに **0x40 なら空白、ほかは `-`**（JPS `processTransparent`。
          // 代替文字を読み込んでいればその字だが、2B FE は未対応）。~~文字として置く~~ は PDT の TPO でない経路の近似だった
          const count = next();
          if (count < 0) break;
          for (let k = 0; k < count; k++) {
            const rb = next();
            if (rb < 0) break;
            if (rb === 0x40) col += 1;
            else put("-");
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
          next(); // JPS は何もしない（チャネルの番号を読むだけ）
          break;
        case GE:
          next(); // JPS は何も置かない（~~グラフィック・エラー文字 `-`~~ は PDT 経路）
          break;
        case ORDER_2B:
          this.skip2b(next, () => i, (to) => (i = to), (v) => (this.spcc = v));
          break;
        default:
          if (this.isDbcs && b === SO) {
            // SBCS モード: SO で DBCS モードへ（既定では 1 桁進める）
            dbcsMode = true;
            shift("so", soWidth());
          } else if (this.isDbcs && b === SI) {
            // **SBCS の状態で来た SI も位置を進める**（ACS の JPS は状態を見ない。日本語機の DSPLIBL の先頭にある）
            shift("si", siWidth());
          } else if (b >= 0x40) put(String.fromCodePoint(this.codec.decodeByte(b)), b);
          // それ以外の 0x40 未満は、ACS も何もしない制御（RNL・RFF ほか）か未定義の制御。印字しない
          break;
      }
    }

    flushPage();
    return pages;
  }

  /**
   * 0x2B のオーダーを読み飛ばす（ACS `PrintSCS5250JPS` の表。`20260921-scs-controls-acs`）。
   * 幾何・フォントは等幅表示では使わないので、**同期のためにバイト数だけ**正しく消費する。
   *
   * - 表にあるクラス（C1 SHF・C2 SVF・C6 SLD・C8 SGEA・CA EPMP・D1・D2・D3・D4 下線と重ね打ち・FD・FE）は
   *   **クラスの次の 1 バイトが長さ**で、2B とクラスを含めて「長さ＋2」バイトを読む。~~C8 は 5 バイト固定~~・
   *   ~~CA / D4 は表に無い~~ は PDT 経路の表だった
   * - **表に無いクラスは 0x2B の 1 バイトだけを読み飛ばす**（ACS は未定義の制御として扱い、次のバイトから読み直す）。
   *   ~~帳票の残りを打ち切る~~ と、知らないオーダーの後ろが全部消えていた
   *
   * `2B FD .. 03` は SO/SI の描き方（SPCC）で、`setSpcc` へ渡す。`read` は次の 1 バイト（EOF で -1）。
   */
  private skip2b(read: () => number, pos: () => number, seek: (to: number) => void, setSpcc: (v: number) => void): void {
    const at = pos(); // クラスの位置
    const cls = read();
    if (cls < 0) return;
    if (!ORDERS_2B.has(cls)) {
      this.warn?.(`SCS: 未定義の 2B オーダー 0x${cls.toString(16)}（0x2B だけを読み飛ばす）`);
      seek(at); // 0x2B だけを捨てて、クラスのバイトから読み直す
      return;
    }
    const len = read(); // 長さ（自身を含み、2B とクラスを含まない）
    if (len < 0) return;
    // 長さ 0 のとき ACS は 2 バイトだけ進めて長さのバイトを次の制御（Null）として読むが、結果は同じなので 3 バイト読む
    if (cls === 0xfd && len >= 2) {
      // **2B FD .. 03 は SO/SI の描き方（SPCC）**（ACS `processSetPresentationControlCharacter`）。
      // 長さは 2 か 4 だけを受け、4 なら続く 2 バイトを**符号付き**で値とし（2 を超えたら既定の 1）、2 なら値なしで 1。
      // それ以外の長さは受けない（ACS は変えない）
      const sub = read();
      if (sub < 0) return;
      if (sub === 0x03 && (len === 2 || len === 4)) {
        let v = 1;
        if (len === 4) {
          const hi = read(), lo = read();
          if (hi < 0 || lo < 0) return;
          v = ((hi << 8) | lo) << 16 >> 16; // ACS の `makeWord` は short
          if (v > 2) v = 1;
        }
        setSpcc(v);
        return;
      }
      for (let k = 0; k < len - 2; k++) if (read() < 0) return;
      return;
    }
    for (let k = 0; k < len - 1; k++) if (read() < 0) return;
  }
}
