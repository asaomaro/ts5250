# レビュー: 起動応答で断られた理由を日本語で出す

## ラウンド 1（通過）
- 指摘なし。独立点検は節目でまとめて行う（PR #410 の方針）。

## ラウンド 2（節目の独立点検・マイルストーン 8。差し戻し）

別コンテキストのエージェントに 6 コミット（`7f192e11` / `3be3993a` / `65fa9200` / `57bf969b` / `4343eece` / `f446f419`）を、ACS の原典
（`PS5250.processBackspace`・`FFT5250.nextNonByPassInputFieldPos`・`PS5250.inputChar`・jt400 `AS400ImplRemote` / `ClassDecoupler` / `DDM*RequestDataStream`・
`DS5250.processStartUpConfirmation` / `extractNameFromStartUpConfirmationRecord`・ACS の文言表）と突き合わせて読ませた（全体で must 0・should 6・nit 5）。この work に関わる指摘と対応:
- [should][conv:-] `opMessages.ts`・requirements AC1 — 「繋ぎ直しで断られたときも通知が日本語になる」は事実と違った（自動の繋ぎ直しの拒否は `closed` の `reason` で届き、`session-controller.ts` が捨てていた） / 対応: `closed` の理由が起動応答の拒否なら日本語の理由を通知に出す
- [should][conv:-] `startup-record.ts`・`opMessages.ts` 8934 — ACS の文言表では "Start-up for S/36 WSF received."（当 PJ は「装置の開始に失敗」） / 対応: 英語・日本語とも ACS の意味に直した
- [should][conv:-] `ServicesPane.vue` — 常駐のプリンターが起動応答で断られた理由が英語のまま出る / 対応: 起動応答の拒否なら日本語の理由に置き換える（それ以外はそのまま）
- [nit][conv:paired-artifact-sync!] 両側のテスト — 「同じ並びで固定」は手書きの一覧 2 つで、互いを参照していなかった / 対応: 表を codec を読み込まない `startup-codes.ts` へ移してブラウザ入口から一覧を出し、web-ui のテストが tn5250 の表と直接比べる
- [nit][conv:-] `opMessages.ts` — 「8925（装置が使用中）」は誤り（使用中は 8902） / 対応: 直した
- [nit][conv:-] `opMessages.ts` — `SESSION_REJECTED` の分岐が `Object.hasOwn` の注記と対象のコードの間にあった / 対応: 並べ替えた

## ラウンド 3（通過）

対応後の差分を主エージェントが点検。**指摘なし**。mutation 13 通り（`scratchpad/mut-m8.py`）を当て、1 回目に 1 つ生き残った（ジョブの照会の名前——テストが
照会の後の名前を「起動応答の名前」として取っていた。照会に使った名前と比べる形に直して検出）。全量は下の test-result。
