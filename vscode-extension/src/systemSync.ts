import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * プリンター(スプール表示)・SQL・IFS用の個人設定（`own:<id>`）を、spawnしたサーバーの
 * `/api/systems`へ登録・同期する。`vscode`モジュールに依存しない純粋ロジック
 * （`ExtensionSecretCrypto`での復号は呼び出し側が行い、ここには平文を渡すだけ）。
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
  /** `.ts5250`ファイルのURI文字列（対応表のキー） */
  documentUri: string;
  /** サーバー設定の`name`欄（一覧に出るだけで機能には使わない）。ファイル名等 */
  name: string;
  host: string;
  port?: number;
  tls?: boolean;
  ccsid?: number;
  user?: string;
  /** 平文。ここで初めてネットワークへ乗る（サーバーへHTTPSではなくloopback） */
  password?: string;
}

/** 登録・同期し、`system` propにそのまま渡せる参照（`own:<id>`）を返す */
export async function syncSystem(input: SystemSyncInput, opts: SystemSyncOptions): Promise<string> {
  const fetchFn = opts.fetchFn ?? fetch;
  const mapping = readMapping(opts.mappingFilePath);
  const existingRef = mapping[input.documentUri];
  const body = JSON.stringify(buildBody(input));
  const headers = { "content-type": "application/json" };

  if (existingRef) {
    const res = await fetchFn(`http://127.0.0.1:${opts.port}/api/systems/${existingRef}`, {
      method: "PUT",
      headers,
      body
    });
    if (res.ok) return existingRef;
    // **404（対象が実在しない）だけPOSTへフォールバックする。** globalStorageの対応表と
    // サーバー側のconnections.jsonがずれることがある（サーバーを別のglobalStorageで
    // 起動し直した等）。それ以外（500等の一時的な障害）まで飲み込むと、失敗のたびに
    // 新規登録が増え続け、本当のエラーも見えなくなる
    if (res.status !== 404) throw new Error(`system同期に失敗しました（HTTP ${res.status}）`);
  }

  const res = await fetchFn(`http://127.0.0.1:${opts.port}/api/systems`, { method: "POST", headers, body });
  if (!res.ok) throw new Error(`system登録に失敗しました（HTTP ${res.status}）`);
  const json = (await res.json()) as { system: { ref: string } };
  mapping[input.documentUri] = json.system.ref;
  writeMapping(opts.mappingFilePath, mapping);
  return json.system.ref;
}

function buildBody(input: SystemSyncInput): Record<string, unknown> {
  const body: Record<string, unknown> = { name: input.name, host: input.host };
  if (input.port !== undefined) body.port = input.port;
  if (input.tls !== undefined) body.tls = input.tls;
  if (input.ccsid !== undefined) body.ccsid = input.ccsid;
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
