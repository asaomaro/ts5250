/**
 * パスワード置換値（password substitute）の生成。
 *
 * 平文パスワードは送らず、サーバー seed とクライアント seed を混ぜたハッシュを送る
 * （チャレンジ・レスポンス）。アルゴリズムはシステムのパスワードレベル（QPWDLVL）で分かれる。
 *
 * - レベル >= 2: SHA-1 を 2 回（本モジュールが実装する）
 * - レベル <  2: DES ベース（**未対応**。下記 assertPasswordLevelSupported 参照）
 *
 * 参照: JTOpen(jtopenlite) の EncryptPassword.encryptPasswordSHA /
 *       HostServerConnection.getEncryptedPassword に対応する
 *       （コードの移植ではなく、アルゴリズム手順に基づく実装）。
 */
import { Tn5250Error } from "../errors.js";

/** SHA 経路を使う最小パスワードレベル。これ未満は DES 経路 */
export const MIN_SHA_PASSWORD_LEVEL = 2;
/** seed の長さ */
export const SEED_LEN = 8;

/** ハッシュの最後に混ぜる固定のシーケンス番号（1） */
const SEQUENCE = Uint8Array.from([0, 0, 0, 0, 0, 0, 0, 1]);

/**
 * クライアント seed を作る。
 *
 * 本実装は暗号論的乱数を使う。参照実装は現在時刻ミリ秒を用いるが、チャレンジの seed が
 * 予測可能である必要はない（プロトコル上は任意の 8 バイト）。
 *
 * Node API ではなく Web Crypto の標準グローバルを使う（この層は Node 非依存に保つ）。
 */
export function generateClientSeed(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(SEED_LEN));
}

/** SHA-1 ダイジェスト（Web Crypto。非同期なのは subtle.digest の仕様） */
async function sha1(...parts: Uint8Array[]): Promise<Uint8Array> {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const joined = new Uint8Array(total);
  let pos = 0;
  for (const part of parts) {
    joined.set(part, pos);
    pos += part.length;
  }
  return new Uint8Array(await crypto.subtle.digest("SHA-1", joined));
}

/**
 * SHA 経路のパスワード置換値を作る（20 バイト）。
 *
 * ```
 * token  = SHA1( userId ‖ password )
 * result = SHA1( token ‖ serverSeed ‖ clientSeed ‖ userId ‖ 0x0000000000000001 )
 * ```
 *
 * @param userIdUnicode UTF-16BE 20 バイト・空白詰め・大文字化（credentials.userIdUnicode）
 * @param passwordUtf16be UTF-16BE・詰めなし・大文字化しない（credentials.passwordUnicode）
 */
export async function passwordSubstituteSha(
  userIdUnicode: Uint8Array,
  passwordUtf16be: Uint8Array,
  clientSeed: Uint8Array,
  serverSeed: Uint8Array
): Promise<Uint8Array> {
  assertSeed(clientSeed, "client");
  assertSeed(serverSeed, "server");

  const token = await sha1(userIdUnicode, passwordUtf16be);
  return sha1(token, serverSeed, clientSeed, userIdUnicode, SEQUENCE);
}

/**
 * パスワードレベルが対応範囲か検査する。
 *
 * DES 経路（レベル < 2）は実装していない。黙って誤った値を送ると「パスワードが違う」に
 * 見える失敗になり切り分けが難しいので、未対応であることを明示的に伝える。
 */
export function assertPasswordLevelSupported(level: number): void {
  if (level < MIN_SHA_PASSWORD_LEVEL) {
    throw new Tn5250Error(
      "HOST_SERVER_UNSUPPORTED",
      `password level ${level} requires DES-based authentication, which is not implemented ` +
        `(only level ${MIN_SHA_PASSWORD_LEVEL} and above are supported)`
    );
  }
}

function assertSeed(seed: Uint8Array, which: string): void {
  if (seed.length !== SEED_LEN) {
    throw new Tn5250Error(
      "PROTOCOL_ERROR",
      `${which} seed must be ${SEED_LEN} bytes, got ${seed.length}`
    );
  }
}
