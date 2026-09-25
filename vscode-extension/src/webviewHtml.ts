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
<iframe id="embed" sandbox="allow-scripts allow-forms allow-same-origin" src="${escapeAttr(iframeSrc)}"></iframe>
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
