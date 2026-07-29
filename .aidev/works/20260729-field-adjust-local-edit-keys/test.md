# テスト結果

spec「6. 受け入れ基準」の 11 項目を検証した。**全項目クリア**。

## 実行したもの

| 種別 | コマンド | 結果 |
|---|---|---|
| core 単体 | `cd packages/core && npx vitest run` | **901 passed / 78 files** |
| web-ui 単体 | `cd packages/web-ui && npx vitest run` | **1043 passed / 89 files** |
| 型・ビルド | `npm run build`（`tsc -b` / `vue-tsc -b` 込み） | **通過** |
| 実ブラウザ＋実機 | `node --env-file=.env scripts/verify-browser-adjust.mjs` | **15/15 passed** |

> web-ui の単体は **パッケージ dir から実行**した（ルートからだと Vite の vue plugin と
> フィクスチャの相対パスが解決されず偽陽性が出る。AGENTS.md）。

## 受け入れ基準の対応

| # | 基準 | 検証 | 結果 |
|---|---|---|---|
| 1 | `rightAdjust` が原典と同じ結果（末尾非空白は無変化 / 全空白は無変化 / 語中の空白は保持 / 先頭空白は fill 置換） | `web-ui/test/field-adjust.test.ts` | ✅ |
| 2 | `mandatory-fill` は桁を動かさない | 同上 | ✅ |
| 3 | signed-num は指定が無くても空白右寄せし符号桁を動かさない | 同上＋実ブラウザ | ✅ 画面値 `"    12 "` |
| 4 | `eraseToEnd` がカーソル以降だけを消す | 同上 | ✅ |
| 5 | `snapshot().fields[].adjust` が FFW から正しく出る | `core/test/field-adjust-snapshot.test.ts` | ✅ 予約値 0x1–0x4 を無指定に落とすことも確認 |
| 6 | 数値欄の検証が前後の空白を通し埋め込みは弾く | `core/test/field-validate.test.ts` | ✅ |
| 7 | `local:*` が `h.local()` を呼び **ホストへ送らない** | `web-ui/test/keybindings.test.ts` | ✅ `sendAid` 未呼び出しを確認 |
| 8 | 版を上げても利用者が消した既定が復活しない | 同上 | ✅ |
| 9 | 実ブラウザで 3 キーが動く | `scripts/verify-browser-adjust.mjs` | ✅ |
| 10 | **実機で右寄せした値がホストへ届く** | 同上（Enter 送信後のエコー欄） | ✅ `[000012]` / `[    12]` |
| 11 | `npm run build -w @as400web/web-ui`（`vue-tsc -b`） | ビルド | ✅ |

## 実機 E2E の内訳（15 項目・実機 / TESTLIB）

```
OK   メインメニューに到達
OK   ADJPGM の画面が出る
OK   入力欄が 9 つある（DDS の CASES 順） — count=9
OK   Field Exit: CHECK(RZ) 欄がゼロ埋めで右寄せされる — "000012"
OK   Field Exit: フォーカスが次の入力欄へ進む — focusIndex=1
OK   Field Exit: CHECK(RB) 欄が空白埋めで右寄せされる — "    12"
OK   Field Exit: CHECK(MF) 欄は桁を動かさない — "12    "
OK   Field Exit: カーソル以降が消える — "AB    "
OK   Erase EOF: カーソル以降だけ消える — "ABC   "
OK   Erase EOF: 欄から出ない — focusIndex=3
OK   Erase Input: すべての入力欄が空になる — ["","","","","","","","",""]
OK   Field Exit: 数値欄（signed-num）は空白で右寄せし符号桁を残す — "    12 "
OK   ホストが CHECK(RZ) 欄をゼロ埋め右寄せで受け取る — 期待 [000012]
OK   ホストが CHECK(RB) 欄を空白埋め右寄せで受け取る — 期待 [    12]
OK   数値欄も送信できる（内容検証が空白 padding を弾かない）— 期待 [12]
15/15 passed
```

ホスト側のエコー（RPG が受け取った値を `[...]` で返したもの）:

```
  CHECK(RZ) A          ->  [000012]
  CHECK(RB) A          ->  [    12]
  CHECK(RZ) 6 0        ->  [12]
```

## 本作業と無関係な既存の失敗（記録）

- `packages/server` の `test/zip-writer.test.ts` が 4 件失敗する。**外部の `unzip` コマンドが
  この環境に入っていないため**で、本作業の変更前（`git stash` した状態）でも同じく 4 件失敗することを
  確認済み。既存の環境要因であり、本作業では触らない。
- `npm run lint` が 6 件エラーを出すが、**すべて未追跡の既存スクリプト**
  （`shot-buttons.mjs` / `shot-crt.mjs` / `shot-empsfl.mjs` / `shot-fkey.mjs` /
  `shot-font.mjs` / `build-empsfl.mjs`）の未使用変数。前セッションの置き土産で、
  **本作業で追加したスクリプトは 1 件も引っかかっていない**（コミット対象にも含めない）。
