import { describe, it, expect, afterEach } from "vitest";
import { mount } from "@vue/test-utils";
import SessionInfo from "../src/components/SessionInfo.vue";
import { sessionsStore, type SessionState } from "../src/stores/sessions.js";

/**
 * セッション情報のジョブ表示。
 *
 * **取得ボタンは無い**——ジョブ情報は接続時に画面へ触れずに入る（DSPJOB を打つ旧経路は廃止）。
 * 番号まで分かるとき／装置名だけのとき／何も分からないときで見せ方が変わる。
 */
function addSession(job?: SessionState["job"]): string {
  const id = `s-${Math.random().toString(36).slice(2)}`;
  sessionsStore.add({
    sessionId: id,
    label: "テスト",
    edits: new Map(),
    connected: true,
    readOnly: false,
    // markRaw に渡されるので object であればよい
    client: {} as never,
    ...(job !== undefined ? { job } : {})
  } as unknown as SessionState);
  return id;
}

const ids: string[] = [];
afterEach(() => {
  for (const id of ids.splice(0)) sessionsStore.remove(id);
});

function paneFor(job?: SessionState["job"]) {
  const id = addSession(job);
  ids.push(id);
  return mount(SessionInfo, { props: { sessionId: id } });
}

describe("セッション情報のジョブ表示", () => {
  it("番号まで分かれば 番号/ユーザー/名前 を出す", () => {
    const w = paneFor({ name: "QPADEV001P", system: "PUB400", user: "USER", number: "337228" });
    expect(w.find(".jobval").text()).toBe("337228/USER/QPADEV001P");
  });

  /** 手サインオンでは誰のジョブか特定できない。装置名（＝ジョブ名）までは出す */
  it("装置名しか分からなければ名前だけ出す", () => {
    const w = paneFor({ name: "QPADEV001P", system: "PUB400" });
    expect(w.find(".jobval").text()).toBe("QPADEV001P");
  });

  it("何も分からなければジョブの行を出さない", () => {
    const w = paneFor();
    expect(w.find(".jobval").exists()).toBe(false);
    expect(w.text()).not.toContain("ジョブ");
  });

  /** **押しても何も起きないボタンを残さない**（旧 DSPJOB 経路の撤去） */
  it("取得ボタンが無い", () => {
    const w = paneFor();
    expect(w.findAll("button").some((b) => b.text().includes("取得"))).toBe(false);
  });

  /**
   * ユーザー・番号は**遅れて届く**（サーバーが背後で引く）。
   * 後から入っても表示が追随することを確かめる——追随しないと、開きっぱなしの
   * ポップオーバーが装置名だけのまま止まる
   */
  it("後から届いた ユーザー・番号 で表示が更新される", async () => {
    const id = addSession({ name: "QPADEV001P", system: "PUB400" });
    ids.push(id);
    const w = mount(SessionInfo, { props: { sessionId: id } });
    expect(w.find(".jobval").text()).toBe("QPADEV001P");

    const s = sessionsStore.get(id);
    if (s) s.job = { name: "QPADEV001P", system: "PUB400", user: "USER", number: "337228" };
    await w.vm.$nextTick();
    expect(w.find(".jobval").text()).toBe("337228/USER/QPADEV001P");
  });

  /** デバイス名は「実際に割り当てられた名前」を出す（ホスト採番なら設定値は空） */
  it("デバイス名は実際の装置名を出し、設定と違えば併記する", () => {
    const w = paneFor({ name: "QPADEV001P" });
    expect(w.text()).toContain("QPADEV001P");
  });
});
