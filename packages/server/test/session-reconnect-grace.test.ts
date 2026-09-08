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
import {
  SessionManager,
  DEFAULT_RECONNECT_GRACE_MS,
  ORPHAN_IDLE_TIMEOUT_MS
} from "../src/session-manager.js";

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

describe("猶予とアイドル上限の関係", () => {
  /**
   * **猶予のあいだはアイドル上限を当てない**（review ラウンド1）。
   *
   * `expired()` が見る `lastActivity` は切断後は誰も進めない。アイドル上限を有限に
   * 設定した環境では、猶予が明ける前にそちらが先に真になり、**猶予が丸ごと無効になる**。
   */
  it("アイドル上限が猶予より短くても、猶予中は刈られない", async () => {
    let t = 1_000_000;
    const mgr = makeManager({ now: () => t });
    const entry = await mgr.open({
      transport: new ReplayTransport(signon()),
      host: "h",
      idleTimeoutMs: 60_000 // 猶予（90 秒）より短い設定
    });
    mgr.holdForReconnect(entry.id);
    t += 70_000; // アイドル上限は超えたが、猶予はまだ明けていない
    sweep(mgr);
    expect(mgr.size).toBe(1);
    expect(mgr.isHeld(entry.id)).toBe(true);
    mgr.closeAll();
  });

  it("猶予が明ければ、そのときに刈られる", async () => {
    let t = 1_000_000;
    const mgr = makeManager({ now: () => t });
    const entry = await mgr.open({
      transport: new ReplayTransport(signon()),
      host: "h",
      idleTimeoutMs: 60_000
    });
    mgr.holdForReconnect(entry.id);
    t += DEFAULT_RECONNECT_GRACE_MS + 1;
    sweep(mgr);
    expect(mgr.size).toBe(0);
  });
});

describe("猶予が明けたのに見ている人が居る場合（review ラウンド2）", () => {
  /**
   * **寿命なしで放流しない。**
   *
   * 猶予を解いただけだと、持ち主の居ない普通のセッションになる。見に来ただけの接続は
   * `dispose` で閉じない側なので、その閲覧タブが去っても誰も畳まず、ブラウザ経路の
   * 既定アイドル上限は `"never"`——枠と装置記述を握ったまま永久に残る。
   */
  it("猶予は解けるが、永久には残さない（持ち主不在の上限が掛かる）", async () => {
    let t = 1_000_000;
    const mgr = makeManager({ now: () => t });
    const entry = await open(mgr);
    // **ブラウザが開いたセッションを再現する**（`ws-handler` は open の直後に claim する）。
    // 一度も持ち主が付かないセッション（MCP / HLLAPI）は対象外なので、ここを省くと
    // 上限が掛からない
    const token = mgr.claim(entry.id);
    mgr.releaseHolder(entry.id, token);
    mgr.holdForReconnect(entry.id);
    mgr.addViewer(entry.id);
    t += DEFAULT_RECONNECT_GRACE_MS + 1;
    sweep(mgr);

    expect(mgr.size).toBe(1);
    expect(mgr.isHeld(entry.id)).toBe(false);
    // **設定は書き換えない**——寿命は規則として重ねる（review ラウンド3）
    expect(mgr.get(entry.id).idleTimeoutMs).toBeUndefined();

    t += ORPHAN_IDLE_TIMEOUT_MS + 1;
    sweep(mgr);
    expect(mgr.size).toBe(0);
  });

  /**
   * **持ち主が戻れば元の寿命に戻る**（review ラウンド3）。
   * 設定を書き換える形にしていた頃は、戻す経路が無く 30 分の上限を持ち続けていた。
   */
  it("持ち主が戻れば、持ち主不在の上限は掛からなくなる", async () => {
    let t = 1_000_000;
    const mgr = makeManager({ now: () => t });
    const entry = await open(mgr);
    const first = mgr.claim(entry.id);
    mgr.releaseHolder(entry.id, first);
    mgr.holdForReconnect(entry.id);
    mgr.addViewer(entry.id);
    t += DEFAULT_RECONNECT_GRACE_MS + 1;
    sweep(mgr); // 猶予は明けたが、見ている人が居るので残る

    mgr.claim(entry.id); // 手動の繋ぎ直しで持ち主が戻った
    t += ORPHAN_IDLE_TIMEOUT_MS + 1;
    sweep(mgr);

    expect(mgr.size).toBe(1); // 既定は「永続」なので切られない
    mgr.closeAll();
  });

  /**
   * **持ち主が去れば、他に見ている人が居ても永久には残らない**（review ラウンド3）。
   * 猶予に入らない枝（他に viewer が居る）でも同じ規則が効く。
   */
  it("持ち主が去ったセッションは、猶予に入らなくても上限が掛かる", async () => {
    let t = 1_000_000;
    const mgr = makeManager({ now: () => t });
    const entry = await open(mgr);
    const token = mgr.claim(entry.id);
    mgr.addViewer(entry.id);
    mgr.releaseHolder(entry.id, token); // 持ち主が去った（猶予には入らなかった）

    t += ORPHAN_IDLE_TIMEOUT_MS + 1;
    sweep(mgr);

    expect(mgr.size).toBe(0);
  });

  /** **短いほうが常に勝つ**（設定が長くても、持ち主が居なければ 30 分で回収する） */
  it("設定が孤児回収より長くても、持ち主不在なら 30 分で回収する", async () => {
    let t = 1_000_000;
    const mgr = makeManager({ now: () => t });
    const entry = await mgr.open({
      transport: new ReplayTransport(signon()),
      host: "h",
      idleTimeoutMs: 60 * 60_000 // 孤児回収の 30 分より**長い**設定
    });
    const token = mgr.claim(entry.id);
    mgr.releaseHolder(entry.id, token);

    t += ORPHAN_IDLE_TIMEOUT_MS + 1;
    sweep(mgr);

    expect(mgr.size).toBe(0);
  });

  /**
   * **一度も持ち主が付いていないセッションは対象外**（MCP / HLLAPI が開いた分）。
   * あちらは開くときに自分で寿命を決めているので、ここで上限を重ねると
   * 「引数なしのマネージャは永続」という既定を黙って壊す。
   */
  it("一度も持ち主が付いていないセッションには上限を掛けない", async () => {
    let t = 1_000_000;
    const mgr = makeManager({ now: () => t });
    await open(mgr); // claim しない＝MCP / HLLAPI が開いたのと同じ状態

    t += ORPHAN_IDLE_TIMEOUT_MS + 1;
    sweep(mgr);

    expect(mgr.size).toBe(1);
    mgr.closeAll();
  });

  it("設定が孤児回収より短ければ、その設定が勝つ（上限が延びない）", async () => {
    let t = 1_000_000;
    const mgr = makeManager({ now: () => t });
    const entry = await mgr.open({
      transport: new ReplayTransport(signon()),
      host: "h",
      idleTimeoutMs: 5 * 60_000
    });
    const token = mgr.claim(entry.id);
    mgr.releaseHolder(entry.id, token);

    t += 5 * 60_000 + 1;
    sweep(mgr);

    expect(mgr.size).toBe(0);
  });
});
