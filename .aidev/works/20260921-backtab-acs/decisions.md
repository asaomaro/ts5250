# 決定記録

## D1: 過去の判断「Shift+Tab にはカーソル送りを効かせない（ACS で確かめられない）」を破棄する

- 背景: `EmulatorPane.vue` の `progressionStop` と `cursor-progression-nav.test.ts` が、tn5250 と tn5250j で割れていて ACS で確かめられないとして逆引きを入れていなかった。
- 決定: ACS の原典（`previousNonByPassInputFieldPos`）が逆引きを持つので入れる。前提（確かめられない）は ACS の原典を読めることで崩れた。取り消し線で残した。

## D2: 継続欄の最終区間からの Backtab は並びの先頭区間へ（既存テストの期待を変えた）

- 背景: `continued-field-tab.test.ts` は「最終区間から Shift+Tab すると並びの前の欄へ」を固定していた。
- 決定: ACS は先頭以外の区間を飛ばして並びの先頭区間の先頭で止まる（欄の途中と同じ扱い）。期待を書き換え、旧い見出しは取り消し線で残した。

## D3: 1,1 の Backtab は ACS のコアの例外に合わせない

- ACS（DBCS のセッション）は位置 −1 を調べて例外で止まる（research F2）。不具合なので写さず、SBCS のセッションの原典どおり最後の欄へ回り込む（従来の位置探索と同じ）。
