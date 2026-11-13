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


describe("PC コマンドの許可は boolean のみ", () => {
  it.each([true, false])("%s を読み書きできる", (allowPcCommand) => {
    expect(parseTs5250File(stringifyTs5250File({ app: "emulator", allowPcCommand }), "emulator"))
      .toEqual({ ok: true, file: { app: "emulator", allowPcCommand } });
  });
  it.each([null, "true", 1, [], {}])("%j を拒否する", (allowPcCommand) => {
    expect(parseTs5250File(JSON.stringify({ allowPcCommand }), "emulator").ok).toBe(false);
  });
});


describe("詳細設定の入力形状", () => {
  it("全項目をファイルへ保存・復元できる", () => {
    const file = { app: "emulator" as const, host: "AS400", enhanced: true, deviceNameRetry: true, keepAlive: true, associatedPrinter: "PRT_TEST", allowPcCommand: true, pcCommand: { allow: ["prog:notepad", "echo .*"], timeoutMs: 1500 }, printer: { autoPdfDir: "/tmp/pdf", autoPrint: "PRT_TEST" }, ifsPath: "/home/USER", sqlInitial: "SELECT 1" };
    expect(parseTs5250File(stringifyTs5250File(file), "emulator")).toEqual({ ok: true, file });
  });
  it.each([
    { pcCommand: null }, { pcCommand: [] }, { pcCommand: "true" },
    { pcCommand: { enabled: true } }, { pcCommand: { allow: [] } },
    { pcCommand: { allow: "echo" } }, { pcCommand: { allow: [null] } },
    { pcCommand: { allow: [{}] } }, { pcCommand: { allow: [42] } },
    { pcCommand: { allow: [""] } }, { pcCommand: { allow: ["["] } },
    { pcCommand: { allow: ["prog:"] } }, { pcCommand: { timeoutMs: 0 } },
    { pcCommand: { timeoutMs: 3_600_001 } }, { pcCommand: { timeoutMs: 1.5 } },
    { pcCommand: { timeoutMs: "60000" } },
    { printer: null }, { printer: [] }, { printer: "PRT_TEST" },
    { printer: { autoPdfDir: [] } }, { printer: { autoPrint: {} } },
    { printer: { command: "echo" } }, { ifsPath: "relative" },
    { ifsPath: null }, { sqlInitial: [] }, { enhanced: "false" },
    { deviceNameRetry: null }, { keepAlive: [] }, { associatedPrinter: 123 }
  ])("不正な形 %j を拒否する", (values) => {
    expect(parseTs5250File(JSON.stringify({ host: "AS400", ...values }), "emulator").ok).toBe(false);
  });
});


describe("接続時間設定の検証", () => {
  it.each([
    { keepAliveOptions: null }, { keepAliveOptions: [] }, { keepAliveOptions: { count: "8" } },
    { keepAliveOptions: { intervalMs: 500 } }, { keepAliveOptions: { initialDelayMs: 1500 } },
    { keepAliveOptions: { intervalMs: 32768000 } }, { keepAliveOptions: { count: 128 } },
    { keepAliveOptions: { extra: true } }, { connectionHold: null }, { connectionHold: "10" },
    { connectionHold: -1 }, { connectionHold: 1.5 }, { connectionHold: 1441 }
  ])("不正な値 %j を受理しない", (fields) => {
    expect(parseTs5250File(JSON.stringify({ host: "AS400", ...fields }), "emulator").ok).toBe(false);
  });
  it("無効でも詳細値を保存して復元できる", () => {
    const file = { app: "emulator" as const, keepAlive: false, keepAliveOptions: { initialDelayMs: 90000, intervalMs: 30000, count: 4 }, connectionHold: "never" as const };
    expect(parseTs5250File(stringifyTs5250File(file), "emulator")).toEqual({ ok: true, file });
  });
});
