/**
 * `/api/host/ifs/*` を呼ぶ薄い層。
 *
 * **コンポーネントから直接 `fetch` しない**ためにここへ寄せる。
 * 呼び出しが画面の中に散ると、描画を通さないとロジックを検証できなくなる。
 *
 * ここは応答をそのまま返し、解釈はしない（解釈は composable の仕事）。
 */
import type { IfsEntry, IfsListResult, LineEnding } from "@as400web/core/browser";

/** サーバーが返すエラー本文 */
export interface IfsError {
  error: string;
  code?: string;
  /** 上限超過のとき、打ち切った時点の集計（総数ではない） */
  files?: number;
  bytes?: number;
  directories?: number;
  maxFiles?: number;
  maxBytes?: number;
  partial?: boolean;
  /** 一覧を辿り切れなかったディレクトリ */
  path?: string;
  /** 削除の対象数（上限超過のとき） */
  entries?: number;
  max?: number;
}

export class IfsRequestError extends Error {
  constructor(
    readonly status: number,
    readonly body: IfsError
  ) {
    // **`message` に日本語化した文言を入れる。**
    // すべてのエラー経路がこれを使う（一覧・プレビュー・操作）。ここに集約するのは、
    // サーバーが返す `code` のうち UI が知らないものが 1 つでもあると、その経路だけ
    // `body.error`（core の英語生文言 `File not found (rc=2)`）に落ちて不揃いになるため。
    // 統合テストで実際に `NOT_FOUND` / `ACCESS_DENIED` の日本語化漏れが見つかった。
    super(messageFor(body));
    this.name = "IfsRequestError";
  }
}

/** `code` から利用者向けの文言を作る。knownCodes と対で保つ */
export function messageFor(b: IfsError): string {
  switch (b.code) {
    case "NOT_FOUND":
      return "対象が見つかりません。すでに削除されたか、名前が変わった可能性があります。";
    case "ACCESS_DENIED":
      return "権限がありません。この操作は許可されていません。";
    case "RESOURCE_BUSY":
      // 02-D1 が「権限が無い」と分けてまで作ったコード。
      // 「時間をおいて再試行できる」を UI が言わないと、その決定の価値が届かない
      return "他の処理が対象を使用中です。時間をおいて再試行してください。";
    case "ALREADY_EXISTS":
      return "同じ名前のものが既にあります。";
    case "INCOMPLETE_LISTING":
      return `${b.path ?? "このフォルダ"} の一覧を最後まで取得できないため、まとめてダウンロードできません。個別に取得してください。`;
    case "TOO_MANY_DIRECTORIES":
      return `フォルダの数が多すぎます（${b.directories} 個以上）。対象を絞ってください。`;
    case "TOO_LARGE": {
      const size = b.bytes !== undefined ? `${(b.bytes / 1024 / 1024).toFixed(1)} MB 以上` : "";
      const count = b.files !== undefined ? `${b.files} ファイル以上 / ` : "";
      return `対象が大きすぎます（${count}${size}）。対象を絞るか、個別に取得してください。`;
    }
    case "NOT_EMPTY":
      return "フォルダの中身が残っています。中身ごと削除するか、先に中身を消してください。";
    case "TOO_MANY":
      return `対象が多すぎます（${b.entries ?? "?"} 件以上 / 上限 ${b.max ?? "?"} 件）。対象を絞ってください。`;
    case "INVALID_NAME":
      return "名前にパス区切り（/）は使えません。";
    case "UNSUPPORTED_CCSID":
      return "この文字コードには対応していません。別の文字コードを選んでください。";
    case "DECODE_FAILED":
      return "選んだ文字コードでは読めませんでした。別の文字コードを選んでください。";
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
  "RESOURCE_BUSY",
  "ALREADY_EXISTS",
  "INCOMPLETE_LISTING",
  "TOO_MANY_DIRECTORIES",
  "TOO_LARGE",
  "UNSUPPORTED_CCSID",
  "DECODE_FAILED",
  "NOT_EMPTY",
  "TOO_MANY",
  "INVALID_NAME"
] as const;

/**
 * 読み取りの結果。
 *
 * **`content` が null でもエラーではない**——読み取りは成功していて、
 * 表示手段が無いだけ（サーバーは 200 で `code: "UNSUPPORTED_ENCODING"` を返す）。
 */
export interface IfsReadResult {
  content: string | null;
  bytes: number;
  encoding: "utf8" | "base64" | null;
  /** 採用した文字コード（テキストとして読めたときだけ） */
  ccsid?: number;
  /** 何を根拠に選んだか。`content` = 中身から推定、`tag` = ファイルのタグ、`manual` = 利用者の指定 */
  detectedBy?: "content" | "tag" | "manual";
  /** 元のファイルの行末。保存時にそのまま返す */
  newline?: LineEnding;
  /** BOM が付いていた。保存時にそのまま返す */
  bom?: boolean;
  /**
   * ファイルに付いていた CCSID タグ。**採用した文字コードとは限らない**——
   * 中身の推定が優先されるため（UTF-8 の内容に 850 のタグが付く）。読めなかったときも返る
   */
  tagCcsid?: number;
  code?: string;
}

async function post(route: string, body: Record<string, unknown>): Promise<Response> {
  const res = await fetch(`/api/host/ifs/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const parsed = (await res.json().catch(() => ({ error: res.statusText }))) as IfsError;
    throw new IfsRequestError(res.status, parsed);
  }
  return res;
}

export interface IfsSource {
  /** `systemsStore.selected` をそのまま渡せるよう undefined を許す（未選択のまま呼ばれうる） */
  system?: string | undefined;
  session?: string | undefined;
}

export interface ListOptions {
  maxCount?: number;
  restartId?: number;
}

export async function listFiles(
  source: IfsSource,
  path: string,
  opts: ListOptions = {}
): Promise<IfsListResult> {
  const res = await post("list", { source, path, ...opts });
  return (await res.json()) as IfsListResult;
}

export async function readFile(
  source: IfsSource,
  path: string,
  encoding: "utf8" | "base64" = "utf8",
  /** 自動判定（中身 → タグ）が外れたときに、利用者が選んだ文字コード */
  ccsid?: number
): Promise<IfsReadResult> {
  const res = await post("read", {
    source,
    path,
    encoding,
    ...(ccsid !== undefined ? { ccsid } : {})
  });
  return (await res.json()) as IfsReadResult;
}

/** 保存の追加指定。**読んだときの値をそのまま返す**と、元のファイルの流儀のまま書き戻せる */
export interface WriteTextOptions {
  ccsid?: number;
  newline?: LineEnding;
  bom?: boolean;
}

export async function writeFile(
  source: IfsSource,
  path: string,
  content: string,
  encoding: "utf8" | "base64" = "utf8",
  opts: WriteTextOptions = {}
): Promise<{ bytes: number; substituted?: number }> {
  const res = await post("write", {
    source,
    path,
    content,
    encoding,
    ...(opts.ccsid !== undefined ? { ccsid: opts.ccsid } : {}),
    ...(opts.newline !== undefined ? { newline: opts.newline } : {}),
    ...(opts.bom !== undefined ? { bom: opts.bom } : {})
  });
  return (await res.json()) as { bytes: number; substituted?: number };
}

export async function makeDirectory(source: IfsSource, path: string): Promise<void> {
  await post("mkdir", { source, path });
}

/** 削除の結果。**種別の判断はサーバー側**なので、UI は消えた件数だけを見る */
export interface IfsDeleteResult {
  files: number;
  directories: number;
}

/**
 * 削除。フォルダも同じ口で消す（種別はサーバーが判定する）。
 *
 * `recursive` を付けないとフォルダは**空のときだけ**消え、中身があれば `NOT_EMPTY` で返る。
 */
export async function deleteFile(
  source: IfsSource,
  path: string,
  opts: { recursive?: boolean } = {}
): Promise<IfsDeleteResult> {
  const res = await post("delete", {
    source,
    path,
    ...(opts.recursive !== undefined ? { recursive: opts.recursive } : {})
  });
  return (await res.json()) as IfsDeleteResult;
}

/**
 * 削除の規模を先に数える（**まだ消さない**）。確認ダイアログに件数を出すために使う。
 *
 * 上限を超えている場合は**エラーではなく `blocked`** で返る——「消せない」という事実であって、
 * 通信の失敗ではないため。
 */
export interface IfsDeletePlan {
  files?: number;
  directories?: number;
  entries?: number;
  blocked?: "too-many" | "too-many-directories";
  max?: number;
  code?: string;
}

export async function deletePlan(source: IfsSource, path: string): Promise<IfsDeletePlan> {
  const res = await post("delete-plan", { source, path });
  return (await res.json()) as IfsDeletePlan;
}

/** 名前を変える。`newName` は**名前だけ**（`/` を含めない。移動は出来ない） */
export async function renamePath(
  source: IfsSource,
  path: string,
  newName: string
): Promise<{ path: string }> {
  const res = await post("rename", { source, path, newName });
  return (await res.json()) as { path: string };
}

/** 単一ファイルのバイト列。ダウンロードとプレビューの両方に使う */
export async function download(source: IfsSource, path: string): Promise<Blob> {
  return (await post("download", { source, path })).blob();
}

/** フォルダを zip で取得する */
export async function zipFolder(source: IfsSource, path: string): Promise<Blob> {
  return (await post("zip", { source, path })).blob();
}

export type { IfsEntry, IfsListResult };
