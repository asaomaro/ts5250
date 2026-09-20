---
backlog: verify-scripts
kind: standing
---

# verify-scripts

<!-- 項目は行頭の `- [ ]` で書く（見出しに書くと aidev status の未着手件数から漏れる） -->
- [ ] review ラウンド 3 の nit 8 件（検証用スクリプトの細部）を直す。(1) 手順の引数の検査（loadSteps）と実行側の解析が別々で、strip の有無・桁あふれ・画面外の setcursor が接続後に落ちる。(2) finally の片付けの catch が Exception のまま。(3) サインオン画面の欄が見つからない／接続の例外が 4 に分類される（README は 3）。(4) acs-probe.mjs 自身の未捕捉の例外が 1（JVM の起動失敗）と混ざる。(5) サインオンの成否を「非表示の欄が無い」だけで見るので、切断された空の画面も成功と読む。(6)(7) S4a の前提が崩れたときに検出の判定へ進む／末尾の cut() の直後に同じ競合が残る。(8) コメントが参照する QPWDLVL 2/3 の記述が README に無い。いずれも偽の合格にはならない細部。出典は 20260919-backlog-acs-triage の review.md ラウンド 3（出典: .aidev/works/20260919-backlog-acs-triage/retro.md）
