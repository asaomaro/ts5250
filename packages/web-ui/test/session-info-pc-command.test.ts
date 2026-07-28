import { describe, it, expect, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import SessionInfo from "../src/components/SessionInfo.vue";
import { sessionsStore, type PcCommandView, type SessionState } from "../src/stores/sessions.js";

/**
 * PC コマンド（STRPCCMD）の表示。
 *
 * ホストが 5250 の画面に隠して送ってくるため、**何も出さないと「勝手に何かが動いた」ようにしか
 * 見えない**。実行の有無・結果・実行先をここで確認できるようにする。
 * 実行先の言い換え（このPC / サーバー）は、ブラウザの接続先が loopback かで決める。
 */
function addSession(
  pcCommands?: PcCommandView[],
  pcCommandEnabled = true
): string {
  const id = `s-${Math.random().toString(36).slice(2)}`;
  sessionsStore.add({
    sessionId: id,
    label: "テスト",
    edits: new Map(),
    connected: true,
    readOnly: false,
    client: {} as never,
    pcCommandEnabled,
    ...(pcCommands !== undefined ? { pcCommands } : {})
  } as unknown as SessionState);
  return id;
}

const ids: string[] = [];
afterEach(() => {
  for (const id of ids.splice(0)) sessionsStore.remove(id);
});

function paneFor(pcCommands?: PcCommandView[], enabled = true) {
  const id = addSession(pcCommands, enabled);
  ids.push(id);
  return mount(SessionInfo, { props: { sessionId: id } });
}

const entry = (o: Partial<PcCommandView> = {}): PcCommandView => ({
  at: Date.UTC(2026, 6, 29, 1, 2, 3),
  command: "echo hello",
  wait: true,
  hostname: "build-box",
  ...o
});

describe("セッション情報の PC コマンド表示", () => {
  it("有効・無効を常に示す（無効でもホストへの応答は返るため、理由が要る）", () => {
    expect(paneFor([], true).text()).toContain("有効");
    expect(paneFor([], false).text()).toContain("無効");
  });

  it("実行したコマンドを出す", () => {
    const w = paneFor([entry({ outcome: { status: "ran", exitCode: 0, durationMs: 12 } })]);
    expect(w.text()).toContain("echo hello");
    expect(w.text()).toContain("完了");
  });

  it("終了コードが 0 以外なら数値を出す（成功と区別する）", () => {
    const w = paneFor([entry({ outcome: { status: "ran", exitCode: 3, durationMs: 12 } })]);
    expect(w.text()).toContain("終了コード 3");
  });

  it("待たない指定は「起動」として区別する", () => {
    const w = paneFor([entry({ wait: false, outcome: { status: "started" } })]);
    expect(w.text()).toContain("起動");
  });

  it("設定で実行しなかったことも出す（黙って何もしない、を避ける）", () => {
    expect(paneFor([entry({ outcome: { status: "disabled" } })]).text()).toContain("無効（実行しない）");
    expect(paneFor([entry({ outcome: { status: "denied" } })]).text()).toContain("許可リスト外");
  });

  it("失敗は理由まで出す", () => {
    const w = paneFor([entry({ outcome: { status: "failed", error: "timed out after 60000ms", durationMs: 60000 } })]);
    expect(w.text()).toContain("失敗");
    expect(w.text()).toContain("timed out");
  });

  it("結果が来る前は「実行中」と出す", () => {
    expect(paneFor([entry()]).text()).toContain("実行中");
  });

  it("新しい実行を上に出す", () => {
    const w = paneFor([entry({ command: "first" }), entry({ command: "second" })]);
    const rows = w.findAll(".pcrow .pccmd").map((n) => n.text());
    expect(rows).toEqual(["second", "first"]);
  });

  it("localhost で開いていれば実行先を「このPC」と言い換える", () => {
    // jsdom の既定 location は http://localhost:3000
    expect(location.hostname).toBe("localhost");
    const w = paneFor([entry({ outcome: { status: "started" } })]);
    expect(w.text()).toContain("このPC（build-box）");
  });
});
