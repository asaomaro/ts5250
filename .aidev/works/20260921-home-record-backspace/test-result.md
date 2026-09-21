# テスト結果: Home・Record Backspace・欄データを載せない AID

## 実行したもの
- tn5250 `test/no-data-aid-home.test.ts` — 11 passed。tn5250 全体 — 76 files 759 passed（関係の広い変更なので流した）
- web-ui `test/home-key-acs.test.ts`（7 件）・Home / Help / Clear に触れる既存 7 ファイルと合わせて 8 ファイル 164 passed。型検査（`vue-tsc --noEmit`）
- server 全体 — 1453 passed / 1 failed（`zip-writer.test.ts` の時間切れ。単独で流すと 15 passed。この変更と無関係の既知の不安定）
- 実機: `scripts/acs-probe/backtab-home.txt`（ACS のコアの Home）、タップ越しの ACS のワイヤ（Help・Record Backspace）

## 受け入れ基準ごとの判定
- AC1: pass — 7,22 → ホーム位置（先頭の入力欄）、IC で指されたホーム位置の桁まで、ホーム位置の無い手組みの画面は先頭の入力欄。
- AC2: pass — ホーム位置で送る・移った後の 2 回目で送る・右寄せに打ったまま（欄の中の左矢印で戻った）でも送る・同じ欄の中の Home で「出た」扱い。
- AC3: pass — 4 つの AID で READ MDT がカーソルと AID だけ・Enter は欄を載せる・READ INPUT FIELDS でも同じ。
- AC4: pass — mutation H-a〜H-h のうち 7 通り検出。H-g（READ INPUT FIELDS 側の分岐）は等価だったので分岐ごと外した（D2）。

## 失敗の証跡

```
$ python3 mut-home.py
H-g 0x42 では欄を載せる: 11 passed (11)
$ (cd packages/server && npx vitest run)
 FAIL  test/zip-writer.test.ts > 外部の unzip が受け付けること > 大きめのデータでも往復する
      Tests  1 failed | 1453 passed | 3 skipped (1457)
```
H-g は実装の重複（D2）。zip-writer は負荷時の時間切れで、単独では通る（`Tests  15 passed (15)`）。

## 起動確認（smoke）

```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 46423)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴
- 実ブラウザの Home（jsdom のみ）。DBCS 欄のホーム位置が SO のときの +1 は、論理位置 0 に置くことで同じ結果になるはず（測っていない）。
- Record Backspace を受けて前のレコードへ戻るアプリでは試していない（手元の実機にそういうアプリが無い）。
