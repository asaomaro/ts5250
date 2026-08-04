/**
 * **メッセージ待ち行列から 1 件受け取る**（`QSYS/QMHRCVM`）。
 *
 * ## なぜプログラム呼び出しなのか
 *
 * `RCVMSG` は CL プログラムの中でしか使えない（`RMVMSG` と同じ制約——
 * `CPD0031「Command RCVMSG not allowed in this setting.」`）。
 * API の `QMHRCVM` は普通のプログラムなので、既存の呼び出し経路にそのまま乗る。
 *
 * ## **待つ**のがこの API の要点
 *
 * 待ち時間に正の秒数を渡すと、**届くまで無通信でブロックする**（実機で確認・2026-08-04）:
 *
 * ```
 * 空の待ち行列 / 待ち 4 秒 → **実測 4.0 秒**（返り 8 バイト＝何も無い）
 * 1 件ある     / 待ち 4 秒 → 実測 0.0 秒（返り 181 バイト）
 * ```
 *
 * ポーリングが要らない。`-1` で無限に待つ。
 *
 * ## 引数の並び（**実機で当てた**）
 *
 * ```
 * 0 メッセージ情報   char(*)   out
 * 1 その長さ         bin(4)    in
 * 2 形式名           char(8)   in   RCVM0200
 * 3 修飾名           char(20)  in   待ち行列(10) ＋ ライブラリー(10)
 * 4 **メッセージ種別** char(10) in
 * 5 **メッセージキー** char(4)  in
 * 6 **待ち時間**      bin(4)   in
 * 7 メッセージ動作   char(10)  in
 * 8 エラーコード     char(8)   inout
 * ```
 *
 * **踏んだ間違いを 2 つ残しておく:**
 *
 * 1. 待ち時間を種別の前に置くと `CPF24B3: Message type <空白 4 個>*ANY not valid`。
 *    **先頭の空白 4 個**が、直前の `bin(4)` を種別として読んでいる証拠だった
 * 2. キーを 0 埋めにすると `CPF2551`。**使わないときも空白（0x40）**
 */
import { As400Error } from "@ts5250/base";
import { codecForCcsid } from "@ts5250/ebcdic";
import type { ProgramParameter } from "./command-datastream.js";

/**
 * 取り出し方。**位置で選ぶものと種類で選ぶものは同じ欄**なので併用できない
 * （`*NEXT` しながら照会だけ、はホスト側では表現できない）。
 */
export type MessageSelector = "*ANY" | "*FIRST" | "*LAST" | "*NEXT" | "*PRV";

/**
 * 受け取ったあとメッセージをどうするか。
 *
 * **`*SAME` は状態を変えない**——待ち受けは観測であって消費ではない。
 * データ待ち行列の監視が「本番のコンシューマの取り分を奪う」のとは違い、
 * メッセージ待ち行列は読んでも減らせる／減らさないを選べる。
 */
export type MessageAction = "*SAME" | "*OLD" | "*REMOVE";

export interface ReceiveMessageSpec {
  /** 待ち行列名 */
  name: string;
  /** ライブラリー名 */
  library: string;
  selector: MessageSelector;
  /** `*NEXT` / `*PRV` の起点。**4 バイト**。省略時は空白（0 埋めではない） */
  key?: Uint8Array | undefined;
  /** 待ち時間（秒）。**負で無限** */
  wait: number;
  action?: MessageAction;
  /**
   * 受け取り域の大きさ（既定 4096）。
   *
   * **足りなくても失敗しない**——`bytesAvailable` が必要量を返し、本文は途中で切れる。
   * 実機の `QSYSOPR` で一番大きかったのは 2,001 バイト（`CPA3303`。二次レベル 1,645）。
   */
  bufferBytes?: number;
  ccsid: number;
}

/** メッセージ種別（`RCVM0200` の 2 桁コード） */
export const MESSAGE_TYPES: Record<string, string> = {
  "01": "COMPLETION",
  "02": "DIAGNOSTIC",
  "04": "INFORMATIONAL",
  "05": "INQUIRY",
  "06": "SENDERS_COPY",
  "08": "REQUEST",
  "10": "REQUEST_WITH_PROMPTING",
  "14": "NOTIFY",
  "15": "ESCAPE",
  "21": "REPLY_NOT_CHECKED",
  "22": "REPLY_CHECKED",
  "23": "REPLY_DEFAULT_USED",
  "24": "REPLY_FROM_LIST",
  "25": "REPLY_FROM_SYSTEM"
};

/** 照会（応答しないとジョブが止まったままになるもの） */
export const INQUIRY_TYPE = "05";

/**
 * 受け取った 1 件。**何も無かったときは `undefined`**（`parseReceivedMessage` が返す）。
 */
export interface ReceivedMessage {
  /** 8 桁 16 進のメッセージキー（`host-message.ts` の表記と揃える） */
  key: string;
  /** `CPA0000` 等。即時メッセージは空 */
  id: string;
  /** 2 桁コード（`MESSAGE_TYPES` の見出し語） */
  typeCode: string;
  /** 読める名前。未知のコードはコードそのもの */
  type: string;
  severity: number;
  /** 本文（読める形。置換データを埋めたもの） */
  text: string;
  /** 二次レベル（原因と回復方法）。無ければ空 */
  help: string;
  /** 器に収まらず切れたか */
  truncated: boolean;
  /** 照会か */
  inquiry: boolean;
}

/**
 * `RCVM0200` の固定部の大きさ。**実機で確定**（2026-08-04）——
 * 本文 3 / 10 / 40 バイトの即時メッセージで返りが 179 / 186 / 216 になり、
 * 差がちょうど本文長ぶんだった。`QSYSOPR` の実メッセージ 5 件でも
 * `176 ＋ 置換データ ＋ 本文 ＋ 二次レベル ＝ 返り` が成り立つ。
 *
 * 何も無いときの返りは **8**（見出しの 2 つの長さだけ）。
 */
const HEADER_BYTES = 176;

/**
 * `RCVM0200` の固定部の位置。
 *
 * **先頭 25 バイトは実機の hex で確認済み**（2026-08-04）:
 *
 * ```
 * 00 00 00 b5  00 00 00 b5  00 00 00 00  40×7        f0 f4  00 00 01 80
 * ↑返り 181    ↑利用可 181  ↑重大度 0    ↑ID 無し     ↑"04"  ↑キー
 * ```
 *
 * 長さの 3 組は `152` から並ぶ（**返った長さ / 使える長さ**の対）。
 * 可変部は `176` から**置換データ → 本文 → 二次レベル**の順。
 */
const OFF = {
  bytesReturned: 0,
  bytesAvailable: 4,
  severity: 8,
  id: 12,
  type: 19,
  key: 21,
  dataReturned: 152,
  messageReturned: 160,
  helpReturned: 168
} as const;

const bin4 = (v: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setInt32(0, v);
  return b;
};

/** EBCDIC で `n` 桁に空白詰め */
function padded(text: string, n: number, ccsid: number): Uint8Array {
  const codec = codecForCcsid(ccsid);
  const blank = codec.encode(" ").bytes[0] ?? 0x40;
  const out = new Uint8Array(n).fill(blank);
  const bytes = codec.encode(text).bytes;
  if (bytes.length > n) {
    throw new As400Error("CONFIG_ERROR", `${n} バイトに収まりません: ${JSON.stringify(text)}`);
  }
  out.set(bytes);
  return out;
}

/** `QMHRCVM` へ渡すパラメータ列を組む */
export function buildReceiveParams(spec: ReceiveMessageSpec): ProgramParameter[] {
  const size = spec.bufferBytes ?? 4096;
  if (size < HEADER_BYTES) {
    throw new As400Error("CONFIG_ERROR", `受け取り域は ${HEADER_BYTES} バイト以上必要です`);
  }
  // **キーは空白 4 バイト**（0 埋めは CPF2551）
  const key = spec.key ?? padded("", 4, spec.ccsid);
  if (key.length !== 4) {
    throw new As400Error("CONFIG_ERROR", `メッセージキーは 4 バイトです（${key.length} バイト）`);
  }
  return [
    { type: "out", length: size },
    { type: "in", data: bin4(size) },
    // **`RCVM0100` では駄目**——返るのは**置換データ**であって読める本文ではない。
    // 実機の `CPI1466` で `"SRBKUP    SUZUKI    081399"` が返り、
    // 「ロックのため〜」という本文は入っていなかった（2026-08-04）
    { type: "in", data: padded("RCVM0200", 8, spec.ccsid) },
    {
      type: "in",
      data: new Uint8Array([...padded(spec.name, 10, spec.ccsid), ...padded(spec.library, 10, spec.ccsid)])
    },
    { type: "in", data: padded(spec.selector, 10, spec.ccsid) },
    { type: "in", data: key },
    { type: "in", data: bin4(spec.wait) },
    { type: "in", data: padded(spec.action ?? "*SAME", 10, spec.ccsid) },
    // エラーコード。**0 = 例外をメッセージで返す**（`service-program.ts` と同じ約束）
    { type: "inout", data: new Uint8Array(8), length: 8 }
  ];
}

const hex = (b: Uint8Array): string => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/**
 * 受け取り域を読む。**何も無ければ `undefined`**。
 *
 * 本文の位置は**長さ項目から求める**（決め打ちしない）——
 * 置換データの長さは可変で、その分だけ本文が後ろへずれる。
 */
export function parseReceivedMessage(raw: Uint8Array | undefined, ccsid: number): ReceivedMessage | undefined {
  if (raw === undefined || raw.length < 8) return undefined;
  const view = new DataView(raw.buffer, raw.byteOffset, raw.length);
  const returned = view.getInt32(OFF.bytesReturned);
  // **固定部に届いていない＝何も無い**（待ち時間が尽きたとき。実機の返りは 8）
  if (returned < HEADER_BYTES) return undefined;
  const codec = codecForCcsid(ccsid);
  const dataLen = view.getInt32(OFF.dataReturned);
  const textLen = view.getInt32(OFF.messageReturned);
  const helpLen = view.getInt32(OFF.helpReturned);
  // **可変部は置換データ → 本文 → 二次レベルの順**。位置は長さから求める（決め打ちしない）
  const textAt = HEADER_BYTES + dataLen;
  const helpAt = textAt + textLen;
  /**
   * **即時メッセージは「置換データ」の側に本文が入る**（実機で確認・2026-08-04）。
   *
   * `SNDMSG MSG('...')` のようにメッセージファイルを使わないものは
   * メッセージ ID を持たず、`本文の長さ = 0 / 置換データの長さ = 打った文字数` になる。
   * 本文の欄だけを読むと**空文字になって、届いたことしか分からない**。
   *
   * ファイル由来のメッセージ（`CPI1466` など）は逆に、置換データが素の値
   * （`"SRBKUP    SUZUKI    081399"`）で、読める文は本文の欄にある。
   */
  const immediate = textLen === 0 && dataLen > 0;
  const typeCode = codec.decode(raw.subarray(OFF.type, OFF.type + 2)).trim();
  // **切れていても読めるだけ読む**（器より長い本文は器の端で止まる）
  const slice = (at: number, len: number): string =>
    at >= raw.length ? "" : codec.decode(raw.subarray(at, Math.min(at + len, raw.length))).trimEnd();
  return {
    key: hex(raw.subarray(OFF.key, OFF.key + 4)),
    id: codec.decode(raw.subarray(OFF.id, OFF.id + 7)).trim(),
    typeCode,
    type: MESSAGE_TYPES[typeCode] ?? typeCode,
    severity: view.getInt32(OFF.severity),
    text: immediate ? slice(HEADER_BYTES, dataLen) : slice(textAt, textLen),
    help: slice(helpAt, helpLen),
    inquiry: typeCode === INQUIRY_TYPE,
    truncated: view.getInt32(OFF.bytesAvailable) > returned
  };
}

/** 8 桁 16 進のキーを 4 バイトへ（`host-message.ts` の表記と往復する） */
export function messageKeyToBytes(key: string): Uint8Array {
  if (!/^[0-9a-fA-F]{8}$/u.test(key)) {
    throw new As400Error("CONFIG_ERROR", `メッセージキーは 16 進 8 桁です: ${JSON.stringify(key)}`);
  }
  const out = new Uint8Array(4);
  for (let i = 0; i < 4; i++) out[i] = Number.parseInt(key.slice(i * 2, i * 2 + 2), 16);
  return out;
}
