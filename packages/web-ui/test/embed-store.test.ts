import { describe, it, expect, beforeEach, vi } from "vitest";
import { reactive } from "vue";
import { appKindFromQuery, embedStore, initEmbedBridge, postToHost } from "../src/stores/embed.js";
import { EMBED_APP_KINDS } from "../src/embed-protocol.js";

/**
 * `embed.html` ⇄ 拡張ホストの`postMessage`橋渡し
 * （`.aidev/works/20260924-vscode-extension/architecture.md`「メッセージプロトコル」）。
 */
describe("postToHost", () => {
  it("親フレームが無ければ何もしない（トップレベルでブラウザ単体で開いた場合）", () => {
    // jsdom の既定は window.parent === window
    expect(() => postToHost({ type: "ready" })).not.toThrow();
  });

  /**
   * **Vue のリアクティブ値を含んでも送れる**（D34）。ブラウザの`postMessage`は構造化複製で、Proxy（`ref`/`reactive`の中身）は
   * `DataCloneError`になる——保存ボタンで入力中の値を`ref`に持った結果、実際の VSCode で「保存」も「接続」も送れなくなった
   */
  it("リアクティブ値（Proxy）を含むメッセージも素の値にして送る", () => {
    const post = vi.fn((msg: unknown) => void structuredClone(msg));
    vi.spyOn(window, "parent", "get").mockReturnValue({ postMessage: post } as unknown as Window);
    const payload = reactive({ host: "AS400", watermark: { text: "検証機" } });
    expect(() => postToHost({ type: "save", payload })).not.toThrow();
    expect(post).toHaveBeenCalledWith({ type: "save", payload: { host: "AS400", watermark: { text: "検証機" } } }, "*");
    vi.restoreAllMocks();
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
    embedStore.loaded = undefined;
    embedStore.connect = undefined;
    embedStore.error = undefined;
  });

  /**
   * **`loaded`/`saved`は接続の合図ではない**（`20260924-vscode-extension` D17。
   * ファイルを開く／保存しただけでは接続しない、という利用者の要望）。
   * `connect`（「接続」ボタン押下に応えた拡張ホストからの応答）だけが
   * `embedStore.connect`を立てる。
   */
  it("loaded メッセージは embedStore.loaded だけを更新し、connect には触れない", () => {
    const payload = { app: "emulator" as const, host: "h1" };
    window.dispatchEvent(fromParent({ type: "loaded", payload }));
    expect(embedStore.loaded).toEqual(payload);
    expect(embedStore.connect).toBeUndefined();
    expect(embedStore.error).toBeUndefined();
  });

  it("connect メッセージは embedStore.connect と embedStore.loaded の両方を更新する", () => {
    const payload = { app: "emulator" as const, host: "h1" };
    window.dispatchEvent(fromParent({ type: "connect", payload }));
    expect(embedStore.connect).toEqual(payload);
    expect(embedStore.loaded).toEqual(payload);
    expect(embedStore.error).toBeUndefined();
  });

  it("saved メッセージは embedStore.loaded だけを更新し、connect には触れない（保存しただけでは接続しない）", () => {
    const payload = { app: "sql" as const, host: "h2", systemRef: "own:1" };
    window.dispatchEvent(fromParent({ type: "saved", payload }));
    expect(embedStore.loaded).toEqual(payload);
    expect(embedStore.connect).toBeUndefined();
  });

  it("saved は既に接続中（connectが立っている）でもconnectを上書きしない", () => {
    const connected = { app: "sql" as const, host: "h1", systemRef: "own:1" };
    window.dispatchEvent(fromParent({ type: "connect", payload: connected }));
    const savedLater = { app: "sql" as const, host: "h2", systemRef: "own:1" };
    window.dispatchEvent(fromParent({ type: "saved", payload: savedLater }));
    expect(embedStore.connect).toEqual(connected); // 接続中のセッションはsaveで変わらない
    expect(embedStore.loaded).toEqual(savedLater); // 表示用の値だけ最新化される
  });

  /** 設定フォームは`loadedRev`を`key`にする（D23）——自分の自動保存の応答（saved）で作り直すと入力中の文字が消える */
  it("loadedRev は loaded でだけ進み、saved では進まない（savedは savedRev を進める）", () => {
    const before = embedStore.loadedRev;
    const savedBefore = embedStore.savedRev;
    window.dispatchEvent(fromParent({ type: "saved", payload: { app: "emulator", host: "h" } }));
    expect(embedStore.loadedRev).toBe(before);
    expect(embedStore.savedRev).toBe(savedBefore + 1);
    window.dispatchEvent(fromParent({ type: "loaded", payload: { app: "emulator", host: "h" } }));
    expect(embedStore.loadedRev).toBe(before + 1);
    expect(embedStore.savedRev).toBe(savedBefore + 1);
  });

  it("fileInvalid は loaded を捨てる（読めないファイルの設定を出し続けると、入力1つで上書きしてしまう）が、saveError は捨てない", () => {
    window.dispatchEvent(fromParent({ type: "loaded", payload: { app: "emulator", host: "h" } }));
    window.dispatchEvent(fromParent({ type: "saveError", message: "競合" }));
    expect(embedStore.loaded).toBeDefined();
    window.dispatchEvent(fromParent({ type: "fileInvalid", message: "JSON不正" }));
    expect(embedStore.loaded).toBeUndefined();
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

/**
 * URLクエリの種別（D21）。以前は`embed.ts`が独自の一覧を持ち、D20で`spool`を足したときに漏れて
 * スプールの画面が`emulator`（「5250端末」）として出た。**一覧（`EMBED_APP_KINDS`）の全要素で回す**
 * ので、種別を足しても自動で検査対象に入る
 */
describe("appKindFromQuery", () => {
  it.each(EMBED_APP_KINDS)("?app=%s はその種別として読む", (kind) => {
    expect(appKindFromQuery(`?app=${kind}`)).toBe(kind);
  });

  it("未知の値・未指定は emulator", () => {
    expect(appKindFromQuery("?app=printer2")).toBe("emulator");
    expect(appKindFromQuery("")).toBe("emulator");
  });

  it("spool のメッセージも受け付ける（許可リストが一覧と同じ）", () => {
    initEmbedBridge();
    embedStore.loaded = undefined;
    const payload = { app: "spool" as const, host: "h" };
    window.dispatchEvent(new MessageEvent("message", { data: { type: "loaded", payload }, source: window }));
    expect(embedStore.loaded).toEqual(payload);
  });
});
