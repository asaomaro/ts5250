# レビュー記録

## タスク点検ログ（coding 工程内・「3.3」(b)）
- [should][conv:verify-by-mutation] packages/web-ui/src/components/ScreenGrid.vue:4776 本文が空で位置だけのとき `.opmsg` の高さが 0 で下のセルを隠さない（テストも存在しか見ていない） / 対応: 修正済（style に height 1.25em、テストで確認。T3・ラウンド1）
- [nit][conv:-] packages/web-ui/src/components/ScreenGrid.vue:4768 `.opmsg-area` が `.opmsg` の説明と本体の間に入った / 対応: 修正済（`.opmsg` の後ろへ）
- [nit][conv:-] packages/web-ui/src/components/ScreenGrid.vue:4439 テンプレートの俯瞰コメントが最下行だけ / 対応: 修正済
- [must][conv:-] packages/tn5250/src/protocol/wtd-applier.ts:372 開始桁・終了桁の欠けを `peek() !== ESC` で見ていたため、桁 4（ESC と同じ値）を欠けと誤り、残った 0x04 が次のコマンドとして誤読される / 対応: 修正済（残りのバイト数だけで判定。テスト追加。T1・ラウンド1）
- [should][conv:-] packages/tn5250/src/protocol/wtd-applier.ts:1003 重ねる幅に IC・SBA・MC の 3 バイトまで数えて 3 桁広くなる / 対応: 修正済（書いた桁だけ数える。テスト追加。T1）
- [should][conv:-] packages/tn5250/src/protocol/wtd-applier.ts:1032 上限の境界にオーダー・DBCS の組がまたがるときの ACS の扱いが未確認なのに書かれていない / 対応: 修正済（コメントに未確認と明記。decisions D4）
- [nit][conv:-] packages/tn5250/src/screen/buffer.ts:739 RESTORE SCREEN で位置が残りうる / 対応: 未確認として記録（decisions D4。0x21 の起票に書く）
- [nit][conv:-] packages/tn5250/src/protocol/wtd-applier.ts:997 終了桁が桁数を超えると幅が次の行へまたがる / 対応: 修正済（行末で止める。テスト追加）
- [nit][conv:verify-by-mutation] packages/tn5250/test/window-error-code.test.ts:80 桁の欠けが 0 バイトの場合だけ / 対応: 修正済（1 バイトの場合を追加。T2）
- [nit][conv:verify-by-mutation] packages/tn5250/test/window-error-code.test.ts:45 SO/SI・DBCS を上限で数えることを固定するテストが無い / 対応: 修正済（930 の本文で追加。T2）

## ラウンド 1（2026-09-27）

`aidev coverage`: gap 0。差分は core（`wtd-applier.ts`・`buffer.ts`・`types.ts`）・web-ui（`ScreenGrid.vue`・`EmulatorPane.vue`）・テスト 2 本・実機の検証資産 3 つ。

- **要件適合**: AC1〜AC5 を満たす（実機で 8/8、ACS の実測と一致）。台帳の「0x22 は観測できないので保留」は DSM で出させて測ったことで置き換えた（D1）。
- **価値適合**: 窓のエラーが ACS と同じ行・桁に出て、窓の外の最下行全体を覆わなくなる（メッセージ行が SOH で申告されている画面）。最下行のときは ACS も行頭から書くので見え方は従来に近いが、幅と本文の長さが ACS と一致した。
- **正確性**: 独立点検の must（桁 4 を ESC と取り違える）を含め全部直した。境界・RESTORE・行またぎの未確認は decisions D4 に残した。
- **規約適合**: 原典は事実の確認だけ（書き起こし）。コメントに出所。測定で作った実機のオブジェクトは消した。

指摘なし。
