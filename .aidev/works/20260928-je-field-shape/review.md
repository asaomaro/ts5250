# レビュー: J・全角の E の欄の送るバイト列

## タスク点検ログ
- (cross・委譲) [should] `packages/web-ui/src/macro-record.ts` マクロの記録が `edits`（論理値）を積み、送った印入りの値（`wire`）を積んでいない——再生で ACS と違うバイト列になる / 対応: `s.wire?.get(index) ?? logical` を積む（`test/macro-record.test.ts` に 1 件。変異で検出）
- (cross・委譲) [should] `ScreenGrid.vue` の `eraseToEndDbcs`: 満杯まで打った直後の Field Exit（`fieldExited`）でも compact → open にしてしまう / 対応: 不要——J・E の欄の打鍵は `onDbcsKeydown` へ分かれ、`fieldExitedIndex` を立てる枝（`onInputKeydown` の FER の枝）に届かないので、DBCS の欄で `erases` が偽になることは無い
- (cross・委譲) [should] Erase EOF の条件 `cursor <= 中身の長さ` の境界（SI の桁と SI の後ろの桁が同じ index か）が未確認 / 対応: 別の index であることをテストで固定済み（`je-field-shape.test.ts` の「SI の桁でも SI は消える」「SI より後ろから Erase EOF しても SI は残る」）
- (cross・委譲) [nit] `commitDbcsSegment`・`commitFieldValueDirect` が `jeMeta` を通らない / 対応: 継続欄の経路で、`onEdit` はメタが無ければ `wire` を消すので古い値は残らない。J・E の継続欄は対象外（台帳の継続欄の項目）
- (cross・委譲) [nit] 桁数が奇数のとき NUL の組が割れる / 対応: J・E の欄は偶数桁でなければ WTD の段で否定応答（`packages/tn5250/src/protocol/wtd-applier.ts` の `DBCS field length`）なので届かない

## ラウンド 1
- 指摘なし（must 0 / should 0 / nit 0）。要件適合: AC1 は単体 18 件（web-ui 14・コア 4）、AC2 は `verify-browser-je-field.mjs` pass=3。
  価値適合: ホストが受け取るバイト列そのものを ACS の測定値と比べている。規約適合: 事実だけを書き起こし（ACS の表現は写していない）、実機の識別子はコミットしていない
