import { describe, it, expect } from "vitest";
import { buildShellHtml } from "../src/webviewHtml.js";

describe("buildShellHtml", () => {
  const html = buildShellHtml({ port: 34567, appKind: "emulator", nonce: "abc123" });

  it("iframeのsrcがport/appクエリを含むloopbackのURLになる", () => {
    expect(html).toContain('src="http://127.0.0.1:34567/embed.html?app=emulator"');
  });

  it("CSPのframe-srcがそのoriginだけを許可する（*ではない）", () => {
    const csp = /Content-Security-Policy" content="([\s\S]*?)">/.exec(html)?.[1] ?? "";
    expect(csp).toContain("frame-src http://127.0.0.1:34567;");
    expect(csp).not.toContain("frame-src *");
  });

  it("インラインscript/styleのnonceがCSPのscript-src/style-srcと一致する", () => {
    expect(html).toContain("'nonce-abc123'");
    expect(html).toContain('nonce="abc123"');
  });

  it("iframeがsandbox属性を持つ（allow-scripts/allow-forms/allow-same-origin）", () => {
    expect(html).toMatch(/<iframe[^>]*sandbox="allow-scripts allow-forms allow-same-origin"/);
  });

  it("中継スクリプトがiframe→vscode・vscode→iframeの両方向を振り分ける", () => {
    expect(html).toContain("vscode.postMessage(event.data)");
    expect(html).toContain("iframe.contentWindow.postMessage(event.data");
    expect(html).toContain("event.source === iframe.contentWindow");
  });

  it("appKindのURLエンコード（記号を含む値でも安全）", () => {
    const h = buildShellHtml({ port: 1, appKind: "a&b", nonce: "n" });
    expect(h).toContain("app=a%26b");
  });
});
