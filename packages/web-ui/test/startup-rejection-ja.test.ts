import { describe, it, expect, vi } from "vitest";
import {
  startupRejectionText,
  wsErrorNotice,
  openErrorText,
  STARTUP_CODE_MEANING_JA,
  MSG_SESSION_REJECTED_HEAD,
  noticeFor
} from "../src/composables/opMessages.js";

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
  it("**日本語の表は、tn5250 の失敗のコードの一覧と同じ**（`packages/tn5250/test/startup-record.test.ts` の `STARTUP_FAILURE_CODES` と同じ並び）", () => {
    const failureCodes = [
      "2702", "2703", "2777", "8901", "8902", "8903", "8906", "8907", "8910", "8916", "8917", "8918", "8920", "8921", "8922",
      "8923", "8925", "8928", "8929", "8930", "8934", "8935", "8936", "8937", "8940", "I904"
    ];
    expect(Object.keys(STARTUP_CODE_MEANING_JA).sort()).toEqual([...failureCodes].sort());
  });
});

describe("出し分け", () => {
  it("**開いたあとのエラー（繋ぎ直しで断られた等）も日本語の理由**", () => {
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
  it("プリンターを開くときも（8925 など）", async () => {
    const msg = "printer session rejected (8925: Creation of device failed.)";
    const p = openPrinterSession({ type: "open", kind: "printer", host: "h" } as never, "p");
    captured.handlers.onServerMessage({ type: "error", code: "SESSION_REJECTED", message: msg });
    await expect(p).rejects.toThrow(startupRejectionText(msg)!);
  });
});
