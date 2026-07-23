import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * 書き出しプログラムが処理できないスプールの拾い上げ。
 *
 * 日本語機では IGC（DBCS）付きの帳票が仮想プリンター装置で書き出せず、ホストが CPA3303 を
 * 出して待ち状態になる（実機で確認）。放っておくと帳票が 1 枚も届かず、後続も止まる。
 * ネットワーク印刷サーバー経由の取得はこの制約を受けないので、そちらで読んで
 * push 型と同じ帳票として配る。
 *
 * ここで固定するのは**判断の部分**——何を拾い、何を拾わないか、読めなかったときどうするか。
 * 実際の取得はホスト依存なので差し替える。
 */
const listSpools = vi.fn();
const readSpoolPages = vi.fn();
const retrieveMessage = vi.fn();
const answerMessage = vi.fn();
const closeNp = vi.fn();

vi.mock("../src/host-spools.js", () => ({
  listSpools: (...a: unknown[]) => listSpools(...a),
  readSpoolPages: (...a: unknown[]) => readSpoolPages(...a),
  DEFAULT_SPOOL_CCSID: 273
}));
vi.mock("../src/host-connect.js", () => ({
  openNetPrint: async () => ({
    retrieveMessage: (...a: unknown[]) => retrieveMessage(...a),
    answerMessage: (...a: unknown[]) => answerMessage(...a),
    close: closeNp
  })
}));

const { rescueStuckSpools } = await import("../src/spool-rescue.js");

const OPTS = { host: "h", user: "u", password: "p" };
const entry = (over: Record<string, unknown> = {}) => ({
  jobName: "DEV1",
  jobUser: "USER",
  jobNumber: "074997",
  fileName: "DSPFMT",
  fileNumber: 1,
  status: "MESSAGE_WAIT",
  ...over
});

beforeEach(() => {
  listSpools.mockReset();
  readSpoolPages.mockReset();
  retrieveMessage.mockReset();
  answerMessage.mockReset();
  closeNp.mockReset();
  readSpoolPages.mockResolvedValue([{ rows: 1, cols: 10, lines: ["取引先ＣＤ"] }]);
  answerMessage.mockResolvedValue(undefined);
  retrieveMessage.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

describe("rescueStuckSpools", () => {
  it("CPA3303 で待っているスプールを取得し、H（保留）で応答する", async () => {
    listSpools.mockResolvedValue({ items: [entry()], truncated: false });
    retrieveMessage.mockResolvedValue({ id: "CPA3303", text: "属性がサポートされていない" });

    const got = await rescueStuckSpools(OPTS, "PRT_TEST");

    expect(got).toHaveLength(1);
    expect(got[0]!.messageId).toBe("CPA3303");
    expect(got[0]!.pages[0]!.lines[0]).toBe("取引先ＣＤ");
    expect(answerMessage).toHaveBeenCalledWith(expect.objectContaining({ id: "CPA3303" }), "H");
  });

  it("待ちが無ければホストへ触りに行かない", async () => {
    listSpools.mockResolvedValue({ items: [entry({ status: "READY" })], truncated: false });
    expect(await rescueStuckSpools(OPTS, "PRT_TEST")).toEqual([]);
    expect(retrieveMessage).not.toHaveBeenCalled();
    expect(answerMessage).not.toHaveBeenCalled();
  });

  /**
   * 用紙タイプのロード要求は「待っていれば解決する」種類なので拾わない。
   * 拾うと push 経路でも届いて**同じ帳票を二重に配る**ことになる。
   */
  it("CPA3394（用紙ロード要求）は拾わない", async () => {
    listSpools.mockResolvedValue({ items: [entry()], truncated: false });
    retrieveMessage.mockResolvedValue({ id: "CPA3394", text: "用紙をロードしてください" });

    expect(await rescueStuckSpools(OPTS, "PRT_TEST")).toEqual([]);
    expect(readSpoolPages, "中身も取りに行かない").not.toHaveBeenCalled();
    expect(answerMessage, "応答もしない").not.toHaveBeenCalled();
  });

  /**
   * **読めなかったら応答しない。** 応答してしまうと、中身を届けないままキューから外れて
   * 帳票が失われたように見える。
   */
  it("中身を読めなければ応答せず、その 1 件を飛ばす", async () => {
    listSpools.mockResolvedValue({ items: [entry()], truncated: false });
    retrieveMessage.mockResolvedValue({ id: "CPA3303", text: "x" });
    readSpoolPages.mockRejectedValue(new Error("read failed"));

    expect(await rescueStuckSpools(OPTS, "PRT_TEST")).toEqual([]);
    expect(answerMessage).not.toHaveBeenCalled();
  });

  it("応答に失敗しても取得済みの帳票は返す（届いたものは捨てない）", async () => {
    listSpools.mockResolvedValue({ items: [entry()], truncated: false });
    retrieveMessage.mockResolvedValue({ id: "CPA3303", text: "x" });
    answerMessage.mockRejectedValue(new Error("answer failed"));

    const got = await rescueStuckSpools(OPTS, "PRT_TEST");
    expect(got).toHaveLength(1);
  });

  it("見張りは指定の出力待ち行列だけを見る（他人のスプールも対象にする）", async () => {
    listSpools.mockResolvedValue({ items: [], truncated: false });
    await rescueStuckSpools(OPTS, "PRT_TEST");
    expect(listSpools).toHaveBeenCalledWith(
      OPTS,
      { outputQueue: "PRT_TEST", user: "*ALL" },
      expect.any(Number)
    );
  });

  it("接続は必ず閉じる（待ちがあってもなくても）", async () => {
    listSpools.mockResolvedValue({ items: [entry()], truncated: false });
    retrieveMessage.mockResolvedValue({ id: "CPA3303", text: "x" });
    await rescueStuckSpools(OPTS, "PRT_TEST");
    expect(closeNp).toHaveBeenCalled();
  });
});

/**
 * **救出した帳票が画面へ届くこと。**
 *
 * ws-handler は当初 `session.on("report")` だけを見ていた。救出した帳票はホストから届いた
 * ものではないのでそのイベントに乗らず、サーバー側には溜まるのに画面へ出なかった。
 * 配る側（`deliverReport`）から必ずフックを叩く形に直した回帰。
 */
describe("救出した帳票の配り先", () => {
  it("push と救出のどちらも同じフックへ流れる", async () => {
    const { SessionManager } = await import("../src/session-manager.js");
    const mgr = new SessionManager();
    const pushed: string[] = [];
    // deliverReport は private なので、entry を組み立てて型経由で叩く
    const entry = {
      id: "p1",
      reports: [] as unknown[],
      waiters: [] as unknown[],
      outputEnabled: true,
      outputWarnings: [],
      outputStatuses: [],
      onReport: (r: { id: string }) => pushed.push(r.id)
    };
    const deliver = (mgr as unknown as {
      deliverReport: (e: unknown, r: unknown) => void;
    }).deliverReport.bind(mgr);

    deliver(entry, { id: "spool-1", pages: [], raw: new Uint8Array(0) });
    deliver(entry, { id: "spool-rescued-DSPFMT-1", pages: [], raw: new Uint8Array(0) });

    expect(pushed, "救出分も画面へ push される").toEqual(["spool-1", "spool-rescued-DSPFMT-1"]);
    expect(entry.reports, "サーバー側にも両方溜まる").toHaveLength(2);
    mgr.closeAll();
  });
});
