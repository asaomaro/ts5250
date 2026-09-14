# レビュー記録

## タスク点検ログ（coding 工程内・`protocol.md`「3.3」(b)）

- [ok] T1（characterization テスト 3 件）: 指摘なし
- [should][conv:comment-provenance] `packages/web-ui/src/session-link.ts` の
  `acceptsLifetimeSignal` の docstring が `decisions.md` を D 番号無しで引いていた
  / 対応: 修正済（`decisions.md D1` と明示。T2・ラウンド1）
- [should][conv:-] 同 docstring の比喩の対比先が design.md の対称とずれていた
  （`isSessionClient`/`acceptsFromSession` を同格に並べてしまっていた）
  / 対応: 修正済（`acceptsFrame → acceptsFromSession` の縮約に揃えた。T2・ラウンド1）
- [ok] T3（`tryResume` の closed 分岐）: 指摘なし
- [should][conv:comment-provenance!] `packages/web-ui/src/session-controller.ts` の
  `applyFromSessionClient` 内、`closed` 分岐コメントの「D-a の注記を参照」が work 名を伴わない
  裸の D 番号参照だった（対になる T3・T5 側は work 名を明記していた）
  / 対応: 修正済（work 名を明示。T4・ラウンド1）
- [ok] T5（`abortReconnect` の呼び出し）: 指摘なし

## タスクをまたぐ点検（cross・1 回）

- [must][conv:-] 新設した合成述語 `acceptsLifetimeSignal` の第 1 項（`isCurrentAttempt`）を
  単独で通すテストが無く、**片項に縮めても全 2038 件が緑のままだった**（実測）。
  前 work `20260910-session-reconnect-freeze` の cross 点検が `acceptsFrame` で見つけたのと
  **まったく同じ形の欠落の再発**
  / 対応: 修正済（`test/session-link.test.ts` に真理値表を 3 件追加。第 1 項を落とす変異で
  赤化を実測。cross・ラウンド1）

## ラウンド 1（2026-09-10T14:12:14Z）

- [should][conv:comment-provenance!] `packages/web-ui/src/session-controller.ts` の `case "closed"`
  に足した `abortReconnect` 呼び出しの注記が、`decisions.md` を D 番号無しで参照していた
  （T2 で同種の指摘を `session-link.ts` 側では直したが、T5 側のこの 1 箇所が漏れていた）。
  この行は design D-c どおりで逸脱が無いため、`decisions.md` に専用エントリは無く（D1 の背景節に
  一般論として触れているだけ）、参照は design.md D-c 単独にするのが正確
  / 対応: 修正済（`decisions.md` への参照を外し、design.md D-c のみを指す形に。review・ラウンド1）
- [ok] T1〜T7: すべて指摘なし（T4 のみ should 1 件・修正済。上記参照）
- [should][conv:comment-provenance!] `packages/web-ui/src/session-controller.ts` の
  `tryResume` 側の新規コメントが「review ラウンド2 の must」と work 名無しで参照し、
  同じファイルに別 work の「review ラウンド2」参照が併存する形になっていた
  / 対応: 修正済（work 名を明示。T8・ラウンド1）

## ラウンド 3（2026-09-10T15:01:27Z）

指摘なし。組み込みレビュー（`code-review high`）は指摘 0 件——検討した縁の事例
（`closed{ended:true}` が試行の見張りタイムアウト後に届くと 1 回分遅れる可能性）は
`acceptsFrame` が他の全種別に対して既に負っている同じトレードオフで、次の試行の
`error`/`closed` が最終的に正しい状態を出すため正確性の問題ではないと判断（自分でも
同じ結論に到達済み）。

**ラウンド 2 の must（transport 起因の closed が notice を消す）は T8 で解消**——
独立点検・変異検証・組み込みレビューの 3 経路で確認済み。

**承認**: must/should の指摘が無いため、この工程を終える。
