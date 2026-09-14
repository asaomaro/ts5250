# 振り返り: ホスト終了がはしごの最中に届くと取りこぼすのを直す

## サマリ

前 work `20260910-session-reconnect-freeze` の review ラウンド3 ＋ デバッグ D1 が発見した
「繋ぎ直しのはしごが走っている間はホスト終了の `closed{ended:true}` が `connected` の門で落ちる」
を、(1) `closed{ended:true}` だけ門を外す新述語 `acceptsLifetimeSignal` と、(2) `hostEnded` 確定時に
はしごを畳む `abortReconnect` 呼び出しの対で解消した。review 3 ラウンド（should 4 件・must 1 件、
いずれも解消）を経て deliver 承認済み（PR #394、未マージ）。テストは 5685 → 5697（+12 件、
0 failed / 41 skipped）。AC1〜AC9 すべて pass。backlog `session-lifecycle.md` の該当行は本 work で
`[x]` 済み。

## うまくいった点

- **characterization を先に書く順序が守られた**（T1 → T2〜T5）。AC9 が求める「修正前に落ちる」ことを
  実行で確認してから直しており、test-result.md に赤→緑の実測が残っている。
- **主張を実行で裏取りする姿勢が一貫していた**: AC4/AC6 は変異（述語を縮める／`abortReconnect` を外す）
  で赤化を確認、唯一の failed テスト（`tab-visibility.test.ts`）も `git stash` でベースラインと突き合わせ、
  本 work と無関係な既存フレークだと実行で示した（narrative だけで済ませていない）。
- **cross 点検が、この work 自身が作った穴（新設した合成述語 `acceptsLifetimeSignal` の第1項に
  対応するテストが無い）を、人間/PR レビューに出る前に捕まえた**。ただしこれは前 work
  `20260910-session-reconnect-freeze` の `acceptsFrame` でも起きた欠落の再発であり、
  「捕まえられた」ことと「2 回連続で起きた」ことは分けて評価する必要がある（下記「課題」）。
- design が却下案を理由付きで列挙し、変更を D-a/D-b/D-c の 3 箇所（同一ファイルの追記）に閉じた。
  `applyDisplayMessage` の switch 構造自体には触れず、スコープが最後まで広がらなかった。

## 課題 / 手戻り

- **round2 の must（transport 起因の `closed` が確定済みの notice を消す）**: 初期の D-a/D-b は
  `closed`（`ended` の有無を問わず）を丸ごと `connected` の門から外す設計だった。これは
  「はしごを使い切って `MSG_RECONNECT_GAVE_UP` が確定したあと、同じ口から遅れて届く
  transport 起因の `closed{ended:false}` が門を通り、`delete s.notice` が無条件に走って
  確定済みの文言を黙って消す」という退行を生んだ。design の doc-check は 2 ラウンド・9 件の指摘を
  出したが、この論点には触れておらず、埋め込みレビュー（round2）まで見つからなかった。
  design.md の真理値表は「新しく通る条件」の行は列挙していたが、**「既に終端状態
  （`lost/gaveUp` 等）に確定したあとに、同じ口から別の意味の `closed` が来る」行は無かった**——
  終端状態への言及自体が真理値表の軸に入っていなかった。上流で防げた可能性がある論点。
- **合成述語の項カバレッジ欠落が 2 works 連続で再発した**: 前 work `20260910-session-reconnect-freeze`
  では `acceptsFrame` の第1項（`isCurrentAttempt`）に対応する単独テストが無く、片項に縮めても
  全回帰が緑のままだった（cross 点検の should）。本 work でも新設した `acceptsLifetimeSignal` の
  第1項で**まったく同じ形**が起き、しかも重大度が should → must に上がった。どちらも
  タスク単位の点検・design の doc-check は素通りし、cross 点検（工程の最後）でしか捕まっていない。
  → 「PJ プロセス / 規約」で新規条項として起票する（下記）。
- **`comment-provenance` 条項が、この 1 work の中で 3 回破られた**（`[conv:comment-provenance!]`。
  T4/ラウンド1 の docstring 参照、ラウンド1 の `tryResume` 側コメント参照、ラウンド1 の
  `case "closed"` コメント参照。いずれも「work 名を伴わない裸の参照」という同じ形）。
  条項は `pending`（`aidev convention status`: pop=2、判定に必要な母集団 5 件にまだ未達）で、
  効果判定は本 retro の範囲外（`aidev-util-insights` が行う）。**id 付きの指摘が繰り返し出ている
  ケースなので、ここで新規条項は起こさない**——起こしても「規約はあるのに守られていない」に
  対して追記が積み上がるだけで効かない可能性がある。母集団が揃った時点で `ineffective` に
  倒れるなら、打ち手は追記ではなく層を下げること（CLI 検査 or フック）になる、という判断材料として
  この事実を残す。
- **`should` 1 件（T2 の docstring）**: `acceptsLifetimeSignal` の docstring の比喩の対比先が
  design.md の対称とずれていた（`isSessionClient`/`acceptsFromSession` を同格に並べていた）。
  1 件のみで再発パターンではないため、条項化はしない。
- **記録漏れ（review.md の round 見出し）**: review round2（transport 起因の `closed` が notice を
  消す must の発見・解消）に対応する **`## ラウンド 2` の見出しが review.md に無い**
  （ラウンド1・ラウンド3にはある）。round2 の内容は `decisions.md` D6・design.md のインライン訂正注記・
  **`test-result.md` 側の「## ラウンド 2（review ラウンド1の差し戻し後）」「## ラウンド 3
  （review ラウンド2の差し戻し後）」という対になる見出し**に分散して記録されており、
  test-result.md は review の 3 ラウンド構成を正しく写し取っているのに、review.md 自身にだけ
  round2 の独立節が無い（review.md「ラウンド 3」の文中に要約が埋め込まれているのみ）。
  `metrics.yml` 側でも、review の 2 回目の `event: start`（14:17:23）に対応する `sent_back` または
  `approved` の締めイベントが無いまま次の `review start`（14:46:12）に進んでいる——coding 側の
  再承認は `amend: yes`（`DESIGN.md` に定義済みの「同ラウンドの打ち直し」機構）として正しく記録されて
  いるが、review 側にはその対がない。aidev-60-review の SKILL.md は「must/should の指摘あり →
  `aidev event review sent_back` を記録のうえ差し戻す」と定めており、この回だけそれを経由していない
  可能性がある（`amend` 機構は coding 側の再承認を軽くするためのものであって、review 側の
  記録義務を免除する規定ではない）。→「ハーネス自体」で提案する。

## 改善提案

### 製品 / コード（→ issue 候補）

特になし。残った既知の欠陥（実機未検証・VT/プリンターの `onClose`・`openSession` の Promise
settle）はいずれも `backlog/session-lifecycle.md` に既存項目として起票済みで、本 work は
それらを増やしていない。本 work 自身の行は deliver で `[x]` 済み。

### PJ プロセス / 規約（→ `.aidev/conventions/` の条項。AGENTS.md 本体には書かない）

- **新規条項 `compound-predicate-coverage` を起こした**（本 retro が起票）。根拠: 新しい合成述語
  （`||`/`&&` で2判定以上を組み合わせる真偽関数）を追加したとき、各項を単独で通す／落とすテストを
  同じタスクの中で書かず、cross 点検まで発見が遅れる欠落が 2 works 連続（`20260910-session-reconnect-freeze`
  の `acceptsFrame` → 本 work の `acceptsLifetimeSignal`）で再発し、重大度も should → must へ悪化した。
  仮説・baseline は `.aidev/conventions/compound-predicate-coverage.md` を参照。
- **`comment-provenance` は条項化を見送った**（上記「課題」参照）。理由: 同じ id が本 work だけで
  3 回破られており、「規約はあるのに守られていない」パターンの可能性がある。新しい条項の追記では
  効かないおそれがあるため、ここでは新規起票を避け、母集団が揃ったときの `aidev-util-insights` の
  判定（`ineffective` なら層を下げる：CLI 検査か Stop フックへ寄せる）に委ねる観察として記録する。

### ハーネス自体（→ aidev-* への提案・適用は人間）

- **review round の記録が review.md 側だけ抜けうる**: 本 work の round2（must 1 件）は、
  `decisions.md`・design.md のインライン注記・test-result.md の対になる見出しには残っているが、
  review.md 自身の `## ラウンド 2` 見出しと、`metrics.yml` の対応する `review sent_back`（または
  ラウンド締めの）イベントが無い。`aidev doctor` または `aidev verify` に、
  「`review, event: start` の回数（`amend` による打ち直しを除く）と review.md の `## ラウンド N`
  見出しの数が一致するか」を突き合わせる検査を足すことを提案する。coding 側の再承認は
  `amend: yes` で正しく「同ラウンドの打ち直し」と記録される一方、review 側は `sent_back` を
  打たなくても次の `review start` で静かに上書きされてしまい、**round の記録漏れを機械が
  検知できない**のが根本原因。test-result.md 側は同じ 3 ラウンド構成を正しく書けているので、
  review.md 側だけの部分的な欠落であることは実測（この work の全成果物突き合わせ）で確認済み。
