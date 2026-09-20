import { describe, it, expect } from "vitest";
import { As400Error } from "@ts5250/base";
import { errShape } from "../src/ws-handler.js";

/**
 * **例外をログに載せるとき、値を 1 文字も漏らさない。**
 *
 * `setField` の検証エラーは文言に**打鍵した値をそのまま埋める**
 * （`packages/tn5250/src/screen/field-validate.ts` の `JSON.stringify(value)`）。
 * その値は**マクロ由来の秘密**でもありうる（`ws-handler` の `resolveSecret`）ので、
 * `AGENTS.md`「秘密の扱い」は「ログにも値を出さない」と定めている。
 *
 * **ここを走査ではなくテストで固定するのは、同じ穴を 2 回開けたから**——
 * `20260920-restore-screen-parity` の review で、
 * ラウンド 2: `String(e)` を `err: e` に変えて message ごとログへ出した（must）。
 * ラウンド 3: 「1 行目を落とせば message は消える」を**測らずに書いた**ため、
 * 複数行の message（zod の `ZodError`）が残った（must）。
 * どちらも「推測せず実機・実測で確かめる」（`AGENTS.md` 判断の原則 2）を外したのが原因。
 */
describe("errShape: 例外をログに載せる形", () => {
  const SECRET = "P@ssw0rd-SECRET";

  it("1 行の message は載らない", () => {
    const e = new As400Error("FIELD_TYPE", `numeric field accepts digits only: ${JSON.stringify(SECRET)}`);
    const s = errShape(e);
    expect(s.code).toBe("FIELD_TYPE");
    expect(JSON.stringify(s)).not.toContain(SECRET);
  });

  it("**複数行の message でも載らない**（zod の ZodError がこの形）", () => {
    // `resolveField` が投げる `invalid secretRef: ${ZodError.message}` は整形 JSON で複数行になる
    const multi = `invalid secretRef: {\n  "issue": "unknown key",\n  "key": ${JSON.stringify(SECRET)}\n}`;
    const s = errShape(new As400Error("PROTOCOL_ERROR", multi));
    expect(s.code).toBe("PROTOCOL_ERROR");
    expect(JSON.stringify(s), "message の 2 行目以降が残っていない").not.toContain(SECRET);
    expect(s.at, "どこで投げたかは残る").toMatch(/^at /);
  });

  it("**message の行頭が `at ` でも載らない**（`at ` の行だけを残す実装はここで漏れた）", () => {
    // 利用者が打った値や zod のキー名が `at ` で始まりうる。行の形で選ぶと message が紛れる
    const multi = `invalid secretRef: {\n  at ${SECRET}\n}`;
    const s = errShape(new As400Error("PROTOCOL_ERROR", multi));
    expect(JSON.stringify(s)).not.toContain(SECRET);
  });

  it("message そのものに `at ` が含まれても載らない", () => {
    const s = errShape(new As400Error("FIELD_TYPE", `accepts digits only: "at ${SECRET}"`));
    expect(JSON.stringify(s)).not.toContain(SECRET);
  });

  it("`cause` に入れた値も載らない", () => {
    const e = new As400Error("FIELD_OVERFLOW", "too long", { cause: new Error(SECRET) });
    expect(JSON.stringify(errShape(e))).not.toContain(SECRET);
  });

  it("フレームは先頭 3 つまで（warn 1 本に十数行を付けない）", () => {
    const s = errShape(new Error("boom"));
    expect(s.at, "フレームは採れている（採れないまま通らない）").toBeDefined();
    expect((s.at ?? "").split(" / ").length).toBeLessThanOrEqual(3);
  });

  /**
   * **頭が `<name>: <message>` にならない例外でも位置は残す。**
   * ラウンド 4 の fail-closed（頭が一致しなければ `at` を諦める）は、この 2 形で
   * **位置が丸ごと消えていた**——`setField` / `resolveField` の失敗をいちばん切り分けたい場面。
   * `20260920-restore-screen-parity` review ラウンド 5（委譲先が変異注入で「テストが無い」ことを実測）。
   */
  it("**`stack` の頭が `<name>: <message>` にならない例外**でもフレームが採れる", () => {
    // Node 内部の `ERR_*` がこの形（頭は `TypeError [ERR_INVALID_ARG_TYPE]: …` なのに
    // `name` は `"TypeError"`）。**環境に依らない形で再現する**——`stack` を確定させてから
    // `name` を変えると、頭と `${name}: ${message}` が食い違う
    const e = new Error("boom");
    void e.stack; // ここで V8 が `"Error: boom\n at …"` に確定させる
    e.name = "Renamed";
    expect(e.stack?.startsWith(`${e.name}: ${e.message}`), "頭が食い違う状況を作れている").toBe(false);

    const s = errShape(e);
    expect(s.at, "位置が残る").toBeDefined();
    expect(s.at).toMatch(/^at /);
  });

  it("**message が空**の例外でもフレームが採れる（V8 は `\": \"` を出さない）", () => {
    const s = errShape(new As400Error("FIELD_TYPE", ""));
    expect(s.code).toBe("FIELD_TYPE");
    expect(s.at, "位置が残る").toBeDefined();
  });

  it("Error でないものを渡しても壊れない", () => {
    expect(errShape("just a string")).toEqual({});
    expect(errShape(undefined)).toEqual({});
  });
});
