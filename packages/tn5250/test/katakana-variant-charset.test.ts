import { describe, it, expect } from "vitest";
import { Session5250 } from "../src/session/session.js";
import { FakeTransport } from "./helpers/fake-transport.js";
import { IAC, CMD, OPT, ENV_SEND, ENV_USERVAR, ENV_VALUE } from "../src/telnet/constants.js";

/**
 * **930 の `katakanaVariant` が、実際に申告する CHARSET を切り替えるか**（`20260922-katakana-variant-setting`。
 * 5026 は対象外——`20260922-katakana-selector-merge` D1）。`deviceEnvFor` 自体は
 * `packages/base/test/device-env.test.ts` で固定済み。ここは `Session5250.establish`
 * が `opts.katakanaVariant` を実際に `deviceEnvFor` へ渡し、`TelnetLayer` の申告まで届くこと（配線）を見る。
 */
function ascii(s: string): number[] {
  return [...s].map((c) => c.charCodeAt(0));
}

/** ENV_SEND を送って CHARSET の申告値を読み取る。connect() の解決は待たず transport だけ見る */
async function charsetSentFor(katakanaVariant?: "katakana" | "katakana-ex"): Promise<string> {
  const t = new FakeTransport();
  const p = Session5250.connect({
    id: "t",
    transport: t,
    ccsid: 930,
    ...(katakanaVariant !== undefined ? { katakanaVariant } : {}),
    negotiationTimeoutMs: 50,
    warn: () => {}
  });
  p.catch(() => {}); // 時間切れで reject する。この테스트では待たない（配線だけを見る）
  await new Promise((r) => setTimeout(r, 10));
  t.feed(IAC, CMD.SB, OPT.NEW_ENVIRON, ENV_SEND, IAC, CMD.SE);
  const sent = t.takeSent();
  const label = ascii("CHARSET");
  const at = sent.findIndex((_, i) => label.every((b, j) => sent[i + j] === b));
  expect(at, "CHARSET を送っている").toBeGreaterThanOrEqual(0);
  const valueStart = at + label.length + 1; // ENV_VALUE の 1 バイト分をまたぐ
  expect(sent[at + label.length]).toBe(ENV_VALUE);
  const valueEnd = sent.indexOf(ENV_USERVAR, valueStart);
  const bytes = sent.slice(valueStart, valueEnd < 0 ? undefined : valueEnd);
  // NEW-ENVIRON は NVT ASCII（RFC 1572）で送る。EBCDIC ではない（telnet.test.ts の ascii() と同じ）
  return String.fromCharCode(...bytes);
}

describe("930 の katakanaVariant が申告する CHARSET", () => {
  it('未指定は現状どおり 1172（Katakana Extended 寄り。既存利用者の挙動を変えない）', async () => {
    expect(await charsetSentFor(undefined)).toBe("1172");
  });

  it('"katakana-ex" も 1172', async () => {
    expect(await charsetSentFor("katakana-ex")).toBe("1172");
  });

  it('"katakana" は 332', async () => {
    expect(await charsetSentFor("katakana")).toBe("332");
  });
});
