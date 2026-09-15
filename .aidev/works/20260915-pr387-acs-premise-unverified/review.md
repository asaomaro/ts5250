# レビュー: `PR#387` の ACS 前提が未検証だったことへの対応

## タスク点検ログ

- [should][conv:comment-provenance!] T1: `session.ts` の `!cursorSet` 分岐内、
  撤去理由コメント末尾の「`decisions.md` 参照」が D 番号を欠いていた
  （同じ diff 内の `buffer.ts` 側は `decisions.md` D2 と明示済みで、
  一貫していなかった） — 対応: `decisions.md` D2 を明示する形に修正。
- [nit][conv:comment-provenance!] T1: 同じ if 節内、「PR 本文の確認チェックリスト
  も未チェックのまま残っていた（`research.md` F1・F2）」が work パスを省略して
  おり、`session.ts` 内に既にある別 work 由来の無印 `research.md F7`
  （`sendAid()` 内、20260914-seu-page-cursor-hold 由来）と紛れうる状態だった
  — 対応: `.aidev/works/20260915-pr387-acs-premise-unverified research.md
  F1・F2` と work パスを明示する形に修正。
- T1: 上記以外（`PR#387` 分岐の完全削除、`cursorBefore`/`cursorBeforeWasEnterable`
  の完全削除、`opts.cursor` 同期コメントの整合性）は問題なし
  （`aidev taskcheck report T1 --findings 2`）。
- [nit][conv:comment-provenance!] T2: `buffer.ts` の撤去理由コメントが
  「decisions.md 参照」とD番号を欠いていた — 対応: `decisions.md` D2 を
  明示する形に修正（`aidev taskcheck report T2 --findings 1`）。
- T3: 指摘なし（`aidev taskcheck report T3 --findings 0`）。4テストの期待値・
  discrimination（`git stash` による再現）・ファイル冒頭 docblock の事実
  引用（`c82e2b34`・`research.md` F1〜F3 の内容）を実物と照合し、いずれも
  一致することを確認済み。
- [nit][conv:comment-provenance!] T4: `cursor-default.test.ts` の撤去理由
  コメントが「decisions.md 参照」とD番号を欠いていた（該当は D1）
  — 対応: `decisions.md` D1 を明示する形に修正
  （`aidev taskcheck report T4 --findings 1`）。T4 の主目的（既存テスト実行）
  自体は green を確認済み。
- [should][conv:comment-provenance!] cross（T1〜T4 横断）: `packages/tn5250/test/
  sendaid-cursor-sync.test.ts`（本 work の対象外だった別ファイル）のヘッダ
  docblock とインラインコメントが、削除済みの `cursorBefore`・`PR#387` 分岐を
  「既存の（現在も存在する）」ものとして現在形で言及し続けていた——本 work の
  4タスクいずれの対象にも入っていなかったため見落としていた
  — 対応: 該当2箇所を過去形に修正し、`.aidev/works/
  20260915-pr387-acs-premise-unverified` decisions.md D2 への参照を追加した
  （`aidev taskcheck report cross --findings 1`）。

## レビュー指摘（ラウンド1）

- [should][conv:comment-provenance!] `session.ts` の `sendAid()` コメントが
  「Attn/SysReq は応答を待たずに `this.snapshot()` を返すため同期が要る」
  という主張の出所を `20260914-seu-page-cursor-hold decisions.md D5` として
  いたが、D5 の実際の記述はこの理由付けを含んでおらず、根拠を確かめずに
  書いた出所参照だった。また理由付け自体も不完全——`sendAndWait()` の
  タイムアウト分岐も同様に応答を処理せずに `this.snapshot()` を返すため、
  Attn/SysReq に限らない
  — 根拠: `packages/tn5250/src/session/session.ts:337-347`
  — 対応: コメントを訂正し、(1) Attn/SysReq の即時 return、(2)
  `sendAndWait()` のタイムアウト分岐、という2つの独立した理由を正確に記述。
  D5 に無い記述であることも明示した。
- [should][conv:-] 上記の帰結として、`packages/tn5250/test/
  sendaid-cursor-sync.test.ts` の既存2テスト（PageDown/PageUp）が、`PR#387`
  分岐撤去後は同期処理の discrimination になっていなかった（同期を無効化
  しても green のまま）。該当する条項（`.aidev/conventions/`）は無いため
  `conv:-`
  — 根拠: `packages/tn5250/test/sendaid-cursor-sync.test.ts:139-175`（実測確認）
  — 対応: ファイル冒頭 docblock と該当テストのコメントで「もう discrimination
  になっていない」ことを明示し、新規テスト（「Attn は応答を待たず、直後の
  snapshot に opts.cursor をそのまま反映する」）を `DeferredTransport` を使って
  追加した。同期処理を一時的に無効化して実際に失敗すること（discrimination）を
  確認済み。

指摘は上記2件（must=0, should=2, nit=0）。両方ともその場で対応済み。
