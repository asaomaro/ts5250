import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * **MCP の書き込みは、必ず予約を取ってから行う。**
 *
 * ## なぜソースを走査するのか
 *
 * 書き込みの入口は **8 箇所**あり、共通のラッパが無い（`server.registerTool` を個別に呼び、
 * 各ハンドラが `withAudit` を自分で巻く。この repo の作法）。
 *
 * 散らすのは構わないが、**忘れると黙って効かなくなる**——予約を取らないツールが 1 つあれば、
 * そこだけ人間の打ちかけを踏み潰す。しかも**動くので気づけない**。
 *
 * `20260803-hllapi-bridge` の `hllapi-bridge-thinness.test.ts` と同じ手口で、
 * **規約を機械で固定する**。書き込みのツールを足す人がこの検査で止まる。
 *
 * ## 書式に左右されない形で見る
 *
 * 空白を潰してから走査する。**行単位で見ると prettier の折り返しで取りこぼす**
 * （最初にそう書いて、8 箇所のうち 2 箇所しか拾えなかった）。
 */

const src = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "..", "src", "mcp-tools.ts"),
  "utf8"
);
/** 空白の連続を 1 つに潰す。改行・字下げ・折り返しの違いを消す */
const flat = src.replace(/\s+/gu, " ");

/**
 * 書き込みの検査を呼んでいる箇所。
 *
 * **引数は `mcpHolder(user)` の内側の `)` で切れる**ので、完全な呼び出しは取れない。
 * ここで見たいのは「holder を渡しているか」だけなので、そこまでで足りる。
 */
const gates = [...flat.matchAll(/sessions\.(assertWritable|assertKeyAllowed)\(([^)]*)/gu)];

describe("MCP の書き込みは予約を取る", () => {
  it("書き込みの入口が見つかる（**検査自体が空振りしていない**）", () => {
    expect(gates.length).toBeGreaterThanOrEqual(8);
  });

  it("**すべての入口が `mcpHolder` を渡す**（自分で取った予約に自分が弾かれない）", () => {
    const bad = gates.filter((m) => !m[2]!.includes("mcpHolder(")).map((m) => m[0]);
    expect(bad).toEqual([]);
  });

  it("**すべての入口の手前で予約を取っている**", () => {
    const bad = gates
      .filter((m) => {
        // 直前 300 文字（＝try の入り口や数行ぶん）に claim があるか
        const before = flat.slice(Math.max(0, m.index - 300), m.index);
        return !before.includes("claimForWrite(sessions, sessionId, user)");
      })
      .map((m) => m[0]);
    expect(bad).toEqual([]);
  });

  it("**`reserve_session` のようなツールを作らない**（エージェントに囲わせない）", () => {
    // 囲い忘れる余地を作らないのがこの設計の要点（spec D2）。
    // 予約は道具の側が勝手に取り、期限で勝手に手放す
    expect(src).not.toMatch(/"(reserve|release)_session"/u);
  });

  it("**期限は HLLAPI と別**（MCP は短く取ってすぐ手放す）", () => {
    expect(src).toContain("MCP_RESERVATION_TTL_MS");
    // SessionManager の既定（2 分）をそのまま使っていないこと
    expect(flat).not.toMatch(/reserve\([^)]*RESERVATION_TTL_MS/u);
  });

  it("**見ている人が居るときだけ取る**（誰も見ていなければ儀式にしない）", () => {
    expect(flat).toMatch(/function claimForWrite\([^)]*\)[^{]*\{ if \(!sessions\.hasViewer/u);
  });
});
