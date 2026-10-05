// @vitest-environment jsdom
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { installReloadGuard, isReloadKey } from "../src/composables/reloadGuard.js";

/**
 * **キーボードからの再読み込みを止める**（利用者の指示）。再読み込みすると開いているセッションへ自動では戻れないので、
 * 誤って押しやすい F5（5250 のファンクションキーでもある）と Ctrl+R だけを止める。
 * ブラウザの再読み込みボタンと、キャッシュを捨てる再読み込み（Ctrl+Shift+R など）は止めない
 */
const key = (key: string, mods: Partial<Record<"ctrlKey" | "shiftKey" | "altKey" | "metaKey", boolean>> = {}) => ({
  key,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods
});

describe("止めるキーの判定", () => {
  it("素の F5 と Ctrl+R（大文字・小文字とも）は止める", () => {
    expect(isReloadKey(key("F5"))).toBe(true);
    expect(isReloadKey(key("r", { ctrlKey: true }))).toBe(true);
    expect(isReloadKey(key("R", { ctrlKey: true }))).toBe(true);
  });

  it("**Ctrl+Shift+R は止めない**（意図した再読み込みの口を残す）。Ctrl+F5・Shift+F5 も同じ", () => {
    expect(isReloadKey(key("R", { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isReloadKey(key("r", { ctrlKey: true, shiftKey: true }))).toBe(false);
    expect(isReloadKey(key("F5", { ctrlKey: true }))).toBe(false);
    expect(isReloadKey(key("F5", { shiftKey: true }))).toBe(false);
  });

  it("ほかのキー・ほかの修飾の組は触らない", () => {
    expect(isReloadKey(key("r"))).toBe(false);
    expect(isReloadKey(key("r", { ctrlKey: true, altKey: true }))).toBe(false);
    expect(isReloadKey(key("r", { metaKey: true }))).toBe(false);
    expect(isReloadKey(key("F4"))).toBe(false);
    expect(isReloadKey(key("F6"))).toBe(false);
    expect(isReloadKey(key("e", { ctrlKey: true }))).toBe(false);
  });
});

describe("window への取り付け", () => {
  let off: (() => void) | undefined;
  afterEach(() => off?.());

  const press = (init: KeyboardEventInit): KeyboardEvent => {
    const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
    document.body.dispatchEvent(ev);
    return ev;
  };

  it("F5・Ctrl+R の既定の動作（再読み込み）を取り消す", () => {
    off = installReloadGuard();
    expect(press({ key: "F5" }).defaultPrevented).toBe(true);
    expect(press({ key: "r", ctrlKey: true }).defaultPrevented).toBe(true);
  });

  it("Ctrl+Shift+R は取り消さない", () => {
    off = installReloadGuard();
    expect(press({ key: "R", ctrlKey: true, shiftKey: true }).defaultPrevented).toBe(false);
  });

  it("**伝播は止めない**——F5 を AID キーとして受けるペインの処理はそのまま走る", () => {
    off = installReloadGuard();
    const seen: string[] = [];
    const onPane = (e: Event): void => void seen.push((e as KeyboardEvent).key);
    document.body.addEventListener("keydown", onPane);
    try {
      press({ key: "F5" });
      expect(seen).toEqual(["F5"]);
    } finally {
      document.body.removeEventListener("keydown", onPane);
    }
  });

  it("取り付けなければ何も取り消さない（取り外しが効く）", () => {
    installReloadGuard()();
    expect(press({ key: "F5" }).defaultPrevented).toBe(false);
  });
});

describe("入口での配線", () => {
  const src = join(dirname(fileURLToPath(import.meta.url)), "..", "src");
  for (const entry of ["main.ts", "embed.ts"]) {
    it(`${entry} が installReloadGuard を呼ぶ`, () => {
      expect(readFileSync(join(src, entry), "utf8")).toMatch(/^installReloadGuard\(\);/m);
    });
  }
});
