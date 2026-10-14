import { describe, it, expect } from "vitest";
import { parseArgs, buildToolArgs, coerce } from "../src/args.js";

describe("parseArgs", () => {
  it("位置引数とオプションを分ける（--k v・--k=v・値なしの --flag）", () => {
    const r = parseArgs(["open_session", "--host", "h", "--port=23", "--tls"]);
    expect(r.positional).toEqual(["open_session"]);
    expect(r.options.get("host")).toBe("h");
    expect(r.options.get("port")).toBe("23");
    expect(r.options.get("tls")).toBe(true);
  });

  it("-- 以降はすべて位置引数", () => {
    expect(parseArgs(["a", "--", "--x", "y"]).positional).toEqual(["a", "--x", "y"]);
  });
});

describe("coerce / buildToolArgs", () => {
  const props = { port: { type: "integer" }, tls: { type: "boolean" }, fields: { type: "array" }, host: { type: "string" } };

  it("スキーマの型へ変換する", () => {
    const o = parseArgs(["--port", "992", "--tls", "--fields", '[{"a":1}]', "--host", "x"]).options;
    expect(buildToolArgs(o, props)).toEqual({ port: 992, tls: true, fields: [{ a: 1 }], host: "x" });
  });

  it("--json を土台にし、個別の指定で上書きする。--url は渡さない", () => {
    const o = parseArgs(["--json", '{"host":"a","port":1}', "--port", "2", "--url", "u"]).options;
    expect(buildToolArgs(o, props)).toEqual({ host: "a", port: 2 });
  });

  it("変換できない値は理由つきで断る", () => {
    expect(() => coerce("port", "abc", props.port)).toThrow("数で指定");
    expect(() => coerce("tls", "maybe", props.tls)).toThrow("true か false");
    expect(() => coerce("fields", "[", props.fields)).toThrow("JSON");
    expect(() => buildToolArgs(new Map([["json", "[]"]]), props)).toThrow("オブジェクト");
  });

  it("スキーマに無い名前は文字列のまま渡す（検証はツール側）", () => {
    expect(buildToolArgs(new Map([["zzz", "1"]]), props)).toEqual({ zzz: "1" });
  });
});
