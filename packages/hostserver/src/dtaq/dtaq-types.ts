/**
 * データ待ち行列（DTAQ）の純粋な型。
 *
 * **ブラウザからも import される**（web-ui は `@as400web/core/browser` 経由でしか core を使えない）。
 * そのため、このファイルには `node:*` にも I/O にも依存するものを置かない——型だけに保つこと。
 */

/** キー検索の順序（プロトコルでは EBCDIC 2 バイト） */
export type DtaqType = "FIFO" | "LIFO" | "KEYED";

/** キー検索の順序（キー付きキューのみ） */
export type SearchOrder = "EQ" | "NE" | "LT" | "LE" | "GT" | "GE";

/** 受信の結果。空なら undefined として扱う（read が返さない） */
export interface DtaqEntry {
  /** エントリ本体（生バイト。CCSID 変換は呼び出し側の責務） */
  data: Uint8Array;
  /** 送信者情報 36 バイト（save sender 有効時。無効なら含まれない） */
  senderInfo?: Uint8Array;
}

/** キューの属性（属性取得 0x0001 → 0x8001 応答から解く） */
export interface DtaqAttributes {
  /** 最大エントリ長（バイト） */
  maxEntryLength: number;
  type: DtaqType;
  /** キー長（KEYED のときのみ 1 以上） */
  keyLength: number;
  /** 送信者情報を保存するか */
  saveSender: boolean;
}

export interface CreateOptions {
  name: string;
  library: string;
  /** 最大エントリ長（1〜64512） */
  maxEntryLength: number;
  type: DtaqType;
  /** キー長（KEYED のときのみ 1〜256） */
  keyLength?: number;
  /** 送信者情報を保存するか */
  saveSender?: boolean;
  description?: string;
}

export interface ReadOptions {
  name: string;
  library: string;
  /** 待機時間（秒）。-1 = 無限待ち / 0 = 待たない / 正 = 秒数 */
  wait: number;
  /** 消費せず覗くか */
  peek?: boolean;
  /** キー検索（キー付きキューのみ） */
  key?: Uint8Array;
  search?: SearchOrder;
}
