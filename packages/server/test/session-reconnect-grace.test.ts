/**
 * 転送断でセッションを失わないための猶予保持（`20260908-session-survives-disconnect`）。
 *
 * 実機で「応答待ちのローディングが解除されない／開き直すと前回セッションが閉じられた警告が出る」
 * という報告が出た。原因は、ブラウザ ↔ サーバーの WebSocket が落ちた時点で
 * `ws-handler.dispose` が**その場でホストセッションを閉じていた**こと。5250 の対話ジョブは
 * 画面遷移の途中状態を持つので、回線が一瞬落ちただけで失うのは代償が大きい。
 *
 * ここで固定するのは `SessionManager` 側の 2 つ:
 *   - **猶予は有限**（`holdForReconnect` → 期限で必ず畳む）。ブラウザ経路の既定アイドル上限は
 *     `"never"` で、掃除役には任せられない（`orphanSafeIdleTimeoutMs` のコメント）
 *   - **持ち主の座**（`claim` / `releaseHolder` / `hasHolder`）。半開きでは古い接続が
 *     後から後始末に来るので、復帰済みのセッションを殺さない／かつ孤児も残さない
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ReplayTransport, parseTraceJsonl } from "@ts5250/tn5250";
import { SessionManager, DEFAULT_RECONNECT_GRACE_MS } from "../src/session-manager.js";

const here = dirname(fileURLToPath(import.meta.url));
const signon = () =>
  parseTraceJsonl(readFileSync(join(here, "..", "..", "tn5250", "test", "fixtures", "pub400-signon.jsonl"), "utf8"));

/** private な sweepIdle を叩く（`session-idle-timeout.test.ts` と同じ手） */
const sweep = (mgr: SessionManager): void => (mgr as unknown as { sweepIdle: () => void }).sweepIdle();

function makeManager(opts: { reconnectGraceMs?: number; now?: () => number } = {}): SessionManager {
  return new SessionManager(opts);
}
const open = (mgr: SessionManager) => mgr.open({ transport: new ReplayTransport(signon()), host: "h" });

describe("猶予保持（holdForReconnect）", () => {
  it("猶予に入れたセッションは残り、isHeld が真になる", async () => {
    const mgr = makeManager();
    const entry = await open(mgr);
    expect(mgr.holdForReconnect(entry.id)).toBe(true);
    expect(mgr.isHeld(entry.id)).toBe(true);
    expect(mgr.size).toBe(1);
    mgr.closeAll();
  });

  it("**既に猶予中なら期限を延ばさない**（切断を繰り返す相手に無期限で掴ませない）", async () => {
    let t = 1_000_000;
    const mgr = makeManager({ now: () => t });
    const entry = await open(mgr);
    expect(mgr.holdForReconnect(entry.id)).toBe(true);
    t += DEFAULT_RECONNECT_GRACE_MS - 1;
    expect(mgr.holdForReconnect(entry.id)).toBe(false); // 2 回目は入らない
    // **返り値だけでは足りない。** `heldUntil` を黙って上書きしていても false は返せるので、
    // **元の期限で**刈られることまで見る（そうでないと、切断を繰り返す相手が無期限に掴める）
    t += 2;
    sweep(mgr);
    expect(mgr.size).toBe(0);
  });

  it("猶予を解除すれば isHeld は偽に戻る（繋ぎ直せた）", async () => {
    const mgr = makeManager();
    const entry = await open(mgr);
    mgr.holdForReconnect(entry.id);
    mgr.cancelHold(entry.id);
    expect(mgr.isHeld(entry.id)).toBe(false);
    expect(mgr.size).toBe(1);
    mgr.closeAll();
  });

  it("`reconnectGraceMs: 0` なら猶予に入らない（従来どおりの即閉じへ戻す逃げ道）", async () => {
    const mgr = makeManager({ reconnectGraceMs: 0 });
    const entry = await open(mgr);
    expect(mgr.holdForReconnect(entry.id)).toBe(false);
    expect(mgr.isHeld(entry.id)).toBe(false);
    mgr.closeAll();
  });

  it("**期限のタイマーが閉じる**（掃除役に任せず自分で畳む＝本筋の経路）", async () => {
    const mgr = makeManager();
    const entry = await open(mgr);
    vi.useFakeTimers();
    try {
      mgr.holdForReconnect(entry.id);
      vi.advanceTimersByTime(DEFAULT_RECONNECT_GRACE_MS + 1);
      expect(mgr.size).toBe(0);
      expect(() => mgr.get(entry.id)).toThrow();
    } finally {
      vi.useRealTimers();
    }
  });

  it("**タイマーを取り逃しても掃除役が刈る**（保険の経路）", async () => {
    let t = 1_000_000;
    const mgr = makeManager({ now: () => t });
    const entry = await open(mgr);
    mgr.holdForReconnect(entry.id);
    t += DEFAULT_RECONNECT_GRACE_MS + 1;
    sweep(mgr);
    expect(mgr.size).toBe(0);
    expect(() => mgr.get(entry.id)).toThrow();
  });

  it("**タイマー経路でも、見ている人が居れば閉じない**（保険側と結論を揃える）", async () => {
    const mgr = makeManager();
    const entry = await open(mgr);
    vi.useFakeTimers();
    try {
      mgr.holdForReconnect(entry.id);
      mgr.addViewer(entry.id);
      vi.advanceTimersByTime(DEFAULT_RECONNECT_GRACE_MS + 1);
      expect(mgr.size).toBe(1);
      expect(mgr.isHeld(entry.id)).toBe(false); // 猶予だけ解けて普通のセッションに戻る
    } finally {
      vi.useRealTimers();
      mgr.closeAll();
    }
  });

  it("期限が来ていなければ刈らない", async () => {
    let t = 1_000_000;
    const mgr = makeManager({ now: () => t });
    const entry = await open(mgr);
    mgr.holdForReconnect(entry.id);
    t += DEFAULT_RECONNECT_GRACE_MS - 1;
    sweep(mgr);
    expect(mgr.size).toBe(1);
    mgr.closeAll();
  });

  it("**見ている人が居れば期限が来ても閉じない**（使っている足元で畳まない）", async () => {
    let t = 1_000_000;
    const mgr = makeManager({ now: () => t });
    const entry = await open(mgr);
    mgr.holdForReconnect(entry.id);
    mgr.addViewer(entry.id); // 猶予中に誰かが見に来た（セッション管理／MCP）
    t += DEFAULT_RECONNECT_GRACE_MS + 1;
    sweep(mgr);
    expect(mgr.size).toBe(1);
    expect(mgr.isHeld(entry.id)).toBe(false); // 猶予だけ解けて普通のセッションに戻る
    mgr.closeAll();
  });

  it("`isHeld` は期限切れを真と言わない（読み取り時に期限を見る）", async () => {
    let t = 1_000_000;
    const mgr = makeManager({ now: () => t });
    const entry = await open(mgr);
    mgr.holdForReconnect(entry.id);
    t += DEFAULT_RECONNECT_GRACE_MS + 1;
    expect(mgr.isHeld(entry.id)).toBe(false);
    mgr.closeAll();
  });
});

describe("持ち主の座（claim / releaseHolder / hasHolder）", () => {
  it("claim した本人だけが座を返せる", async () => {
    const mgr = makeManager();
    const entry = await open(mgr);
    const token = mgr.claim(entry.id);
    expect(mgr.hasHolder(entry.id)).toBe(true);
    expect(mgr.releaseHolder(entry.id, token + 999)).toBe(false); // 他人の印では返せない
    expect(mgr.releaseHolder(entry.id, token)).toBe(true);
    expect(mgr.hasHolder(entry.id)).toBe(false);
    mgr.closeAll();
  });

  it("**後から claim した者が持ち主**（古い印は無効になる）", async () => {
    const mgr = makeManager();
    const entry = await open(mgr);
    const older = mgr.claim(entry.id);
    const newer = mgr.claim(entry.id);
    expect(mgr.releaseHolder(entry.id, older)).toBe(false);
    expect(mgr.releaseHolder(entry.id, newer)).toBe(true);
    mgr.closeAll();
  });

  it("**持ち主が去ったあとは hasHolder が偽**（残った接続が最後の 1 人だと分かる）", async () => {
    const mgr = makeManager();
    const entry = await open(mgr);
    const stale = mgr.claim(entry.id);
    const current = mgr.claim(entry.id);
    mgr.releaseHolder(entry.id, current); // 新しい持ち主が先に去った
    expect(mgr.hasHolder(entry.id)).toBe(false);
    expect(mgr.releaseHolder(entry.id, stale)).toBe(false); // 古い印では返せないままだが
    mgr.closeAll();
  });

  it("印が undefined なら常に偽（一度も claim していない経路を巻き込まない）", async () => {
    const mgr = makeManager();
    const entry = await open(mgr);
    expect(mgr.releaseHolder(entry.id, undefined)).toBe(false);
    expect(mgr.hasHolder(entry.id)).toBe(false);
    mgr.closeAll();
  });
});
