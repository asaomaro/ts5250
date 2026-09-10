---
backlog: code-quality-checks
kind: standing
---

# code-quality-checks

<!-- 項目は行頭の `- [ ]` で書く（見出しに書くと aidev status の未着手件数から漏れる） -->
- [ ] JSDoc が宙に浮くのを機械で検知する。既存の JSDoc とその宣言のあいだに新しい JSDoc ブロックを挿し込むと、前者がどの宣言にも結び付かなくなる（TS/エディタは直近のブロックだけを結ぶ）。20260908-session-lifetime-rules-fold で 3 回起きた（T8 / T9 / T12。うち 2 回は独立点検が検出、1 回は自己検出）。ブロックコメントが 2 つ連続する箇所を落とす検査を置けば機械で止まる——packages/web-ui は eslint の対象外なので、走査テスト（packages/*/test/lifetime-flag-containment.test.ts と同じ形）か lint ルールのどちらかで。条項にしないのは、層を下げられるものを規約に置かないため（protocol.md「12.」）（出典: .aidev/works/20260908-session-lifetime-rules-fold/retro.md）
- [ ] sharedFiles を .aidev/config.yml に宣言する。aidev doctor が「20 コミット中 9 回触られているのに未宣言」として 4 件挙げている（packages/web-ui/src/session-controller.ts 9/20、packages/web-ui/test/session-reconnect.test.ts 8/20、packages/server/src/session-manager.ts 6/20、packages/server/test/session-reconnect-grace.test.ts 5/20）。宣言すると coding のタスク点検の発火条件「共有モジュール・公開 API に触れたタスク」が機械判定になる（aidev-40-coding 手順5）。いまは人が思い出す形なので、20260908-session-lifetime-rules-fold では T10 の点検を 1 つ打ち漏らし、cross 点検が拾うまで気づかなかった（出典: .aidev/works/20260908-session-lifetime-rules-fold/retro.md）
- [ ] work をまたぐ参照の無修飾を走査で検知する。`decisions.md D<n>` / `前 work の D<n>` / `review ラウンド<n>` が work slug（`\d{8}-[a-z-]+`）で修飾されずにコメントへ書かれたら落ちる検査。20260910-session-reconnect-freeze で comment-provenance 違反が 14 件出て、うち 6 件がこの形（同じファイルに 2 つの work の参照が並んだ瞬間に解決不能になる）。条項は既に在って守られていないので、追記ではなく層を下げる（protocol.md「12.」）。走査は packages/*/test/lifetime-flag-containment.test.ts と同じ形で書ける（出典: .aidev/works/20260910-session-reconnect-freeze/retro.md）
- [ ] 「網羅の主張」を書いた箇所を機械で拾えるか検討する。「〜だけ」「のみ」「すべて」「唯一」「揃った」を含むコメントを一覧に出し、review の観点に載せる（落とすのではなく目印にする）。20260910-session-reconnect-freeze で数え漏らしが 3 回（D10 → D11 → D15）、いずれも独立点検が捕まえ、自分では 1 度も気づけなかった（出典: .aidev/works/20260910-session-reconnect-freeze/retro.md）
