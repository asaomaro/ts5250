# 決定記録

## D1: 「DBCS 24x80 は G02」を破棄し、ACS と同じ C01 にする

- 背景: PUB400 の総当たりで C01 だと STRSEU が 27x132 で来たので、24x80 に G02 を採っていた。
- 決定: 当時の Query Reply は常に 27x132 可（0x31）と申告していた。いまの申告（24x80 は 0x11）なら C01 でも STRSEU は 24x80 で来る（両方の実機。research F3）。ACS のワイヤも C01（F1）なので C01 に統一した。旧い総当たりの表は `docs/PROTOCOL.md` に取り消し線の注記つきで残した。

## D2: 実験の手順はリポジトリに入れない

- 比べるために `terminal-type.ts` を一時的に書き換えて流した（すぐ戻した）。手順（scratchpad の `term-type.mjs`・`seu-size.mjs`）は端末タイプを外から指定できないことを前提にしていて、恒久の検証スクリプトにはならない。恒久の確認は `scripts/verify-screen-size.mjs`（PUB400 の固定のライブラリを前提）に任せる。
