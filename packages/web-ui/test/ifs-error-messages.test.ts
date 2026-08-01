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

/**
 * 上限「値」の表示（backlog hostserver.md:207）。
 *
 * **超過値だけでは「どこまでなら通るか」が分からない**——対象を絞る当てが付かない。
 * サーバーは既に `maxFiles` / `maxBytes` を送っており、使っていなかったのは UI 側だった。
 * 削除の `TOO_MANY` だけが上限を出していて、同じ関数の中で扱いが不揃いだった。
 */
describe("上限値の表示", () => {
  it("zip の TOO_LARGE に上限が出る", () => {
    const msg = messageFor({
      error: "x",
      code: "TOO_LARGE",
      files: 501,
      bytes: 21_000_000,
      maxFiles: 500,
      maxBytes: 20_971_520
    });
    expect(msg).toContain("501 ファイル以上");
    expect(msg).toContain("上限 500 ファイル");
    expect(msg).toContain("20.0 MB");
  });

  /**
   * **1 ファイルの読み取りは文面を分ける。** `files` を持たないのが単数系の目印。
   * 「対象が大きすぎます。対象を絞るか、個別に取得してください」では、
   * 1 本のファイルを開いたときに何を絞ればよいのか分からない。
   */
  it("read の TOO_LARGE は単数形で上限を出す", () => {
    const msg = messageFor({ error: "x", code: "TOO_LARGE", bytes: 6_500_000, maxBytes: 5_242_880 });
    expect(msg).toContain("ファイルが大きすぎます");
    expect(msg).toContain("6.2 MB");
    expect(msg).toContain("上限 5.0 MB");
    expect(msg).toContain("ダウンロード");
    // 複数系の案内が混ざらないこと
    expect(msg).not.toContain("対象を絞る");
  });

  it("TOO_MANY_DIRECTORIES に上限が出る", () => {
    const msg = messageFor({
      error: "x",
      code: "TOO_MANY_DIRECTORIES",
      directories: 6000,
      maxDirectories: 5000
    });
    expect(msg).toContain("6000 個以上");
    expect(msg).toContain("上限 5000 個");
  });

  /**
   * 上限が載っていない応答（古いサーバー・想定外の形）でも壊れない。
   * **`undefined` を文言に出さない**のが要——出ると利用者は意味を読み取れない。
   */
  /**
   * **MB 固定にしない。** 上限は CLI 引数で下げられるので、MB だけで書くと
   * 「大きすぎます（0.0 MB / 上限 0.0 MB）」という何も伝えない文になる。
   * 実機の実機検証（`scripts/verify-ifs-limits.mjs`）で実際にそう出た。
   */
  it("MB 未満は KB / B で出す（0.0 MB にしない）", () => {
    const small = messageFor({ error: "x", code: "TOO_LARGE", bytes: 4608, maxBytes: 4096 });
    expect(small).toContain("4.5 KB");
    expect(small).toContain("上限 4.0 KB");
    expect(small).not.toContain("0.0 MB");

    const tiny = messageFor({ error: "x", code: "TOO_LARGE", bytes: 900, maxBytes: 512 });
    expect(tiny).toContain("900 B");
    expect(tiny).toContain("上限 512 B");

    // 1 MB 以上は従来どおり MB
    const big = messageFor({ error: "x", code: "TOO_LARGE", bytes: 6_500_000, maxBytes: 5_242_880 });
    expect(big).toContain("6.2 MB");
    expect(big).toContain("上限 5.0 MB");
  });

  it("上限が欠けていても undefined を出さない", () => {
    for (const b of [
      { error: "x", code: "TOO_LARGE", files: 501, bytes: 9_000_000 },
      { error: "x", code: "TOO_LARGE", bytes: 9_000_000 },
      { error: "x", code: "TOO_MANY_DIRECTORIES", directories: 6000 }
    ]) {
      const msg = messageFor(b);
      expect(msg).not.toContain("undefined");
      expect(msg).not.toContain("NaN");
      // 上限が取れないなら「上限」の断片ごと出さない（中途半端な文にしない）
      expect(msg).not.toContain("上限");
    }
  });
});
