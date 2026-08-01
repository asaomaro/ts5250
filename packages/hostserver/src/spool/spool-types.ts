/**
 * スプールファイルの型。
 *
 * 一覧（コマンドサーバー経由）と中身取得（ネットワーク印刷サーバー）の**両方が使う**ため
 * 独立させてある。一覧の結果 `SpoolEntry` はそのまま中身取得へ渡せる（`SpoolId` を含む）。
 */

/** スプールを一意に指す識別子 */
export interface SpoolId {
  /** 例 "WEBEMU01" */
  jobName: string;
  /** 例 "USER" */
  jobUser: string;
  /** 例 "672961" */
  jobNumber: string;
  /** 例 "QPJOBLOG" */
  fileName: string;
  /** 同一ジョブ内での連番 */
  fileNumber: number;
}

/** 一覧で得られる情報 */
export interface SpoolEntry extends SpoolId {
  outputQueue: string;
  outputQueueLibrary: string;
  /** 例 "READY" / "HELD" / "WRITING" */
  status: string;
  /** 状態の生コード（IBM i の数値） */
  statusCode: number;
  totalPages: number;
  copiesLeft: number;
  userData: string;
  formType: string;
  jobSystemName: string;
  /** 例 "2026-07-18"（IBM i の CYYMMDD を変換したもの） */
  dateOpened: string;
  /** 例 "16.46.05" */
  timeOpened: string;
  /** バイト数（size × multiplier） */
  size: number;
  priority: string;
}

/**
 * 一覧の絞り込み。
 *
 * **各配列は最低 1 件必要**（0 件だと `GUI0011` / `GUI0012` で弾かれる）ため、
 * 未指定の項目には `*ALL` を入れて送る。
 */
export interface SpoolListFilter {
  /** 既定は `*CURRENT`（接続ユーザー） */
  user?: string;
  outputQueue?: string;
  outputQueueLibrary?: string;
  /** 例 "*READY" */
  status?: string;
  formType?: string;
  userData?: string;
}

/** 状態コード → 名前（IBM i の spooled file status） */
const STATUS_NAMES: ReadonlyMap<number, string> = new Map([
  [1, "READY"],
  [2, "OPEN"],
  [3, "CLOSED"],
  [4, "SAVED"],
  [5, "WRITING"],
  [6, "HELD"],
  [7, "MESSAGE_WAIT"],
  [8, "PENDING"],
  [9, "PRINTING"],
  [10, "FINISHED"],
  [11, "SENDING"],
  [12, "DEFERRED"]
]);

/** 状態コードを名前にする。未知のコードも情報を落とさない */
export function statusName(code: number): string {
  return STATUS_NAMES.get(code) ?? `UNKNOWN(${code})`;
}

/**
 * IBM i の CYYMMDD（世紀 1 桁 ＋ 年月日 6 桁）を ISO 形式にする。
 *
 * 世紀は 0 = 1900 年代、1 = 2000 年代。空欄なら空文字を返す。
 */
export function cyymmddToIso(cyymmdd: string): string {
  const t = cyymmdd.trim();
  if (t.length !== 7 || !/^\d{7}$/.test(t)) return "";
  const century = Number(t[0]) === 0 ? 1900 : 2000;
  const year = century + Number(t.slice(1, 3));
  return `${year}-${t.slice(3, 5)}-${t.slice(5, 7)}`;
}

/** HHMMSS を hh.mm.ss にする */
export function hhmmssToReadable(hhmmss: string): string {
  const t = hhmmss.trim();
  if (t.length !== 6 || !/^\d{6}$/.test(t)) return "";
  return `${t.slice(0, 2)}.${t.slice(2, 4)}.${t.slice(4, 6)}`;
}
