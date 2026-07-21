/**
 * ZIP を組む。**IFS を知らない**——名前とバイト列の配列を受けて ZIP のバイト列を返すだけ。
 *
 * 依存を増やさず `node:zlib` で書く。この PJ は 5250 データストリームやホストサーバー
 * プロトコルを自前で起こしており、ZIP の容器はそれより単純（局所ヘッダ → データ →
 * セントラルディレクトリ → 終端レコード）。
 *
 * **非対応と決めていること**:
 * - **zip64**。4GB 超のアーカイブや 65,535 件超のエントリは作れない。
 *   **上限は `buildZip` 自身が検査する**——呼び出し側の設定だけに頼ると、
 *   ヘッダやセントラルディレクトリの分でデータが上限内でもアーカイブが 4GB を超え、
 *   `setUint32` が黙って剰余を取って壊れた ZIP を返す
 * - データ記述子（ストリーミング用の後置ヘッダ）。全バイトが手元にあるので不要
 * - 暗号化・分割アーカイブ
 *
 * 仕様: PKWARE APPNOTE 6.3.x の 4.3.7（局所ヘッダ）/ 4.3.12（セントラルディレクトリ）/
 * 4.3.16（終端レコード）。
 */
import { deflateRawSync } from "node:zlib";

/** ZIP に入れる 1 件 */
export interface ZipEntry {
  /** アーカイブ内のパス。`/` 区切り。先頭に `/` を付けない */
  path: string;
  data: Uint8Array;
  /** 更新日時。省略時は MS-DOS 形式の最小値（1980-01-01） */
  modifiedAt?: Date;
}

/** 格納（無圧縮） */
const METHOD_STORE = 0;
/** deflate */
const METHOD_DEFLATE = 8;
/**
 * 汎用フラグの bit 11。**ファイル名が UTF-8 であることを示す**。
 * 立てないと、展開側が OEM コードページとして解釈して非 ASCII 名が化ける。
 */
const FLAG_UTF8 = 0x800;
/** 展開に必要な最小バージョン（2.0 = deflate をサポート） */
const VERSION_NEEDED = 20;
/**
 * アーカイブ全体の上限。**zip64 非対応なので 32 ビットのオフセットに収まる必要がある。**
 * 超えると `setUint32` が黙って 2^32 で巻き戻り、例外なく壊れた ZIP が返る。
 */
const MAX_ARCHIVE_BYTES = 0xffffffff;

const CRC_TABLE = buildCrcTable();

function buildCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    // 生成多項式 0xEDB88320（IEEE 802.3 の反転表現）
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
}

export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    c = (CRC_TABLE[(c ^ (data[i] as number)) & 0xff] as number) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** MS-DOS 形式で表せる年の範囲。7 ビットしか無いので 1980+127 が上端 */
const DOS_MIN_YEAR = 1980;
const DOS_MAX_YEAR = 2107;
/** 1980-01-01 00:00:00 */
const DOS_EPOCH = { date: (1 << 5) | 1, time: 0 };

/**
 * MS-DOS 形式の日時に変換する。
 * 秒は 2 秒単位、年は 1980 年起点。
 *
 * **範囲外は下限に丸める。** 上端を素通しすると `(year - 1980) << 9` が
 * `setUint16` で切り捨てられ、2108 年が 1980 年に「化ける」（下限だけ守っても片手落ち）。
 */
function dosDateTime(at: Date): { date: number; time: number } {
  const year = at.getFullYear();
  if (year < DOS_MIN_YEAR || year > DOS_MAX_YEAR) return DOS_EPOCH;
  const date = ((year - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate();
  const time = (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1);
  return { date, time };
}

interface Placed {
  nameBytes: Uint8Array;
  compressed: Uint8Array;
  method: number;
  crc: number;
  rawSize: number;
  offset: number;
  date: number;
  time: number;
}

/** ZIP のバイト列を組み立てる */
export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  if (entries.length > 0xffff) {
    // zip64 非対応。ここを黙って通すと、終端レコードの件数が溢れて壊れた ZIP になる
    throw new RangeError(`too many entries for a non-zip64 archive: ${entries.length}`);
  }
  // **確保する前に見積もって落とす。** 実際に組んでから気づくと、
  // 4GB 分の中間バッファを確保しようとして先に OOM する
  const estimated = entries.reduce(
    (n, e) => n + 30 + 46 + new TextEncoder().encode(e.path).length * 2 + e.data.length,
    22
  );
  if (estimated > MAX_ARCHIVE_BYTES) {
    throw new RangeError(`archive too large for a non-zip64 zip: about ${estimated} bytes`);
  }

  const placed: Placed[] = [];
  const chunks: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = new TextEncoder().encode(entry.path);
    const raw = entry.data;
    const deflated = deflateRawSync(raw);
    // **圧縮して大きくなるなら格納に落とす**（乱数や既圧縮のデータで起きる）
    const useDeflate = deflated.length < raw.length;
    const compressed = useDeflate ? new Uint8Array(deflated) : raw;
    const { date, time } = dosDateTime(entry.modifiedAt ?? new Date(0));
    const item: Placed = {
      nameBytes,
      compressed,
      method: useDeflate ? METHOD_DEFLATE : METHOD_STORE,
      crc: crc32(raw),
      rawSize: raw.length,
      offset,
      date,
      time
    };
    placed.push(item);

    const header = new Uint8Array(30 + nameBytes.length);
    const v = new DataView(header.buffer);
    v.setUint32(0, 0x04034b50, true); // PK\x03\x04
    v.setUint16(4, VERSION_NEEDED, true);
    v.setUint16(6, FLAG_UTF8, true);
    v.setUint16(8, item.method, true);
    v.setUint16(10, time, true);
    v.setUint16(12, date, true);
    v.setUint32(14, item.crc, true);
    v.setUint32(18, compressed.length, true);
    v.setUint32(22, raw.length, true);
    v.setUint16(26, nameBytes.length, true);
    v.setUint16(28, 0, true); // 拡張フィールド長
    header.set(nameBytes, 30);

    chunks.push(header, compressed);
    offset += header.length + compressed.length;
  }

  const centralStart = offset;
  for (const item of placed) {
    const record = new Uint8Array(46 + item.nameBytes.length);
    const v = new DataView(record.buffer);
    v.setUint32(0, 0x02014b50, true); // PK\x01\x02
    v.setUint16(4, VERSION_NEEDED, true); // 作成バージョン
    v.setUint16(6, VERSION_NEEDED, true); // 展開に必要なバージョン
    v.setUint16(8, FLAG_UTF8, true);
    v.setUint16(10, item.method, true);
    v.setUint16(12, item.time, true);
    v.setUint16(14, item.date, true);
    v.setUint32(16, item.crc, true);
    v.setUint32(20, item.compressed.length, true);
    v.setUint32(24, item.rawSize, true);
    v.setUint16(28, item.nameBytes.length, true);
    v.setUint16(30, 0, true); // 拡張フィールド長
    v.setUint16(32, 0, true); // コメント長
    v.setUint16(34, 0, true); // 分割番号
    v.setUint16(36, 0, true); // 内部属性
    v.setUint32(38, 0, true); // 外部属性
    v.setUint32(42, item.offset, true);
    record.set(item.nameBytes, 46);
    chunks.push(record);
    offset += record.length;
  }

  // 見積もりを抜けても、実際の値で最終確認する（防波堤は 2 枚）
  if (offset > MAX_ARCHIVE_BYTES) {
    throw new RangeError(`archive too large for a non-zip64 zip: ${offset} bytes`);
  }

  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); // PK\x05\x06
  ev.setUint16(4, 0, true); // このディスクの番号
  ev.setUint16(6, 0, true); // セントラルディレクトリの開始ディスク
  ev.setUint16(8, placed.length, true);
  ev.setUint16(10, placed.length, true);
  ev.setUint32(12, offset - centralStart, true);
  ev.setUint32(16, centralStart, true);
  ev.setUint16(20, 0, true); // コメント長
  chunks.push(end);

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
