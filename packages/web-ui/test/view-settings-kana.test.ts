import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveSbcsView, viewSettings, initViewSettings, VIEW_ITEMS } from "../src/stores/viewSettings.js";

/**
 * **表示コード切替（ACS の半角カナ ⇔ 英小文字）が CCSID に対して対称であること。**
 *
 * CCSID 930 の SBCS 部（CP290）と 939 の SBCS 部（CP1027）はカタカナと英小文字の位置が
 * 入れ替わった鏡像で、切替とは「もう一方の表で読み直すこと」に他ならない。
 * 以前は 930 の表でしか再解釈しておらず、**ホストが 930 のセッションでは
 * 「セッションのコーデックと同じ表で読み直す」＝結果が変わらない**ため、
 * 切替が無反応だった（利用者報告）。
 */
describe("resolveSbcsView — ホストの表と同じ向きなら再解釈しない", () => {
  it("auto はどちらのホストでもホストの表のまま（＝既定の見た目を変えない）", () => {
    expect(resolveSbcsView("auto", true)).toBe("host"); // 930/5026
    expect(resolveSbcsView("auto", false)).toBe("host"); // 939/1399/5035
  });

  it("英小文字系ホスト（939 等）では kana だけが再解釈になる", () => {
    expect(resolveSbcsView("kana", false)).toBe("kana"); // 930 の表で読み直す
    expect(resolveSbcsView("latin", false)).toBe("host"); // 既にその向き
  });

  /** これが直った不具合そのもの。以前はここが常に「930 の表で読み直す」＝無反応だった。 */
  it("カタカナ系ホスト（930/5026）では latin だけが再解釈になる", () => {
    expect(resolveSbcsView("latin", true)).toBe("latin"); // 939 の表で読み直す
    expect(resolveSbcsView("kana", true)).toBe("host"); // 既にその向き
  });
});

describe("表示コードの選択肢", () => {
  it("画面設定・キー順送りが 3 値（自動/カナ/英）を扱える", () => {
    const item = VIEW_ITEMS.find((i) => i.key === "kana")!;
    expect(item.opts.map((o) => o.value)).toEqual(["auto", "kana", "latin"]);
  });

  it("cycle が 3 値を一巡する", () => {
    viewSettings.set("kana", "auto");
    expect(viewSettings.cycle("kana")?.valueLabel).toBe("カナ");
    expect(viewSettings.settings.kana).toBe("kana");
    expect(viewSettings.cycle("kana")?.valueLabel).toBe("英");
    expect(viewSettings.settings.kana).toBe("latin");
    expect(viewSettings.cycle("kana")?.valueLabel).toBe("自動");
    expect(viewSettings.settings.kana).toBe("auto");
  });
});

/**
 * **旧設定（boolean）の移行。利用者から見た挙動を変えないことが要件。**
 *
 * 旧 `false`（英）は再解釈しない挙動だった＝新 `auto` と同じ。
 * 旧 `true`（カナ）は 930 の表で読み直す挙動＝新 `kana`（カナ系ホストでは
 * `resolveSbcsView` が `host` に倒すので、そちらも従来どおり無変化）。
 */
describe("旧 kana: boolean の移行", () => {
  const KEY = "as400.view.settings";
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  const loadWith = (kana: unknown): unknown => {
    localStorage.setItem(KEY, JSON.stringify({ kana }));
    initViewSettings();
    return viewSettings.settings.kana;
  };

  it("旧 true（カナ）は kana になる", () => {
    expect(loadWith(true)).toBe("kana");
  });

  it("旧 false（英）は auto になる（＝再解釈しない従来の挙動）", () => {
    expect(loadWith(false)).toBe("auto");
  });

  it("新しい 3 値はそのまま読める", () => {
    expect(loadWith("auto")).toBe("auto");
    expect(loadWith("kana")).toBe("kana");
    expect(loadWith("latin")).toBe("latin");
  });

  it("保存値が無ければ既定は auto（新規利用者の見た目もホストの表のまま）", () => {
    initViewSettings();
    expect(viewSettings.settings.kana).toBe("auto");
  });
});
