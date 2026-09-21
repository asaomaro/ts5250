import { describe, it, expect } from "vitest";
import { DeviceNameGenerator, nextDeviceName, upperDeviceName, hasDeviceNameSymbols } from "../src/telnet/device-name.js";

/**
 * **装置名の置換記号**（ACS `AutoDeviceName5250`。`20260921-device-name-acs`）。
 * 期待値の規則は ACS のコアを PUB400 に当ててタップで採った DEVNAME で確かめたもの（research F2〜F5）。
 * 実測の利用者名・機械名は記録に残さないので、ここでは合成の名前で同じ規則を当てる。
 */
const gen = (p: string, env = {}, retry = false) => new DeviceNameGenerator(p, env, retry);

describe("記号の無い名前", () => {
  it("**大文字にして**そのまま送る（実測: `tsLow1x` → `TSLOW1X`）", () => {
    expect(gen("tsLow1x").next()).toBe("TSLOW1X");
  });
  it("何度聞かれても同じ名前（実測: 使用中でも同じ名前を送り直すだけ）。答え直せない", () => {
    const g = gen("DEV1");
    expect([g.next(), g.next()]).toEqual(["DEV1", "DEV1"]);
    expect(g.canRetry()).toBe(false);
  });
  it("トルコ語の İ は I に寄せる（ACS `NVT5250`）", () => {
    expect(upperDeviceName("İX")).toBe("IX");
  });
});

describe("置換記号", () => {
  it("`%` は表示なら S・プリンターなら P、`*` はセッション名（無ければ A）（実測: `W%*` → `WSA`）", () => {
    expect(gen("W%*").next()).toBe("WSA");
    expect(gen("W%*", { printer: true }).next()).toBe("WPA");
    expect(gen("W%*", { sessionName: "BCD" }).next()).toBe("WSBC");
    expect(gen("W%*", { sessionName: "b" }).next()).toBe("WS0B");
  });
  it("**`&` を含むと記号以外の文字は落ちる**（実測: `T%*&USERN` の `T` は送られない）", () => {
    // 位置 3 の `&` で、残り 10−3−0 = 7 文字。長すぎれば**右**を残す
    expect(gen("T%*&USERN", { userName: "abcdefgh" }).next()).toBe("SABCDEFGH");
  });
  it("`+` があれば**左**を残す（残りは 1 増える。実測の `T%*+&USERN` と同じ形）", () => {
    // 位置 4 の `&`: 10−4−0+1 = 7 文字、左の 7 文字
    expect(gen("T%*+&USERN", { userName: "abcdefgh" }).next()).toBe("SAABCDEFG");
  });
  it("`&COMPN` は機械名（位置 1 なら 9 文字。長ければ右）", () => {
    expect(gen("U&COMPN", { computerName: "host-name-12345" }).next()).toBe("AME-12345");
    expect(gen("U&compn", { computerName: "pc1" }).next(), "語は大文字小文字を問わない").toBe("PC1");
  });
  it("名前が取れなければ記号のまま返し、答え直せない（ACS は状態 9）", () => {
    const g = gen("X&USERN");
    expect(g.next()).toBe("X&USERN");
    expect(g.canRetry()).toBe(false);
  });
  it("`%` `*` だけのパターンは何度聞かれても同じ（番号を使わないので一巡と取り違えない）", () => {
    const g = gen("W%*");
    expect([g.next(), g.next(), g.next()]).toEqual(["WSA", "WSA", "WSA"]);
  });
  it("記号の判定", () => {
    expect(hasDeviceNameSymbols("DEV1")).toBe(false);
    expect(hasDeviceNameSymbols("DEV=")).toBe(true);
    expect(hasDeviceNameSymbols("&USERN")).toBe(true);
  });
});

describe("`=`（衝突を避ける番号）", () => {
  it("**聞かれるたびに 0 から進む**（実測: `TSC=` は `TSC0` が使用中で、同じ接続の中で `TSC1`）", () => {
    const g = gen("TSC=");
    expect(g.next()).toBe("TSC0");
    expect(g.canRetry()).toBe(true);
    expect(g.next()).toBe("TSC1");
  });
  it("0〜9 の次は A〜Z。Z の次は使い切り（記号のまま返し、答え直せない）", () => {
    const g = gen("T=");
    const names = Array.from({ length: 36 }, () => g.next());
    expect(names.slice(8, 12)).toEqual(["T8", "T9", "TA", "TB"]);
    expect(names[35]).toBe("TZ");
    expect(g.next()).toBe("T=");
    expect(g.canRetry()).toBe(false);
  });
  it("開始番号を指定できる（ACS の「重複名を避ける」開始番号）", () => {
    expect(gen("T=", { startIndex: 5 }).next()).toBe("T5");
  });
  it("2 つ以上なら乱数の位置から 36 進で数え、**先頭の `=` が最も速く回る**（原典の読み）", () => {
    // 2 つ: 乱数 × 1295。700 = 19×36 + 16 → 先頭が 16（G）、次が 19（J）
    const g = gen("E==", { random: () => 700 / 1295 });
    expect(g.next()).toBe("EGJ");
    expect(g.next()).toBe("EHJ");
  });
});

describe("当 PJ の繰り上げ（`deviceNameRetry`。ACS には無い）", () => {
  it("記号の無い名前でも、聞き直されたら末尾の数字を繰り上げる（5 回まで）", () => {
    const g = gen("WEBEMU01", {}, true);
    expect(g.next()).toBe("WEBEMU01");
    expect(g.canRetry()).toBe(true);
    expect(g.next()).toBe("WEBEMU02");
    for (let i = 0; i < 4; i++) g.next();
    expect(g.canRetry()).toBe(false);
  });
});

describe("nextDeviceName", () => {
  it("末尾の数字を桁を保って繰り上げる", () => {
    expect(nextDeviceName("WEBEMU01")).toBe("WEBEMU02");
    expect(nextDeviceName("WEBEMU09")).toBe("WEBEMU10");
    expect(nextDeviceName("DEV1")).toBe("DEV2");
  });
  it("数字が無ければ 2 を足す（10 文字上限を超えるなら打ち止め）", () => {
    expect(nextDeviceName("WEBEMU")).toBe("WEBEMU2");
    expect(nextDeviceName("ABCDEFGHIJ")).toBeUndefined();
  });
  it("桁が増えるなら打ち止め（装置名は 10 文字まで）", () => {
    expect(nextDeviceName("WEBEMU99")).toBeUndefined();
    expect(nextDeviceName("DEV9")).toBeUndefined();
  });
});
