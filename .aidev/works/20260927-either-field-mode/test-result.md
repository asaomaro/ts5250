# テスト結果: E 欄の半角・全角

## 実行したもの
- `packages/tn5250` `npx vitest run` — 1021 passed / 0 failed（新規 `either-dbcs-flag.test.ts` 7 件を含む）
- `packages/web-ui` `npx vitest run` — 2821 passed / 1 failed → 落ちた `delete-word.test.ts` は単独で 33 passed（負荷下の時間切れ。この変更は Delete Word に触れていない）
- `packages/server` `npx vitest run` — 1617 passed / 1 failed / 3 skipped → 落ちた `app-pdf.test.ts` は単独でも 5 秒の時間切れ、`--testTimeout 60000` で 2 passed（import に 34 秒かかっていた。テスト本体は 1 秒未満。この変更と無関係）
- `packages/web-ui` `npx vue-tsc -b` — エラーなし
- 変異: web-ui 5 件（コアの状態を見ない・切り替えの記録を見ない・選択を戻さない・IME に規則を掛けない・Space の全角化を外す）、コア 4 件（SO で立てない・値で上げ下げしない・空白を飛ばさない・空で下ろす）がすべて落ちた

## ラウンド 2（レビューの差し戻し後）
- `packages/tn5250` 1030 passed（`either-dbcs-flag.test.ts` 9 件。この数には別 work〔read-alt-raw〕の未コミットのテストも含む）
- `packages/web-ui` 2822 passed / 0 failed・`vue-tsc -b` エラーなし
- 変異: 同じ位置の SF で状態を引き継がない・スナップショットの else の相手を変える、の 2 件とも落ちた

## 受け入れ基準ごとの判定
- AC1: pass — 実測 A〜F（`scripts/acs-probe/either-field-mode.txt`）をテストで固定（`either-field-mode.test.ts` 12 件・`either-dbcs-flag.test.ts` 7 件）
- AC2: pass — 0060・0061 の文言が出て、`isOperatorError` に登録（施錠の配線は既存のテスト）
- AC3: pass — 実機の片付け（KEYTST は次の work の測定にも使ったので、そちらの片付けで消す。research F4 の測定に使った）

## 失敗の証跡
このラウンドでは差し戻しになる失敗は発生していない（上の 2 件は単独の再実行で通った。出力は下）

```
$ npx vitest run test/delete-word.test.ts
      Tests  33 passed (33)
$ npx vitest run test/app-pdf.test.ts --testTimeout 60000
      Tests  2 passed (2)
   Duration  37.36s (transform 25.80s, setup 0ms, import 34.72s, tests 964ms, environment 12ms)
```

## 起動確認（smoke）
```
smoke: /healthz ok, / が Web UI を返した (port 38854)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- 実機の web-ui を手で打つ確認はしていない（ACS 側はコアで測り、当 PJ 側は単体テスト）
- 「切り替えてから欄を空にし、そのまま送る」とコアの状態が前のまま（decisions D4 の残り。台帳に残す）
