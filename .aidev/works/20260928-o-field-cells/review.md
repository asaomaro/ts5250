# レビュー: O 欄の編集をセルの並びで行う

## タスク点検ログ
（指摘なし）

## ラウンド 1（独立レビュー・サブエージェント）
- [must][conv:-] packages/web-ui/src/components/ScreenGrid.vue:3931 フォーカスしていない O 欄への複数行の貼り付けが `normalizeO` を通らず、崩れた並び（`{AB}` など）が送られる。コアは半角を全角の 2 セルとして置き、ホストに別の字が届く / 対応: O 欄の貼り付けを ACS と同じ 1 字ずつの打鍵にした（`oPasteInto`。上書きは止まったところまで、挿入は 1 字でも止まれば何も貼らない）。組み直しは桁がずれるので使わない
- [should][conv:-] packages/tn5250/src/screen/buffer.ts:1263 `setFieldCells` が並びの中の半角を 2 セルにし、組にならない生バイトを捨て、NUL を空白にした原本の書き戻しで桁が倍になる / 対応: 並びの中でも全角（`isFullWidth`）だけ 2 セル、半端な前半は 1 セルで残す。単体を足した
- [should][conv:-] packages/tn5250/src/protocol/read-response.ts:501 並びの中に半角が混ざると codec が途中に SO/SI を足す / 対応: 並びの中は 1 字ずつ書く。単体を足した
- [nit][conv:-] ScreenGrid.vue `baselineValue` が編集済みの値に `oExplicit` を掛けず、比較が常に「変更あり」になりうる / 対応: 掛けた
- [nit][conv:-] ScreenGrid.vue `dtOpenValues` に印が混ざる / 対応: 印を外した
- [nit][conv:-] 途中の空きを空白の実セルで持つ（ALT で 0x00 でなく 0x40）・ホストが途中に置いた NUL の桁の対応 / 対応: 以前からの差（全欄共通）。未検証の穴に残す

## ラウンド 2
- 前ラウンドの 6 件の解消を確認（貼り付けを 1 字ずつの打鍵に・コアの並びの中の半角と半端な生バイト・送信を 1 字ずつ・基準の印・日付の選択。途中の NUL の差は未検証の穴へ）。
  このラウンドの差分（単一行の挿入の貼り付けの事前の検査を O 欄で外した）に must/should なし
