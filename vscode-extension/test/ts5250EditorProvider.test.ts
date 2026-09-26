import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `vscode`モジュール全体のフェイク（`vi.mock`はホイストされる）。
 * `ts5250EditorProvider.ts`が`import * as vscode from "vscode"`で直接使う
 * 名前空間レベルのAPI（`WorkspaceEdit`・`Range`・`workspace.applyEdit`・
 * `env.openExternal`・`Uri.parse`）だけを最小実装する
 * （`vscode-mock.ts`のオブジェクト単位モックとは別枠——こちらはモジュール差し替え）
 */
const applyEdit = vi.fn(async (_edit: unknown) => true);
const openExternal = vi.fn(async (_uri: unknown) => true);
vi.mock("vscode", () => {
  class WorkspaceEdit {
    replacements: Array<{ uri: unknown; range: unknown; text: string }> = [];
    replace(uri: unknown, range: unknown, text: string): void {
      this.replacements.push({ uri, range, text });
    }
  }
  class Range {
    constructor(
      public start: unknown,
      public end: unknown
    ) {}
  }
  return {
    WorkspaceEdit,
    Range,
    workspace: { applyEdit: (e: unknown) => applyEdit(e) },
    env: { openExternal: (u: unknown) => openExternal(u) },
    Uri: { parse: (s: string) => ({ toString: () => s }) }
  };
});

import { Ts5250EditorProvider } from "../src/ts5250EditorProvider.js";
import { ExtensionSecretCrypto } from "../src/secretCrypto.js";
import { mockSecretStorage, mockTextDocument, mockWebviewPanel } from "./vscode-mock.js";
import type { HostToWebviewMessage } from "../src/protocol.js";

async function setup(fileText: string) {
  const crypto = await ExtensionSecretCrypto.fromSecretStorage(mockSecretStorage());
  const acquireService = vi.fn(async () => ({ port: 12345 }));
  const releaseService = vi.fn(async () => {});
  const syncSystem = vi.fn(async (_localPort: number, _input: unknown) => "own:mock");
  const log = vi.fn();
  const provider = new Ts5250EditorProvider({ secretCrypto: crypto, acquireService, releaseService, syncSystem, log });
  const document = mockTextDocument("file:///a.ts5250", fileText);
  const panel = mockWebviewPanel();
  await provider.resolveCustomTextEditor(document as never, panel as never, {} as never);
  return { crypto, acquireService, releaseService, syncSystem, log, document, panel };
}

function lastPostedOfType<T extends HostToWebviewMessage["type"]>(
  panel: Awaited<ReturnType<typeof setup>>["panel"],
  type: T
): Extract<HostToWebviewMessage, { type: T }> | undefined {
  const calls = panel.webview.postMessage.mock.calls as [HostToWebviewMessage][];
  const found = [...calls].reverse().find(([m]) => m.type === type);
  return found?.[0] as Extract<HostToWebviewMessage, { type: T }> | undefined;
}

beforeEach(() => {
  applyEdit.mockClear();
  applyEdit.mockResolvedValue(true);
  openExternal.mockClear();
});

describe("resolveCustomTextEditor: 起動", () => {
  it("serviceを確保し、webview.htmlをshell HTMLへ差し替える", async () => {
    const { acquireService, panel } = await setup('{"app":"emulator"}');
    expect(acquireService).toHaveBeenCalledTimes(1);
    expect(panel.webview.html).toContain("embed.html?app=emulator");
  });

  it("service起動に失敗したら、失敗理由を表示するプレースホルダーHTMLにする（例外を投げない）", async () => {
    const crypto = await ExtensionSecretCrypto.fromSecretStorage(mockSecretStorage());
    const acquireService = vi.fn(async () => {
      throw new Error("boom");
    });
    const releaseService = vi.fn(async () => {});
    const provider = new Ts5250EditorProvider({
      secretCrypto: crypto,
      acquireService,
      releaseService,
      syncSystem: vi.fn(async (_localPort: number, _input: unknown) => "own:mock"),
      log: vi.fn()
    });
    const document = mockTextDocument("file:///a.ts5250", '{"app":"emulator"}');
    const panel = mockWebviewPanel();

    await expect(provider.resolveCustomTextEditor(document as never, panel as never, {} as never)).resolves.toBeUndefined();
    expect(panel.webview.html).toContain("boom");
  });
});

describe("ready → loaded（接続はしない。decisions.md D17）", () => {
  it("readyを受けたら.ts5250の内容からloadedを送る（connectは送らない）", async () => {
    const { panel } = await setup('{"app":"emulator","host":"AS400","port":992}');
    panel.webview.fireMessage({ type: "ready" });
    await flush();

    const loaded = lastPostedOfType(panel, "loaded");
    expect(loaded?.payload).toMatchObject({ app: "emulator", host: "AS400", port: 992 });
    expect(lastPostedOfType(panel, "connect")).toBeUndefined();
  });

  it("passwordEncがあれば復号して平文をloadedへ乗せる", async () => {
    const { crypto, panel } = await setup("{}"); // 後で書き換える
    const enc = crypto.encrypt("hunter2");
    // 実際のファイル内容を差し替えて再度readyを発火させたいので、setupをやり直す形で検証
    const { panel: panel2 } = await setupWithCrypto(crypto, `{"app":"emulator","host":"H","signon":{"user":"U","passwordEnc":"${enc}"}}`);
    panel2.webview.fireMessage({ type: "ready" });
    await flush();
    const loaded = lastPostedOfType(panel2, "loaded");
    expect(loaded?.payload.user).toBe("U");
    expect(loaded?.payload.password).toBe("hunter2");
    void panel; // 未使用警告よけ（最初のsetupは鍵取得のためだけに使った）
  });

  it("appが未指定/JSONが壊れているファイルはfileInvalidを送る", async () => {
    const { panel } = await setup("{not json");
    panel.webview.fireMessage({ type: "ready" });
    await flush();
    expect(lastPostedOfType(panel, "fileInvalid")).toBeDefined();
  });

  it("passwordEncの復号に失敗しても、passwordを省いたloadedを送る（他のフィールドは活かす。saveErrorにはしない）", async () => {
    const { panel } = await setup('{"app":"emulator","host":"H","signon":{"user":"U","passwordEnc":"v1:aa:bb:cc"}}');
    panel.webview.fireMessage({ type: "ready" });
    await flush();
    const loaded = lastPostedOfType(panel, "loaded");
    expect(loaded?.payload).toMatchObject({ host: "H", user: "U" });
    expect(loaded?.payload.password).toBeUndefined();
    expect(lastPostedOfType(panel, "saveError")).toBeUndefined();
  });

  it("emulator以外はloadedでもuser/passwordを剥離する（syncSystemを経ないぶん、ここで剥がさないと平文が漏れる）", async () => {
    const { panel } = await setup('{"app":"sql","host":"AS400","signon":{"user":"U","passwordEnc":"v1:aa:bb:cc"}}');
    panel.webview.fireMessage({ type: "ready" });
    await flush();
    const loaded = lastPostedOfType(panel, "loaded");
    expect(loaded?.payload.user).toBeUndefined();
    expect(loaded?.payload.password).toBeUndefined();
  });

  it("readyだけではsyncSystemを呼ばない（ファイルを開いただけでは何もサーバー側に登録しない）", async () => {
    const { panel, syncSystem } = await setup('{"app":"sql","host":"AS400","signon":{"user":"U"}}');
    panel.webview.fireMessage({ type: "ready" });
    await flush();
    expect(syncSystem).not.toHaveBeenCalled();
  });
});

describe("接続ボタン → connect → systemRef解決（03-sql-ifs。emulatorへの拡張は`decisions.md` D12。ボタン化はD17）", () => {
  it("emulator以外はsyncSystemを呼び、user/passwordを直接乗せずsystemRefを乗せる", async () => {
    const { panel, syncSystem } = await setup('{"app":"sql","host":"AS400","port":992,"signon":{"user":"U"}}');
    syncSystem.mockResolvedValueOnce("own:xyz");
    panel.webview.fireMessage({ type: "connect" });
    await flush();

    expect(syncSystem).toHaveBeenCalledTimes(1);
    const [localPort, input] = syncSystem.mock.calls[0]!;
    expect(localPort).toBe(12345);
    expect(input).toMatchObject({ documentUri: "file:///a.ts5250", host: "AS400", port: 992, user: "U" });

    const connect = lastPostedOfType(panel, "connect");
    expect(connect?.payload.systemRef).toBe("own:xyz");
    expect(connect?.payload.user).toBeUndefined();
    expect(connect?.payload.password).toBeUndefined();
  });

  it("syncSystemが失敗しても、systemRef無しのconnectを送り、logへ記録する（致命的に倒さない）", async () => {
    const { panel, syncSystem, log } = await setup('{"app":"ifs","host":"AS400"}');
    syncSystem.mockRejectedValueOnce(new Error("network down"));
    panel.webview.fireMessage({ type: "connect" });
    await flush();

    const connect = lastPostedOfType(panel, "connect");
    expect(connect?.payload.systemRef).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("network down"));
    expect(lastPostedOfType(panel, "saveError")).toBeUndefined();
  });

  it("emulatorもsyncSystemを呼ぶが、user/passwordはconnectのpayloadに残したままsystemRefを併せて乗せる（D12: ステータスバーのメッセージ表示等、system参照を要求するREST機能のため）", async () => {
    const { panel, syncSystem } = await setup('{"app":"emulator","host":"AS400","signon":{"user":"U"}}');
    syncSystem.mockResolvedValueOnce("own:emu");
    panel.webview.fireMessage({ type: "connect" });
    await flush();

    expect(syncSystem).toHaveBeenCalledTimes(1);
    const [, input] = syncSystem.mock.calls[0]!;
    expect(input).toMatchObject({ host: "AS400", user: "U" });

    const connect = lastPostedOfType(panel, "connect");
    // **emulatorはuser/passwordを剥離しない**——WsOpen直接指定がこの経路も使うため
    expect(connect?.payload.user).toBe("U");
    expect(connect?.payload.systemRef).toBe("own:emu");
  });

  it("emulatorでsyncSystemが失敗しても、systemRef無しのconnectを送り接続自体は成立する（致命的に倒さない）", async () => {
    const { panel, syncSystem, log } = await setup('{"app":"emulator","host":"AS400"}');
    syncSystem.mockRejectedValueOnce(new Error("network down"));
    panel.webview.fireMessage({ type: "connect" });
    await flush();

    const connect = lastPostedOfType(panel, "connect");
    expect(connect?.payload.host).toBe("AS400"); // 接続情報自体は届く
    expect(connect?.payload.systemRef).toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("network down"));
  });

  it("実在するpasswordEncがあっても、復号した平文はsyncSystemへだけ渡り、WebViewへのpayloadからは剥離される（taskcheck T2の指摘）", async () => {
    const { crypto } = await setup("{}"); // 鍵を取り出すためだけ
    const enc = crypto.encrypt("realSecret123");
    const { panel, syncSystem } = await setupWithCrypto(
      crypto,
      `{"app":"sql","host":"AS400","signon":{"user":"U","passwordEnc":"${enc}"}}`
    );
    syncSystem.mockResolvedValueOnce("own:xyz");
    panel.webview.fireMessage({ type: "connect" });
    await flush();

    const [, input] = syncSystem.mock.calls[0]!;
    expect(input).toMatchObject({ user: "U", password: "realSecret123" });

    const connect = lastPostedOfType(panel, "connect");
    expect(connect?.payload.user).toBeUndefined();
    expect(connect?.payload.password).toBeUndefined();
    expect(JSON.stringify(connect?.payload)).not.toContain("realSecret123");
  });

  it("appが未指定/JSONが壊れているファイルへの接続要求はfileInvalidを送る", async () => {
    const { panel } = await setup("{not json");
    panel.webview.fireMessage({ type: "connect" });
    await flush();
    expect(lastPostedOfType(panel, "fileInvalid")).toBeDefined();
  });
});

describe("save → WorkspaceEdit書き戻し → saved", () => {
  it("平文パスワードを暗号化してWorkspaceEditで書き戻し、savedを返す", async () => {
    const { panel, document } = await setup('{"app":"emulator","host":"OLD"}');
    panel.webview.fireMessage({
      type: "save",
      payload: { host: "NEW", port: 992, user: "U", password: "secret" }
    });
    await flush();

    expect(applyEdit).toHaveBeenCalledTimes(1);
    const edit = applyEdit.mock.calls[0]![0] as { replacements: Array<{ text: string }> };
    const written = JSON.parse(edit.replacements[0]!.text) as { host: string; signon?: { passwordEnc?: string } };
    expect(written.host).toBe("NEW");
    expect(written.signon?.passwordEnc?.startsWith("v1:")).toBe(true);

    const saved = lastPostedOfType(panel, "saved");
    expect(saved?.payload).toMatchObject({ host: "NEW", user: "U", password: "secret" });
    void document;
  });

  it("applyEditがfalse（競合）を返したらsaveErrorを送り、savedは送らない", async () => {
    applyEdit.mockResolvedValueOnce(false);
    const { panel } = await setup('{"app":"emulator","host":"OLD"}');
    panel.webview.fireMessage({ type: "save", payload: { host: "NEW" } });
    await flush();

    expect(lastPostedOfType(panel, "saveError")).toBeDefined();
    expect(lastPostedOfType(panel, "saved")).toBeUndefined();
  });

  it("既存の壊れたpasswordEncを新パスワードなしで保存しても、書き込み自体は成功としてsavedを送る（保存成功とpassword復号失敗を混同しない）", async () => {
    const { panel } = await setup('{"app":"emulator","host":"OLD","signon":{"user":"U","passwordEnc":"v1:aa:bb:cc"}}');
    panel.webview.fireMessage({ type: "save", payload: { host: "NEW" } }); // passwordは入力しない
    await flush();

    expect(applyEdit).toHaveBeenCalledTimes(1); // 書き込みは実行された
    expect(lastPostedOfType(panel, "saved")).toBeDefined();
    expect(lastPostedOfType(panel, "saveError")).toBeUndefined();
    expect(lastPostedOfType(panel, "saved")?.payload.password).toBeUndefined();
  });

  it("saveメッセージのpayloadの形が不正（nullやhost欠落）ならsaveErrorを送り、例外を投げない", async () => {
    const { panel } = await setup('{"app":"emulator","host":"OLD"}');
    panel.webview.fireMessage({ type: "save", payload: null });
    await flush();
    expect(lastPostedOfType(panel, "saveError")).toBeDefined();
    expect(applyEdit).not.toHaveBeenCalled();
  });

  /**
   * **保存はsyncSystemを呼ばない**（`decisions.md` D17）——設定を変えただけでは
   * サーバー側に何も登録しない。以前（D12まで）は保存直後にsyncSystemまで解決していたが、
   * 「接続」ボタンを押すまで実接続しない、という利用者の要望でこの経路から外した
   */
  it("app!==emulator（sql）の保存は、暗号化して書き込むがsyncSystemは呼ばず、savedのpayloadからはuser/passwordを剥離する（taskcheck T2の指摘の踏襲。D17でsyncSystemは呼ばれなくなった）", async () => {
    const { panel, syncSystem } = await setup('{"app":"sql","host":"OLD"}');
    panel.webview.fireMessage({
      type: "save",
      payload: { host: "NEW", user: "U", password: "freshSecret" }
    });
    await flush();

    // ファイルには暗号化して書き込む（app種別に関わらず、フィルタリングはWebView向けpayloadだけ）
    const edit = applyEdit.mock.calls[0]![0] as { replacements: Array<{ text: string }> };
    const written = JSON.parse(edit.replacements[0]!.text) as { signon?: { passwordEnc?: string } };
    expect(written.signon?.passwordEnc?.startsWith("v1:")).toBe(true);

    // 保存だけではsyncSystemを呼ばない（D17）
    expect(syncSystem).not.toHaveBeenCalled();

    // WebViewへの`saved`payloadにはsystemRefも付かず（syncSystemを経ないため）、user/passwordも含まない
    const saved = lastPostedOfType(panel, "saved");
    expect(saved?.payload.systemRef).toBeUndefined();
    expect(saved?.payload.user).toBeUndefined();
    expect(saved?.payload.password).toBeUndefined();
  });

  it("emulatorの保存はsyncSystemを呼ばない（D17。接続時のみ呼ぶ）", async () => {
    const { panel, syncSystem } = await setup('{"app":"emulator","host":"OLD"}');
    panel.webview.fireMessage({ type: "save", payload: { host: "NEW", user: "U", password: "secret" } });
    await flush();
    expect(syncSystem).not.toHaveBeenCalled();
    const saved = lastPostedOfType(panel, "saved");
    // emulatorはuser/passwordを剥離しない（WsOpen直接指定のため。既存の仕様のまま）
    expect(saved?.payload).toMatchObject({ host: "NEW", user: "U", password: "secret" });
  });
});

describe("openExternal", () => {
  it("openExternalメッセージでvscode.env.openExternalを呼ぶ", async () => {
    const { panel } = await setup('{"app":"emulator"}');
    panel.webview.fireMessage({ type: "openExternal", url: "https://example.com" });
    await flush();
    expect(openExternal).toHaveBeenCalledTimes(1);
  });
});

describe("パネルを閉じる", () => {
  it("onDidDisposeでreleaseServiceを呼ぶ", async () => {
    const { panel, releaseService } = await setup('{"app":"emulator"}');
    panel.fireDispose();
    await flush();
    expect(releaseService).toHaveBeenCalledTimes(1);
  });
});

async function setupWithCrypto(crypto: ExtensionSecretCrypto, fileText: string) {
  const acquireService = vi.fn(async () => ({ port: 1 }));
  const releaseService = vi.fn(async () => {});
  const syncSystem = vi.fn(async (_localPort: number, _input: unknown) => "own:mock");
  const log = vi.fn();
  const provider = new Ts5250EditorProvider({ secretCrypto: crypto, acquireService, releaseService, syncSystem, log });
  const document = mockTextDocument("file:///a.ts5250", fileText);
  const panel = mockWebviewPanel();
  await provider.resolveCustomTextEditor(document as never, panel as never, {} as never);
  return { provider, document, panel, syncSystem, log };
}

/** メッセージハンドラ内の`await`が終わるまでマイクロタスクを1周待つ */
function flush(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/**
 * **画面の名前＝ファイル名（拡張子なし）**を付ける（`decisions.md` D19）。本来のアプリのタブ名
 * （保存済みセッション設定の名前）に当たるものが`.ts5250`には無いため
 */
describe("title（ファイル名）", () => {
  it("loaded / connect / saved のどれにもファイル名（拡張子なし）が付く", async () => {
    const { panel } = await setup('{"app":"emulator","host":"AS400"}'); // file:///a.ts5250
    panel.webview.fireMessage({ type: "ready" });
    panel.webview.fireMessage({ type: "connect" });
    panel.webview.fireMessage({ type: "save", payload: { host: "NEW" } });
    await flush();
    expect(lastPostedOfType(panel, "loaded")?.payload.title).toBe("a");
    expect(lastPostedOfType(panel, "connect")?.payload.title).toBe("a");
    expect(lastPostedOfType(panel, "saved")?.payload.title).toBe("a");
  });
});
