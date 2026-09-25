import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * `vi.mock`のファクトリはファイル先頭へホイストされるため、参照する値も
 * `vi.hoisted`で同じくホイストして宣言する（`const`のTDZに引っかからないように）
 */
const { acquire, release, heartbeatFn, ServiceManagerCtor } = vi.hoisted(() => {
  const acquire = vi.fn(async () => ({ port: 1 }));
  const release = vi.fn(async () => {});
  const heartbeatFn = vi.fn(async () => {});
  const ServiceManagerCtor = vi.fn().mockImplementation(function () {
    return { acquire, release, heartbeat: heartbeatFn };
  });
  return { acquire, release, heartbeatFn, ServiceManagerCtor };
});
vi.mock("../src/serviceManager.js", () => ({ ServiceManager: ServiceManagerCtor }));

const { Ts5250EditorProviderCtor } = vi.hoisted(() => {
  const Ts5250EditorProviderCtor = Object.assign(
    vi.fn().mockImplementation(function () {
      return {};
    }),
    { viewType: "ts5250.editor" }
  );
  return { Ts5250EditorProviderCtor };
});
vi.mock("../src/ts5250EditorProvider.js", () => ({ Ts5250EditorProvider: Ts5250EditorProviderCtor }));

const { registerCustomEditorProvider, createOutputChannel } = vi.hoisted(() => ({
  registerCustomEditorProvider: vi.fn(() => ({ dispose: vi.fn() })),
  createOutputChannel: vi.fn(() => ({ append: vi.fn(), dispose: vi.fn() }))
}));
vi.mock("vscode", () => ({
  window: { registerCustomEditorProvider, createOutputChannel },
  ExtensionMode: { Production: 1, Development: 2, Test: 3 }
}));

import { activate, deactivate } from "../src/extension.js";
import { mockExtensionContext } from "./vscode-mock.js";

interface CapturedDeps {
  secretCrypto: unknown;
  acquireService: () => Promise<{ port: number }>;
  releaseService: () => Promise<void>;
}

/** `Ts5250EditorProvider`のコンストラクタへ渡された最後の引数（`extension.ts`が組み立てたdeps） */
function lastCapturedDeps(): CapturedDeps {
  const calls = Ts5250EditorProviderCtor.mock.calls as [CapturedDeps][];
  const last = calls.at(-1);
  if (!last) throw new Error("Ts5250EditorProvider が構築されていません");
  return last[0];
}

function makeContext(extensionMode: 1 | 2 = 2 /* Development */) {
  const context = mockExtensionContext("/tmp/mock-global-storage") as unknown as {
    extensionUri: { fsPath: string };
    extensionMode: number;
    subscriptions: Array<{ dispose: () => void }>;
  };
  context.extensionUri = { fsPath: "/repo/vscode-extension" };
  context.extensionMode = extensionMode;
  return context;
}

beforeEach(() => {
  acquire.mockClear();
  release.mockClear();
  heartbeatFn.mockClear();
  ServiceManagerCtor.mockClear();
  Ts5250EditorProviderCtor.mockClear();
  registerCustomEditorProvider.mockClear();
});

describe("activate", () => {
  it("Ts5250EditorProviderをviewType付きで登録する", async () => {
    await activate(makeContext() as never);
    expect(registerCustomEditorProvider).toHaveBeenCalledWith(
      "ts5250.editor",
      expect.anything(),
      expect.objectContaining({ webviewOptions: expect.objectContaining({ retainContextWhenHidden: true }) })
    );
  });

  it("Development: リポジトリルート（extensionUriの1階層上）のpackages/以下を指す", async () => {
    await activate(makeContext(2 /* Development */) as never);
    const opts = ServiceManagerCtor.mock.calls[0]![0] as { serverMainPath: string; webRootPath: string };
    expect(opts.serverMainPath).toBe("/repo/packages/server/dist/main.js");
    expect(opts.webRootPath).toBe("/repo/packages/web-ui/dist");
  });

  it("Production: 拡張機能自身のserver-stage/以下を指す（04-packaging）", async () => {
    await activate(makeContext(1 /* Production */) as never);
    const opts = ServiceManagerCtor.mock.calls[0]![0] as { serverMainPath: string; webRootPath: string };
    expect(opts.serverMainPath).toBe(
      "/repo/vscode-extension/server-stage/node_modules/@ts5250/server/dist/main.js"
    );
    expect(opts.webRootPath).toBe("/repo/vscode-extension/server-stage/packages/web-ui/dist");
  });

  it("ServiceManagerへonChildOutputを渡し、呼ぶと「ts5250」出力パネルへ流れる", async () => {
    createOutputChannel.mockClear();
    await activate(makeContext() as never);
    const channel = createOutputChannel.mock.results[0]!.value as { append: (s: string) => void };
    const opts = ServiceManagerCtor.mock.calls[0]![0] as { onChildOutput: (chunk: string) => void };

    opts.onChildOutput("起動中...\n");

    expect(channel.append).toHaveBeenCalledWith("起動中...\n");
  });

  it("ローカル参照カウント: 2回acquireして1回releaseしても、まだ下位のreleaseは呼ばれない", async () => {
    await activate(makeContext() as never);
    const deps = lastCapturedDeps();
    await deps.acquireService();
    await deps.acquireService();
    await deps.releaseService();
    expect(release).not.toHaveBeenCalled();

    await deps.releaseService();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("acquireServiceは毎回下位のacquireを呼ぶ（起動済みなら再利用はServiceManager側の責務）", async () => {
    await activate(makeContext() as never);
    const deps = lastCapturedDeps();
    await deps.acquireService();
    await deps.acquireService();
    expect(acquire).toHaveBeenCalledTimes(2);
  });

  it("releaseServiceをacquire無しで呼んでも0未満にならず、下位のreleaseを呼ばない", async () => {
    await activate(makeContext() as never);
    await lastCapturedDeps().releaseService();
    expect(release).not.toHaveBeenCalled();
  });

  it("acquireが失敗したらローカルカウントを戻す（失敗を数えたままにしない）", async () => {
    await activate(makeContext() as never);
    const deps = lastCapturedDeps();
    acquire.mockRejectedValueOnce(new Error("boom"));
    await expect(deps.acquireService()).rejects.toThrow("boom");

    // カウントが戻っていれば、後続の1回のacquire成功→release で下位のreleaseまで到達する
    await deps.acquireService();
    await deps.releaseService();
    expect(release).toHaveBeenCalledTimes(1);
  });
});

describe("ハートビート", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("参照が無い間はハートビートを送らない", async () => {
    await activate(makeContext() as never);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(heartbeatFn).not.toHaveBeenCalled();
  });

  it("参照がある間は30秒ごとにハートビートを送る", async () => {
    await activate(makeContext() as never);
    await lastCapturedDeps().acquireService();
    await vi.advanceTimersByTimeAsync(65_000);
    expect(heartbeatFn.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("deactivate", () => {
  it("例外を投げない（後片付けはcontext.subscriptions経由）", () => {
    expect(() => deactivate()).not.toThrow();
  });
});
