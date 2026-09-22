# 決定記録

## D1: 末尾へは着いた欄に End を渡して置く

- 末尾の桁の求め方（入力の直後・埋まっていれば最後の桁・DBCS の SO/SI）は ScreenGrid の欄の中の End と同じなので、ペインで計算し直さずに渡す。
  End に割り当てがあればペインの `end` 自体に来ないので、渡した End が割り当てへ回ることは無い。
  ~~渡すのは安全~~ → 欄が処理しない状態（施錠中など）では渡した End がペインへ伝わり、また `end` が走って無限に繰り返した（D3）。

## D2: 実機では確かめていない

- 行き先の規則は原典の読み（F1・F2）。~~欄の中の End の桁は `20260921-acs-default-keys` で原典どおり（`getEndPosition`）~~ → 行をまたぐ欄の下限と継続欄の鎖が原典と違っていた（D3）。ACS のコアで欄の外の End を測ってはいない（未確認）。

## D3: 節目の独立点検で D1・D2 の前提を破棄した（マイルストーン 7）

- 証拠: 点検の再現テスト（施錠中＋マクロ再生中で合成 End が 462 回で `Stack overflow`）と原典（`getEndPosition` の下限・`getEndPositionOfContField`・`FFT5250.getField` は保護欄も返す）。
- 決定: 合成 End は伝えない（`bubbles: false`）。継続欄は鎖全体で末尾を探す（`continuedEnd`）。保護（バイパス）欄の上ではその欄の中の末尾へ置く（`endInProtectedField`）。
- 行をまたぐ欄の下限は ACS のコアで実測して一致（`scripts/acs-probe/end-row-bound.txt`）。保護欄の上の End はコアで測っていない（未確認）。
