# テスト結果: FFW の挙動ビット

## 自動テスト

| 対象 | 結果 |
|---|---|
| `packages/core` | **936 passed / 81 files**（新規 `field-ffw-bits.test.ts` = 17 件） |
| `packages/web-ui` | **1126 passed / 96 files**（新規 `ffw-behavior-bits.test.ts` = 27 件） |
| `packages/server` | 83 passed |
| `packages/ebcdic` ほか | 13 passed |
| ビルド | `tsc -b` / `vue-tsc -b` / `vite build` すべて成功 |
| lint | 変更ファイルはエラー 0 |

### 未検証の穴（環境不足）

- **`packages/server/test/zip-writer.test.ts` の 4 件が失敗**（`spawnSync unzip EACCES`）。
  この環境に `unzip` が無いことによるもので、**`main` でも同じ 4 件が失敗する**ことを
  `git stash` で確認済み。本 work の変更（core/screen・web-ui）とは無関係。
  → deliver で PR 本文の「既知の制約」に載せる。

## 空振り検証（実装を壊してテストが落ちるか）

判定を 1 か所ずつ外して、対応するテストが**落ちること**を確認した（落ちなければ何も守っていない）。

| 壊した内容 | 結果 |
|---|---|
| FER の自動送り抑止を外す | 落ちた |
| MONOCASE を見ず常に大文字化する | 落ちた |
| AUTO_ENTER を無視する | 落ちた |
| Enter 限定をやめて全 AID で検証する | 落ちた |
| 検証しても送信を止めない | 落ちた |
| mandatory-fill で空も弾く | 落ちた |
| キーボード入力不可の判定を外す | 落ちた |
| `alphaOnly` をフラグに写さない | 落ちた |

**空振り 0 件**（8/8）。

## 実機ブラウザ検証（`scripts/verify-browser-ffw.mjs`）

実機へ実際に接続し、`TESTLIB/FFWPGM`・`TESTLIB/ADJPGM` を呼んで
**core → WS → ブラウザ**の端から端までを確かめた。**18/18 passed（2 回連続）**。

- MONOCASE 欄で `abc` → `ABC` ／ `CHECK(LC)` 欄では `abc` のまま
- 英字専用（`X`）欄が数字を弾き、操作員メッセージが出る
- キーボード入力不可（`I`）欄は何も受け付けない
- `CHECK(ER)` 欄が満杯になると Enter が飛ぶ
- `CHECK(FE)` 欄は満杯でも次欄へ飛ばない／`CHECK(FE)` でない欄は飛ぶ
- `CHECK(ME)` 空・`CHECK(MF)` 部分入力で Enter が止まりメッセージが出る
- **F3 は止まらない**（必須欄が空でも画面から出られる）

### この検証だけが見つけた欠陥（重要）

**必須検証が OIA の「⏎ 実行」ボタンで素通りしていた。**

当初は判定を `EmulatorPane.onAid` に置いていたが、`StatusBar.vue:62` は
`onAid` を通らず `sendKey` を直に呼ぶため、ボタンで押すとホストへ抜けていた。
**単体テストは 27 件すべて緑のまま**で、実機ブラウザ検証で初めて出た
（キーボード経路しか叩いていなかったため）。

→ 判定を `session-controller.ts` の `sendKey`（全送信経路の合流点。同ファイルのコメントが
既に「キーボード・凡例ボタン・ホイール・OIA ボタンはすべてここを通る」と明記している）へ移し、
**その経路を直接叩く回帰テストを追加**した（`sendKey を直に呼んでも Enter は止まる`）。

### 検証スクリプトの安定化

1 回おきに「メインメニューに到達」で失敗していた。原因は**装置 DEV1 のジョブが残る**こと
（次の実行が回復画面から始まる）。終了時に `SIGNOFF` するようにして再現性を確保した。

## 判定

**全て合格**（環境不足による既知の失敗を除く）。coding への差し戻しは無し。
