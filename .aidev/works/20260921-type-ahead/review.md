# レビュー

## ラウンド 1（節目の独立点検・①〜③ をまとめて。差し戻し）

別コンテキストのエージェントに ①〜③ の差分と相互作用を読ませた。③に関わる指摘と対応:

- [must][conv:-] `EmulatorPane.vue` — 溜めがペインのローカル状態で、タブの切り替えで使い回されたペインから別のセッションへ再生・送信された / 対応: 溜めを `SessionState.typeAhead` へ移した（D8）。テスト 1 件
- [must][conv:-] `EmulatorPane.vue` `replayTypeAhead` — 分割したペインの他方にフォーカスがあると、合成 keydown がペイン自身に届いて保護領域エラーに化け、AID は握り潰された / 対応: このペインがフォーカスを持つまで流さない（D7）。テスト 1 件
- [must][conv:verify-by-mutation] `EmulatorPane.vue` `replayTypeAhead` — 同期ループで流したので、0020 の待ちを外す監視・エラーへ入る監視・Erase Input の着地（次の tick）が反映されなかった。テストは 0020・エラー状態と再生の組み合わせを試していなかった / 対応: 1 キーごとに `await nextTick()`（D9）。テスト 2 件
- [should][conv:verify-by-mutation] `EmulatorPane.vue` `onFkeyAid` — 溜めの分岐に実際の UI から到達できず、テストは `$emit` で空振りしていた / 対応: 分岐とテストを撤去（D10）
- [should][conv:-] 解錠から `setTimeout(0)` の再生までの隙間の打鍵が溜めを追い越しうる / 対応: 溜めが残る間は生の打鍵も後ろへ積む（D9）。テスト 1 件
- [should][conv:-] 予約が途中で始まっても溜めを捨てなかった / 対応: `setReserved` で捨てる（D8）。テスト 1 件
- [nit][conv:-] `help` の分岐で `leftCtrlAlone` を下ろしていなかった / 対応: 下ろした
- [nit][conv:-] キー一覧（パレット）は capture を通らず、施錠中は捨てられた / 対応: `onPaletteKey` で溜める。テスト 1 件

## ラウンド 2（通過）

対応後の差分を主エージェントが点検。**指摘なし**。mutation N1〜N10 で、N10（冗長な条件。外した）以外はすべて検出。
