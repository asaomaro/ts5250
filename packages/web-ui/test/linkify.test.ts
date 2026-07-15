import { describe, it, expect } from "vitest";
import { linkify, splitLinks } from "../src/composables/linkify.js";

describe("linkify", () => {
  it("http/https URL を検出する", () => {
    const s = linkify("see https://pub400.com/docs here");
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ href: "https://pub400.com/docs", kind: "url" });
    expect("see https://pub400.com/docs here".slice(s[0]!.start, s[0]!.end)).toBe("https://pub400.com/docs");
  });

  it("メールアドレスを mailto: にする", () => {
    const s = linkify("contact admin@example.com now");
    expect(s).toHaveLength(1);
    expect(s[0]).toMatchObject({ href: "mailto:admin@example.com", kind: "email" });
  });

  it("URL 末尾の句読点はリンクから除外する", () => {
    const s = linkify("visit http://example.com.");
    expect(s[0]!.href).toBe("http://example.com");
  });

  it("複数のリンクを開始位置順に返す", () => {
    const s = linkify("a@b.com and http://x.io");
    expect(s.map((x) => x.kind)).toEqual(["email", "url"]);
  });

  it("URL 内の @ をメールとして二重検出しない", () => {
    const s = linkify("http://user@host.com/path");
    expect(s).toHaveLength(1);
    expect(s[0]!.kind).toBe("url");
  });

  it("危険スキームや素のテキストはリンク化しない", () => {
    expect(linkify("javascript:alert(1)")).toHaveLength(0);
    expect(linkify("ftp://host/file")).toHaveLength(0);
    expect(linkify("just plain text 12:34")).toHaveLength(0);
  });

  it("TLD の無いアドレス様文字列はメールにしない", () => {
    expect(linkify("user@localhost")).toHaveLength(0);
    expect(linkify("a @ b")).toHaveLength(0);
  });

  it("splitLinks はプレーン/リンク部分に分割する", () => {
    const parts = splitLinks("go https://x.io end");
    expect(parts).toEqual([
      { text: "go " },
      { text: "https://x.io", href: "https://x.io" },
      { text: " end" }
    ]);
  });

  it("splitLinks はリンク無しなら単一プレーン部分", () => {
    expect(splitLinks("no links")).toEqual([{ text: "no links" }]);
  });
});
