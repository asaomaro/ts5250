import { describe, it, expect } from "vitest";
import { appKindFromFileName, parseTs5250File, stringifyTs5250File } from "../src/schema.js";
import { EMBED_APP_EXTENSIONS, EMBED_APP_KINDS } from "../src/protocol.js";

/** 種別は拡張子で決まり、ファイルには`app`を書かない（`decisions.md` D32） */
describe("appKindFromFileName", () => {
  it.each(EMBED_APP_KINDS)("%s の拡張子から種別を決める（大文字でも可）", (app) => {
    expect(appKindFromFileName(`/w/prod${EMBED_APP_EXTENSIONS[app]}`)).toBe(app);
    expect(appKindFromFileName(`C:\\w\\PROD${EMBED_APP_EXTENSIONS[app].toUpperCase()}`)).toBe(app);
  });

  it("知らない拡張子（旧来の .ts5250 を含む）は undefined", () => {
    expect(appKindFromFileName("a.ts5250")).toBeUndefined();
    expect(appKindFromFileName("a.json")).toBeUndefined();
  });
});

describe("parseTs5250File", () => {
  it("空のファイル（空白だけ）は何も設定していないものとして受理する——作った空ファイルを画面から設定するため", () => {
    for (const text of ["", "  \n"]) {
      const r = parseTs5250File(text, "printer");
      expect(r).toEqual({ ok: true, file: { app: "printer" } });
    }
  });

  it("全フィールドを持つファイルを受理し、種別は引数（拡張子）から入れる", () => {
    const src = { host: "AS400", port: 992, tls: true, ccsid: 5035, signon: { user: "MYUSER", passwordEnc: "v1:a:b:c" } };
    const r = parseTs5250File(JSON.stringify(src), "sql");
    expect(r).toEqual({ ok: true, file: { ...src, app: "sql" } });
  });

  it("ファイルに app が書かれていても無視する（拡張子が正）", () => {
    const r = parseTs5250File('{"app":"sql","host":"H"}', "emulator");
    expect(r.ok && r.file.app).toBe("emulator");
  });

  it("不正なJSON・トップレベルが配列はエラーにする", () => {
    const r = parseTs5250File("{not json", "emulator");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/JSON/);
    expect(parseTs5250File("[]", "emulator").ok).toBe(false);
  });
});

describe("stringifyTs5250File", () => {
  it("2スペースインデント・末尾改行で整形し、app は書かない", () => {
    expect(stringifyTs5250File({ app: "emulator", host: "H" })).toBe('{\n  "host": "H"\n}\n');
  });

  it("stringify→parseで往復できる", () => {
    const original = { app: "ifs" as const, host: "H", ifsPath: "/home/u" };
    const parsed = parseTs5250File(stringifyTs5250File(original), "ifs");
    expect(parsed).toEqual({ ok: true, file: original });
  });
});
