# テスト結果: Windows 実機で測り、生存を回帰資産にした

## 実機（この作業は Windows 実機の上で行った）

Windows 11 Pro build 10.0.26200.9168 / `cmd.exe` 10.0.26100.8875 / Node 24.18.0 /
Electron 32.3.3 / Defender ＋ ESET Security。
`ComSpec` は既定、`Command Processor` の `AutoRun` は HKCU / HKLM ともに空。

## 測定（40 ケース。詳細は research.md）

| 段 | 振った軸 | 件数 | 結果 |
|---|---|---|---|
| 1 | コマンドの形 × spawn の指定 | 11 | **全部生存**（`START /B` のタイトル省略だけ起動せず＝cmd の仕様） |
| 2 | `CMD /C "…"` の入れ子 × コンソール / GUI | 12 | **全部生存** |
| 3 | 親プロセス（bash / cmd.exe / **Electron main**）× 3 形 | 9 | **全部生存**。3 親とも **no-job**（`IsProcessInJob`） |
| 4 | `CALL` の構文解析差（起動された側の argv） | 8 | **`CALL` 有無で完全に同一** |

**「`CALL START` で消える」はこの機械では再現しない。**

## この環境で確かめたこと

| 対象 | 結果 |
|---|---|
| `pc-command.test.ts` ＋ `pc-command-boundary.test.ts` ＋ **新規 `pc-command-windows.test.ts`** | **39 passed**（3 ファイル・4.6 秒） |
| `packages/server` 全体（Windows 実機） | **1,246 件中 1,233 passed / 2 skipped / 11 failed** |
| 同・**この作業の前**（baseline） | 1,243 件中 12 failed |
| `npx tsc -b` | 通る（error 0） |
| `npx eslint`（触った 3 ファイル） | 通る（error 0） |
| 新テストを単体で 2 回 | どちらも 3 passed（4.6 秒 / 5.1 秒） |

**残った 11 件はいずれもこの作業の前から赤い**（`lp` / `unzip` / `python3` の不在、
`chmod` が Windows で効かない、CRLF チェックアウトで指紋が変わる）。
原因つきで `.aidev/backlog/windows-test-run.md` に起票した。
差し引き **1 件（`test -d .`）を減らし、3 件を増やした**。

### 新規テスト（3 件）

`packages/server/test/pc-command-windows.test.ts`（`describe.skipIf(!isWin)`）。
本番の `runPcCommand` 経路で「アプリ」を起動し、**シェルが終わったあとに行が増えるか**で
生存を見る: `CALL START "t" /B …` / `CMD /C "NET USE & CALL START "t" /B …"` /
対照の `START "t" /B …`。

**一度は偽陽性で作り直した。** 最初は「アプリが 2 秒で自分から終わる」形にしていたが、
suite 全体（92 ファイル）と並行させるとタイマーが数秒ずれ、
**2 回目の観測時にはもう終わっていて 3 件とも落ちた**。
起動は**出るまで待つ**・生存は**増分**で見る形に変え、アプリの寿命は
テスト側（`afterAll` の `process.kill`）が握るようにした。

## 空振り検証（mutation）: 3/3 想定どおり

| ミュータント | 結果 |
|---|---|
| アプリが 1 拍で終わる（＝原資料の症状を再現） | **新テスト 3 件とも死亡**（`expected 1 to be greater than 2`） |
| `cwd` の指定を落とす（作業ディレクトリーのテスト） | **死亡**（`marker.txt` が cwd に無い） |
| `stripCallBeforeStart` を呼ばない（回避策を外す） | **新テストは空振り**——この機械では `CALL START` でもアプリが生きるため。検出したのは既存の「渡した文字列は置換後か」1 件 |

3 つ目は**この機械の限界そのもの**なので、隠さずここに残す。
生存テストは「アプリが消える退行」を捕まえるが、
「回避策が要るかどうか」は**再現する機械でしか測れない**。

## 未検証の穴

- **原資料の機械**（別環境）での再確認。届かないので測れない
- **POSIX 側の実行経路**は Windows からは回せない。置き換えたコマンド文字列
  （`"<node>" -e "setTimeout(…)"` / `echo x > marker.txt`）は
  **`cmd.exe` と `sh` の両方で実行して**終了コードと所要時間・書かれた場所を確認したが、
  `runPcCommand` 自体を POSIX で走らせた確認は Linux 側の CI に委ねる
- Windows の残り 11 件（この作業の対象外。backlog に起票）
