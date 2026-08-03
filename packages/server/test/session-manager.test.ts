import { describe, it, expect } from "vitest";
import { SessionManager, nextDeviceName, RESERVATION_TTL_MS } from "../src/session-manager.js";
import { As400Error } from "@ts5250/base";
import { ReplayTransport, parseTraceJsonl } from "@ts5250/tn5250";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// core の実機 fixture を借用（サインオン画面まで到達すれば十分）
const signonFixture = () =>
  parseTraceJsonl(
    readFileSync(join(here, "..", "..", "tn5250", "test", "fixtures", "pub400-signon.jsonl"), "utf8")
  );

function openReplay(mgr: SessionManager, readOnly = false) {
  return mgr.open({ transport: new ReplayTransport(signonFixture()), readOnly });
}

describe("SessionManager", () => {
  it("セッションを開いて get/list できる", async () => {
    const mgr = new SessionManager();
    const entry = await openReplay(mgr);
    expect(mgr.size).toBe(1);
    expect(mgr.get(entry.id).id).toBe(entry.id);
    expect(mgr.list()).toHaveLength(1);
    mgr.closeAll();
  });

  // 上限は **SESSION_LIMIT**。CONNECT_FAILED（＝ホストへ繋げなかった）ではない
  // （`20260729-connect-failed-semantics`。意味ごとの検証は `error-code-semantics.test.ts`）
  it("上限を超えると SESSION_LIMIT", async () => {
    const mgr = new SessionManager({ maxSessions: 1 });
    await openReplay(mgr);
    await expect(openReplay(mgr)).rejects.toSatisfy(
      (e: unknown) => e instanceof As400Error && e.code === "SESSION_LIMIT"
    );
    mgr.closeAll();
  });

  it("不明な sessionId は SESSION_NOT_FOUND", () => {
    const mgr = new SessionManager();
    expect(() => mgr.get("nope")).toThrow(
      expect.objectContaining({ code: "SESSION_NOT_FOUND" })
    );
  });

  it("readOnly セッションは assertWritable で拒否、通常は通す", async () => {
    const mgr = new SessionManager();
    const ro = await openReplay(mgr, true);
    const rw = await openReplay(mgr, false);
    expect(() => mgr.assertWritable(ro.id)).toThrow(
      expect.objectContaining({ code: "READ_ONLY_SESSION" })
    );
    expect(mgr.assertWritable(rw.id).id).toBe(rw.id);
    mgr.closeAll();
  });

  it("readOnly は PageUp/PageDown のみ AID を許可する", async () => {
    const mgr = new SessionManager();
    const ro = await openReplay(mgr, true);
    expect(mgr.assertKeyAllowed(ro.id, "PageUp").id).toBe(ro.id);
    expect(mgr.assertKeyAllowed(ro.id, "PageDown").id).toBe(ro.id);
    expect(() => mgr.assertKeyAllowed(ro.id, "Enter")).toThrow(
      expect.objectContaining({ code: "READ_ONLY_SESSION" })
    );
    expect(() => mgr.assertKeyAllowed(ro.id, "F3")).toThrow(
      expect.objectContaining({ code: "READ_ONLY_SESSION" })
    );
    mgr.closeAll();
  });

  it("close でセッションが除去される", async () => {
    const mgr = new SessionManager();
    const entry = await openReplay(mgr);
    await mgr.close(entry.id);
    expect(mgr.size).toBe(0);
    expect(() => mgr.get(entry.id)).toThrow(
      expect.objectContaining({ code: "SESSION_NOT_FOUND" })
    );
  });

  it("アイドルタイムアウトで掃除される", async () => {
    let t = 1000;
    const mgr = new SessionManager({ idleTimeoutMs: 100, now: () => t });
    const entry = await openReplay(mgr);
    expect(mgr.size).toBe(1);
    t += 200; // アイドル超過
    // sweepIdle は private のため、get の lastActivity 更新前に startIdleSweep 経由で呼ぶ代わりに
    // 直接時間を進めて close 判定を検証（sweep を明示起動）
    (mgr as unknown as { sweepIdle: () => void }).sweepIdle();
    expect(mgr.size).toBe(0);
    void entry;
  });
});

/**
 * **セッションの予約**（HLLAPI の `Reserve`/`Release`）。
 *
 * 自動操作の最中に人間が同じ画面へ書くのを止める仕掛け。検査の要点は 3 つ:
 *
 * 1. 予約中は**持ち主以外の書き込みが断られる**（経路を問わず——検査は `assertWritable` の内側）
 * 2. **期限で自然に解ける**（落ちた自動化は `Release` を送れない）
 * 3. **利用者が取り戻せる**（`forceRelease`）
 */
describe("セッションの予約", () => {
  const setup = async (): Promise<{ mgr: SessionManager; id: string; tick: (ms: number) => void }> => {
    let t = 1000;
    const mgr = new SessionManager({ now: () => t });
    const entry = await openReplay(mgr);
    return { mgr, id: entry.id, tick: (ms) => (t += ms) };
  };
  /** 投げたエラーコードを取り出す（投げなければ `undefined`） */
  const codeOf = (fn: () => unknown): string | undefined => {
    try {
      fn();
      return undefined;
    } catch (e) {
      return e instanceof As400Error ? e.code : "not-As400Error";
    }
  };

  it("予約中は**持ち主以外の書き込みを断る**（人間・MCP＝holder なし）", async () => {
    const { mgr, id } = await setup();
    mgr.reserve(id, "auto", "HLLAPI");
    expect(codeOf(() => mgr.assertWritable(id))).toBe("SESSION_RESERVED");
    expect(codeOf(() => mgr.assertKeyAllowed(id, "Enter"))).toBe("SESSION_RESERVED");
    mgr.closeAll();
  });

  it("**持ち主は通る**（自動化自身は書ける）", async () => {
    const { mgr, id } = await setup();
    mgr.reserve(id, "auto", "HLLAPI");
    expect(mgr.assertWritable(id, undefined, "auto").id).toBe(id);
    expect(mgr.assertKeyAllowed(id, "Enter", undefined, "auto").id).toBe(id);
    mgr.closeAll();
  });

  it("**別の主体は予約できない**（SESSION_RESERVED）", async () => {
    const { mgr, id } = await setup();
    mgr.reserve(id, "auto", "HLLAPI");
    expect(codeOf(() => mgr.reserve(id, "other", "HLLAPI"))).toBe("SESSION_RESERVED");
    mgr.closeAll();
  });

  it("同じ主体の再予約は通る（期限の延長）", async () => {
    const { mgr, id } = await setup();
    mgr.reserve(id, "auto", "HLLAPI");
    expect(mgr.reserve(id, "auto", "HLLAPI").id).toBe(id);
    mgr.closeAll();
  });

  it("**期限が切れたら解ける**（落ちた自動化が締め切ったままにしない）", async () => {
    const { mgr, id, tick } = await setup();
    mgr.reserve(id, "auto", "HLLAPI");
    tick(RESERVATION_TTL_MS + 1);
    expect(mgr.reservationOf(id)).toBeUndefined();
    expect(mgr.assertWritable(id).id).toBe(id);
    mgr.closeAll();
  });

  it("**操作のたびに期限が延びる**（長い自動化の途中で切れない）", async () => {
    const { mgr, id, tick } = await setup();
    mgr.reserve(id, "auto", "HLLAPI");
    for (let i = 0; i < 5; i++) {
      tick(RESERVATION_TTL_MS - 1);
      mgr.touchReservation(id, "auto");
    }
    expect(mgr.reservationOf(id)?.holder).toBe("auto");
    mgr.closeAll();
  });

  it("**持ち主でない解除は効かない**（横から外させない）", async () => {
    const { mgr, id } = await setup();
    mgr.reserve(id, "auto", "HLLAPI");
    mgr.release(id, "other");
    expect(mgr.reservationOf(id)?.holder).toBe("auto");
    mgr.closeAll();
  });

  it("**利用者は強制解除できる**（自動化が落ちたときの非常口）", async () => {
    const { mgr, id } = await setup();
    mgr.reserve(id, "auto", "HLLAPI");
    mgr.forceRelease(id);
    expect(mgr.reservationOf(id)).toBeUndefined();
    expect(mgr.assertWritable(id).id).toBe(id);
    mgr.closeAll();
  });

  it("**予約の変化が購読者へ届く**（ブラウザへ push するため）", async () => {
    const { mgr, id } = await setup();
    const seen: (string | undefined)[] = [];
    mgr.get(id).onReservationChange = (r) => seen.push(r?.label);
    mgr.reserve(id, "auto", "HLLAPI");
    mgr.release(id, "auto");
    expect(seen).toEqual(["HLLAPI", undefined]);
    mgr.closeAll();
  });

  it("**閲覧専用は予約できない**（予約しても書けないので意味が変わらない）", async () => {
    const mgr = new SessionManager({ now: () => 1000 });
    const entry = await openReplay(mgr, true);
    expect(codeOf(() => mgr.reserve(entry.id, "auto", "HLLAPI"))).toBe("READ_ONLY_SESSION");
    mgr.closeAll();
  });
});

/**
 * **装置名の自動リトライ（任意設定）。**
 *
 * IBM i は要求された装置が使用中だと、理由を返さずソケットを閉じる。名前にこだわらない運用の
 * ために、末尾の数字を繰り上げて再試行できるようにしてある。既定 off なのは、装置名を固定する
 * のが「その名前で繋ぎたい」意図だからで、黙って別名にすり替えるのは裏切りになるため。
 */
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

/**
 * ジョブ識別子の解決。**画面に触れずに**（起動応答＋ジョブ一覧で）行う経路。
 *
 * 見たいのは 3 つ:
 * - 資格情報が無ければ**引かない**（誰のジョブか分からないのに引くと他人のジョブを掴む）
 * - **1 件に定まったときだけ**採用する
 * - 失敗しても**セッションに影響しない**
 */
describe("ジョブ識別子の解決", () => {
  /** 起動応答が無い fixture なので、装置名は注入した session から来ないことに注意 */
  const open = (mgr: SessionManager, over: Record<string, unknown> = {}) =>
    mgr.open({ transport: new ReplayTransport(signonFixture()), ...over });

  /**
   * 実機（PUB400）で捕えた起動応答レコードを先頭に足した fixture。
   * これで「接続しただけで装置名が分かる」状態を再現できる。
   */
  const withStartup = () => {
    const rec = [
      0x00, 0x49, 0x12, 0xa0, 0x90, 0x00, 0x05, 0x60, 0x06, 0x00, 0x20, 0xc0, 0x00, 0x3d, 0x00,
      0x00, 0xc9, 0xf9, 0xf0, 0xf2, 0xd7, 0xe4, 0xc2, 0xf4, 0xf0, 0xf0, 0x40, 0x40, 0xd8, 0xd7,
      0xc1, 0xc4, 0xc5, 0xe5, 0xf0, 0xf0, 0xf1, 0xd7,
      ...new Array<number>(73 - 38).fill(0)
    ];
    // telnet 枠に包む（IAC エスケープ＋IAC EOR）
    const framed: number[] = [];
    for (const b of rec) {
      framed.push(b);
      if (b === 0xff) framed.push(0xff);
    }
    framed.push(0xff, 0xef);
    const hex = framed.map((b) => b.toString(16).padStart(2, "0")).join("");
    return [{ ts: "t", dir: "rx" as const, hex }, ...signonFixture()];
  };

  const openWithStartup = (mgr: SessionManager, over: Record<string, unknown> = {}) =>
    mgr.open({ transport: new ReplayTransport(withStartup()), ...over });

  it("起動応答だけで装置名（＝ジョブ名）が入る（資格情報も往復も要らない）", async () => {
    const mgr = new SessionManager();
    const entry = await openWithStartup(mgr);
    expect(entry.job).toEqual({ name: "QPADEV001P", system: "PUB400" });
    mgr.closeAll();
  });

  it("照会が 1 件なら ユーザー・番号 を足す", async () => {
    const seen: unknown[] = [];
    const mgr = new SessionManager({
      lookupJobs: async (target, filter) => {
        seen.push({ target: target.host, filter });
        return [{ name: "QPADEV001P", user: "USER", number: "337228" }];
      }
    });
    const entry = await openWithStartup(mgr, { host: "h", user: "USER", password: "x" });
    await entry.jobResolved;
    expect(entry.job).toEqual({
      name: "QPADEV001P",
      system: "PUB400",
      user: "USER",
      number: "337228"
    });
    // **装置名だけでなくユーザーでも絞っている**（他人のジョブを掴まないため）
    expect(seen).toEqual([{ target: "h", filter: { name: "QPADEV001P", user: "USER" } }]);
    mgr.closeAll();
  });

  /** 実機では同じ装置名のジョブが複数返った（別の利用者のもの）。採用してはいけない */
  it("照会が複数件なら採用しない（装置名だけのまま）", async () => {
    const mgr = new SessionManager({
      lookupJobs: async () => [
        { name: "QPADEV001P", user: "USER", number: "337228" },
        { name: "QPADEV001P", user: "OTHER", number: "300886" }
      ]
    });
    const entry = await openWithStartup(mgr, { host: "h", user: "USER", password: "x" });
    await entry.jobResolved;
    expect(entry.job).toEqual({ name: "QPADEV001P", system: "PUB400" });
    mgr.closeAll();
  });

  it("照会が 0 件でも壊れない", async () => {
    const mgr = new SessionManager({ lookupJobs: async () => [] });
    const entry = await openWithStartup(mgr, { host: "h", user: "USER", password: "x" });
    await entry.jobResolved;
    expect(entry.job).toEqual({ name: "QPADEV001P", system: "PUB400" });
    mgr.closeAll();
  });

  /** ホストサーバーが使えない環境でも、セッションは成立していること */
  it("照会が失敗しても例外を投げず、セッションは生きている", async () => {
    const mgr = new SessionManager({
      lookupJobs: async () => {
        throw new Error("no host server");
      }
    });
    const entry = await openWithStartup(mgr, { host: "h", user: "USER", password: "x" });
    await expect(entry.jobResolved).resolves.toEqual({ name: "QPADEV001P", system: "PUB400" });
    expect(mgr.get(entry.id).id).toBe(entry.id);
    mgr.closeAll();
  });

  it("資格情報が無ければ照会しない", async () => {
    let called = 0;
    const mgr = new SessionManager({
      lookupJobs: async () => {
        called++;
        return [{ name: "QPADEV0001", user: "USER", number: "1" }];
      }
    });
    const entry = await open(mgr);
    await entry.jobResolved;
    expect(called).toBe(0);
    mgr.closeAll();
  });

  it("起動応答が無ければ照会しない（装置名が分からない）", async () => {
    let called = 0;
    const mgr = new SessionManager({
      lookupJobs: async () => {
        called++;
        return [];
      }
    });
    // fixture は起動応答を含まないので job は付かない
    const entry = await open(mgr, { host: "h", user: "USER", password: "x" });
    await entry.jobResolved;
    expect(entry.job).toBeUndefined();
    expect(called).toBe(0);
    mgr.closeAll();
  });
});
