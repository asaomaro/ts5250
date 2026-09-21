# テスト結果: G（純 DBCS）欄の SO/SI

## 実行したもの（関係するテストだけ。全量・独立点検は節目で）
- `npx vitest run`（tn5250 のパッケージ全体）— 879 passed / 0 failed / 0 skipped（`dbcs-pure-field.test.ts` の 14 件を足した。実機が送った WTD の生バイトをそのまま使った）
- `npx vitest run`（DBCS・挿入・貼り付け・IME・欄の編集・継続欄・削除・MF に触れる web-ui のテスト 43 ファイル）— 643 passed / 0 failed / 0 skipped（`dbcs-pure-field.test.ts` の 14 件を足した。うち 1522 は下の合計）
- mutation（`scratchpad/mut-gf.py`）— 20 通りすべて落ちた（G の欄の中を読まない〔core 2 か所〕・欄の範囲を 1 桁広げる・WEA5 の区間・0x80／0x00 の終わり・G の SO/SI を外さない・欄長まで詰めない・切らない・
  平坦な応答の詰め物・SO/SI を外さない・バイト長・詰め物を半角空白・末尾の全角空白を落とさない・列ビューの SO の桁・休止時の列ビュー・押し出しに欄を渡さない・`dbcsByteLength`・MF の満杯判定）。
  最初の実行で 3 通り（欄の範囲・欄長で切る・休止時の列ビュー）が生き残ったので、欄の直後の半角・7 字の値・編集済みで休止している G のテストを足して落とした
- 実機（社内機）: 当 PJ で GTST（G・J・E・O）を受信・送信し（`scripts/diag-gfield.mjs`）、ACS のコアで同じ画面を表示・入力してワイヤを採った（`scripts/acs-probe/g-field.txt`）。当 PJ の送信もホストの受け取りも ACS と一致
- web-ui の型検査（`vue-tsc -b tsconfig.json tsconfig.test.json`）— エラーなし。全量と lint は節目で回す

## 受け入れ基準ごとの判定
- AC1: pass — 実機の WTD で G が `あいう□□□`（全角）。WEA5 の区間・欄の中・欄の直後の半角・DBCS でないコードページ
- AC2: pass — `かきく` が `11 03 14 44 86 44 87 44 88 40 40 40 40 40 40`（実機の ACS と同じ）。未編集は原本のまま。平坦な応答も。J は従来どおり
- AC3: pass — 12 バイトに 6 字・列ビューに SO/SI の桁が無い・挿入は全角空白を押し出す・満杯は 0012
- AC4: pass — 離れた桁へ打っても全角空白・末尾の詰め物は値から落ちる・触っただけでは編集にならない・MF は 6 字で満杯
- AC5: pass — mutation 20 通りすべて。実機の当 PJ の送信が ACS と同じ 12 バイト

## 失敗の証跡
このラウンドでは失敗が発生していない（テストの実行では）。実装前の当 PJ の実機の出力が失敗の証跡で、受信 `G PURE: ､ｱ､ｲ､ｳ`・送信 `11 03 14 0e 44 86 44 87 44 88 0f`・ホストの受け取り `GOT FG: F0 0E 44 86 44 87 44 88 0F 40 40 40`
（全角が 1 バイトずれた）を `scripts/diag-gfield.mjs` で採った。mutation の 1 回目で 3 通りが生き残った（`$ python3 mut-gf.py` の SURVIVED 行）。

## 起動確認（smoke）
```
$ node launcher/smoke.mjs
smoke: /healthz ok, / が Web UI を返した (port 45183)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- 実際の業務アプリの G の欄の頻度・実ブラウザでの打鍵（jsdom まで）
- SBCS のセッションでの WEA5 の否定応答・空きが NUL の G を ACS が DBCS 空白として扱うか（D5）
- J の空きへ離れて打ったときの半角空白は別件（D4。台帳）
