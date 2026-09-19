# セッションの寿命・接続状態まわり

- [x] 判定の置き場所を 1 か所に畳む（`20260908-session-survives-disconnect` デバッグ D1）。
      「持ち主が居るか」「猶予中か」「繋ぎ直しの対象か」「この試行はまだ有効か」の 4 規則が、
      独立フラグの組み合わせとして 12〜15 か所に散っている。レビューが 3 ラウンド続けて
      「直した項の隣が壊れる」を出した原因。**振る舞いを変えない差し替え**として行う:
      サーバー = `SessionManager.disposition()` / `lifetimeOf()`、
      クライアント = `SessionState.link` の判別可能 union / `resumable` / `sendToHost` /
      `isCurrentAttempt`。完了条件は既存の回帰テストが緑のまま、かつ
      判定に使うフラグの出現箇所が定義と導出関数の内側に限られること。
      **消し込み: `20260908-session-lifetime-rules-fold`。** 規則は依存ゼロの純粋モジュール 2 本に出した
      （`packages/server/src/session-lifetime.ts` = R1/R2、`packages/web-ui/src/session-link.ts` = R3/R4）。
      クライアントの導出は当初案の `resumable` / `sendToHost` ではなく **`resumeVerdict` / `canSendToHost`**
      になった（前者は review ラウンド1 の must で真偽 → 列挙に変えたため。`decisions.md` D21）。
      サーバーの `lifetimeOf` は純粋側の関数として在り、`SessionManager` 側は `idleLimitOf` のまま
      （改名は見送り。D20-3 で理由を記録）。
      **実測**: `holderToken` 14→0 / `hadHolder` 5→0 / `heldUntil` 10→0 / `attached` 4→0、
      クライアント側 4 フラグ＋2 Map 21→0（`packages/*/test/lifetime-flag-containment.test.ts` が固定）。
      回帰テストは 5664 passed / 0 failed / 41 skipped（ベースライン 5560＋新規 104）。
- [x] 端末種別 × 切れ方 × viewer × 持ち主の全組合せを 1 つの表にし、サーバー・クライアント
      双方をその表から回す（上の畳み込みと同時にやると効果が出る）
      **消し込み: `20260908-session-lifetime-rules-fold`。**
      `packages/web-ui/test/session-lifetime-matrix.ts` に 1 つの表（サーバー 64 行 / クライアント 20 行 /
      門の順序 2 行）。両側の `session-lifetime-matrix.test.ts` がここから回り、`clientViewOf()` の射影で
      両向きに突き合わせる（片側にしか無い行が生まれたら落ちる）。
      **期待値は畳み込みの前に HEAD `90f5636f` の実装から採取**した。
- [x] **繋ぎ直しに成功したあと画面が固まる**（`20260908-session-lifetime-rules-fold` の `decisions.md` D13）。
      `packages/web-ui/src/session-controller.ts` のメッセージ共通ガードが `isCurrentAttempt` だけを見るため、
      成功時に試行を退役させた瞬間から**以後の全フレームが落ちる**（`screen` / `key-done` / `reserved` /
      `pc-command` / `jobinfo` / `closed` / `error`）。利用者から見ると「再接続したのに画面が更新されず、
      応答待ちの覆いとスピナーが永久に残る」。**HEAD `90f5636f` でも再現する**ので畳み込み由来ではない
      （旧 `pendingResumes.get(id)?.client !== client` も同じ効果）。畳み込み work では
      「振る舞いを変えない」制約のため意図的に直していない。
      **直し方の当たり**: ガードに「この口がいま現役か」（`sessionsStore.get(id)?.client === client`）を足す
      ——`session-link.ts` の `Attempt` の docstring が、この項を畳まなかった理由と欠けている事実を記している。
      **直すときの注意**: ガードを緩めると `stores/sessions.ts` の `updateScreen` の遷移が広がった件の
      「到達しない」根拠を検査し直す必要がある。深刻度は高い。
      **消し込み: `20260910-session-reconnect-freeze`。** 判定を R4 の内側に置き直した——
      `packages/web-ui/src/session-link.ts:240` `isSessionClient`（セッションがいま抱えている口か）と
      `:266` `acceptsFrame`（＝`isCurrentAttempt || acceptsFromSession`）。共通ガードは
      `packages/web-ui/src/session-controller.ts:504` でこれを呼ぶだけ。
      **当たりの「この口がいま現役か」を素朴に足すだけでは足りなかった**——
      (1) 差し替えた口が `markRaw` されずリアクティブプロキシになり同一性が壊れていた
      （`stores/sessions.ts:374` `setClient` に閉じた。**成功 → 再切断ではしごが二度と回らない**という
      2 つ目の欠陥がここで判明）、(2) 第 2 項には `link.state === "connected"` の門が要る
      （無いとはしごの最中に死にかけの口で「繋がっている」へ戻る）、(3) 初回接続の口にも同じ門が要る
      （`session-controller.ts:651` `applyFromSessionClient`）。詳細は同 work の `decisions.md` D7・D12・D13。
      **「到達しない」根拠の検査し直しも完了**（`stores/sessions.ts` の `updateScreen` の注記を書き直した）。
      **実測**: テスト 5664 → 5685（+21 件、0 failed / 41 skipped）。変異で 8 件の赤化を確認。
      **残した穴 3 つはこのファイルと下に起票済み**（`closed` の取りこぼし・VT/プリンターの `onClose`・
      `openSession` の Promise）。**実機は未検証。**
- [ ] **同一ファイル内の判定の写しを CI が検知できない**（同 work の `decisions.md` D19 / design「AC2 の詳細」）。
      走査テストは `session-manager.ts` を丸ごと「内側」に置くので、同じ規則の答えをファイル内で
      組み立て直しても落ちない。実際 R1 / R2 の写し 2 件を見つけたのは CI ではなく `cross` 点検だった。
      「写しが増えたら CI が落ちる」（US3）がここだけ成立していない。
      走査の粒度を上げるか、規則を読む口をファイル外から呼ぶ形に変えるかの検討。
      あわせて**分割代入**（`const { hold } = e`）と **`link` の読み**も走査を素通りする。
      **判定（`20260919-backlog-acs-triage`）: 対応要・優先度 低** — 穴は現物にある。
      `packages/server/test/lifetime-flag-containment.test.ts:84` はファイルごと「内側」に置き、
      `:88-91` はドット付きの読みしか照合しない。web-ui 側（同名テストの `:61-66`）は `.link =` の代入だけを見る。
      写し（R1 の答えの組み立て直し・分割代入）を変異で入れても、関連 92 件は緑のままだった。
      現時点で写しは実在しないので、利用者への実害の経路は無い（保険の穴）。（research F1-1）
- [x] **R4 の `error` 経路と `lifetimeOf` が組合せ表に無い**（同 work の `decisions.md` D17 の積み残し）。
      `session-controller.ts` の `error` 枝のガードはどのテストも覆っていない。
      `lifetimeOf`（持ち主不在の寿命）も表がまったく通らない（門を丸ごと壊しても表は 0 件。
      server 全体では `session-reconnect-grace.test.ts` の 3 件が落ちる）。
      **注記（`20260910-session-reconnect-freeze`）**: 同 work が `error` の経路にテストを 2 件足した
      （繋ぎ直し成功後の `error` ／ 初回接続の口の `error` の通る・落ちるの両方）が、
      **これは D17 の消し込みではない**——組合せ表（`session-lifetime-matrix.ts`）には 1 行も足しておらず、
      `lifetimeOf` はサーバー側で同 work の対象外。表の軸は `Terminal × Disconnect × Role` で
      R4 の軸を持たないため、足すには表の作り直しが要る。
      **判定（`20260919-backlog-acs-triage`・PR #406）: `lifetimeOf` の側は対応不要（解決済み: 回帰テストが覆っている）** —
      組合せ表には無いが、回帰テストが覆っている。門を丸ごと壊すと `session-reconnect-grace.test.ts` の 3 件が落ちる。
      次の部分変異も、grace（と idle-timeout）の 1〜2 件が検出する。
      - `holder.held` 条件の削除
      - `Math.min` を `orphanMs` に置換
      - `ever` 条件の削除
      `error` の側は下に割った。（research F1-2b）
- [ ] **繋ぎ直し成功後の `error` で健全な接続を諦める経路を、どのテストも判別できない**（上の項目＝`20260908-session-lifetime-rules-fold` decisions D17 から割った）。
      `packages/web-ui/src/session-controller.ts:483` の `if (msg.type === "error" && !a.settled)` から
      `&& !a.settled` を外しても、関連 6 ファイル 87 件は緑のままだった（変異）。
      外すと、繋ぎ直しに成功した後の通常の `error`（例: `FIELD_TYPE`）で `giveUpReconnect(…, "gone")` に入り、
      **健全な接続が lost/gone になり、口が close される**。
      `20260910-session-reconnect-freeze` が足した `session-reconnect.test.ts:531-532` は `s.notice` しか見ていない。
      誤った経路でも同じ文言が入るので、判別できない。
      手当て: 「成功後の `error` で `connected` が true のまま・`close` が呼ばれない」を assert する 1 件で閉じる。
      **判定（`20260919-backlog-acs-triage`）: 対応要・優先度 中**（research F1-2a）
- [x] 実機（`.env.verify`）で瞬断からの復帰を確認する（`20260908-session-survives-disconnect`
      の「未検証の穴」）。**`20260908-session-lifetime-rules-fold` も単体テストと型のみで実機は通していない**
      ので、この項目はそのまま残る。
      **判定（`20260919-backlog-acs-triage`・PR #406）: 対応不要（解決済み）** — 実機・実ブラウザで実測した。
      構成: HEAD の server / web-ui、Chromium の headless、ブラウザとサーバーの間に TCP 中継。
      - S1: 3 秒の断（RST＋拒否）。戻してから **1,117ms** で同じ画面に復帰し、F3 がホストに通った（同じジョブ）。
      - S2: `DLYJOB DLY(6)` の応答待ちの最中に 3 秒の断。戻してから **2,933ms** で最新の画面に復帰し、応答待ちも解けた。
      - S3: 40 秒の断。**29.7 秒**で「切断 ↻ 再接続」が出た。押すと **1,374ms** で復帰した。
      - S4: 最初の ping の後に半開き。**93.3 秒**で再接続中になり、**632ms** で復帰した。
      ping を受ける前の半開きは検出されない。これは別の欠陥として下に起票した。
      再現: `scripts/verify-browser-reconnect.mjs`。（research F2）
- [ ] `packages/web-ui/test/tab-visibility.test.ts` が並列実行時に 5 秒タイムアウトで落ちる。
      CI の並列度かこのテストのタイムアウトを見直す（本件とは無関係の既存フレーク）。
      `20260908-session-lifetime-rules-fold` の test 工程でラウンド1 は落ち・ラウンド2 は落ちなかった
      ——タイミング依存であることの傍証。~~単体実行では 8 件とも緑。~~
      **判定（`20260919-backlog-acs-triage`）: 対応要・優先度 低〜中** — 単体で実行しても落ちる。
      2026-09-19、load average 4.07 で 8 件中 1 件が 5 秒で timed out（8.59s）。
      本体は並列ではなく、テスト本体の `await import("../src/App.vue")`（`packages/web-ui/test/tab-visibility.test.ts:128`）。
      この動的 import だけで 6.5〜7.1 秒かかり、5 秒の枠を食う。
      App.vue を使う他の 3 本は先頭で静的 import しているので落ちない。
      CI では他のファイルの変換が先に済むので通る（推測）。
      手当て: 静的 import にするか、この it にタイムアウトを明示する。（research F1-4）
- [ ] **VT とプリンターの `onClose` にも「この口がまだセッションのものか」の門を当てる**
      （`20260910-session-reconnect-freeze` の `decisions.md` D14 / review ラウンド2 の点検）。
      5250 の 2 か所（`tryResume` と `openSession`）には門を当てたが、`onClose` は全部で 4 つあり、
      VT とプリンターは `sessionsStore.get(sessionId)` の有無だけで判断する。同じ id で開き直すと
      `sessionsStore.add` が口ごと差し替えるので、あとから届く古い口の `close` が
      **健全なセッションを `markLost(transport)` ＋「接続が切れました」にする**。
      踏める経路は現物にある（`ConfigCard.vue` の force 経由で `openPrinterSession` を再度呼ぶと、
      サーバーが同じ `entry.id` を返して `add` が差し替える）。
      **本 work の門はこの 2 つを通らないので、悪化はしていない**（VT・プリンターは
      `updateScreen` / `markConnected` を呼ばず、`not-resumable` ではしごも回らない）。
      **判定（`20260919-backlog-acs-triage`）: 対応要・優先度 低（プリンターだけ）** — 門が無いのは事実
      （`session-controller.ts:861-867` VT、`:1035-1040` プリンター）。
      **VT には到達しない**。VT の id は毎回 `randomUUID()`（`packages/server/src/vt-manager.ts:87`）で、attach の経路も無い。
      プリンターに届くのは「＋新規」（`LauncherPane.vue:229`、force=true）で、しかも**装置名の無い設定**のときだけ。
      装置名があると `openConfigured.ts` の `deviceNameInUse` が先に断る。
      同じ経路の未起票の問題は、下に別項目で起こした。（research F1-5）
- [x] **ホスト終了がはしごの最中に届くと取りこぼす**（`20260910-session-reconnect-freeze` の
      review ラウンド3 ＋ デバッグ D1）。**2 つを 1 つの直しとして入れること**——片方だけでは無効。
      1. `closed` は表示の更新ではなく**寿命の信号**なので、共通の門の `link.state === "connected"` の
         要求から外す（口の同一性は残す＝`acceptsFrame` から `connected` の要求だけを外した述語）。
         **`delete s.notice` / `setBusy(false)` は門の内側に残す**——諦めの文言
         （`MSG_RECONNECT_GAVE_UP`）が消えると、次の打鍵で汎用の `MSG_NOT_CONNECTED` に
         塗り替わって「待てば戻る」という嘘になる（`20260908-session-survives-disconnect` の
         review ラウンド1 で潰した形の再来）。
      2. **`hostEnded` / `gone` が確定したらはしごを畳む**。いま `resumeVerdict` を問うのは
         `startReconnect` の 1 か所だけで、走り出したはしごは誰も止めない
         （`scheduleReconnect` も `tryResume` も問い直さない）。`beginReconnect` が次の段で
         `link` を `reconnecting` に戻して `hostEnded` を消すため、**1 だけ入れても
         最終状態・文言・ボタンが 1 つも変わらない**（デバッグ D1 が実測）。
      **1 は本 work が作った退行、2 は HEAD から在る欠陥**。1 単独では「直った」と言えるテストが
      書けないため、本 work では両方とも入れず対で起票した。
      再現の順序: `onClose()`（見張りの保険で CLOSING のまま）→ 同じ口へ `closed{ended:true}`。
      既存の順序（`closed` → `onClose`）は `session-reconnect.test.ts` が固定済みで影響なし。
      **判定（`20260919-backlog-acs-triage`・PR #406）: 対応不要（差異なし・実害なし: 実ブラウザでは起きない）** —
      ロジック上の穴は実在し、一時テストで再現した。
      しかし「`onClose` → 同じ口から `closed`」の順序は、実ブラウザでは起きない。
      WHATWG WebSockets Standard は、ready state が OPEN でなければ message イベントを発火しないと定めている。
      `close()` は CLOSING にするので、見張りが閉じた後に同じソケットからフレームは届かない。
      PR #394 の 3 件目（試行中の口から `opened` の前に `closed`）も起きない。
      サーバーの `attach`（`ws-handler.ts:958-`）が、購読と `opened` の送信を同じ同期ブロックで行うため。
      はしごの最中にホストが終わった場合は、次の試行で `error` が返り、`giveUpReconnect("gone")` で止まる（既存の経路）。
      修正の PR #394（`feature/session-closed-ladder-interrupt`、2026-09-10）は、この判定の根拠を添えて閉じた（2026-09-20・`20260919-backlog-acs-triage` decisions D7）。（research F1-6）
- [ ] `openSession` の Promise が settle しないまま残る経路がある
      （`20260910-session-reconnect-freeze` の review ラウンド3）。`opened` / `error` のどちらも
      届かずにソケットが閉じると（プロキシの 1006、upgrade 後にフレーム無しで閉じるサーバー等）、
      `sessionId` が `""` のままなので `onClose` の門が閉じ、`connect()` は既に解決済みなので
      `notifyClosed` の `rejectConnect` も no-op。**開いている最中のスピナーが永久に残る**。
      その枝で reject するか、エラー付きで resolve すれば閉じる。本 work とは独立の既存欠陥。
      **判定（`20260919-backlog-acs-triage`）: 対応要・優先度 中（記述より影響が大きい）** — 穴は現物にある。
      `openSession` の `onClose`（`session-controller.ts:749-755`）は、`sessionId` が `""` の間は門で何もしない。
      **`openVtSession`（`:861-863`）と `openPrinterSession`（`:1035-1037`）にも同じ穴がある。**
      影響はスピナーだけではない。`openConfigured.ts` の `connecting` はモジュールで共有されていて、`if (connecting.value) return` で止まる。
      そのため、**ページを再読み込みするまで、どの設定も開けなくなる**。
      再現: upgrade 後、`opened` の前にソケットが閉じる（サーバーの再起動・プロキシの 1006・回線断）。
      ホストへの接続とサインオンにかかる数秒の窓で踏める。
      手当て: 3 関数とも `onClose` で、`sessionId === ""` なら reject する。（research F1-7）
- [x] 最近の接続状態維持・再接続対応（session-reconnect-freeze / session-closed-ladder-interrupt 系）以降、今までスムーズだった操作で待たされるタイミングが出るなど不安定化しているとの報告（利用者、20260915）。再現条件・原因未特定。どの変更が影響しているか、直近のreconnect関連workから疑って切り分ける必要がある。（出典: .aidev/works/20260914-seu-page-cursor-hold/decisions.md）
      **判定（`20260919-backlog-acs-triage`・PR #406）: 対応不要（解決済み: 切り分けは済み、候補を 4 つ起票した。確定は下の項目）** —
      **平常時の往復は健全**。実機・実ブラウザで、ページ内の時計で 30 回の打鍵（`1` と F3 の 15 往復）を測った。
      - 打鍵 → `screen`: 38〜76ms
      - 打鍵 → 描画と覆いの解除: 72〜137ms
      - ホストの応答: 9〜75ms（1 レコード・READ MDT 込み）
      #391〜#393 の差分は、健全時の打鍵経路に待ちを入れていない。
      報告にある「session-closed-ladder-interrupt 系」は PR #394 のことで、**main に入っていない**。
      間欠的な待ちの候補は、次の 4 つとして起票した。
      - (D) リロード後の装置名の衝突（下の項目）
      - (N3) 先打ちを捨てる（`acs-parity.md`）
      - (A) 半開き。最大約 93 秒。ping を受ける前なら検出されない（下の項目）
      - (H) READ の無いアンロック（`acs-parity.md`）
      （research F3）
- [ ] **利用者に「待たされた操作」を 1 つ確かめ、上の候補 D / N3 / A / H のどれかに確定する**（上の項目から割った）。
      見分け方:
      - リロードやタブを開き直した直後に開けない・遅い → D
      - Enter の直後に打った文字が欠ける → N3
      - スピナーが長く（最大 90 秒）残って「再接続中」になる → A
      - 🔒 のまま解けず、Attn / SysReq でしか抜けない → H
      **判定（`20260919-backlog-acs-triage`）: 対応要・優先度 中**（利用者の確認待ち）

- [ ] **リロード・タブを閉じた後、90 秒は同じ装置名で開けない（`8902 Device not available`）**（優先度 高・深さ ◎）。
      装置名を固定する運用（利用者の設定がこれ）で、リロードやタブの開き直しの直後に開けない・開くのが遅いと当たる。
      利用者の「待たされる」報告の有力な候補（上の「最近の接続状態維持・再接続対応以降…不安定化」の項目の候補 D）。
      ACS はウィンドウを閉じると接続も閉じるので、この待ちは起きない。
      当 PJ
      - web-ui には、タブを閉じるときに `close` を送る処理が無い（`pagehide` / `beforeunload` の grep は 0 件）。
      - サーバーはこれを転送断とみなし、セッションを `DEFAULT_RECONNECT_GRACE_MS`＝90 秒保持する（`packages/server/src/ws-handler.ts` の `onSocketClose` → `transportLost`、`packages/server/src/session-manager.ts:119`）。
      - 表示セッションの `open()`（`session-manager.ts:692`）には、同じ設定のセッションが保持中かを確かめる処理が無い。プリンターの `openPrinter`（`:885-889`）にはある。
      実測（実機）: 同じ装置名の 2 本目は、1 本目が生きている間も、閉じた 0.3 秒後も、`8902 Device not available` で即座に拒否された。
      手当ての候補
      - 同じ設定（ref・owner）の保持中セッションがあれば、それに繋ぐ（プリンターと同じ形）。
      - タブを閉じるときに明示の `close` を送る（ただしリロードで続きから操作したい場合と両立させる設計が要る）。
      （出典: `20260919-backlog-acs-triage` research F3-3 D）
- [ ] **クライアントの ping の見張りが、最初の ping を受けるまで張られない。接続してから約 30 秒の間の半開きを検出できない**（優先度 中・深さ ◎）。
      繋いだ直後や繋ぎ直した直後に回線が黙って切れると、クライアントは切断に気づかない。
      打鍵は OPEN のソケットへ送られたまま消え、スピナーが残る。
      実機の回線断は「繋ぎ直した直後にもう一度切れる」形で起きやすい。
      当 PJ: `packages/web-ui/src/ws-client.ts:199-200` は、`ping` を受けたときにだけ `armPingWatchdog()` を呼ぶ。開いた時点では張らない。
      これは ping を送らないサーバーとの後方互換のための意図した設計（同ファイルの注記・`20260908-session-survives-disconnect` decisions D6）だが、サーバーの ping は 30 秒周期なので、その間が穴になる。
      実測（実機・実ブラウザ・中継で黙って止める）
      - ping を受ける前に止めると、130 秒たっても切断と判断しなかった。
      - サーバーの心拍は約 120 秒で相手を死んだと判定して閉じるが、本物の半開きではその閉鎖はブラウザに届かない（中継でそれを伝えると「検出した」ように見える。`20260919-backlog-acs-triage` decisions D10）。
      - 最初の ping を受けてから止めると、設計どおり 93.3 秒で「再接続中」になった。
      再現: `scripts/verify-browser-reconnect.mjs S4a`（直るまで FAIL が正しい結果）。
      手当ての候補: 開いた時点で見張りを張る。後方互換を守るなら、「サーバーが ping を送る」ことを `opened` で申告させる。
      （出典: `20260919-backlog-acs-triage` research N19・F2）
- [ ] **プリンターの「＋新規」で同じ id に差し替わったとき、古い口がリークし、サーバーの購読の解除が新しい接続にまで及びうる**（優先度 低・深さ △）。
      上の「VT とプリンターの `onClose` の門」と同じ経路（装置名の無い設定で「＋新規」、`LauncherPane.vue:229`）で起きる、別の問題。
      - 差し替えられた古い `WsClient` は、クライアントの誰も close しない（一時テストで `close` が呼ばれないことを確認）。
      - サーバーの `detachReport`（`packages/server/src/ws-handler.ts:812`）は、エントリの `onReport` / `onState` などを無条件に削除する。古い接続が後から閉じると、新しい接続の帳票や状態の push まで外れる（コード読みのみ・未実証）。
      手当ての候補: プリンターでは「＋新規」は新規にならないので出さない。これで根から塞がる。
      **着手時に両側を再確認すること**（委譲先の読みのみ）。
      （出典: `20260919-backlog-acs-triage` research F1-5）
