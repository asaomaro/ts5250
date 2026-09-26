import { reactive } from "vue";
import type { ConnectPayload, HostToWebviewMessage, WebviewToHostMessage } from "../embed-protocol.js";

/**
 * `embed.html` と、それを iframe 表示する VSCode 拡張機能（`vscode-extension/`）との
 * `postMessage` 橋渡し。`.aidev/works/20260924-vscode-extension/architecture.md`
 * 「メッセージプロトコル」の実装。
 *
 * **信頼境界は「直接の親フレームか」まで**（`event.source === window.parent`）。
 * `postMessage`の送信先を`"*"`にしている（ポートが動的で相手のoriginを事前に知れないため）
 * のと対称に、受信側もorigin文字列では絞れない。`event.source`の同一性判定なら、
 * どのoriginで動いていても効く。**これはメッセージの送り主が本当に拡張ホストかまでは
 * 保証しない**——`127.0.0.1`は同一マシン上の任意のページから到達できるため、
 * `embed.html`を直接iframe化して偽装する攻撃までは防げない。この境界は既存のサーバー
 * （`X-Frame-Options`等を出さない。AGENTS.md「認証オフ＝単一の信頼ユーザー」の
 * ネットワーク境界＝loopback限定を信頼の前提とする設計）と同じ前提の上に立つ。
 */
export const embedStore = reactive<{
  connect: ConnectPayload | undefined;
  error: string | undefined;
}>({ connect: undefined, error: undefined });

/**
 * 拡張ホストへ送る。**トップレベルで直接開かれた場合（親フレームが無い）は何もしない**——
 * VSCode拡張が無い状態でもブラウザで`/embed.html?app=...`を直接開いて目視確認できるようにするため
 * （`01-embed-ui`の実装方針）。
 */
export function postToHost(msg: WebviewToHostMessage): void {
  if (window.parent === window) return;
  window.parent.postMessage(msg, "*");
}

const APP_KINDS = ["emulator", "printer", "sql", "ifs"] as const;

/**
 * `payload`の形を検査する（`type`が合っているだけでは中身の型は保証されない。
 * `.aidev/conventions/test-input-shape.md`——外から来る入力は値だけでなく形も見る）。
 * 必須項目（`app`が既知の種別・`host`が文字列）だけを見る。その他の項目は`ConnectPayload`側で
 * 任意（`?:`）なので、無くても・型が違っても実害が小さく、ここでは検査しない
 */
function isConnectPayload(v: unknown): v is ConnectPayload {
  if (!v || typeof v !== "object") return false;
  const p = v as Record<string, unknown>;
  return typeof p.host === "string" && APP_KINDS.includes(p.app as (typeof APP_KINDS)[number]);
}

/** メッセージ受信を配線する。`embed.ts` から一度だけ呼ぶ */
export function initEmbedBridge(): void {
  window.addEventListener("message", (ev: MessageEvent<unknown>) => {
    if (ev.source !== window.parent) return; // 直接の親フレーム以外からは受け取らない
    const msg = ev.data as HostToWebviewMessage | undefined;
    if (!msg || typeof msg !== "object" || !("type" in msg)) return;
    switch (msg.type) {
      case "connect":
      case "saved":
        if (!isConnectPayload(msg.payload)) return;
        embedStore.connect = msg.payload;
        embedStore.error = undefined;
        break;
      case "saveError":
      case "fileInvalid":
        if (typeof msg.message !== "string") return;
        embedStore.error = msg.message;
        break;
    }
  });
}
