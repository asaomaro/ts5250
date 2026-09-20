import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { WsConnection } from "../src/ws-handler.js";
import { SessionManager } from "../src/session-manager.js";
import { ConfigResolver } from "../src/config-resolver.js";
import { PersonalConfigStore, ServerConfigStore } from "../src/config-store.js";
import { MacroStore } from "../src/macro-store.js";
import { SecretCrypto } from "../src/secret-crypto.js";
import type { AuthUser } from "../src/auth.js";
import { ReplayTransport, parseTraceJsonl, buildRecord, bytesToHex, type Transport } from "@ts5250/tn5250";
import type { WsServerMessage } from "../src/ws-messages.js";
import type { CreateMacroBody } from "../src/macro-types.js";

/**
 * 再生時の秘密の差し込み（spec D11）を ws 経路で確認する。
 *
 * 守りたい不変条件は 2 つ:
 *   1. 解決できたときだけホストへ書く（所有者違い・復号失敗は**キー送信ごと落とす**）
 *   2. 失敗時に**空文字で代替しない**——空のパスワードがホストに届くと、
 *      サインオン失敗の原因が分からなくなる
 */
const here = dirname(fileURLToPath(import.meta.url));
const fixtureDir = join(here, "..", "..", "tn5250", "test", "fixtures");
const signonTrace = (): ReturnType<typeof parseTraceJsonl> =>
  parseTraceJsonl(readFileSync(join(fixtureDir, "pub400-signon.jsonl"), "utf8"));

const crypto = SecretCrypto.fromEnv("K", { K: randomBytes(32).toString("hex") })!;
const alice: AuthUser = { username: "alice", role: "user" };
const bob: AuthUser = { username: "bob", role: "user" };

const DUMMY_SECRET = "dummy-secret-value";

class InjectingManager extends SessionManager {
  constructor(private readonly makeTransport: () => Transport) {
    super();
  }
  override open(opts: Parameters<SessionManager["open"]>[0]) {
    return super.open({ ...opts, transport: this.makeTransport() });
  }
}

/**
 * signon 画面の実データに合わせる（フィールド index は **1 始まり**）:
 *   index 1 = ユーザー欄（row 5 col 25 len 10）
 *   index 2 = パスワード欄（row 6 col 25、`hidden: true`）
 */
function macroBody(): CreateMacroBody {
  return {
    name: "サインオン",
    steps: [
      {
        screen: {
          rows: 24,
          cols: 80,
          targets: [
            { field: 1, row: 5, col: 25, len: 10 },
            { field: 2, row: 6, col: 25, len: 128 }
          ]
        },
        fields: [{ field: 1, value: "USER" }],
        plainSecrets: [{ field: 2, value: DUMMY_SECRET }],
        key: "Enter",
        cursor: { row: 5, col: 25 }
      }
    ]
  };
}

/**
 * **数字しか入らない欄を 1 つ置いた画面**（24x80。(5,25) から 20 桁）。
 *
 * signon の実トレース（`pub400-signon.jsonl`）の欄は**どちらも型の制約を持たない**ので、
 * 18 文字の秘密は型検証まで届かず**桁あふれ**（`FIELD_OVERFLOW`）で落ちる。それだと
 * `field-validate.ts` を一度も通らず、ws 経路の回帰資産にならない
 * （`20260920-field-error-no-value` の cross 点検で実測——値を埋める形に戻しても
 * このファイルは 10/10 緑のままだった）。型検証に届く欄をここで用意する。
 *
 * バイトの意味は `packages/tn5250/src/protocol/constants.ts`
 * （**定数は `@ts5250/tn5250` の公開面に無い**ので値を直に書く。`buildRecord` は在る）:
 * ```
 *   04 40              ESC CLEAR_UNIT
 *   04 11 00 18        ESC WRITE_TO_DISPLAY / CC1=0x00 CC2=0x18
 *   11 07 1d           SBA → (7,29)＝属性バイトの桁。欄は次の 30 桁目から
 *                      （**signon フィクスチャの (5,25) とわざとずらす**——同じにすると
 *                      位置を定数で埋めた実装でも ws 側の検査が全部通ってしまう）
 *   1d 45 00 20 00 14  SF / FFW=ID_VALUE|SHIFT_DIGITS_ONLY(0x4500) / 属性 0x20 / 長さ 20
 *   04 52 00 00        ESC READ_MDT_FIELDS
 * ```
 */
function digitsOnlyTrace(): ReturnType<typeof parseTraceJsonl> {
  const body = Uint8Array.from([
    0x04, 0x40, 0x04, 0x11, 0x00, 0x18, 0x11, 0x07, 0x1d, 0x1d, 0x45, 0x00, 0x20, 0x00, 0x14, 0x04,
    0x52, 0x00, 0x00
  ]);
  const record = buildRecord(0x03 /* OPCODE.PUT_GET */, body);
  const framed: number[] = [];
  for (const b of record) {
    framed.push(b);
    if (b === 0xff) framed.push(0xff); // IAC はエスケープする
  }
  framed.push(0xff, 0xef); // IAC EOR
  return [{ ts: "t", dir: "rx", hex: bytesToHex(Uint8Array.from(framed)) }];
}

/** ws 接続を用意し、`setField` の呼び出しを覗けるようにする */
async function setup(opts: {
  macros?: MacroStore;
  user?: AuthUser;
  trace?: ReturnType<typeof parseTraceJsonl>;
} = {}): Promise<{
  conn: WsConnection;
  sent: WsServerMessage[];
  setField: ReturnType<typeof vi.fn>;
  sessionId: string;
}> {
  const sent: WsServerMessage[] = [];
  const trace = opts.trace ?? signonTrace();
  const mgr = new InjectingManager(() => new ReplayTransport(trace));
  const resolver = new ConfigResolver(new ServerConfigStore(), new PersonalConfigStore());
  const deps = { sessions: mgr, resolver, ...(opts.macros ? { macros: opts.macros } : {}) };
  const conn = new WsConnection(deps, { send: (d) => sent.push(JSON.parse(d) as WsServerMessage), close: () => {} }, opts.user);
  await conn.handle(JSON.stringify({ type: "open", host: "h" }));
  const opened = sent[0] as { type: "opened"; sessionId: string };
  const entry = mgr.get(opened.sessionId, opts.user);
  // 実際にホストへ書かれた値を覗く（平文が届いたか／そもそも書かれなかったか）
  const setField = vi.fn(entry.session.setField.bind(entry.session));
  entry.session.setField = setField as unknown as typeof entry.session.setField;
  // **sendAid は差し替える**。replay トレースに signon 後の往復が無く、本物を呼ぶと
  // ホスト応答待ちで止まってしまう。ここで確かめたいのは「どの値が欄に書かれたか」なので、
  // 送信そのものは即座に完了させて切り離す。
  entry.session.sendAid = (async () => ({
    screen: entry.session.snapshot(),
    timedOut: false
  })) as unknown as typeof entry.session.sendAid;
  return { conn, sent, setField, sessionId: opened.sessionId };
}

function keyWithSecret(macroId: string): string {
  return JSON.stringify({
    type: "key",
    key: "Enter",
    fields: [
      { field: 1, value: "USER" },
      { field: 2, secretRef: { macroId, step: 0, field: 2 } }
    ]
  });
}

describe("ws: マクロの秘密の差し込み", () => {
  it("所有者なら復号した平文がホストへ書かれる", async () => {
    const macros = new MacroStore([], crypto);
    const macro = macros.create(macroBody(), alice, 1000);
    const { conn, sent, setField } = await setup({ macros, user: alice });

    await conn.handle(keyWithSecret(macro.id));

    expect(sent.at(-1)?.type).toBe("key-done");
    expect(setField).toHaveBeenCalledTimes(2);
    expect(setField).toHaveBeenNthCalledWith(1, { index: 1 }, "USER");
    expect(setField).toHaveBeenNthCalledWith(2, { index: 2 }, DUMMY_SECRET);
  });

  it("他人のマクロを指す参照は拒否され、**1 欄も書かれない**", async () => {
    const macros = new MacroStore([], crypto);
    const macro = macros.create(macroBody(), alice, 1000);
    const { conn, sent, setField } = await setup({ macros, user: bob });

    await conn.handle(keyWithSecret(macro.id));

    expect(sent.at(-1)).toMatchObject({ type: "error" });
    expect(sent.some((m) => m.type === "key-done")).toBe(false);
    // 先に解決してから書くので、平文でない欄（USER）も書かれない＝中途半端な状態を残さない
    expect(setField).not.toHaveBeenCalled();
  });

  it("復号に失敗する（鍵が違う）と拒否され、空文字で代替しない", async () => {
    const macros = new MacroStore([], crypto);
    const macro = macros.create(macroBody(), alice, 1000);
    // 同じレコードを別の鍵のストアへ移す＝鍵ローテーション後の状況
    const other = SecretCrypto.fromEnv("K", { K: randomBytes(32).toString("hex") })!;
    const moved = new MacroStore([macros.get(macro.id, alice)], other);
    const { conn, sent, setField } = await setup({ macros: moved, user: alice });

    await conn.handle(keyWithSecret(macro.id));

    expect(sent.at(-1)).toMatchObject({ type: "error" });
    expect(setField).not.toHaveBeenCalled();
  });

  it("マクロストアが無い構成では秘密参照を拒否する", async () => {
    const { conn, sent, setField } = await setup({ user: alice });
    await conn.handle(keyWithSecret("m-whatever"));
    expect(sent.at(-1)).toMatchObject({ type: "error" });
    expect(setField).not.toHaveBeenCalled();
  });

  it("存在しないステップ / 欄への参照も拒否する", async () => {
    const macros = new MacroStore([], crypto);
    const macro = macros.create(macroBody(), alice, 1000);
    const { conn, sent, setField } = await setup({ macros, user: alice });

    await conn.handle(
      JSON.stringify({
        type: "key",
        key: "Enter",
        fields: [{ field: 2, secretRef: { macroId: macro.id, step: 5, field: 2 } }]
      })
    );

    expect(sent.at(-1)).toMatchObject({ type: "error" });
    expect(setField).not.toHaveBeenCalled();
  });

  it("壊れた secretRef は PROTOCOL_ERROR で弾く（素の TypeError を漏らさない）", async () => {
    const macros = new MacroStore([], crypto);
    const { conn, sent, setField } = await setup({ macros, user: alice });

    // secretRef を持たない・形が違う 3 パターン
    for (const bad of [{}, { macroId: "m-1" }, { macroId: 1, step: "x", field: null }]) {
      await conn.handle(
        JSON.stringify({ type: "key", key: "Enter", fields: [{ field: 2, secretRef: bad }] })
      );
      expect(sent.at(-1)).toMatchObject({ type: "error", code: "PROTOCOL_ERROR" });
    }
    // secretRef キー自体が無い場合も同じ扱い（value も secretRef も無い欄）
    await conn.handle(JSON.stringify({ type: "key", key: "Enter", fields: [{ field: 2 }] }));
    expect(sent.at(-1)).toMatchObject({ type: "error", code: "PROTOCOL_ERROR" });

    expect(setField).not.toHaveBeenCalled();
  });

  it("秘密を含まない従来どおりの fields は影響を受けない（回帰）", async () => {
    const { conn, sent, setField } = await setup({ user: alice });
    await conn.handle(
      JSON.stringify({ type: "key", key: "Enter", fields: [{ field: 1, value: "USER" }] })
    );
    expect(sent.at(-1)?.type).toBe("key-done");
    expect(setField).toHaveBeenCalledWith({ index: 1 }, "USER");
  });

  it("readOnly セッションでは秘密参照の解決以前に弾かれる", async () => {
    const macros = new MacroStore([], crypto);
    const macro = macros.create(macroBody(), alice, 1000);
    const sent: WsServerMessage[] = [];
    const mgr = new InjectingManager(() => new ReplayTransport(signonTrace()));
    const resolver = new ConfigResolver(new ServerConfigStore(), new PersonalConfigStore());
    const conn = new WsConnection(
      { sessions: mgr, resolver, macros },
      { send: (d) => sent.push(JSON.parse(d) as WsServerMessage), close: () => {} },
      alice
    );
    await conn.handle(JSON.stringify({ type: "open", host: "h", readOnly: true }));
    await conn.handle(keyWithSecret(macro.id));
    expect(sent.at(-1)).toMatchObject({ type: "error", code: "READ_ONLY_SESSION" });
  });
});

/**
 * **復号した秘密が、エラーの文言としてブラウザへ返らない。**
 *
 * `resolveSecret` は**ws 経路だけが呼ぶ**（`macro-store.ts` の注記）ので、ここだけが
 * 「サーバーが復号した平文を、送った本人が知らないまま受け取る」経路になる。
 * 型の合わない欄に当たると `FIELD_TYPE` の文言に値が埋まり、
 * `ws-handler` の catch が **message をそのままクライアントへ送っていた**
 * （`20260920-field-error-no-value` research F1。`AGENTS.md`「秘密の扱い」違反）。
 */
describe("ws: エラーの文言に秘密を載せない", () => {
  it("型の合わない欄へ再生しても、error の message に平文が出ない", async () => {
    const macros = new MacroStore([], crypto);
    const macro = macros.create(macroBody(), alice, 1000);
    // **数字しか入らない欄**へ差し込む＝`field-validate.ts` の型検証まで届く経路。
    // 秘密は 18 文字・欄は 20 桁なので、**桁あふれではなく型で**弾かれる。
    // 欄は (7,30)＝下の桁あふれの検査が使う signon 画面の (5,25) と別位置
    const { conn, sent } = await setup({ macros, user: alice, trace: digitsOnlyTrace() });
    sent.length = 0;

    await conn.handle(
      JSON.stringify({
        type: "key",
        key: "Enter",
        fields: [{ field: 1, secretRef: { macroId: macro.id, step: 0, field: 2 } }]
      })
    );
    await new Promise((r) => setTimeout(r, 20));

    const err = sent.find((m) => m.type === "error") as { code: string; message: string } | undefined;
    expect(err, "弾かれてエラーが返っている（この検査が空振りしていない）").toBeDefined();
    // **型検証で弾かれている**ことを見る——`FIELD_OVERFLOW` だと直した経路を通らない
    expect(err!.code, "桁あふれではなく型で弾かれている").toBe("FIELD_TYPE");
    expect(err!.message, "復号した平文が返っていない").not.toContain(DUMMY_SECRET);
    // 値の代わりに位置が入る（利用者が直せる唯一の手掛かり。AC3）
    expect(err!.message).toBe("field at (7,30) accepts digits only");
  });

  it("平文の**記号**も長さも返らない（英数字は文言と重なるので別途 toBe で見る）", async () => {
    const macros = new MacroStore([], crypto);
    const macro = macros.create(macroBody(), alice, 1000);
    const { conn, sent } = await setup({ macros, user: alice, trace: digitsOnlyTrace() });
    sent.length = 0;

    await conn.handle(
      JSON.stringify({
        type: "key",
        key: "Enter",
        fields: [{ field: 1, secretRef: { macroId: macro.id, step: 0, field: 2 } }]
      })
    );
    await new Promise((r) => setTimeout(r, 20));

    const err = sent.find((m) => m.type === "error") as { code: string; message: string } | undefined;
    // `DUMMY_SECRET` に固有の記号で見る（英数は位置・理由の文言にも在るため）
    for (const ch of new Set([...DUMMY_SECRET])) {
      if (/[a-z0-9]/i.test(ch)) continue;
      expect(err!.message, `平文の文字 ${JSON.stringify(ch)} が漏れている`).not.toContain(ch);
    }
    expect(err!.message, "長さも出さない").not.toContain(String(DUMMY_SECRET.length));
  });

  /**
   * **桁あふれの経路も同じ**。`field-validate.ts` の手前で落ちるが、そこで出していた
   * `value length 18 exceeds field length 10` は**秘密の長さ**をブラウザへ返していた
   * （requirements FR1「値・その一部・**その長さ**を含めない」）。
   */
  it("桁あふれで弾かれたときも、平文の長さを返さない", async () => {
    const macros = new MacroStore([], crypto);
    const macro = macros.create(macroBody(), alice, 1000);
    // signon 画面の index 1（ユーザー欄）は 10 桁。18 文字の秘密は桁あふれで落ちる
    const { conn, sent } = await setup({ macros, user: alice });
    sent.length = 0;

    await conn.handle(
      JSON.stringify({
        type: "key",
        key: "Enter",
        fields: [{ field: 1, secretRef: { macroId: macro.id, step: 0, field: 2 } }]
      })
    );
    await new Promise((r) => setTimeout(r, 20));

    const err = sent.find((m) => m.type === "error") as { code: string; message: string } | undefined;
    expect(err?.code, "この検査が空振りしていない").toBe("FIELD_OVERFLOW");
    expect(err!.message, "平文が返っていない").not.toContain(DUMMY_SECRET);
    expect(err!.message, "平文の長さも返さない").not.toContain(String(DUMMY_SECRET.length));
    // 欄の桁数（ホストが宣言した値）と位置は出してよい
    expect(err!.message).toBe("field at (5,25) accepts at most 10 characters");
  });

  /**
   * **`fields[].field` も実行時に検証する。** `handle()` は `JSON.parse(raw) as WsClientMessage`
   * で型を**名乗らせているだけ**なので、`field` に任意の文字列が入ってくる。
   * 検証せずに `setField` へ渡すと `resolveField` の `"index" in target` が
   * `TypeError: Cannot use 'in' operator to search for 'index' in <その文字列>` を投げ、
   * catch がそれをそのままクライアントへ返していた（AC9 違反。review 指摘で実測）。
   */
  it("**欄の指定が壊れていても、クライアントが送った文字列を反射しない**", async () => {
    const marker = "LEAK_MARKER_XYZ";
    // **要素そのものがプリミティブな形と、容れ物が配列でない形も振る**——
    // `{ field, value }` の中だけを振っていると、`"value" in f` を検証より前に置く並びも、
    // `fields.map is not a function` も見逃す（ラウンド 3・4 で実際に 2 度見逃した。
    // 3270 側の `ws-tn3270.test.ts` と**同じ形を振る**＝条項 `paired-artifact-sync`）
    const payloads: unknown[] = [
      { field: marker, value: "x" },
      { field: { index: marker }, value: "x" },
      { field: { row: marker, col: 1 }, value: "x" },
      { field: null, value: "x" },
      { field: [], value: "x" },
      { field: 1, value: { [marker]: 1 } },
      marker, // 要素そのものが文字列
      42
    ];
    for (const entry of payloads) {
      const { conn, sent } = await setup({ user: alice });
      sent.length = 0;
      await conn.handle(JSON.stringify({ type: "key", key: "Enter", fields: [entry] }));
      await new Promise((r) => setTimeout(r, 20));

      const label = JSON.stringify(entry);
      const err = sent.find((m) => m.type === "error") as { code: string; message: string } | undefined;
      expect(err, `弾かれている: ${label}`).toBeDefined();
      expect(err!.message, `反射している: ${label}`).not.toContain(marker);
      // 素の TypeError（JS のエラー文）を漏らさない
      expect(err!.message, `素の TypeError: ${label}`).not.toContain("in operator");
    }
  });

  /**
   * **容れ物（`fields` そのもの）も検証する。** 要素だけ守っても、配列でないものが来ると
   * `fields.map is not a function` が**素の V8 の文言のまま**ブラウザへ返る
   * （review ラウンド 4 で実測。3270 では文字列を 1 文字ずつ回っており、
   * **同じ入力に 5250 と 3270 が別の答えを返していた**）。
   */
  it("**fields が配列でなければ素の JS エラーを返さない**", async () => {
    for (const fields of ["LEAK_MARKER_XYZ", { length: 1, 0: { field: 1, value: "x" } }, 42, null]) {
      const { conn, sent } = await setup({ user: alice });
      sent.length = 0;
      await conn.handle(JSON.stringify({ type: "key", key: "Enter", fields }));
      await new Promise((r) => setTimeout(r, 20));

      const label = JSON.stringify(fields);
      const err = sent.find((m) => m.type === "error") as { code: string; message: string } | undefined;
      if (fields === null) continue; // null は「欄の指定なし」と同義で通ってよい
      expect(err, `弾かれている: ${label}`).toBeDefined();
      expect(err!.code, label).toBe("PROTOCOL_ERROR");
      expect(err!.message, `素の JS エラー: ${label}`).not.toContain("is not a function");
      expect(err!.message, `素の JS エラー: ${label}`).not.toContain("is not iterable");
    }
  });

  /**
   * **`gui-select` / `gui-submit` の `fieldId` も同じ**（review ラウンド 3 の指摘）。
   * `handle()` は型を名乗らせているだけなので任意の JSON が届き、
   * `選択できません（fieldId=…）` / `no GUI selection field id=…` として反射していた。
   */
  it("**GUI 選択の fieldId を反射しない**", async () => {
    const marker = "LEAK_MARKER_XYZ";
    for (const type of ["gui-select", "gui-submit"]) {
      const { conn, sent } = await setup({ user: alice });
      sent.length = 0;
      await conn.handle(JSON.stringify({ type, fieldId: marker, choiceIndex: 0 }));
      await new Promise((r) => setTimeout(r, 20));

      const err = sent.find((m) => m.type === "error") as { code: string; message: string } | undefined;
      expect(err, `弾かれている: ${type}`).toBeDefined();
      expect(err!.message, `反射している: ${type}`).not.toContain(marker);
    }
  });

  it("**値が文字列でなくても素の TypeError を漏らさない**", async () => {
    const { conn, sent } = await setup({ user: alice });
    sent.length = 0;
    await conn.handle(
      JSON.stringify({ type: "key", key: "Enter", fields: [{ field: 1, value: { LEAK_MARKER_XYZ: 1 } }] })
    );
    await new Promise((r) => setTimeout(r, 20));
    const err = sent.find((m) => m.type === "error") as { code: string; message: string } | undefined;
    expect(err).toBeDefined();
    expect(err!.message).not.toContain("LEAK_MARKER_XYZ");
  });

  it("**不正な secretRef でも、クライアントが送った文字列を反射しない**", async () => {
    const { conn, sent } = await setup({ macros: new MacroStore([], crypto), user: alice });
    sent.length = 0;

    await conn.handle(
      JSON.stringify({
        type: "key",
        key: "Enter",
        fields: [{ field: 1, secretRef: { macroId: "x", step: 0, field: 2, LEAK_MARKER_XYZ: "v" } }]
      })
    );
    await new Promise((r) => setTimeout(r, 20));

    const err = sent.find((m) => m.type === "error") as { code: string; message: string } | undefined;
    expect(err?.code).toBe("PROTOCOL_ERROR");
    // zod の `unrecognized_keys` は**クライアントが付けたキー名**を文言に出す（同 research F1-c）
    expect(err!.message, "クライアント由来の文字列を反射しない").not.toContain("LEAK_MARKER_XYZ");
  });
});
