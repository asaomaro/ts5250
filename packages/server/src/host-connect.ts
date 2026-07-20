/**
 * ホストサーバー（SQL・コマンド・スプール・IFS）接続の共通の開き方。
 *
 * **5250 の自動サインオン情報を流用する**——同じ相手に同じ資格情報で繋ぐため、
 * ホストサーバー専用の資格情報の置き場を新設しない（`host-lists.ts` から移設した方針）。
 *
 * 接続は**単発完結**で使う（spec D2）。呼び出し側は必ず `try { … } finally { conn.close() }` の形にする。
 * プールや長命セッションを持たないのは `/mcp` 自体がステートレス（接続はリクエスト毎に管理）であり、
 * 既存の `/api/host/*` もリクエスト単位で開閉しているため。
 *
 * core の 4 種の接続オプションは `{ host, user, password, port?, tls?, resolvePort?, timeoutMs? }` で
 * 共通形なので、資格情報の検証をここ 1 箇所に集約できる。
 */
import {
  CommandConnection,
  DbConnection,
  IfsConnection,
  NetPrintConnection,
  As400Error,
  type ConnectOptions
} from "@as400web/core";

/** ホストサーバー接続に必要な最小の資格情報。core の 4 種すべてがこの形を含む */
export interface HostServerAuth {
  host: string;
  user: string;
  password: string;
  tls?: boolean | { rejectUnauthorized?: boolean; ca?: string | string[] };
}

/**
 * 5250 の接続設定からホストサーバー用の資格情報を取り出す。
 *
 * `tls` は **boolean へキャストしない**。`ConnectOptions.tls` は
 * `boolean | { rejectUnauthorized?, ca? }` で、core 側の `HostTlsOptions` と同じ形をしている。
 * 旧 `host-lists.ts` は `opts.tls as boolean` としており、実行時はオブジェクトがそのまま
 * 渡って動いていたが型が実態と食い違っていた（証明書検証の設定を落としているように読める）。
 */
export function hostAuthFrom(opts: ConnectOptions): HostServerAuth {
  if (!opts.host || !opts.user || !opts.password) {
    throw new As400Error(
      "CONFIG_ERROR",
      "この接続設定にはユーザーとパスワードが登録されていないためホストサーバーに接続できません"
    );
  }
  return {
    host: opts.host,
    user: opts.user,
    password: opts.password,
    ...(opts.tls !== undefined ? { tls: opts.tls } : {})
  };
}

/** コマンドサーバー接続（CL 実行・プログラム呼び出し・各種一覧の土台） */
export function openCommand(opts: ConnectOptions): Promise<CommandConnection> {
  return CommandConnection.connect(hostAuthFrom(opts));
}

/** database サーバー接続（SQL） */
export function openDb(opts: ConnectOptions): Promise<DbConnection> {
  return DbConnection.connect(hostAuthFrom(opts));
}

/**
 * ネットワークプリントサーバー接続（スプールの取得）。
 *
 * `ccsid` は SCS のデコードに使う（既定 273）。5250 側の `ccsid` を既定に流用**しない**——
 * 5250 の CCSID は画面の文字変換用で、スプールの SCS とは別の設定である
 * （`20260718-hostserver-spool` で「経路によって扱いが違う」と指摘され、明示指定できるようにした経緯）。
 */
export function openNetPrint(opts: ConnectOptions, ccsid?: number): Promise<NetPrintConnection> {
  return NetPrintConnection.connect({
    ...hostAuthFrom(opts),
    ...(ccsid !== undefined ? { ccsid } : {})
  });
}

/** IFS ファイルサーバー接続 */
export function openIfs(opts: ConnectOptions): Promise<IfsConnection> {
  return IfsConnection.connect(hostAuthFrom(opts));
}
