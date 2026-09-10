# レビュー記録

## タスク点検ログ（coding 工程内・`protocol.md`「3.3」(b)）

- [must][conv:-] `packages/web-ui/src/session-controller.ts:443` 繋ぎ直しで差し替えた口が `markRaw` されず
  リアクティブプロキシになるため、口の同一性比較が必ず偽になる（design D-a のとおりガードを差し替えても
  追加した 4 件が赤のままであることを点検役が実測）/ 対応: タスク T9 を追加（T1・ラウンド1。decisions D7）
- [should][conv:-] `packages/web-ui/test/session-reconnect.test.ts` の `error` の assertion が
  `toBeDefined()` で、同じ `it` の 3 つ前に送った `pc-command` が立てた通知でも緑になる
  / 対応: 修正済（`wsErrorNotice` の戻り値と突き合わせる。T1・ラウンド1）
- [should][conv:paired-artifact-sync] `packages/web-ui/src/session-controller.ts:493` 対の片側（`onClose`）が
  未固定——同じ根で成功後は必ず偽になり、成功 → 再切断ではしごが回らない / 対応: T9 で固定する（T1・ラウンド1）
- [nit][conv:-] `packages/web-ui/test/session-reconnect.test.ts` の俯瞰コメントが helper の JSDoc の直上に
  重なり、`reconnected()` の責務説明として読める（AGENTS.md「コメントの残し方」は俯瞰＝セクション冒頭、
  責務＝JSDoc と定める）/ 対応: 修正済（セクション見出しの形に変更。T1・ラウンド1）
- [nit][conv:comment-provenance] テストのコメントが名指しする `acceptsFrame` は、この時点でソースに実体が無く
  design.md にしか存在しない / 対応: T2 実装後に名前を突き合わせる（T1・ラウンド1）
- [nit][conv:comment-provenance] design.md の数え（「全 576 行で `type: "screen"` は 1 か所」）が T1 の追加で
  再現しなくなる / 対応: 修正済（数の出所に HEAD `657ad59b` を添えた。T1・ラウンド1）
- [must][conv:comment-provenance!] `packages/web-ui/test/session-reconnect.test.ts` の新テストが素の `D7` で
  前 work `20260908-session-survives-disconnect` の**実在する別の D7** に解決されてしまう
  / 対応: 修正済（work 名を明示。T9・ラウンド1）
- [should][conv:comment-provenance!] `packages/web-ui/src/stores/sessions.ts` の `setClient` の注記が
  「共通ガードも口の同一性で答える」と書くが、現物では口の同一性を見ているのは `onClose` の 1 か所だけ
  （共通ガードは `isCurrentAttempt` 単独で、成功後に偽になるのは別原因）/ 対応: 修正済（`onClose` に限定。T9・ラウンド1）
- [nit][conv:paired-artifact-sync] 同注記の「`markRaw` をここに閉じる」に対し、`add()` にも `markRaw` が残る
  （`add` は `byId.set` の前に掛けるので `setClient` を経由できない）/ 対応: 修正済（「store に閉じる
  ——生成は `add`・差し替えはここ」に改めた。T9・ラウンド1）
- [should][conv:comment-provenance!] `packages/web-ui/src/session-link.ts` の新注記の「前 work」が、同じファイルの
  既存の「前 work」（`20260908-session-survives-disconnect`）と別の work を指す。両 work に別内容の D13 がある
  / 対応: 修正済（「同 work は」に改め、直前の work 名に係るようにした。T2・ラウンド1）
- [should][conv:paired-artifact-sync] `isSessionClient` は参照の同一性で答えるので store の `markRaw` に
  乗っているが、その前提が注記に無い（外れると必ず偽になり静かに壊れる）/ 対応: 修正済（前提と、
  Vue を知らないので `toRaw` を置けないことを明記。T2・ラウンド1）
- [nit][conv:comment-provenance] 「下の `acceptsFrame` と `Attempt` の注記」の `Attempt` は同ファイルの上にある
  / 対応: 修正済（「上の `Attempt` と下の `acceptsFrame`」。T2・ラウンド1）
- [nit][conv:-] 「退役した口でも真を返しうる」の「退役」が、同ファイルの他の 2 か所（成功した試行の退役）と
  語義が衝突し、逆の意味に読める / 対応: 修正済（「切れたばかりの口」に言い換え。T2・ラウンド1）
- [nit][conv:paired-artifact-sync] 「生の口比較 0 件」が注記だけを根拠にしており、再び書かれても落ちない
  （同じ封じ込めは走査テストが守っている。web-ui は lint が効かない）/ 対応: 修正済（`lifetime-flag-containment.test.ts`
  に走査を 1 件追加し、変異で赤化を実測。T4・ラウンド1。decisions D9）
- [should][conv:comment-provenance!] `packages/web-ui/src/session-link.ts` の `Attempt` の docstring が
  `onClose` を「繋ぎ直しを回し直す**唯一の**経路」と書くが、`startReconnect` の呼び手は 3 か所
  （`tryResume` の `onClose` / `openSession` の `onClose` / 利用者が押し直す `retryReconnect`）
  / 対応: 修正済（「切れたことを機に自動で回し直す唯一の経路」に限定し、他 2 つを数え上げた。T5・ラウンド1）
- [nit][conv:comment-provenance] 同 docstring に 2 work の参照が並んだのに `research.md` F4 だけ無修飾
  / 対応: 修正済（`20260908-session-lifetime-rules-fold` の、と明示。T5・ラウンド1）
- [nit][conv:paired-artifact-sync] backlog `session-lifecycle.md` の当該行が「docstring が**欠けている事実**を
  記している」と書いており、過去形に直した現物と食い違う / 対応: deliver の消し込みで併せて直す（T5・ラウンド1）
- [should][conv:comment-provenance!] `packages/web-ui/src/stores/sessions.ts` の書き直した注記の
  「弾かれない組合せが**1 つだけ**残る」が数え漏らし。第 2 項が真である限り `link` が `connected` でない
  間ずっと同じ差が出る（諦めた後・はしごに入らない場合も含む）/ 対応: 修正済（単位を数え直した。
  T6・ラウンド1。decisions D10 に D5 の訂正として記録）
- [nit][conv:comment-provenance!] 「到達には閉じたソケットへの配送が要る」で言い切れない枝がある
  （ホスト終了は `markLost` するだけで口を閉じない）/ 対応: 修正済（根拠が 2 系統あることを明記。T6・ラウンド1）
- [nit][conv:comment-provenance] 「ガードを持たない初回接続の口」だけ名前で指されておらず確かめにいけない
  / 対応: 修正済（`openSession` の `onServerMessage` の `default:` 枝、と明示。T6・ラウンド1）

## タスクをまたぐ点検（cross・1 回）

- [must][conv:comment-provenance!] `packages/web-ui/src/session-controller.ts` の `opened` 枝の注記
  「**他の 2 経路と同じガードを置く**」が T3 の差し替えで偽になり、`acceptsFrame` の注記
  （「`opened` の枝では使わない」）と正面から食い違う。次に読む人が 3 経路を 1 つの述語に寄せる根拠になる
  / 対応: 修正済（問いが違うこと・寄せると成功処理が二重に走ることを明記。cross・ラウンド1）
- [should][conv:paired-artifact-sync!] design.md の 3 つの断定が実装で覆ったのに古いまま
  （`stores/sessions.ts` は注記のみ / 走査の規則は変えない / AC5 は真偽が変わらない）
  / 対応: 修正済（3 か所に訂正を明記し、decisions D7・D8・D9 と cross 点検へ紐づけた。cross・ラウンド1）
- [should][conv:comment-provenance!] `updateScreen` の注記と decisions D10 が 3270・プリンターを
  数え入れているが、両者は `not-resumable` で `tryResume` の口を持たないためこのガードは評価されない
  / 対応: 修正済（注記を 3 つの単位に直し、decisions D11 に数え直しを記録。cross・ラウンド1）
- [should][conv:comment-provenance!] 本 work が別 work の修飾付き参照を同じファイルに入れたことで、
  既存の素の参照（`前 work の D4 / D13` / `decisions.md D10` / `review ラウンド3`）が解決不能になった
  / 対応: 修正済（src 2 ファイル・test 1 ファイルの計 5 か所に work 名を補った。cross・ラウンド1）
- [should][conv:paired-artifact-sync] 「口の代入は store の 2 か所だけ」が機械で固定されていない
  （兄弟の `.link =` は固定済み。D9 は比較だけを固定して代入を残した）
  / 対応: 修正済（走査を 1 件追加し、変異で赤化を実測。cross・ラウンド1）
- [should][conv:paired-artifact-sync] `acceptsFrame` の**第 1 項に対応するテストが無い**——
  片項へ縮めても回帰が緑のままで、R4 の合成そのものが守られていない
  / 対応: 修正済（`test/session-link.test.ts` を新設し真理値表を固定。第 1 項を落とす変異で赤化を実測。cross・ラウンド1）
- [nit][conv:paired-artifact-sync] D9 の走査は `.client` が比較の左に来る形しか見ない
  / 対応: 修正済（網羅ではなく「再発しやすい形の禁止」であることを注記。cross・ラウンド1）

## ラウンド 1（2026-09-10T08:42:54Z）

- [must][conv:-] `packages/web-ui/src/session-controller.ts` の共通ガードの**第 2 項が、はしごの最中に
  穴を開け直す**。`setClient` は成功時にしか呼ばれないので、はしごが回っている間 `s.client` は
  **前回成功した（いま死にかけの）口**を指したまま＝第 2 項が真。そこへその口からフレームが届くと
  `updateScreen` が `applyLink({to:"connected"})` を打ち、**はしごの最中に「繋がっている」へ戻る**。
  以後 `canSendToHost` は ok を返し、次の打鍵は非 OPEN のソケットへ落ちて黙殺され、
  `setBusy(true)` だけが残って**スピナーが張り付く**——本 work が直したのと同じ症状。
  **配送は実在する**: `ws-client.ts` の `armPingWatchdog` は `ws.close()` のあと
  `closeFallback` タイマーで `notifyClosed` を撃つ（半開きで `close` が来ない場合の保険）ので、
  `onClose` が走った後も**ソケットは CLOSING のまま**で、`message` リスナには
  `readyState` の検査が無い。/ 対応: **coding へ差し戻し**（第 2 項を `link.state === "connected"` で
  門番する）
- [should][conv:comment-provenance!] 上と同じ根で、`decisions.md` D5 / D10 / D11 と
  `stores/sessions.ts` の `updateScreen` の注記が挙げる到達根拠
  （「閉じたソケットには配送されない」「サーバーがもう送らない」）が **CLOSING のソケットからの配送を
  覆っていない**。「数え切ってから書く」が**3 度目**の破れ。/ 対応: 差し戻しの修正とあわせて書き直す
- [should][conv:-] `requirements.md` の背景が「タブを開き直す以外に復帰の手が無く、そのとき
  打ちかけの入力（`edits`）は失われる」と書いており、**PR 本文で「打ちかけの入力が守られる」と
  読める**。実際は繋ぎ直しでも `updateScreen` が `edits` を消す（`session-reconnect.test.ts` が
  「設計の当初は残すとしていたが…」として仕様に固定済み）/ 対応: 修正済（文書のみ・コード変更なし。
  本 work が取り戻すのは**セッションの継続と画面の追従**であることを明記）
- [nit][conv:paired-artifact-sync] 代入の走査（`lifetime-flag-containment.test.ts`）が
  `sessionsStore.get(id)!.client = client` を素通りする——正規表現が `.client` の直前に
  識別子しか許さないので、`!` が挟まると外れる。**D7 のバグを最も自然に再導入する形**がこれ
  / 対応: 差し戻しの修正とあわせて直す

## タスク点検ログ（続き・review ラウンド1 の差し戻し後）

- [should][conv:comment-provenance!] T10 が入れた素の「review ラウンド1」が、同じファイル内の
  **別 work のラウンド参照**と衝突する（`session-link.ts` の既存記述は fold work の、
  `session-reconnect.test.ts` の既存記述は survives-disconnect の各ラウンドを指す）。
  cross 点検が同じ形を 5 か所直した**直後の再発** / 対応: 修正済（3 か所に work 名を補った。T10・ラウンド1）
- [should][conv:paired-artifact-sync!] 覆された到達根拠が `session-controller.ts` の `opened` 枝の注記に
  残り、同じタスクが書いた注記と正面から食い違う（あちらは「閉じたソケットには配送されない」、
  こちらは「配送は実在する」）。review ラウンド1 の should は `decisions.md` と `updateScreen` しか
  名指ししておらず、**対のもう片方に当たっていなかった**
  / 対応: 修正済（`abortReconnect` も `close()` するだけで CLOSING であること、届いても
  `isCurrentAttempt` が弾く＝ガードが効いているのであって配送が来ないのではない、と書き直し。T10・ラウンド1）
- [should][conv:comment-provenance!] 「畳み込み前の実装（判定が `isCurrentAttempt` 単独だった頃）」が
  年代の取り違え——`isCurrentAttempt` は畳み込みで**新設**された述語で、畳み込み前のガードは
  `pendingResumes` との突き合わせ / 対応: 修正済（現物を引く出所つきに。T10・ラウンド1）
- [nit][conv:comment-provenance!] 「残るのは 1 つだけ: 代表の試行から `opened` より前に `screen` が
  来る場合」が数え漏らし——`updateScreen` へ入る枝は `screen` と `key-done` の 2 つ
  / 対応: 修正済（2 つとも数えた。T10・ラウンド1）

## ラウンド 2（2026-09-10T09:13:13Z）

- [must][conv:-] **初回接続の口にはガードが無く、1 回目のはしごが無防備**。
  `openSession` の `onServerMessage` は `default:` と（`sessionId` 確定後の）`error` を
  素通しで `applyDisplayMessage` に渡す。**1 回目のはしごを駆動するのは必ずこの口**なので、
  T10 で塞いだのと同じ経路——見張りが `ws.close()` の後に保険タイマーで `onClose` を撃ち、
  CLOSING のソケットから遅れて `screen` が届く——で `updateScreen` が「繋がっている」へ戻す。
  OIA は繋がった顔になり、次の打鍵は非 OPEN のソケットへ落ちて黙殺され、待ちが張り付く。
  **`requirements.md` はこの経路を対象外にしていたが、その理由（「あちらはガードを持たず
  現に正しく動いている」）は本 work の調査で覆っている。** / 対応: **coding へ差し戻し**
  （第 2 項を `acceptsFromSession` として切り出し、初回の口にも当てる）
- [should][conv:-] 上に伴い `requirements.md` の「対象外」と `stores/sessions.ts` の注記
  （「ガードを持たない初回接続の口も最初から同じものを負っている」）が実態と合わなくなる
  / 対応: 差し戻しの修正とあわせて書き直す

**ラウンド 1 の指摘の解消**（再掲ではなく状態の記録）: must 1 件（第 2 項の穴）は T10 で解消し、
独立点検が門そのものに指摘なしと確認。should 2 件・nit 1 件も解消済み。

## タスク点検ログ（続き・review ラウンド2 の差し戻し後）

- [must][conv:-] `applyFromSessionClient` を挿入したことで **`applyDisplayMessage` の JSDoc が宙に浮いた**
  （旧ヘッダが新関数の責務説明として読める。しかも「開く前の `error` はここに入れない」が
  新関数とは食い違う）/ 対応: 修正済（新関数を `applyDisplayMessage` の後ろへ移し、ヘッダの隣接を戻した。
  T11・ラウンド1）。**backlog `code-quality-checks.md` が「機械で検知したい」と起票している形を自分で踏んだ**
- [should][conv:-] 旧ヘッダの「（`sessionId` が未確定のうちにも呼ばれうる）」が本タスクで偽になった
  （呼び手 2 つとも先に「受け取ってよい口か」を確かめる）/ 対応: 修正済（呼び手を数え上げる形に。T11・ラウンド1）
- [should][conv:paired-artifact-sync] 門を当てた 2 か所のうち **`error` 枝がテストで固定されていない**
  / 対応: 修正済（通す側と落とす側の両方を 1 件で見るテストを追加。T11・ラウンド1）
- [should][conv:paired-artifact-sync!] **対の `onClose` の片側だけが述語化された**。同じ id で開き直すと
  口が差し替わり、古い口の `close` で健全な口を抱えたままはしごが始まる。**門が付いた今、この経路は
  「画面が追従して隠れる」から「画面が固まる」側へ倒れる**（本 work が作った退行）
  / 対応: 修正済（`openSession` の `onClose` にも同じ述語。変異で赤化を実測。T11・ラウンド1。decisions D14）
- [nit][conv:paired-artifact-sync] CLOSING 配送の説明が 6 か所に複製されている（1 か所が更新されると
  残りが黙って古くなる。本 work は既に同型を 1 件踏んでいる）/ 対応: 修正済（規則側の
  `acceptsFrame` の注記 1 か所に寄せ、他は参照に。T11・ラウンド1）

## タスク点検ログ（続き・T11 ラウンド2）

- [should][conv:paired-artifact-sync!] D12 / D13 / D14 が**対の計画資産に反映されていない**
  （design.md の対象範囲・コード片・振る舞い表の 2 行、tasks.md の T11 の対象）。
  この work 自身が D7・D8・D9 では「coding で訂正」を入れているのに、そこだけ漏れていた
  / 対応: 修正済（design.md 4 か所・tasks.md 1 か所を同期。T11・ラウンド2）
- [should][conv:comment-provenance!] 素の「（decisions D12）」が、本 work が同じファイルに入れた
  別 work の D12（猶予 90 秒）と衝突する。cross 点検の「素の参照 5 か所を直した」が数え切れていなかった
  / 対応: 修正済（`session-controller.ts` 3 か所・`session-link.ts` 2 か所・テスト 1 か所を修飾。T11・ラウンド2）
- [should][conv:paired-artifact-sync!] **D14 の門が当たったのは `onClose` 4 つのうち 2 つ**——
  VT とプリンターにも同型の欠陥がある（同じ id で開き直すと健全なセッションが `markLost` される）
  / 対応: 数えを訂正し（decisions D15）、**backlog へ起票**。本 work では直さない
  （本 work の門を通らず悪化していないため）。T11・ラウンド2
- [should][conv:paired-artifact-sync] **`tryResume` の `onClose` の門はテストで固定できない**——
  その門だけを外しても 37 件が緑のまま（実測）。先の `resumeVerdict` の `running` が効いているため
  / 対応: 保険であることをコードとテストの注記に残した（`isCurrentAttempt` の `!a.settled` と同じ扱い）。
  **作り話のテストは足さない**。T11・ラウンド2
- [nit][conv:comment-provenance!] 無修飾の work をまたぐ参照がまだ残る（`前 work の D3` / `D11` /
  `decisions.md D17` / 素の「review ラウンド1」）/ 対応: 修正済（本 work が触った 3 ファイルの
  6 か所。他ファイルの既存分は本 work が曖昧にしたものではないので触らない。T11・ラウンド2）

## ラウンド 3（2026-09-10T11:15:32Z）

- [should][conv:-] **`closed{ended:true}` が門で落ちうる**——本 work の門が生んだ狭い退行。
  `closed` は表示の更新ではなく**寿命の信号**で、サーバーは `closed{ended:true}` を送っても
  WS を閉じない。心拍が `PING_DEAD_MS` を超えて滞ると見張りが `onClose` を撃ってはしごに入り、
  そのあと本物のホスト終了が **CLOSING のソケット**に届いて `link` が `connected` でないため落ちる。
  `hostEnded` が記録されないので `resumeVerdict` ははしごを短絡できず、`canSendToHost` も
  `MSG_SESSION_ENDED` を出せない——利用者ははしごを待たされた末に汎用の文言を見る。
  / 対応: **coding へ差し戻し**（`closed` は `link` の状態を問わず口の同一性だけで通す）
- [nit][conv:-] `openSession` の Promise が settle しないまま残る経路がある（`opened` / `error` の
  どちらも来ずに閉じた場合。`connect()` は既に解決済みなので `rejectConnect` は no-op）。
  **本 work とは独立の既存欠陥**だが、レビュー対象のハンクの中に在る / 対応: backlog へ起票
- [nit][conv:paired-artifact-sync] VT とプリンターの `onClose` に同じ門が無い
  / 対応: **本 work の diff で既に backlog へ起票済み**（decisions D15）。据え置きは意図的な判断であり
  見落としではない、とレビュー側も明記

**ラウンド 2 の指摘の解消**: must 1 件（初回接続の口）は T11 で解消し、独立点検 2 ラウンドで検証済み。
should 1 件（文書の同期）も解消。

### ラウンド 3 の決着（デバッグ D1 を経て）

差し戻し 3 回目＝上限のため `aidev debug start` でまっさらなコンテキストへ原因究明を委譲した。
結果、**提案されていた直し方は単独では無効**（`beginReconnect` が次の段で `hostEnded` を上書きするため、
最終状態・文言・ボタンが 1 つも変わらない。実測）。効かせるには「はしごを畳む」修正が対で要るが、
そちらは HEAD から在る欠陥で本 work の退行ではない。

**決定**: どちらも入れず、対にして backlog へ起票（`decisions.md` D16）。
**残した退行は観測可能ではない**——`closed` が落ちても落ちなくても利用者から見た結果は同じ。
残り 2 件（nit）も backlog へ起票済み。**コードは変更していないので coding / test の承認は有効なまま。**
