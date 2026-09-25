/**
 * shell HTML（`WebviewPanel.webview.html`に設定する文字列）を組み立てる。
 *
 * VSCode公式のSimple Browser拡張と同じ構成——CSPで`frame-src`を許可し、
 * サンドボックス化した`<iframe>`にローカルサーバーのページを読み込む
 * （research F1: `microsoft/vscode` `extensions/simple-browser/src/simpleBrowserView.ts`）。
 * Simple Browserの`frame-src *`と違い、**このsubtaskの`app`とサーバーの`port`は
 * 起動時点で分かっている**ため、`frame-src`をその1オリジンに絞れる（design.md
 * 「設計方針5」）。
 *
 * shellはメッセージの中身を検査せず、`window`の`message`イベントを送り主
 * （iframe／拡張ホスト）で振り分けて中継するだけ（architecture.md「設計判断」
 * ——「shellは中身を検査せず素通しする」）。
 *
 * **`allow="local-fonts"`が要る**（`ViewSettingsMenu`の画面フォント選択。
 * 利用者の実機報告で発覚）。`queryLocalFonts()`（Local Font Access）は
 * Permissions Policyでゲートされる強力な機能で、`<iframe>`側に明示の`allow`が
 * 無いと**クロスオリジンiframeへは既定で継承されない**——付けずに呼ぶと
 * `SecurityError: Access to the feature "local-fonts" is disallowed by
 * Permissions Policy`になり、`listInstalledFonts()`（`screenFonts.ts`）が
 * これを「非対応」として黙って`null`へ倒すため、利用者からは「標準（自動）しか
 * 選べない」としか見えない（実際に`allow`の有無を切り替えて`SecurityError`の
 * 発生/非発生を確認して原因を特定した）。**この`allow`だけでは足りない可能性がある**
 * ——VSCode拡張の`Webview`自体（この`buildShellHtml`が返すHTMLを表示する外側の
 * コンテキスト）がさらに上位でこの機能を許可しているかは、実際のVSCode拡張ホストが
 * 無いこの開発環境では確認できていない（`decisions.md` D8）。許可されない環境では
 * 従来どおり「フォント名を直接入力」欄で指定する
 *
 * **`sandbox`に`allow-downloads`が要る**（`⬇ HTML`ボタン。`decisions.md` D14）。
 * `EmulatorPane`の画面保存はBlob URLを`<a download>`で叩くだけの素朴な実装
 * （`screenExport.ts`）で、通常のタブでは動くが、**sandbox化された`<iframe>`では
 * `allow-downloads`トークンが無いとブラウザがダウンロードそのものを黙ってブロックする**
 * （Chromiumの仕様。Playwrightで最小再現し、トークン有無でダウンロードイベントの
 * 発火/非発火を確認して特定した）。`local-fonts`と同様、**VSCode拡張の`Webview`自体が
 * さらに上位でダウンロードを許可しているかは、実際のVSCode拡張ホストが無いこの開発環境
 * では確認できていない**
 */
export interface ShellHtmlOptions {
  /** spawnしたサーバーのポート（loopback限定） */
  port: number;
  /** iframeに渡すURLクエリの`app` */
  appKind: string;
  /** インラインscriptに付けるnonce（CSPの`script-src 'nonce-...'`と対にする） */
  nonce: string;
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, "&quot;");
}

export function buildShellHtml(opts: ShellHtmlOptions): string {
  const origin = `http://127.0.0.1:${opts.port}`;
  const iframeSrc = `${origin}/embed.html?app=${encodeURIComponent(opts.appKind)}`;
  return /* html */ `<!DOCTYPE html>
<html>
<head>
<meta http-equiv="Content-type" content="text/html;charset=UTF-8">
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none';
  frame-src ${escapeAttr(origin)};
  script-src 'nonce-${opts.nonce}';
  style-src 'nonce-${opts.nonce}';
">
<style nonce="${opts.nonce}">
  html, body { margin: 0; padding: 0; height: 100%; }
  iframe { border: none; width: 100%; height: 100%; display: block; }
</style>
</head>
<body>
<iframe id="embed" allow="local-fonts" sandbox="allow-scripts allow-forms allow-same-origin allow-downloads" src="${escapeAttr(iframeSrc)}"></iframe>
<script nonce="${opts.nonce}">
  const vscode = acquireVsCodeApi();
  const iframe = document.getElementById("embed");
  window.addEventListener("message", (event) => {
    if (event.source === iframe.contentWindow) {
      vscode.postMessage(event.data);
    } else {
      iframe.contentWindow.postMessage(event.data, "${escapeAttr(origin)}");
    }
  });
</script>
</body>
</html>`;
}
