/**
 * `/api/host/dtaq/*`（送受信・作成・クリア・削除・属性）と、一覧の SQL 呼び出しを寄せる薄い層。
 *
 * **コンポーネントから直接 `fetch` しない**——呼び出しが画面に散ると、描画を通さないと
 * ロジックを検証できなくなる（`ifsApi.ts` と同じ方針）。
 *
 * 一覧だけは自前プロトコルに「全部覗く」操作が無いため **SQL サービス
 * `QSYS2.DATA_QUEUE_ENTRIES` を使う**（design 判断 3）。送受信・管理は自前プロトコル。
 */
import type { DtaqAttributes, DtaqSearchOrder } from "@as400web/core/browser";

export type DtaqEncoding = "utf8" | "base64" | "ebcdic";

/** サーバーが返すエラー本文 */
export interface DtaqError {
  error: string;
  code?: string;
}

export class DtaqRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: DtaqError
  ) {
    // **`message` に日本語化した文言を入れる**（ifsApi と同じ集約）。
    // UI が知らない code が 1 つでもあると、その経路だけ英語の生文言に落ちて不揃いになる。
    super(messageFor(body));
    this.name = "DtaqRequestError";
  }
}

/** `code` から利用者向けの文言を作る。KNOWN_ERROR_CODES と対で保つ */
export function messageFor(b: DtaqError): string {
  switch (b.code) {
    case "NOT_FOUND":
      return "対象のデータ待ち行列が見つかりません。名前・ライブラリーを確認してください。";
    case "ACCESS_DENIED":
      return "権限がありません。この操作は許可されていません。";
    case "ALREADY_EXISTS":
      return "同じ名前のデータ待ち行列が既にあります。";
    case "RESOURCE_BUSY":
      return "他の処理が対象を使用中です。時間をおいて再試行してください。";
    case "CONFIG_ERROR":
      // 入力の不整合（キー付きでないのにキー指定、不正な base64、KEYED の keyLength 欠落など）
      return b.error || "指定に誤りがあります。入力を確認してください。";
    default:
      // 知らない code はサーバーの文言をそのまま（英語のこともある。既知にすべきは上に足す）
      return b.error;
  }
}

/**
 * `messageFor` が日本語にするコードの一覧。
 * **テストが「サーバーが返しうる code をすべて網羅しているか」を確かめるための表**。
 * サーバーに新しい code を足したらここにも足す。
 */
export const KNOWN_ERROR_CODES = [
  "NOT_FOUND",
  "ACCESS_DENIED",
  "ALREADY_EXISTS",
  "RESOURCE_BUSY",
  "CONFIG_ERROR"
] as const;

export interface DtaqSource {
  /** `systemsStore.selected` をそのまま渡せるよう undefined を許す（未選択で呼ばれうる） */
  system?: string | undefined;
  session?: string | undefined;
}

/**
 * IBM i オブジェクト名として妥当か。
 *
 * **一覧の SQL では library/name を SQL 文字列リテラルに埋める**ため、埋める前に必ず通す。
 * 素通しすると `'` を含む名前でクエリを壊せる（SQL インジェクション）。
 * 通常名の文字集合（英数字と `$ # @ _ .`）と 10 文字上限に限る。
 */
const OBJECT_NAME = /^[A-Za-z0-9$#@_.]{1,10}$/u;
export function isValidObjectName(name: string): boolean {
  return OBJECT_NAME.test(name);
}
export function assertObjectName(kind: string, name: string): void {
  if (!isValidObjectName(name)) {
    throw new DtaqRequestError(400, {
      error: `${kind}が不正です（英数字と $ # @ _ . のみ、10 文字まで）`,
      code: "CONFIG_ERROR"
    });
  }
}

async function post(route: string, body: Record<string, unknown>): Promise<Response> {
  const res = await fetch(`/api/host/dtaq/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const parsed = (await res.json().catch(() => ({ error: res.statusText }))) as DtaqError;
    throw new DtaqRequestError(res.status, parsed);
  }
  return res;
}

export interface SendOptions {
  data: string;
  encoding?: DtaqEncoding;
  key?: string;
  keyEncoding?: DtaqEncoding;
}

export async function send(
  source: DtaqSource,
  library: string,
  name: string,
  opts: SendOptions
): Promise<void> {
  await post("send", { source, library, name, ...opts });
}

export interface ReceiveOptions {
  wait?: number;
  peek?: boolean;
  key?: string;
  keyEncoding?: DtaqEncoding;
  search?: DtaqSearchOrder;
  encoding?: DtaqEncoding;
}

/** 受信結果。空なら `entry` は null（エラーではない） */
export interface ReceiveResult {
  entry: { data: string; encoding: string; bytes: number; senderInfo?: string } | null;
}

export async function receive(
  source: DtaqSource,
  library: string,
  name: string,
  opts: ReceiveOptions = {}
): Promise<ReceiveResult> {
  const res = await post("receive", { source, library, name, ...opts });
  return (await res.json()) as ReceiveResult;
}

export interface CreateOptions {
  maxEntryLength: number;
  type: "FIFO" | "LIFO" | "KEYED";
  keyLength?: number;
  saveSender?: boolean;
  description?: string;
}

export async function create(
  source: DtaqSource,
  library: string,
  name: string,
  opts: CreateOptions
): Promise<void> {
  await post("create", { source, library, name, ...opts });
}

export async function clear(
  source: DtaqSource,
  library: string,
  name: string,
  key?: string,
  keyEncoding?: DtaqEncoding
): Promise<void> {
  await post("clear", {
    source,
    library,
    name,
    ...(key !== undefined ? { key, keyEncoding } : {})
  });
}

export async function deleteQueue(source: DtaqSource, library: string, name: string): Promise<void> {
  await post("delete", { source, library, name });
}

export async function attributes(
  source: DtaqSource,
  library: string,
  name: string
): Promise<DtaqAttributes> {
  const res = await post("attributes", { source, library, name });
  return (await res.json()) as DtaqAttributes;
}

/** 一覧の 1 件（SQL `DATA_QUEUE_ENTRIES` の 1 行） */
export interface DtaqListedEntry {
  position: number;
  /** best-effort の EBCDIC 解釈（非 EBCDIC は化ける。真値は hex を見る） */
  textEbcdic: string | null;
  bytes: number;
  /** 先頭 64 バイトの hex（符号化非依存の真値） */
  hex: string | null;
  enqueuedAt: string | null;
  sender: string | null;
}

/** 一覧で取る最大件数（巨大キュー対策） */
const LIST_LIMIT = 200;

/**
 * エントリを一覧する（**SQL サービス経由**・design 判断 3）。
 *
 * `DATA_QUEUE_ENTRIES` の text 列は CCSID の都合で best-effort（`MESSAGE_DATA`=EBCDIC）。
 * **サーバーの SQL デコーダは CCSID 1208(UTF-8) 列を扱えない**ので `MESSAGE_DATA_UTF8` は使わず、
 * EBCDIC 列＋HEX で返す。UTF-8/バイナリのエントリは受信（encoding 指定）で確認する。
 */
export async function listEntries(
  source: DtaqSource,
  library: string,
  name: string
): Promise<DtaqListedEntry[]> {
  // **SQL に埋める前に必ず検証**（インジェクション対策）
  assertObjectName("ライブラリー", library);
  assertObjectName("キュー名", name);
  const sql =
    "SELECT ORDINAL_POSITION AS POS, " +
    "CAST(MESSAGE_DATA AS VARCHAR(256)) AS DATA_EBCDIC, " +
    "LENGTH(MESSAGE_DATA_BINARY) AS BYTES, " +
    "HEX(CAST(MESSAGE_DATA_BINARY AS VARCHAR(64) FOR BIT DATA)) AS HEX64, " +
    "MESSAGE_ENQUEUE_TIMESTAMP AS ENQUEUED, " +
    "SENDER_JOB_NAME AS SENDER " +
    `FROM TABLE(QSYS2.DATA_QUEUE_ENTRIES(DATA_QUEUE_LIBRARY => '${library.toUpperCase()}', ` +
    `DATA_QUEUE => '${name.toUpperCase()}')) ` +
    `ORDER BY ORDINAL_POSITION FETCH FIRST ${LIST_LIMIT} ROWS ONLY`;
  const res = await fetch("/api/host/sql", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ source, sql, pageSize: LIST_LIMIT })
  });
  // **ok を先に見て、json は握って parse する**（post() と同じ）。
  // プロキシ等が非 JSON（HTML の 502/504）を返すと res.json() が投げ、生の SyntaxError が
  // 日本語文言を通らずに漏れる
  if (!res.ok) {
    const parsed = (await res.json().catch(() => ({ error: res.statusText }))) as DtaqError;
    throw new DtaqRequestError(res.status, {
      error: parsed.error ?? "一覧の取得に失敗しました",
      ...(parsed.code !== undefined ? { code: parsed.code } : {})
    });
  }
  const data = (await res.json().catch(() => ({ rows: [] }))) as {
    rows?: Record<string, unknown>[];
  };
  return (data.rows ?? []).map((r) => ({
    position: Number(r["POS"] ?? 0),
    textEbcdic: (r["DATA_EBCDIC"] as string | null) ?? null,
    bytes: Number(r["BYTES"] ?? 0),
    hex: (r["HEX64"] as string | null) ?? null,
    enqueuedAt: (r["ENQUEUED"] as string | null) ?? null,
    sender: (r["SENDER"] as string | null) ?? null
  }));
}

export type { DtaqAttributes };
