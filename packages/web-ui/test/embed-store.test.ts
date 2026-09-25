import { describe, it, expect, beforeEach, vi } from "vitest";
import { embedStore, initEmbedBridge, postToHost } from "../src/stores/embed.js";

/**
 * `embed.html` ⇄ 拡張ホストの`postMessage`橋渡し
 * （`.aidev/works/20260924-vscode-extension/architecture.md`「メッセージプロトコル」）。
 */
describe("postToHost", () => {
  it("親フレームが無ければ何もしない（トップレベルでブラウザ単体で開いた場合）", () => {
    // jsdom の既定は window.parent === window
    expect(() => postToHost({ type: "ready" })).not.toThrow();
  });

  it("親フレームがあれば postMessage する", () => {
    const post = vi.fn();
    vi.spyOn(window, "parent", "get").mockReturnValue({ postMessage: post } as unknown as Window);
    postToHost({ type: "ready" });
    expect(post).toHaveBeenCalledWith({ type: "ready" }, "*");
    vi.restoreAllMocks();
  });
});

describe("initEmbedBridge", () => {
  // 実運用（embed.ts）でも1度しか呼ばない。テストごとに呼ぶとlistenerが積み重なるため、
  // ここでも1度だけ呼び、各テストはstateのリセットとdispatchだけを行う
  initEmbedBridge();

  // **`event.source === window.parent` を検査する**（`stores/embed.ts`）。jsdomでは
  // window.parent === window なので、正規の送信元を装うテストは source: window を明示する
  const fromParent = (data: unknown) => new MessageEvent("message", { data, source: window });

  beforeEach(() => {
    embedStore.connect = undefined;
    embedStore.error = undefined;
  });

  it("connect メッセージで embedStore.connect を更新する", () => {
    const payload = { app: "emulator" as const, host: "h1" };
    window.dispatchEvent(fromParent({ type: "connect", payload }));
    expect(embedStore.connect).toEqual(payload);
    expect(embedStore.error).toBeUndefined();
  });

  it("saved メッセージも connect と同じ扱い", () => {
    const payload = { app: "sql" as const, host: "h2", systemRef: "own:1" };
    window.dispatchEvent(fromParent({ type: "saved", payload }));
    expect(embedStore.connect).toEqual(payload);
  });

  it("saveError/fileInvalid メッセージで embedStore.error を更新する", () => {
    window.dispatchEvent(fromParent({ type: "saveError", message: "復号失敗" }));
    expect(embedStore.error).toBe("復号失敗");
    window.dispatchEvent(fromParent({ type: "fileInvalid", message: "JSON不正" }));
    expect(embedStore.error).toBe("JSON不正");
  });

  it("型が違う/形が無いメッセージは無視する", () => {
    window.dispatchEvent(fromParent("not-an-object"));
    window.dispatchEvent(fromParent({ foo: "bar" }));
    expect(embedStore.connect).toBeUndefined();
    expect(embedStore.error).toBeUndefined();
  });

  it("親フレーム以外（source不一致）からのメッセージは無視する", () => {
    const payload = { app: "emulator" as const, host: "attacker" };
    window.dispatchEvent(new MessageEvent("message", { data: { type: "connect", payload }, source: null }));
    expect(embedStore.connect).toBeUndefined();
  });

  it("形が違うpayload（hostが文字列でない・appが未知）は無視する（taskcheck T4の指摘）", () => {
    window.dispatchEvent(fromParent({ type: "connect", payload: { app: "emulator", host: 123 } }));
    expect(embedStore.connect).toBeUndefined();
    window.dispatchEvent(fromParent({ type: "connect", payload: { app: "not-a-real-app", host: "h" } }));
    expect(embedStore.connect).toBeUndefined();
  });

  it("messageが文字列でない（数値等）saveError/fileInvalidは無視する", () => {
    window.dispatchEvent(fromParent({ type: "saveError", message: 42 }));
    expect(embedStore.error).toBeUndefined();
  });
});
