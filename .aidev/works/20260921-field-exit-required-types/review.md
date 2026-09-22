# レビュー

## ラウンド 1（通過）

バッチ処理の 1 件。**指摘なし**。独立点検は次の節目でまとめて行う。
- 最初に付けた「符号付き数値を除く」条件は mutation で不要と分かり外した（D1）。その過程で、② の記録にあった
  「符号付きは自動送りするので送れてしまう」が確かめずに書いた誤りだと分かり、取り消し線で直した（D2）。

## ラウンド 2（節目の独立点検・12 と 13 をまとめて。差し戻し）

別コンテキストのエージェントに `764daaee..899a8e24` の差分と、既存の仕組みとの相互作用を読ませた。この work に関わる指摘と対応
（どれも実機の ACS で確かめてから直した。`scripts/acs-probe/field-exit-full.txt`・research F4〜F9）:

- [must][conv:-] `ScreenGrid.vue` `dupKey` — Dup の後に Field Exit 必須の欄へ留める変更は ACS と逆（`processDupFM` は FER も
  `isFieldExitRequired` も見ない） / 対応: 自動 Enter 欄なら送信、それ以外は次の欄へ。実機でも RZ DUP → 次の欄・ER DUP → 送信（D5）
- [must][conv:-] `EmulatorPane.vue` `noteFieldTyped` — RZ を満杯→Backspace→Enter で 0020 にならず左詰めのまま送られた
  （`edit` が `cursor` より先に届き、境界を欄の外と数えた） / 対応: 最終桁に留める形（D4）にし、`noteFieldTyped` は `fieldAtCaret` で見る。
  実機でも満杯→Backspace は `12346`・Enter は 0020
- [should][conv:measurement-sanity!] D1・テスト・コメント — 「符号付きは数字桁を埋めても 0020（場合 11）」は実測の読み違い
  （6S0 は 7 桁で、5 桁しか打っていなかった） / 対応: 6 桁打って測り直し（送れた）、記録とテストを直した（research F4）
- [should][conv:-] `ScreenGrid.vue` — 満杯の欄でさらに打つと黙って捨てていた（ACS は 0018） / 対応: 0018 の操作員エラーにした（D4）

## ラウンド 3（通過）

対応後の差分を主エージェントが点検。**指摘なし**。mutation 7 通り（F-a〜F-g）すべて検出。
