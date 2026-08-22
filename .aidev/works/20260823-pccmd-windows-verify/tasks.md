# タスク

- [x] `npm install` ＋ `npx tsc -b` で土台を整え、Windows の baseline を取る（1,243 件中 12 件 failed）
- [x] 測定 1: コマンドの形 8 × spawn の指定 4（11 ケース）
- [x] 測定 2: `CMD /C "…"` の入れ子 × コンソール / GUI（12 ケース）
- [x] 測定 3: 親プロセス 3（bash / cmd.exe / Electron main）× 3 形 ＋ `IsProcessInJob`（9 ケース）
- [x] 測定 4: `CALL` の構文解析差を argv で突き合わせ（8 ケース・空白入りパスを含む）
- [x] `packages/server/test/pc-command-windows.test.ts` を書く（3 形・生存で判定）
- [x] 空振り検証（アプリを 1 拍で終わらせるミュータント → 3 件とも死亡）
- [x] `pc-command.test.ts` の POSIX 前提 3 か所を外す（`test -d .` / `sleep 5` × 2）
- [x] 直した文字列を `cmd.exe` と `sh` の両方で実行して確認
- [x] `pc-command.ts` の docstring に測定結果の節を足す
- [x] `.aidev/backlog/pc-command.md` の 2 件を閉じる／割る
- [x] `.aidev/backlog/windows-test-run.md` を起票（残り 11 件を原因つきで）
- [x] `tsc -b` ・ lint ・ `packages/server` の suite で締める
