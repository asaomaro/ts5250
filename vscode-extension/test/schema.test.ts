import { describe, it, expect } from "vitest";
import { parseTs5250File, stringifyTs5250File } from "../src/schema.js";

describe("parseTs5250File", () => {
  it("appだけの最小ファイルを受理する", () => {
    const r = parseTs5250File('{"app":"emulator"}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.file).toEqual({ app: "emulator" });
  });

  it("全フィールドを持つファイルを受理する", () => {
    const src = {
      app: "sql",
      host: "AS400",
      port: 992,
      tls: true,
      ccsid: 5035,
      signon: { user: "MYUSER", passwordEnc: "v1:a:b:c" }
    };
    const r = parseTs5250File(JSON.stringify(src));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.file).toEqual(src);
  });

  it("不正なJSONはエラーにする", () => {
    const r = parseTs5250File("{not json");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/JSON/);
  });

  it("トップレベルが配列はエラーにする", () => {
    const r = parseTs5250File("[]");
    expect(r.ok).toBe(false);
  });

  it("appが欠落・不正な種別はエラーにする", () => {
    expect(parseTs5250File("{}").ok).toBe(false);
    expect(parseTs5250File('{"app":"printer2"}').ok).toBe(false);
    expect(parseTs5250File('{"app":123}').ok).toBe(false);
  });

  it("printer/sql/ifsのappも受理する（4種）", () => {
    for (const app of ["emulator", "printer", "sql", "ifs"]) {
      expect(parseTs5250File(JSON.stringify({ app })).ok).toBe(true);
    }
  });
});

describe("stringifyTs5250File", () => {
  it("2スペースインデント・末尾改行で整形する", () => {
    const out = stringifyTs5250File({ app: "emulator", host: "H" });
    expect(out).toBe('{\n  "app": "emulator",\n  "host": "H"\n}\n');
  });

  it("stringify→parseで往復できる", () => {
    const original = { app: "ifs" as const, host: "H", ifsPath: "/home/u" };
    const parsed = parseTs5250File(stringifyTs5250File(original));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.file).toEqual(original);
  });
});
