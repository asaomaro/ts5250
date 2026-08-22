# 調査: `CALL START` でアプリが消えるかを Windows 実機で測る

**結論から: この機械では 40 ケース測って 1 件も消えなかった。** `CALL` の有無は
起動された側の `argv` まで含めて**完全に同一**で、親プロセスは（Electron の main を含めて）
**どれもジョブオブジェクトに入っていない**。原資料の「`CALL` の有無だけが唯一の分岐点」は
**この機械では成り立たない**。

## 測った環境

| 項目 | 値 |
|---|---|
| OS | Windows 11 Pro build **10.0.26200.9168** |
| `cmd.exe` | **10.0.26100.8875**（`C:\Windows\System32\cmd.exe`） |
| `ComSpec` | `C:\Windows\system32\cmd.exe`（差し替えなし） |
| `Command Processor` の `AutoRun` | **HKCU / HKLM ともに空**（cmd 起動時に走る仕込みは無い） |
| Node | 24.18.0 / Electron | 32.3.3 |
| セキュリティソフト | **Windows Defender ＋ ESET Security**（原資料が疑った EDR 相当は**居る**） |

## 測り方

「アプリ」は **200ms ごとに追記して自分から終わる node スクリプト**（`heartbeat.cjs`）。
**生存は追記が続くかで測る**——`status: "started"` は spawn の成否しか言わないので、
原資料の症状（`started` のままアプリだけ消える）はそこでは捕まらない。
終わり方も書かせた（`SIGHUP` / `SIGINT` / `SIGBREAK` / `SIGTERM` / `exit`）
——コンソール切断で殺されたのか強制終了かを見分けるため。

spawn の指定は**本番と同じ**（`pc-command.ts` の `runPcCommand`）:
`{ shell: true, windowsHide: true, stdio: "ignore", detached: true }`。

## 測定 1: コマンドの形と spawn の指定（11 ケース・親は bash 起動の node）

| ケース | 結果 |
|---|---|
| 直接実行 `"node" "hb" "log"` | ALIVE（13 拍） |
| `START "t" /B <app>` | ALIVE |
| **`CALL START "t" /B <app>`** | **ALIVE** |
| `NET USE & CALL START "t" /B <app>` | ALIVE |
| `START "t" <app>`（窓あり） | ALIVE |
| `CALL START "t" <app>`（窓あり） | ALIVE |
| `CALL <app>`（`START` 無しの `CALL`） | ALIVE |
| `START /B <app>`（**タイトル省略**） | **NEVER-STARTED** |
| `CALL START "t" /B <app>` ＋ `detached` 無し | ALIVE |
| `CALL START "t" /B <app>` ＋ `windowsHide` 無し | ALIVE |
| `CALL START "t" /B <app>` ＋ `stdio: "inherit"` | ALIVE |

**唯一「アプリが動かなかった」のはタイトルを省いた `START /B "exe" "script"`。**
これは cmd の仕様で、`START` は最初の引用符つきトークンをタイトルとして食う。
実測で起きたことは「起動しない」より悪く、**次のトークンが起動対象になった**:

- `heartbeat.cjs` が **ファイルの関連付けで開かれた**（この機械では VS Code が起きた）
- **起動側の `cmd.exe` が居座った**（測定の後片付けで見つけた。`/d /s /c` なのに残る）

`START` を組み立てる側の落とし穴として覚えておく価値がある——タイトルを省くと
**別のプログラムが起動する**（`windowsHide` ＋ `stdio: "ignore"` では気づけない）。

## 測定 2: `CMD /C "…"` の入れ子 × アプリの種類（12 ケース）

原資料の実物は `CMD /C "…"` で始まる文字列で、`shell: true` がさらに `cmd /d /s /c "…"` で
包むため**入れ子と引用符が二重になる**。アプリの種類（コンソール / GUI）も振った。

| 形 | コンソール（node.exe） | GUI（notepad.exe） |
|---|---|---|
| `CALL START "t" /B <app>` | ALIVE | ALIVE |
| `START "t" /B <app>` | ALIVE | ALIVE |
| `CMD /C "CALL START "t" /B <app>"` | ALIVE | ALIVE |
| `CMD /C "START "t" /B <app>"` | ALIVE | ALIVE |
| `CMD /C "NET USE & CALL START "t" /B <app>"` | ALIVE | ALIVE |
| `CMD /C "NET USE & START "t" /B <app>"` | ALIVE | ALIVE |

GUI 側の生存は `Get-CimInstance Win32_Process` でコマンド行に印を含む `notepad.exe` を
1 秒後と 4 秒後に数えた（どちらも同じ PID が居た）。

## 測定 3: 親プロセスを振る（9 ケース）＋ **ジョブオブジェクトの在否**

原資料は「単体の再現スクリプトでは `detached` が効くのに、**実際のサーバープロセスからは
効かない**」と記録しており、**親の生い立ちが分岐点**である疑いがあった。
配布形（Electron 版）は**サーバーを Electron の main プロセス内で動かす**
（`electron/main.cjs` の `startServer()` が `await mod.main(argv)`）ので、
`spawn` の親は **Electron の main プロセス**になる。そこを直接測った。

| 親 | ジョブ | `CALL START` | `START` | `CMD /C "NET USE & CALL START …"` |
|---|---|---|---|---|
| bash 起動の node 24.18 | **no-job** | ALIVE | ALIVE | ALIVE |
| cmd.exe 起動の node 24.18 | **no-job** | ALIVE | ALIVE | ALIVE |
| **Electron 32.3.3 の main** | **no-job** | ALIVE | ALIVE | ALIVE |

ジョブの在否は `kernel32!IsProcessInJob`（PowerShell の P/Invoke）で実測。
**どの親もジョブに入っていない**＝「ジョブが閉じるときに巻き添えで殺される」
（`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`）という当時の見立ての**前提がこの機械には無い**。

> 副産物: `IsProcessInJob` は `out bool` の marshalling で黙って false を返す。
> `out int` で宣言し、ハンドルは `[System.Diagnostics.Process]::GetProcessById($pid).Handle`
> から取ると通る（`OpenProcess` の P/Invoke は 0 を返した）。

## 測定 4: `CALL` が構文解析にもたらす差（8 ケース・argv で突き合わせ）

「消える」の別の筋として **「実は起動していない」**（`CALL` が引用符を 1 段剥がし、
`START` がタイトルとプログラムを取り違える）を疑った。起動された側に `argv` と `cwd` を
書かせて突き合わせた。**パスに空白を含む形**（`C:\Users\Public\pc probe with space`）も振った。

| 形 | 起動 | アプリが見た argv |
|---|---|---|
| `START "t" /B <app> A1 A2` | YES | `["A1","A2"]` |
| `CALL START "t" /B <app> A1 A2` | YES | `["A1","A2"]` |
| `CMD /C "START …"` | YES | `["A1","A2"]` |
| `CMD /C "CALL START …"` | YES | `["A1","A2"]` |
| `CMD /C "NET USE & CALL START …"` | YES | `["A1","A2"]` |
| 空白入りパス × `START` / `CALL START` / `CMD /C "CALL START …"` | YES（3 件） | `["A1","A2"]` |

**`CALL` の有無で差は無い。** 引用符も剥がれず、`cwd` も同じ。
「`CALL` が構文解析を変える」という筋も**否定**された。

## 何が否定できて、何が残るか

否定できたもの（この機械で）:

- `CALL` そのものが原因（**8 形 × 4 指定 × 2 種類 × 3 親で 1 件も消えない**）
- ジョブオブジェクトによる巻き添え（**どの親もジョブに入っていない**）
- `CALL` による引用符・argv の歪み（**完全に同一**）
- コンソール切断のシグナル（**`SIGHUP` / `SIGBREAK` は 1 度も記録されていない**）
- EDR 一般（**この機械にも ESET が居る**が再現しない）

残るもの（**測れない**）:

- 原資料の機械そのものの事情。`ComSpec` の差し替え・`cmd.exe` の版・
  `Command Processor` の `AutoRun`・**app.exe が `NET USE` した UNC 共有の上にあったか**
  （共有側の事情でアプリが落ちれば、同じ「起動直後に消える」に見える）
- 原資料の観測が **`CALL` の有無で分岐した回数**（何回試したか）は記録に無い。
  1〜2 回の観測なら、別の揺らぎを `CALL` に帰属した可能性が残る

**回避策は残す。** `CALL START` の `CALL` は意味を持たないので落としても無害で、
実機 1 台に「落とせば直った」という観測がある以上、外す理由が無い。

## 回帰の自動化（backlog 2 件目）

「アプリが生き残る」は**本番の `runPcCommand` 経路**で測るのが要点で、
そこを通せば Electron ビルドを回す必要は無い（測定 3 で親を Electron にしても同じだった）。
テストは `packages/server/test/pc-command-windows.test.ts`（`describe.skipIf(!isWin)`）。

Windows で suite を回すには**前提の整えが要った**（`npm install` → `npx tsc -b`。
どちらか欠けると 27 ファイルが collect 段階で落ちる）。整えた後の baseline は
**1,243 件中 12 件 failed**で、うち 1 件（`pc-command.test.ts` の `test -d .`）は
この作業で直した。残り 11 件は POSIX 前提・外部コマンド依存・CRLF チェックアウトで、
**製品の不具合ではない**——`.aidev/backlog/windows-test-run.md` に分けて起票した。
