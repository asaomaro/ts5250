# 決定記録

## D1: `scripts/diag-dspfmt-reconnect-blank.mjs` は当初、本件の欠陥を検出できない
診断だった——`sendAid()` の解決値を見るよう改修した

- 背景: 本 work の最初の実機診断（`scripts/diag-dspfmt-reconnect-blank.mjs`）は
  `session.snapshot()`（ライブのバッファ状態を都度読む API）を100msごとにポーリングする
  実装だった。これは「コア層では6回とも正常に見えた」という結果を出し、当初これを
  「コア層には再現しない」（原因は `packages/server`/`packages/web-ui` にある）という
  誤った結論の根拠にしてしまった。
- 判断: 実際には `sendAid()` が返す Promise の解決値（`res.screen`）こそが
  `key-done` メッセージの内容そのものであり、これを直接調べたところ、コア層単体・
  フレッシュな接続で8回中8回、決定的に不具合が再現することが判明した（`research.md`
  F1'）。**`diag-dspfmt-reconnect-blank.mjs` を、ライブ polling に加えて `sendAid()` の
  解決値も直接チェックする形に改修し、regression 判定（AC2）はこちらを基準にする。**
  ライブ polling 自体は「WTD の処理過程を時系列で観測する」という別の価値
  （タイミング分析）があるため残す。
- 理由 / 代替案: 新しい別スクリプトを作る案も検討したが、既存スクリプトの目的
  （DSPFMT の実機再現）と完全に重なるため、同じファイルを改修する方が診断資産が
  散らばらず追跡しやすい。
- 影響: `requirements.md` AC2 の文言を「ライブ polling で正常に見えること」から
  「`sendAid()` の解決値が正常であること（改修後のスクリプトで確認）」に訂正した
  （doccheck requirements ラウンド2の指摘を受けて対応）。この誤りに気づかないまま
  design/coding へ進んでいたら、**修正後のコードが実際にバグを直しているかどうかを
  検証する手段が無いまま test 工程に入っていた**——doccheck の価値が具体的に発揮された
  ケースとして記録する。

## D2: design.md の doccheck が `maxDocCheckRounds`（2）に達したため、
ラウンド2の nit 3件は直したのみで再点検しない

- 背景: design.md の doccheck ラウンド1で must 2件・should 1件・nit 1件、ラウンド2
  （上限）で nit 3件（session.ts:442-448 の未掲載、行番号表記の節間不一致2件）が
  出た。ラウンド1の must/should は内容の正確性に関わる実質的な指摘で、その場で
  session.ts の実装（`keyboardLocked` ゲッター、644-646のコメント）・
  ws-handler.ts/app.ts の該当行を直読して修正した。ラウンド2の3件は全て
  「引用漏れ」「行番号のずれ」という機械的な訂正で済むものだった。
- 判断: ラウンド2の3件をその場で修正し、`protocol-check.md`「上限で止まったら
  深追いしない」方針に従い、3回目の doccheck ラウンドは実施しない
  （`maxDocCheckRounds` の設定通り）。判断は review 工程に委ねる。
- 理由 / 代替案: 3件とも内容の正確性そのものには関わらない表記の不揃いであり、
  再点検で新たな実質的指摘が出る可能性は低いと判断した。
- 影響: review 工程で design.md の内部一貫性に問題が残っていないか、最終確認の
  対象に含める。
