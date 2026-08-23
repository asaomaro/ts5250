import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir, EOL } from "node:os";
import { join } from "node:path";
import { runPcCommand } from "../src/pc-command.js";

/**
 * **PC コマンドで起動したアプリが生き残ること**を Windows 実機で確かめる回帰。
 *
 * ## なぜ別ファイルなのか
 *
 * `pc-command.test.ts` の `stripCallBeforeStart` は**文字列までしか見ない**。
 * 実機で起きた不具合は「`CALL START "title" /B "app.exe"` で起動したアプリが直後に消える」で、
 * **消えるかどうかは Windows でしか測れない**（`20260730-pccmd-call-start-and-winbat` の
 * decisions D5 が「未検証の穴」として残し、backlog `pc-command.md` に
 * 「Windows 実機での回帰確認の自動化」として起票された項目）。
 *
 * ## 何を見ているか
 *
 * 本番と同じ経路（`runPcCommand` → `spawn(shell: true)`）で「アプリ」を起動し、
 * **シェルが終わったあとも書き足し続けるか**を見る。`status: "started"` は
 * spawn が成功したことしか言わない——実機の不具合はそこが `started` のまま
 * アプリだけが消えていたので、**起動の成否ではなく生存**を測る必要がある。
 *
 * ## 落とし穴
 *
 * - **Windows 以外では skip する。** 対象は `cmd.exe` の `CALL` / `START` の解釈で、
 *   POSIX シェルには存在しない（`/bin/sh` では `START` はコマンド未検出で終わる）
 * - 「アプリ」は node.exe に書かせる。GUI アプリだと窓が出て邪魔になり、
 *   生存の判定も**プロセス一覧の照会**が要る（`Get-CimInstance`）。追記ファイルなら
 *   **行数の比較で測れる**——しかも「0 拍＝起動していない」と
 *   「数拍で止まった＝消えた」を同じ物差しで見分けられる
 * - **アプリに寿命を持たせない。** suite 全体（92 ファイル）と並行で走ると
 *   タイマーが数秒ずれるので、寿命つきのアプリでは「2 回目に見たときには
 *   もう終わっていた」で偽陽性になる（実測で 3 件とも落ちた）。**測り終えてから殺す**
 */
const isWin = process.platform === "win32";

/**
 * 起動されたら PID を書き、100ms ごとに 1 行追記し続ける「アプリ」。
 * 終わらせるのはテストの側（`afterAll`）。取り残しても 30 秒で自分から止まる。
 */
const APP_SOURCE = [
  'const fs = require("node:fs");',
  'const os = require("node:os");',
  "const out = process.argv[2];",
  'fs.writeFileSync(out + ".pid", String(process.pid));',
  "let n = 0;",
  "const t = setInterval(() => {",
  '  fs.appendFileSync(out, "beat" + os.EOL);',
  "  if (++n >= 300) clearInterval(t);",
  "}, 100);",
  ""
].join(EOL);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!isWin)("Windows 実機: PC コマンドで起動したアプリが生き残る", () => {
  const dir = mkdtempSync(join(tmpdir(), "ts5250-pccmd-win-"));
  const app = join(dir, "app.cjs");
  const launched: number[] = [];
  if (isWin) writeFileSync(app, APP_SOURCE);

  afterAll(async () => {
    for (const pid of launched) {
      try {
        process.kill(pid);
      } catch {
        // 既に居ない＝この suite が捕まえたい不具合そのもの。判定は it 側でしているので黙って進む
      }
    }
    // Windows は使用中のファイルを消せない。終了が伝わるのを少し待ってから消す
    await sleep(200);
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  });

  /**
   * `shape` の `{APP}` を「アプリの起動」に置き換えて実行し、
   * **最初の 1 拍が出たあと、さらに増えるか**を測る。
   *
   * 待ち時間を固定しないのが要点——suite 全体と並行で走るとタイマーがずれるので、
   * 起動は**出るまで待ち**、生存は**増分**で判定する。
   */
  async function launch(name: string, shape: string) {
    const log = join(dir, `${name}.log`);
    const command = shape.replace("{APP}", `"${process.execPath}" "${app}" "${log}"`);
    const beats = () => (existsSync(log) ? readFileSync(log, "utf8").split("beat").length - 1 : 0);

    const outcome = await runPcCommand({ command, wait: false }, { enabled: true });
    for (let i = 0; i < 100 && beats() === 0; i += 1) await sleep(100); // 起動を最大 10 秒待つ
    const early = beats();
    // `START` は起動したら即戻るので、シェル（cmd.exe）はこの時点で既に居ない。
    // ここから増えていれば「親が消えても生きている」ことになる
    await sleep(800);
    const late = beats();
    const pidFile = `${log}.pid`;
    if (existsSync(pidFile)) launched.push(Number(readFileSync(pidFile, "utf8")));
    return { outcome, early, late };
  }

  /** 3 形とも同じ見方をする（形ごとに判定が違うと、どこが緩いのか分からなくなる） */
  function expectSurvived(r: { outcome: unknown; early: number; late: number }) {
    expect(r.outcome).toEqual({ status: "started" });
    expect(r.early).toBeGreaterThan(0); // 起動している
    expect(r.late).toBeGreaterThan(r.early + 1); // シェルが終わったあとも書き続けている
  }

  it(
    "`CALL START ... /B` で起動したアプリが消えない（実機で消えた形）",
    async () => {
      expectSurvived(await launch("call-start", 'CALL START "t" /B {APP}'));
    },
    30_000
  );

  it(
    "`CMD /C \"NET USE & CALL START ... /B\"` でも消えない（業務 CL の実例の形）",
    async () => {
      // `NET USE` は引数無しなら接続一覧の表示だけ（原資料の実例は `NET USE \\SRV`。
      // 共有名はこの機械に無いので落とす——見たいのは `&` で繋いだ入れ子の方）
      expectSurvived(await launch("netuse-call-start", 'CMD /C "NET USE & CALL START "t" /B {APP}"'));
    },
    30_000
  );

  it(
    "`CALL` を含まない `START ... /B` も消えない（対照）",
    async () => {
      expectSurvived(await launch("start", 'START "t" /B {APP}'));
    },
    30_000
  );
});
