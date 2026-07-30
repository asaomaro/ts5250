# テスト結果: Windows 実機で見つかった 2 件を直す

## 実機の裏付け（**この環境では取れない**）

Windows 実機での確認は**持ち込まれた原資料**（別環境の実測）に依る。
そこで確認されていること:

- `CALL START "title" /B "app.exe"` は起動したアプリが**直後に消える**
- `CALL` を落とした `START …` は**毎回問題なく生き残る**
- 効かなかった手: `detached` 単独 / `cmd.exe` 直接呼び出し（**退行も起こした**）/
  CCSID・EBCDIC のデコード / EDR のブロック（いずれも原因ではない）

**この環境に Windows は無いので再検証していない**（decisions D5）。
「アプリが生き残る」ことは未検証の穴として backlog と PR に残した。

## この環境で確かめたこと

| 対象 | 結果 |
|---|---|
| `packages/server/test/pc-command.test.ts` | **26 passed**（既存 15 ＋ 新規 11） |
| server / core 全体 | **1810 passed**（4 failed は既知の環境不足＝`unzip` 無し。`main` でも同じ） |
| web-ui（パッケージ dir から実行） | **1235 passed** |
| `tsc -b` / lint | 通る（error 0） |
| `start.bat` の行末 | 既存と同じ **LF のまま**（混在させていない） |

### 新規テスト（11 件）

| 節 | 見ているもの |
|---|---|
| `stripCallBeforeStart` | `CALL START` → `START` ／ `&` で繋いだ業務 CL の実例 ／ **2 つ並んだら両方** ／ 空白の数・種類（空白 2 つ・タブ・改行）／ `CALL` 無しはそのまま ／ 無関係はそのまま ／ **語の一部は変えない**（`CALLSTART` / `MYCALL START`）／ **バッチの `CALL` は落とさない**（`CALL setup.bat` / `CALL :label`） |
| 許可判定との順序 | `CALL START …` を許可した設定で**実行できる** ／ 置換後の文面だけを許可した設定では**弾かれる**（置換で門をすり抜けない） |
| spawn に渡す文字列 | **シェルに書かせて読む**（`echo CALL START > file` の中身が `START`）＝実際に渡っているのは置換後の文字列 |

**`detached: true` を入れても既存 15 件が通る**（終了コード・上限打ち切り・作業ディレクトリー）
——research F6 の見立てを実行で確かめた。

## 空振り検証（mutation）: 7/7 想定どおり

| ミュータント | 結果 |
|---|---|
| 置換を許可判定の**前**に移す | 死亡 |
| `g` を外す（2 つ目が残る） | 死亡 |
| `i` を外す（小文字が残る） | 死亡 |
| 語境界を外す（`MYCALL START` を壊す） | 死亡 |
| 空白 1 つ固定にする（`CALL  START` が残る） | 死亡 |
| 置換を呼ばない（元の文字列で spawn） | 死亡 |
| **`start.bat` から `--auto-secret-key` を落とす** | **空振り（想定どおり）** |

初回は「置換を呼ばない」が空振りした（`stdio: "ignore"` で渡した文字列が見えないため）。
**シェルに書かせて読むテスト**を足して塞いだ。

`start.bat` は Windows 専用スクリプトで、この環境のテストからは実行できない。
**空振りするのが現状**であることを正直に記録する（decisions D5。
backlog に「Windows 実機での回帰確認の自動化」を項目として起こした）。

## 未検証の穴

- **Windows 実機での動作**（アプリが生き残ること・`start.bat` からの起動）。原資料に依る
- **根本原因は未特定**。回避策なので、Windows 側の事情が変われば再訪が要る（backlog に項目）
- 引用符の中の `CALL START` も落とす（decisions D4。既知の限界）
- `packages/server/test/zip-writer.test.ts` の 4 件は `unzip` が無いため失敗（`main` でも同じ）
