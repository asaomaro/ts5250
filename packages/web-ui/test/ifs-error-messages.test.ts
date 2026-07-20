import { describe, it, expect } from "vitest";
import { IfsRequestError, messageFor, KNOWN_ERROR_CODES } from "../src/ifsApi.js";

/**
 * **エラーコードの網羅を固定する。**
 *
 * 統合テストで、`NOT_FOUND` / `ACCESS_DENIED` が UI の文言化から漏れており、
 * 削除やアクセス拒否のときだけ英語の技術文字列（`File not found (rc=2)`）が出ていた。
 * サーバーが返しうるコードと UI が日本語にできるコードを、ここで突き合わせる。
 */

/**
 * server が IFS 系で返しうる、エラーとしての `code` の一覧。
 * 根拠（実コードから）:
 * - `host-ifs.ts` がルート本体で直接返す: INCOMPLETE_LISTING / TOO_LARGE / TOO_MANY_DIRECTORIES
 * - core のエラーが `statusOf`（host-api.ts）を通って `{ code }` で返る:
 *   NOT_FOUND / ACCESS_DENIED / ALREADY_EXISTS / RESOURCE_BUSY
 * （UNSUPPORTED_ENCODING は 200 で content:null になるので、エラー文言の対象ではない）
 */
const SERVER_ERROR_CODES = [
  "INCOMPLETE_LISTING",
  "TOO_LARGE",
  "TOO_MANY_DIRECTORIES",
  "NOT_FOUND",
  "ACCESS_DENIED",
  "ALREADY_EXISTS",
  "RESOURCE_BUSY"
] as const;

describe("エラーコードの網羅", () => {
  /**
   * **これが本丸。** サーバーが返す全コードを UI が日本語にできること。
   * 新しい code をサーバーに足して KNOWN_ERROR_CODES に足し忘れると、ここで落ちる。
   */
  it("サーバーが返しうるコードをすべて日本語化できる", () => {
    for (const code of SERVER_ERROR_CODES) {
      const msg = messageFor({ error: `raw ${code} (rc=99)`, code });
      // 英語の生文言（rc 付き）に落ちていないこと
      expect(msg, code).not.toContain("rc=");
      // 日本語が含まれること（ひらがな/カタカナ/漢字のいずれか）
      expect(msg, code).toMatch(/[ぁ-んァ-ヶ一-龠]/);
    }
  });

  it("KNOWN_ERROR_CODES がサーバーの全コードを覆っている", () => {
    for (const code of SERVER_ERROR_CODES) {
      expect(KNOWN_ERROR_CODES, code).toContain(code);
    }
  });

  it("知らないコードはサーバーの文言をそのまま出す（握りつぶさない）", () => {
    expect(messageFor({ error: "何か未知のエラー", code: "SOMETHING_NEW" })).toBe("何か未知のエラー");
  });

  it("IfsRequestError.message が messageFor を通す", () => {
    const e = new IfsRequestError(404, { error: "File not found (rc=2)", code: "NOT_FOUND" });
    expect(e.message).not.toContain("rc=");
    expect(e.message).toContain("見つかりません");
  });

  it("TOO_LARGE は超過した実測値を添える", () => {
    const msg = messageFor({ error: "x", code: "TOO_LARGE", files: 501, bytes: 9_000_000 });
    expect(msg).toContain("501 ファイル以上");
    expect(msg).toContain("MB 以上");
  });
});
