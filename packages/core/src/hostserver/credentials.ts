/**
 * ホストサーバー認証で使う資格情報のバイト化。
 *
 * **同じユーザー ID が用途によって 3 通りに符号化される**のが最大の落とし穴。
 *
 * | 用途 | 形式 |
 * |---|---|
 * | ハッシュ入力のユーザー ID（レベル >= 2） | UTF-16BE 20 バイト・空白詰め・大文字化 |
 * | ハッシュ入力のパスワード（レベル >= 2） | UTF-16BE・詰めなし・**大文字化しない** |
 * | 要求 CP 0x1104 のユーザー ID | **CCSID 37** 10 バイト・0x40 詰め・大文字化 |
 *
 * CCSID 37 は固定であり、システムの CCSID（PUB400 は 273）とは無関係。
 * ここに 273 を持ち込むと認証が通らない。
 *
 * 参照: JTOpen(jtopenlite) の HostServerConnection.getUserBytes / getPasswordBytes に対応する
 *       （コードの移植ではなく、符号化規則に基づく実装）。
 */
import { Tn5250Error } from "../errors.js";
import { codecForCcsid } from "../codec/codec.js";

/** ユーザー ID の最大長（IBM i のプロファイル名） */
export const MAX_USER_LEN = 10;
/** 資格情報の EBCDIC は CCSID 37 固定（システム CCSID と混同しない） */
export const CREDENTIAL_CCSID = 37;

const EBCDIC_SPACE = 0x40;
const codec37 = codecForCcsid(CREDENTIAL_CCSID);

/**
 * ユーザー ID を CCSID 37 の 10 バイトにする（0x40 詰め・大文字化）。
 * 要求の CP 0x1104 に載せる形式。パスワードレベルに関わらずこれを使う。
 */
export function userIdEbcdic37(user: string): Uint8Array {
  const upper = user.toUpperCase();
  if (upper.length === 0) {
    throw new Tn5250Error("CONFIG_ERROR", "user id is empty");
  }
  if (upper.length > MAX_USER_LEN) {
    throw new Tn5250Error(
      "CONFIG_ERROR",
      `user id too long: ${upper.length} chars (max ${MAX_USER_LEN})`
    );
  }
  const { bytes, substituted } = codec37.encode(upper);
  if (substituted > 0) {
    // 置換文字(0x3F)を黙って送ると「パスワードが違う」に見える失敗になる
    throw new Tn5250Error(
      "CONFIG_ERROR",
      `user id contains characters not representable in CCSID ${CREDENTIAL_CCSID}: ${upper}`
    );
  }
  const out = new Uint8Array(MAX_USER_LEN).fill(EBCDIC_SPACE);
  out.set(bytes.subarray(0, MAX_USER_LEN));
  return out;
}

/**
 * ユーザー ID を UTF-16BE 20 バイトにする（空白詰め・大文字化）。
 * パスワードレベル >= 2 のハッシュ入力に使う形式。
 */
export function userIdUnicode(user: string): Uint8Array {
  const upper = user.toUpperCase();
  if (upper.length === 0) {
    throw new Tn5250Error("CONFIG_ERROR", "user id is empty");
  }
  if (upper.length > MAX_USER_LEN) {
    throw new Tn5250Error(
      "CONFIG_ERROR",
      `user id too long: ${upper.length} chars (max ${MAX_USER_LEN})`
    );
  }
  const out = new Uint8Array(MAX_USER_LEN * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < MAX_USER_LEN; i++) {
    view.setUint16(i * 2, i < upper.length ? upper.charCodeAt(i) : 0x20);
  }
  return out;
}

/**
 * パスワードを UTF-16BE にする（詰めなし）。
 * パスワードレベル >= 2 のハッシュ入力に使う形式。
 *
 * **大文字化しない**——レベル >= 2 のパスワードは大小文字を区別する。
 */
export function passwordUnicode(password: string): Uint8Array {
  if (password.length === 0) {
    throw new Tn5250Error("CONFIG_ERROR", "password is empty");
  }
  const out = new Uint8Array(password.length * 2);
  const view = new DataView(out.buffer);
  for (let i = 0; i < password.length; i++) {
    view.setUint16(i * 2, password.charCodeAt(i));
  }
  return out;
}
