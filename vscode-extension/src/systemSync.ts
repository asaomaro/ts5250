import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * 接続先システムを、spawnしたサーバーの
 * `/api/systems`へ登録・同期する。`vscode`モジュールに依存しない純粋ロジック
 * （`ExtensionSecretCrypto`での復号は呼び出し側が行い、ここには平文を渡すだけ）。
 * 通常は個人設定（own:）、PC コマンドの許可を持つセッションの親だけはサーバー設定（srv:）へ登録する。
 *
 * **idは決定的に導出できない。** `POST /api/systems`はidを呼び出し側から指定できず、
 * サーバーが自動採番する（`packages/server/src/config-store.ts`の`addSystem`）。
 * そのため、初回`POST`で採番された**参照（`PublicSystem.ref`。既に`own:s-xxx`の形）**を
 * `mappingFilePath`（`systemRefs.json`）へキャッシュし、2回目以降はその参照へ`PUT`で
 * 同期する（`03-sql-ifs/decisions.md` D1）。
 *
 * **`POST`/`PUT`の応答は`{system:{ref, ...}}`——`id`という欄は無い。**
 * 実プロセス統合テスト（`test/systemSync.integration.test.ts`）で確認するまで
 * `{system:{id}}`だと思い込んでおり、`own:undefined`という壊れた参照を返していた
 * （単体テストは自分で書いたモックの応答形状が間違っていたため、この欠陥を素通りしていた）
 */

export interface SystemSyncOptions {
  /** spawnしたサーバーのポート */
  port: number;
  /** `context.globalStorageUri/systemRefs.json`。`documentUri` → サーバーの`ref` の対応表 */
  mappingFilePath: string;
  /** 注入可能（テスト用）。既定は`globalThis.fetch` */
  fetchFn?: typeof fetch;
}

export interface SystemSyncInput {
  /** 設定ファイルのURI文字列（対応表のキー） */
  documentUri: string;
  /** PC コマンドのような信頼設定を持つセッションの親だけ server に登録する */
  source?: "server";
  /** サーバー設定の`name`欄（一覧に出るだけで機能には使わない）。ファイル名等 */
  name: string;
  host: string;
  port?: number;
  tls?: boolean;
  ccsid?: number;
  /** スプールの復号CCSID。**送らないとサーバーの既定（273）で復号されて、日本語のスプールが化ける** */
  spoolCcsid?: number;
  ifsPath?: string;
  sqlInitial?: string;
  user?: string;
  /** 平文。ここで初めてネットワークへ乗る（サーバーへHTTPSではなくloopback） */
  password?: string;
}

/** 登録・同期し、保存先に対応する参照（通常は own:、信頼設定の親は srv:）を返す */
export async function syncSystem(input: SystemSyncInput, opts: SystemSyncOptions): Promise<string> {
  return syncConfigRecord(input.documentUri, "systems", buildBody(input), opts);
}

/** システム・セッションの参照を同じ規則で同期する。404 以外で新規作成へ倒さない。 */
export async function syncConfigRecord(
  documentUri: string,
  resource: "systems" | "sessions-config",
  value: Record<string, unknown>,
  opts: SystemSyncOptions
): Promise<string> {
  const fetchFn = opts.fetchFn ?? fetch;
  const mapping = readMapping(opts.mappingFilePath);
  const existingRef = mapping[documentUri];
  const body = JSON.stringify(value);
  const headers = { "content-type": "application/json" };

  if (existingRef) {
    const res = await fetchFn(`http://127.0.0.1:${opts.port}/api/${resource}/${existingRef}`, {
      method: "PUT",
      headers,
      body
    });
    if (res.ok) return existingRef;
    // **404（対象が実在しない）だけPOSTへフォールバックする。** globalStorageの対応表と
    // サーバー側のconnections.jsonがずれることがある（サーバーを別のglobalStorageで
    // 起動し直した等）。それ以外（500等の一時的な障害）まで飲み込むと、失敗のたびに
    // 新規登録が増え続け、本当のエラーも見えなくなる
    if (res.status !== 404) throw await syncError(res, resource, "同期");
  }

  const res = await fetchFn(`http://127.0.0.1:${opts.port}/api/${resource}`, { method: "POST", headers, body });
  if (!res.ok) throw await syncError(res, resource, "登録");
  const json = (await res.json()) as { system?: { ref: string }; session?: { ref: string } };
  const ref = resource === "systems" ? json.system?.ref : json.session?.ref;
  if (typeof ref !== "string" || !ref.startsWith(value.source === "server" ? "srv:" : "own:")) {
    throw new Error("設定の参照を取得できません");
  }
  mapping[documentUri] = ref;
  writeMapping(opts.mappingFilePath, mapping);
  return ref;
}

/** 出力先の検証など、サーバーが返した理由も伝える。HTTP 失敗を読めない応答で上書きしない。 */
async function syncError(response: Response, resource: string, action: string): Promise<Error> {
  const label = resource === "systems" ? "system" : "session";
  let detail = "";
  try {
    const body = await response.json() as { error?: unknown } | null;
    if (typeof body?.error === "string") detail = `: ${body.error}`;
  } catch {
    // JSON 以外の応答でも、元の HTTP ステータスは残す。
  }
  return new Error(`${label}${action}に失敗しました（HTTP ${response.status}）${detail}`);
}

function buildBody(input: SystemSyncInput): Record<string, unknown> {
  const body: Record<string, unknown> = { name: input.name, host: input.host };
  if (input.source !== undefined) {
    body.source = input.source;
    // ファイルは資格情報の全体を表す。フォームの「空欄は変更なし」と同じ扱いにすると、
    // ファイルから消したパスワードで過去の自動サインオンが復活してしまう。
    body.autoSignon = Boolean(input.user && input.password);
  }
  if (input.port !== undefined) body.port = input.port;
  if (input.tls !== undefined) body.tls = input.tls;
  if (input.ccsid !== undefined) body.ccsid = input.ccsid;
  if (input.spoolCcsid !== undefined) body.spoolCcsid = input.spoolCcsid;
  if (input.ifsPath !== undefined) body.ifsPath = input.ifsPath;
  if (input.sqlInitial !== undefined) body.sqlInitial = input.sqlInitial;
  if (input.user !== undefined) body.signonUser = input.user;
  if (input.password !== undefined) body.password = input.password;
  return body;
}

function readMapping(path: string): Record<string, string> {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

function writeMapping(path: string, mapping: Record<string, string>): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(mapping, null, 2));
}
