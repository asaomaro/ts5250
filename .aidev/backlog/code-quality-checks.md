---
backlog: code-quality-checks
kind: standing
---

# code-quality-checks

<!-- 項目は行頭の `- [ ]` で書く（見出しに書くと aidev status の未着手件数から漏れる） -->
- [ ] JSDoc が宙に浮くのを機械で検知する。既存の JSDoc とその宣言のあいだに新しい JSDoc ブロックを挿し込むと、前者がどの宣言にも結び付かなくなる（TS/エディタは直近のブロックだけを結ぶ）。20260908-session-lifetime-rules-fold で 3 回起きた（T8 / T9 / T12。うち 2 回は独立点検が検出、1 回は自己検出）。ブロックコメントが 2 つ連続する箇所を落とす検査を置けば機械で止まる——packages/web-ui は eslint の対象外なので、走査テスト（packages/*/test/lifetime-flag-containment.test.ts と同じ形）か lint ルールのどちらかで。条項にしないのは、層を下げられるものを規約に置かないため（protocol.md「12.」）（出典: .aidev/works/20260908-session-lifetime-rules-fold/retro.md）
- [ ] sharedFiles を .aidev/config.yml に宣言する。aidev doctor が「20 コミット中 9 回触られているのに未宣言」として 4 件挙げている（packages/web-ui/src/session-controller.ts 9/20、packages/web-ui/test/session-reconnect.test.ts 8/20、packages/server/src/session-manager.ts 6/20、packages/server/test/session-reconnect-grace.test.ts 5/20）。宣言すると coding のタスク点検の発火条件「共有モジュール・公開 API に触れたタスク」が機械判定になる（aidev-40-coding 手順5）。いまは人が思い出す形なので、20260908-session-lifetime-rules-fold では T10 の点検を 1 つ打ち漏らし、cross 点検が拾うまで気づかなかった（出典: .aidev/works/20260908-session-lifetime-rules-fold/retro.md）
