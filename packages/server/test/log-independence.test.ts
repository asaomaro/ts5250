import { describe, it, expect, afterEach } from "vitest";
import { resetLogSink, setLogSink, childLog as coreChildLog } from "@as400web/core";
import { childLog as serverChildLog } from "../src/log.js";

/**
 * ロガーの依存の向き。
 *
 * core からロガー実装（pino）を外したとき、**素直にやると server のログも core の注入に
 * ぶら下がる**。その形だと `setLogSink` の呼び忘れで `audit.ts` の監査証跡が静かに消える——
 * 気づきにくく、消えて最も困る種類のログである。
 *
 * そこで依存の向きを逆にし、**server は自前の pino を直接使う**ようにした。
 * このテストはその不変条件を固定する。
 */
afterEach(() => {
  resetLogSink();
});

describe("server のログは core の注入に依存しない", () => {
  it("core に何も注入していなくても server のロガーは実体を持つ", () => {
    resetLogSink(); // core は黙る状態
    const l = serverChildLog({ component: "test" });
    // pino のロガーであること（no-op のスタブではない）
    expect(typeof l.info).toBe("function");
    expect(typeof l.isLevelEnabled).toBe("function");
    expect(l.level).toBeTruthy();
  });

  it("server のロガーは core の childLog とは別物", () => {
    const s = serverChildLog({ component: "test" });
    const c = coreChildLog({ component: "test" });
    // core 側は薄いラッパで、pino の API（level 等）を持たない
    expect("level" in s).toBe(true);
    expect("level" in c).toBe(false);
  });
});

describe("core は既定で黙る（ライブラリは利用側にロガーを強制しない）", () => {
  it("注入前は何も出力しない", () => {
    resetLogSink();
    const l = coreChildLog({ component: "x" });
    // 呼んでも例外にならず、出力先が無いので isDebugEnabled は false
    expect(() => l.debug("消える")).not.toThrow();
    expect(l.isDebugEnabled()).toBe(false);
  });

  it("注入すると出力先に届く", () => {
    const seen: string[] = [];
    setLogSink((bindings) => ({
      debug: (m) => seen.push(`${String(bindings["component"])}:${m}`),
      info: (m) => seen.push(m),
      warn: (m) => seen.push(m),
      error: (m) => seen.push(m),
      isDebugEnabled: () => true
    }));
    const l = coreChildLog({ component: "x" });
    l.debug("届く");
    expect(seen).toEqual(["x:届く"]);
    expect(l.isDebugEnabled()).toBe(true);
  });

  it("先に取得したロガーにも後からの注入が効く", () => {
    // 利用側はモジュールのトップレベルで childLog を束縛するため、
    // 束縛時に出力先を確定させると「起動時の注入が効かない」ことになる
    const l = coreChildLog({ component: "early" });
    const seen: string[] = [];
    setLogSink(() => ({
      debug: (m) => seen.push(m),
      info: () => {},
      warn: () => {},
      error: () => {},
      isDebugEnabled: () => true
    }));
    l.debug("あとから");
    expect(seen).toEqual(["あとから"]);
  });
});
