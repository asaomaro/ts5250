import { vi } from "vitest";
import type { SecretStorage, SecretStorageChangeEvent, Event, Disposable, Uri, ExtensionContext } from "vscode";

/**
 * 手書きの`vscode`モックハーネス。実際のVSCode拡張ホストはこのコンテナに無い
 * （`code`はWSL越しのWindowsバイナリで、ここから駆動できない。`Xvfb`も無い。
 * `@vscode/test-electron`によるヘッドレス実行環境の整備は別セッションで進行中——
 * `02-extension-core/tasks.md`「実装方針」3）。
 *
 * **フルの型を実装しない。** 使う面だけの最小オブジェクトを`as unknown as X`で
 * キャストする——`vscode.Webview`等は使わないプロパティ（`viewColumn`・`active`等）が
 * 多数あり、全部埋めるとモックの保守コストがテスト対象より大きくなる
 */

export function mockSecretStorage(): SecretStorage {
  const store = new Map<string, string>();
  const noopEvent: Event<SecretStorageChangeEvent> = () => ({ dispose() {} }) as Disposable;
  return {
    keys: async () => [...store.keys()],
    get: async (key) => store.get(key),
    store: async (key, value) => {
      store.set(key, value);
    },
    delete: async (key) => {
      store.delete(key);
    },
    onDidChange: noopEvent
  };
}

/** `window.addEventListener`のVSCode版——`fire()`でテストから発火させられる簡易イベント */
function makeEmitter<T>(): { event: Event<T>; fire: (v: T) => void } {
  const handlers: Array<(v: T) => void> = [];
  return {
    event: ((handler: (v: T) => void) => {
      handlers.push(handler);
      return { dispose() {} };
    }) as Event<T>,
    fire: (v: T) => handlers.forEach((h) => h(v))
  };
}

export interface MockWebview {
  html: string;
  postMessage: ReturnType<typeof vi.fn>;
  /** テストから「WebView側がメッセージを送ってきた」を模擬する */
  fireMessage: (msg: unknown) => void;
  cspSource: string;
  asWebviewUri: (uri: Uri) => Uri;
}

export function mockWebview(): MockWebview {
  const emitter = makeEmitter<unknown>();
  const webview = {
    options: {},
    html: "",
    cspSource: "vscode-webview://mock",
    asWebviewUri: (uri: Uri) => uri,
    postMessage: vi.fn(async () => true),
    onDidReceiveMessage: emitter.event
  };
  return Object.assign(webview, { fireMessage: emitter.fire }) as unknown as MockWebview;
}

export interface MockWebviewPanel {
  webview: MockWebview;
  dispose: ReturnType<typeof vi.fn>;
  /** テストから「利用者がタブを閉じた」を模擬する */
  fireDispose: () => void;
}

export function mockWebviewPanel(): MockWebviewPanel {
  const webview = mockWebview();
  const disposeEmitter = makeEmitter<void>();
  const panel = {
    webview,
    onDidDispose: disposeEmitter.event,
    dispose: vi.fn(() => disposeEmitter.fire())
  };
  return Object.assign(panel, { fireDispose: disposeEmitter.fire }) as unknown as MockWebviewPanel;
}

export function mockExtensionContext(globalStorageDir: string): ExtensionContext {
  return {
    secrets: mockSecretStorage(),
    globalStorageUri: { fsPath: globalStorageDir, toString: () => globalStorageDir } as Uri,
    subscriptions: []
  } as unknown as ExtensionContext;
}

export function mockTextDocument(uri: string, text: string) {
  let current = text;
  return {
    getText: () => current,
    /** テキストエディタ等で書き換えられた状態を作る（`onDidChangeTextDocument`の検証用） */
    setText: (t: string) => {
      current = t;
    },
    save: vi.fn(async () => true),
    // 実際の位置計算はしない（`handleSave`は戻り値を`Range`へそのまま渡すだけで、
    // 中身（line/character）は見ない）。テスト対象が使う面だけを満たす
    positionAt: (offset: number) => ({ line: 0, character: offset }),
    uri: { toString: () => uri, fsPath: uri } as Uri,
    fileName: uri
  };
}
