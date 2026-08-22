import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runPcCommand,
  isAllowed,
  invalidAllowPattern,
  pcCommandHostname,
  stripCallBeforeStart
} from "../src/pc-command.js";

/** どちらのシェルでも 5 秒待つ（cmd.exe に `sleep` は無い。node は必ず在る） */
const SLEEP_5 = `"${process.execPath}" -e "setTimeout(() => {}, 5000)"`;

/**
 * PC コマンド（STRPCCMD）の実行。**既定は無効**で、明示的に有効化したときだけ動く。
 * ホストが送ってきた文字列をそのまま OS のシェルへ渡す機能なので、
 * 「有効化していないのに動く」経路が無いことをここで固める。
 *
 * **コマンド文字列は cmd.exe と POSIX シェルの両方で通る形で書く。** この機能は
 * Windows でしか確かめられない部分を持つ（`pc-command-windows.test.ts`）ので、
 * この suite 自体も Windows で走らないと回帰確認が半分になる——実際 `test -d .` は
 * Windows で落ち、`sleep` は Git 同梱の `sleep.exe` が PATH に居るかどうかで結果が変わっていた。
 */
describe("runPcCommand", () => {
  it("設定が無ければ実行しない（既定は無効）", async () => {
    expect(await runPcCommand({ command: "echo x", wait: true }, undefined)).toEqual({
      status: "disabled"
    });
  });

  it("enabled を立てていなければ実行しない", async () => {
    expect(await runPcCommand({ command: "echo x", wait: true }, { timeoutMs: 5000 })).toEqual({
      status: "disabled"
    });
  });

  it("有効なら実行して終了コードを返す（PAUSE(*YES) 相当）", async () => {
    const r = await runPcCommand({ command: "exit 0", wait: true }, { enabled: true });
    expect(r.status).toBe("ran");
    if (r.status === "ran") expect(r.exitCode).toBe(0);
  });

  it("終了コードは握りつぶさない", async () => {
    const r = await runPcCommand({ command: "exit 3", wait: true }, { enabled: true });
    expect(r.status).toBe("ran");
    if (r.status === "ran") expect(r.exitCode).toBe(3);
  });

  it("PAUSE(*NO) は完了を待たずに started で返る", async () => {
    const r = await runPcCommand({ command: SLEEP_5, wait: false }, { enabled: true });
    expect(r).toEqual({ status: "started" });
  });

  it("待つ指定で上限を超えたら打ち切って失敗として返す（ホストは待たせない）", async () => {
    const r = await runPcCommand({ command: SLEEP_5, wait: true }, { enabled: true, timeoutMs: 150 });
    expect(r.status).toBe("failed");
    if (r.status === "failed") expect(r.error).toMatch(/timed out/);
  });

  it("空のコマンドは失敗として扱う", async () => {
    const r = await runPcCommand({ command: "   ", wait: true }, { enabled: true });
    expect(r.status).toBe("failed");
  });

  it("許可リストに合わなければ実行しない", async () => {
    const cfg = { enabled: true, allow: ["echo .*"] };
    expect(await runPcCommand({ command: "rm -rf /tmp/x", wait: true }, cfg)).toEqual({
      status: "denied"
    });
    const ok = await runPcCommand({ command: "echo hi", wait: true }, cfg);
    expect(ok.status).toBe("ran");
  });

  it("作業ディレクトリーを指定できる", async () => {
    // **効いたことを結果で見る**（`test -d .` は成功しても cwd を見たことにならず、
    // そのうえ POSIX 専用で Windows では走らない）。`echo … > 相対パス` はどちらの
    // シェルでも cwd に書くので、書かれた場所が cwd の証拠になる
    const dir = mkdtempSync(join(tmpdir(), "pccmd-cwd-"));
    try {
      const r = await runPcCommand(
        { command: "echo x > marker.txt", wait: true },
        { enabled: true, cwd: dir }
      );
      expect(r.status).toBe("ran");
      if (r.status === "ran") expect(r.exitCode).toBe(0);
      expect(existsSync(join(dir, "marker.txt"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("isAllowed", () => {
  it("パターン省略は制限なし", () => {
    expect(isAllowed("anything", undefined)).toBe(true);
    expect(isAllowed("anything", [])).toBe(true);
  });

  it("**全体一致**で判定する（前方一致だと後置きが素通りする）", () => {
    expect(isAllowed("notepad", ["notepad"])).toBe(true);
    expect(isAllowed("notepad; rm -rf /", ["notepad"])).toBe(false);
    expect(isAllowed("xnotepad", ["notepad"])).toBe(false);
  });

  it("複数パターンはいずれかに合えばよい", () => {
    expect(isAllowed("start https://example.com", ["notepad", "start https?://.*"])).toBe(true);
  });

  it("壊れた正規表現は「一致しない」に倒す（緩む方向へ倒さない）", () => {
    expect(isAllowed("anything", ["("])).toBe(false);
  });
});

describe("invalidAllowPattern", () => {
  it("壊れたパターンを見つけて返す（保存前に弾くため）", () => {
    expect(invalidAllowPattern(["ok.*", "["])).toBe("[");
    expect(invalidAllowPattern(["ok.*", "also ok"])).toBeUndefined();
  });
});

/**
 * `CALL START` の落とし込み（**Windows 実機の回避策**）。
 *
 * 実機では `CALL START "title" /B "app.exe"` で起動したアプリが直後に消え、
 * `CALL` を外すと毎回生き残る（`pc-command.ts` の docstring に経緯）。
 * **この環境に Windows は無い**ので、ここで固定できるのは「置換の結果」まで
 * ——実機の裏付けは持ち込まれた実測資料（`20260730-pccmd-call-start-and-winbat`）による。
 */
describe("stripCallBeforeStart", () => {
  it("CALL START を START に落とす（実機で CALL START は app が起動直後に消える）", () => {
    expect(stripCallBeforeStart('CALL START "WINMERGE" /B "app.exe"')).toBe(
      'START "WINMERGE" /B "app.exe"'
    );
  });

  it("大文字小文字を問わない・NET USE と & で繋いだ形にも効く（業務 CL の実例）", () => {
    const input = String.raw`CMD /C "NET USE \\SRV  & call start "T" /B "app.exe" arg1 arg2"`;
    const expected = String.raw`CMD /C "NET USE \\SRV  & START "T" /B "app.exe" arg1 arg2"`;
    expect(stripCallBeforeStart(input)).toBe(expected);
  });

  it("**2 つ以上並んでいれば全部落とす**（1 つ目だけ直すと 2 つ目が同じ不具合を起こす）", () => {
    const input = 'CMD /C "call start "A" /B "a.exe" & call start "B" /B "b.exe""';
    const expected = 'CMD /C "START "A" /B "a.exe" & START "B" /B "b.exe""';
    expect(stripCallBeforeStart(input)).toBe(expected);
  });

  it("CALL と START の間の空白は数・種類を問わない", () => {
    expect(stripCallBeforeStart('CALL  START "T"')).toBe('START "T"');
    expect(stripCallBeforeStart('CALL\tSTART "T"')).toBe('START "T"');
    expect(stripCallBeforeStart('CALL\nSTART "T"')).toBe('START "T"');
  });

  it("CALL の無い START はそのまま", () => {
    expect(stripCallBeforeStart('START "T" /B "app.exe"')).toBe('START "T" /B "app.exe"');
  });

  it("CALL START を含まないコマンドはそのまま", () => {
    expect(stripCallBeforeStart("echo hi")).toBe("echo hi");
  });

  it("語の一部は変えない（CALLSTART / MYCALL START）", () => {
    expect(stripCallBeforeStart('CALLSTART "T"')).toBe('CALLSTART "T"');
    expect(stripCallBeforeStart('MYCALL START "T"')).toBe('MYCALL START "T"');
  });

  it("バッチファイルの CALL は落とさない（START の直前だけを見る）", () => {
    expect(stripCallBeforeStart("CALL setup.bat")).toBe("CALL setup.bat");
    expect(stripCallBeforeStart("CALL :label")).toBe("CALL :label");
  });
});

/**
 * **置換は許可判定より後**であること。
 *
 * 順序を逆にすると、利用者が `CALL START …` を許可したのに `START …` で照合され、
 * **許可した文面と実際の判定がずれる**（ホスト起点の任意コード実行なので、
 * ここがずれると信頼境界の意味が変わる）。
 */
describe("許可判定は利用者が書いた文字列で行う", () => {
  it("CALL START を許可した設定では実行できる", async () => {
    const cfg = { enabled: true, allow: ["CALL START .*"] };
    const r = await runPcCommand({ command: "CALL START true", wait: true }, cfg);
    expect(r.status).toBe("ran");
  });

  it("置換後の文面だけを許可した設定では弾かれる（置換で門をすり抜けない）", async () => {
    const cfg = { enabled: true, allow: ["START .*"] };
    const r = await runPcCommand({ command: "CALL START true", wait: true }, cfg);
    expect(r).toEqual({ status: "denied" });
  });
});

/**
 * **実際に渡されている文字列が置換後のものか**を確かめる。
 *
 * `stdio` は `ignore` なので出力からは見えない。そこで**シェルに書かせて読む**
 * ——`echo CALL START > file` は置換されると `echo START > file` になるので、
 * ファイルの中身が「渡した文字列」の証拠になる（`echo … > file` は cmd.exe でも
 * POSIX シェルでも同じ意味なので、**Windows でもそのまま走る**）。
 */
describe("spawn に渡すのは置換後の文字列", () => {
  it("CALL START が落ちた文字列で実行される", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pccmd-"));
    try {
      const file = join(dir, "out.txt");
      const r = await runPcCommand(
        { command: `echo CALL START > ${file}`, wait: true },
        { enabled: true }
      );
      expect(r.status).toBe("ran");
      expect(readFileSync(file, "utf8").trim()).toBe("START");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pcCommandHostname", () => {
  it("実行先の機械名を返す（UI が「このPC / サーバー」を言い分けるのに使う）", () => {
    expect(pcCommandHostname()).toBeTruthy();
  });
});
