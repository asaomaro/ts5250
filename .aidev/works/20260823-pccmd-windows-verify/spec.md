# 仕様: Windows 実機の回帰確認を入れ、測った事実で台帳を直す

調査（research.md）の結論は「**この機械では再現しない**」。よって仕様は
**(a) 生存を測るテストを回帰資産として入れる**、**(b) 測った事実を記録に落とす**の 2 本。
製品コードの振る舞いは**変えない**（回避策 `stripCallBeforeStart` はそのまま残す）。

## S1: Windows でだけ走る生存テストを足す

`packages/server/test/pc-command-windows.test.ts`（新規）。

- `describe.skipIf(process.platform !== "win32")`。対象は `cmd.exe` の `CALL` / `START` の
  解釈なので、POSIX シェルでは意味が無い（`/bin/sh` では `START` はコマンド未検出）
- **本番の経路を通す**: `runPcCommand({ command, wait: false }, { enabled: true })`。
  spawn の指定をテスト側で組み直さない（組み直すと本番の指定が変わっても気づけない）
- 「アプリ」は node に書かせる: 100ms ごとに 1 行追記し、20 拍（2 秒）で自分から終わる。
  GUI アプリだと窓が出て邪魔になり、生存判定にプロセス一覧の照会が要る
- **判定は「シェルが終わったあとに行が増えたか」**:
  `600ms` 後の行数を `early`、さらに `800ms` 後を `late` として `late > early + 2`。
  `START` は起動したら即戻るので、600ms 後にはシェル（cmd.exe）は既に居ない
  ——増えていれば「親が消えても生きている」ことになる
- 形は 3 つ: `CALL START "t" /B <app>`（実機で消えた形）/
  `CMD /C "NET USE & CALL START "t" /B <app>"`（業務 CL の実例の形）/
  `START "t" /B <app>`（対照）
- 後片付けは `rmSync(..., { maxRetries: 5, retryDelay: 300 })`
  ——Windows は使用中のファイルを消せないため（アプリの追記と競る）

## S2: `pc-command.test.ts` の POSIX 前提を外す

**Windows で走らないテストは、Windows の回帰確認にならない。** 実測で落ちた／
揺らいだ 3 か所だけを直す（他は触らない）:

| 箇所 | いま | 直し方 |
|---|---|---|
| 「作業ディレクトリーを指定できる」 | `test -d .` ＋ `cwd: "/tmp"` | 一時ディレクトリーを作り `echo x > marker.txt` を実行して**書かれた場所**を見る（cwd が効いた証拠になる。どちらのシェルでも同義） |
| 「PAUSE(*NO) は…started で返る」 | `sleep 5` | `"<node>" -e "setTimeout(() => {}, 5000)"` |
| 「上限を超えたら打ち切って…」 | `sleep 5` | 同上（cmd.exe に `sleep` は無く、**Git 同梱の `sleep.exe` が PATH に居るかで結果が変わっていた**） |

`echo … > file` は cmd.exe でも POSIX シェルでも同義なので、
「spawn に渡すのは置換後の文字列」の suite はそのまま Windows でも走る（コメントの
「POSIX 前提」の記述だけ現状に合わせる）。

## S3: 測った事実を記録へ

- `pc-command.ts` の `stripCallBeforeStart` docstring に
  **「別の Windows 実機で測り直した（再現しない）」節**を足す。振った軸・件数・
  否定できたもの・**再発時に最初に測るもの**まで書く（同じ道を 2 度歩かせない）
- `.aidev/backlog/pc-command.md`:
  - 根本原因の項目を**割る**（`- [x]` 測り直した ／ `- [ ]` あの 1 台の事情は未解明）。
    誤りが確定した記述（`CALL` 以外の入れ子は未確認）は**取り消し線で残す**
  - 回帰確認の自動化を `- [x]`。テストのパス・見ているもの・空振り検証の結果・
    **Electron ビルドで回す道を採らなかった理由**を書く
- `.aidev/backlog/windows-test-run.md`（新規）: Windows で suite を回す前提
  （`npm install` → `tsc -b`）と、残り 11 件の落ち方を原因つきで起票

## 受け入れ基準

- [ ] 新テストが Windows で緑（3 件）
- [ ] 新テストが**空振りしない**（アプリが 1 拍で終わるミュータントで 3 件とも落ちる）
- [ ] `pc-command*.test.ts` が Windows で**全件緑**
- [ ] 直した 3 か所が**両方のシェルで意図どおり**（コマンド文字列を `cmd.exe` と
      `sh` の双方で実行して確認する）
- [ ] `tsc -b` と lint が通る
- [ ] backlog の 2 件が根拠つきで閉じる／割れる
