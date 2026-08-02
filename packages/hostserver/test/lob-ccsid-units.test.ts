import { describe, it, expect } from "vitest";
import { isTwoByteCcsid, isBinaryCcsid, decodeLobBytes } from "../src/db/db-decode.js";

/**
 * **ホストが申告する LOB の長さは、単位が CCSID で変わる。**
 *
 * 実機（IBM i 7.3）で両方を確かめた
 * （`scripts/research-dbclob-locator.mjs` / `20260801-dbclob-locator-decode`）:
 *
 * | 列 | CCSID | 値 | 申告長 | 実際の本体 |
 * |---|---|---|---|---|
 * | `DBCLOB` | 1200（UTF-16） | `日本語` | **3**（文字数） | 6 バイト |
 * | `DBCLOB` | 1200 | `全角混在ab` | **6**（文字数） | 12 バイト |
 * | `CLOB` | 5035（混在） | `日本語` | **8**（バイト数。SO/SI 込み） | 8 バイト |
 * | `CLOB` | 5035 | `a` | **1**（バイト数） | 1 バイト |
 *
 * **SBCS だけで試すと文字数＝バイト数で一致してしまい、取り違えに気づけない。**
 * バイト数として読んでいた実装は `日本語` を `日` に切っていた。
 */
describe("isTwoByteCcsid", () => {
  it("UTF-16 は 2 バイト/文字（申告長は文字数）", () => {
    expect(isTwoByteCcsid(1200)).toBe(true);
    expect(isTwoByteCcsid(13488)).toBe(true);
  });

  it("純 DBCS も 2 バイト/文字", () => {
    // 300 / 16684 は純 DBCS（GRAPHIC で使う）
    expect(isTwoByteCcsid(16684)).toBe(true);
  });

  it("混在・SBCS は 1 バイト/文字扱い（申告長はバイト数）", () => {
    // 5035 は実機のサーバー CCSID。SO/SI 込みのバイト数で申告される
    expect(isTwoByteCcsid(5035)).toBe(false);
    expect(isTwoByteCcsid(37)).toBe(false);
    expect(isTwoByteCcsid(273)).toBe(false);
  });

  it("0（BLOB）は 1 バイト扱い", () => {
    expect(isTwoByteCcsid(0)).toBe(false);
  });

  it("**65535（実機の BLOB）も 1 バイト扱い**", () => {
    // 実機の BLOB は 0 ではなく 65535 で来る（`20260802-lob-big-dbcs-blob` F3）
    expect(isTwoByteCcsid(65535)).toBe(false);
  });
});

/**
 * **バイナリ（文字コードを持たない）CCSID。**
 *
 * `0` は「未設定」、`65535`（0xFFFF）は IBM の「変換しない」。
 * **実機の BLOB は `65535` で来る**——`0` ではない
 * （`scripts/research-lob-big-dbcs-blob.mjs` F3 で実測）。
 *
 * この判定は `db-reply.ts` / `marker-encode.ts` / `decodeLobBytes` の 3 か所にあり、
 * **`decodeLobBytes` だけ `0` しか見ていなかった**。BLOB がバイト列で返っていたのは
 * `catch` に落ちていたからで、**65535 に codec を足した瞬間に文字列へ化ける**形だった。
 */
describe("isBinaryCcsid", () => {
  it("0 と 65535 がバイナリ", () => {
    expect(isBinaryCcsid(0)).toBe(true);
    expect(isBinaryCcsid(65535)).toBe(true);
  });

  it("文字コードを持つものは違う", () => {
    expect(isBinaryCcsid(37)).toBe(false);
    expect(isBinaryCcsid(1200)).toBe(false);
    expect(isBinaryCcsid(5035)).toBe(false);
    expect(isBinaryCcsid(300)).toBe(false);
  });
});

describe("decodeLobBytes", () => {
  it("UTF-16 を文字列にする（以前はバイト列のまま返っていた）", () => {
    // UTF-16BE で "日本語"
    const bytes = Uint8Array.from([0x65, 0xe5, 0x67, 0x2c, 0x8a, 0x9e]);
    expect(decodeLobBytes(bytes, 1200)).toBe("日本語");
  });

  it("混在 CCSID は SO/SI 込みで読む", () => {
    // 5035 で "日本語" = SO + DBCS 3 文字 + SI（実機で採ったバイト列）
    const bytes = Uint8Array.from([0x0e, 0x45, 0x62, 0x45, 0x66, 0x48, 0xe7, 0x0f]);
    expect(decodeLobBytes(bytes, 5035)).toBe("日本語");
  });

  it("CCSID 0（BLOB）はバイト列のまま", () => {
    const bytes = Uint8Array.from([0x01, 0x02, 0xff]);
    expect(decodeLobBytes(bytes, 0)).toBe(bytes);
  });

  it("**CCSID 65535（実機の BLOB）もバイト列のまま**", () => {
    // 以前は `catch` に落ちて偶然バイト列を返していた。**明示的に返す**
    const bytes = Uint8Array.from([0x01, 0x23, 0x45, 0x67, 0x89, 0xab, 0xcd, 0xef]);
    expect(decodeLobBytes(bytes, 65535)).toBe(bytes);
  });

  it("未知の CCSID は壊れた文字列にせずバイト列で返す", () => {
    const bytes = Uint8Array.from([0x01, 0x02]);
    expect(decodeLobBytes(bytes, 999999)).toBe(bytes);
  });
});
