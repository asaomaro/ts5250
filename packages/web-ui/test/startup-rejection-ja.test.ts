import { describe, it, expect, vi } from "vitest";
import {
  startupRejectionText,
  wsErrorNotice,
  openErrorText,
  STARTUP_CODE_MEANING_JA,
  MSG_SESSION_REJECTED_HEAD,
  noticeFor
} from "../src/composables/opMessages.js";
import { knownStartupCodes, STARTUP_SUCCESS_CODES } from "@ts5250/tn5250/browser";

/**
 * **起動応答で断られた理由を日本語で出す**（`20260921-startup-codes-japanese`）。サーバーの文言は英語なので、コードを拾って意味に置き換える。
 * ACS もコードごとの文言を出す（`KEY_5250_CONNECTION_ERR_<コード>`）。
 */
let captured: { handlers: { onServerMessage: (m: unknown) => void } };
vi.mock("../src/ws-client.js", () => ({
  wsUrl: () => "ws://test/ws",
  WsClient: class {
    send = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(_url: string, handlers: any) {
      captured = { handlers };
    }
    connect() {
      return Promise.resolve();
    }
    close() {}
    setHiddenIndexes() {}
    setSessionId() {}
  }
}));
const { openSession, openPrinterSession } = await import("../src/session-controller.js");

const REJECTED = "session rejected (8902: Device not available.)（装置 DSP01）";

describe("startupRejectionText", () => {
  it("**コード・日本語の意味・装置名**", () => {
    expect(startupRejectionText(REJECTED)).toBe(`${MSG_SESSION_REJECTED_HEAD}（8902: ${STARTUP_CODE_MEANING_JA["8902"]}・装置 DSP01）`);
  });
  it("プリンター・答え直しの最中の時間切れの文言からも読む", () => {
    expect(startupRejectionText("printer session rejected (8925: Creation of device failed.)")).toContain(`8925: ${STARTUP_CODE_MEANING_JA["8925"]}`);
    expect(startupRejectionText("session rejected (8902: Device not available.)（装置 DEV0）; the host did not ask for another name within 15000ms")).toContain("装置 DEV0");
  });
  it("表に無いコードは、そう分かる文言", () => {
    expect(startupRejectionText("session rejected (0004: unknown startup response)")).toBe(`${MSG_SESSION_REJECTED_HEAD}（0004: 意味の分からない起動応答です）`);
  });
  it("コードが読めなければ undefined", () => {
    expect(startupRejectionText("closed during negotiation")).toBeUndefined();
  });
  it("**日本語の表は、tn5250 の表の失敗のコードとちょうど同じ**（一覧を手書きで 2 つ持たず、tn5250 の表と直接比べる。節目の点検の指摘）", () => {
    const failureCodes = knownStartupCodes().filter((c) => !STARTUP_SUCCESS_CODES.has(c));
    expect(Object.keys(STARTUP_CODE_MEANING_JA).sort()).toEqual([...failureCodes].sort());
  });
});

describe("出し分け", () => {
  it("**開いたあとのエラー（`error`）も日本語の理由**（自動の繋ぎ直しの拒否は `closed` で届く——下のテスト）", () => {
    expect(wsErrorNotice("SESSION_REJECTED", REJECTED)).toBe(startupRejectionText(REJECTED));
    expect(wsErrorNotice("SESSION_REJECTED", "something else")).toBe(noticeFor("SESSION_REJECTED"));
  });
  it("開く前の失敗: 起動応答だけ置き換え、他は従来どおり code と文言", () => {
    expect(openErrorText("SESSION_REJECTED", REJECTED)).toBe(startupRejectionText(REJECTED));
    expect(openErrorText("CONNECT_FAILED", "connect ECONNREFUSED")).toBe("CONNECT_FAILED: connect ECONNREFUSED");
  });
  it("**ランチャーに出る Error の文言が日本語になる**（`openSession` の reject）", async () => {
    const p = openSession({ type: "open", host: "h" }, "t");
    captured.handlers.onServerMessage({ type: "error", code: "SESSION_REJECTED", message: REJECTED });
    await expect(p).rejects.toThrow(startupRejectionText(REJECTED)!);
  });
  it("**自動の繋ぎ直しがホストに断られて終わったとき（`closed` の理由）も日本語の理由を出す**", async () => {
    const { sessionsStore } = await import("../src/stores/sessions.js");
    const p = openSession({ type: "open", host: "h" }, "t");
    captured.handlers.onServerMessage({ type: "opened", sessionId: "s1", screen: { sessionId: "s1", rows: 24, cols: 80, cursor: { row: 1, col: 1 }, keyboardLocked: false, cells: [], fields: [] } });
    await p;
    captured.handlers.onServerMessage({ type: "closed", sessionId: "s1", reason: REJECTED, ended: true });
    expect(sessionsStore.get("s1")!.notice).toBe(startupRejectionText(REJECTED));
  });

  it("起動応答でない終わり方は従来どおり（通知を消すだけ）", async () => {
    const { sessionsStore } = await import("../src/stores/sessions.js");
    const p = openSession({ type: "open", host: "h" }, "t");
    captured.handlers.onServerMessage({ type: "opened", sessionId: "s2", screen: { sessionId: "s2", rows: 24, cols: 80, cursor: { row: 1, col: 1 }, keyboardLocked: false, cells: [], fields: [] } });
    await p;
    sessionsStore.get("s2")!.notice = "前の通知";
    captured.handlers.onServerMessage({ type: "closed", sessionId: "s2", reason: "socket closed", ended: true });
    expect(sessionsStore.get("s2")!.notice).toBeUndefined();
  });

  it("プリンターを開くときも（8925 など）", async () => {
    const msg = "printer session rejected (8925: Creation of device failed.)";
    const p = openPrinterSession({ type: "open", kind: "printer", host: "h" } as never, "p");
    captured.handlers.onServerMessage({ type: "error", code: "SESSION_REJECTED", message: msg });
    await expect(p).rejects.toThrow(startupRejectionText(msg)!);
  });
});
