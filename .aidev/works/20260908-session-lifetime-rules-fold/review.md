# レビュー記録

## タスク点検ログ（coding 工程内・「3.3」(b)）

- [must][conv:-] `packages/web-ui/test/session-lifetime-matrix.ts` 3270 のホスト終了を `connectionLost` と書いていたが、`tn3270-manager.ts:78` はホスト終了を購読しておらず `closed` も WS の切断も起きない（クライアントには何も届かない） / 対応: 修正済（T1・ラウンド1。`nothing` を ClientOutcome に追加）
- [must][conv:-] 同 5250 の `hostEnded` × 見に来ただけのタブを `connectionLost` と書いていたが、**ホスト終了は WS を閉じない**ので `startReconnect` の門を通らない（`ws-handler.ts:861-866` は `closed{ended:true}` を送るだけ）。持ち主と同じ `silent` が正 / 対応: 修正済（T1・ラウンド1。門の順序が効くのは「ホスト終了のあと転送断」のときだけなので `CLIENT_ORDER_CASES` に分離）
- [must][conv:-] 同 プリンターの `hostEnded` を `connectionLost` と書いていたが、`session-manager.ts:987-997` は `state="error"` に落として `printer-state` を push するだけで WS は閉じず `connected` も true のまま / 対応: 修正済（T1・ラウンド1。`printerState` を ClientOutcome に追加）
- [should][conv:-] 同 3270 / VT 節の見出し「常に閉じる」が、同じ節の `hostEnded` 行（`nothing` / `entryRemoved`）と矛盾。閉じるのは `dispose` を通る 3 つだけ / 対応: 修正済（T1・ラウンド2）
- [should][conv:-] 同 「見に来ただけのタブ（門1 が門2 より先に効く）」の見出しが、そのブロックのどの行でも成り立たない（1 巡目で `hostEnded` 行を `silent` に直した取り残し） / 対応: 修正済（T1・ラウンド2）
- [nit][conv:-] 同 VT / プリンターの `clientClose` の why「同上」が `startReconnect` を指していたが、この 2 つは専用 `onClose` の早期 return で戻る / 対応: 修正済（T1・ラウンド2）
- [nit][conv:-] 同 `CLIENT_ORDER_CASES` の why が `MSG_SESSION_ENDED` の出所に門2（`:305`）を挙げていたが、文言を出すのは `refuseIfDisconnected`（`:152`） / 対応: 修正済（T1・ラウンド2）
- [should][conv:-] `packages/web-ui/test/session-lifetime-matrix.test.ts:213-217` `nothing`（3270 のホスト終了）が実装コードを 1 行も通らず、どんな実装変更でも落ちない空振りだった / 対応: 修正済（T3・ラウンド1。観測できる帰結——ホストが終わっても繋がったままに見え、打鍵も止められない——まで assert する形にした）
- [should][conv:-] 同 `silent` の 2 行で実際に効く assert が `connected === false` だけで、`endedByHost` を潰す変異を主表が捕まえられなかった（落ちるのは `CLIENT_ORDER_CASES` の 1 行のみ） / 対応: 修正済（T3・ラウンド1。次の打鍵で `MSG_SESSION_ENDED` が出るところまで見る。変異で 1 行 → 3 行が落ちることを確認）
- [nit][conv:-] 同 `expect(s.reconnect).toBeUndefined()` が `silent` / `vtNotice` / `notStarted` の 3 経路で常に真 / 対応: 修正済（上の `silent` 強化に含む）
- [nit][conv:-] 同 突き合わせが `CLIENT_ORDER_CASES` を見ておらず、門の順序を唯一固定する 2 行が消えても落ちなかった / 対応: 修正済（T3・ラウンド1。件数と id の重複を固定）
- [nit][conv:-] 同 `eslint-disable-next-line @typescript-eslint/no-explicit-any` が無効化するものを持たない（`packages/web-ui/**` は eslint の対象外） / 対応: 修正済（T3・ラウンド1。型で書き直して disable を削除）
- [nit][conv:-] 同 `snap()` だけ JSDoc ヘッダが無く、`as unknown as` で型を曲げている理由も書かれていなかった（AGENTS.md「関数の責務は JSDoc ヘッダで」） / 対応: 修正済（T3・ラウンド1）
- [should][conv:-] `packages/server/test/session-lifetime-matrix.test.ts:225` 5250 の `handedOverPresent` を WS 接続で組み立てていたため、表の `otherViewer: false` に反して在席 1 の状況になり、**在席の判定が保持者ガードより先に効いて素通し**していた（`abandoned` を常に真にする変異でプリンター 3 行しか落ちなかった） / 対応: 修正済（T2・ラウンド1。`mgr.claim()` で座だけ譲る形に変更。同じ変異で 3 行 → 6 行が落ちることを確認）
- [should][conv:-] 同 `keep` が「エントリが在る」ことしか見ておらず、待ち受けだけ降ろす変異（`stopPrinter`）が 65 件すべて素通りした / 対応: 修正済（T2・ラウンド1。プリンターの `keep` は `state === "listening"` まで見る。同じ変異で 0 行 → 12 行が落ちることを確認）
- [nit][conv:-] 同 `nothing` が `closed` の不在しか見ておらず、別種の通知が増えても通った / 対応: 修正済（T2・ラウンド1。心拍を除いた通知が 1 通も無いことを見る）
- [must][conv:-] `packages/server/src/session-lifetime.ts:92,156` `holdForReconnect()` の `false` が兼ねる 3 通りのうち「**セッションが無い**」が入力に写っておらず、既に閉じられたセッションへ古いハンドラが心拍死判定で来る経路で、現行が `close` に落とす場面で `hold` を返していた / 対応: 修正済（T4・ラウンド1。`holdable` を「現行 `holdForReconnect` が true を返す条件そのもの」と定義し直し、エントリの存在を含めた。5 経路をプローブで確認）
- [should][conv:-] 同 `act: "hold"` が「新たに入れる」と「既に猶予中」を畳んでおり、素直な呼び出し側が**期限を延長**して「切断を繰り返すクライアントが枠を無期限に掴む」穴を開けられた / 対応: 修正済（T4・ラウンド1。`{ act: "hold"; already: boolean }` に分けて型で防いだ）
- [should][conv:-] 同 `lifetimeOf()` の JSDoc に「**表示セッション専用**」が落ちており、プリンターに掛けると常駐が持ち主不在の 30 分で刈られる旨が書かれていなかった / 対応: 修正済（T4・ラウンド1）
- [must][conv:-] 同 「常駐プリンターは切らない」の出所を「前 work の design D1」としていたが、前 work の `design.md` に `## D` 見出しは 0 件で、正しくは `20260801-printer-session-residency` の design D1（AGENTS.md「判断の出所を明記する」） / 対応: 修正済（T4・ラウンド1。裏取り済み）
- [must][conv:-] `packages/server/src/session-lifetime.ts:196-199` **ラウンド1 で自分が足したコメントが事実と違っていた**——「プリンターに `lifetimeOf` を掛けると常駐が持ち主不在の 30 分で刈られる」と書いたが、`sweepIdle` は上限を計算する前に `if (entry.resident) continue`（`session-manager.ts:1713`）で常駐を落とすので刈られない。本当の理由は「プリンターは猶予の対象外で、転送断ではその場で閉じるので『持ち主が去って宙に浮く』状態が作れない」（前 work の review で「対応不要」と結論済み） / 対応: 修正済（T4・ラウンド2。裏取り済み）
- [should][conv:-] 同 ラウンド1 で `holdable` にだけ「エントリが在る」の前提を書いた結果、同じ前提が掛かる `hold: HoldState` 側に注記が無いままだった / 対応: 修正済（T4・ラウンド2）
- [should][conv:-] 同 R2（猶予）のうち「期限が来たときどうするか」（`reapHold` の規則）だけが畳み込まれておらず、`session-manager` に残っていた / 対応: 修正済（T4・ラウンド2。`decideHoldExpiry()` を追加）
- [nit][conv:-] 同 猶予枝のコメントが二重になり、前半がこのモジュールに存在しない `holdForReconnect` の戻り値の読み方を説明していた / 対応: 修正済（T4・ラウンド2）
- [nit][conv:-] 同 `IdleLimit` が `session-manager.ts` と二重定義のままで、tasks.md T4 の「移す」を満たしていなかった / 対応: 修正済（T4・ラウンド2。`session-lifetime.ts` へ移し、`session-manager.ts` は再エクスポートに——入口を変えないので AC6 を満たす）
- [should][conv:-] `packages/server/test/mcp-*.test.ts` 4 箇所の偽 `SessionEntry` が新必須フィールド（`holder` / `hold`）を持たないまま `sessions` マップへ差し込まれていた。テストは型検査対象外（`tsconfig.json` の `include` は `["src"]`）なので素通りし、以後 `sweepIdle` / `disposition` が触った瞬間に `undefined.holding` で落ちる時限爆弾だった / 対応: 修正済（T5・ラウンド1。**うち 2 件は本 work 以前から `viewers` も欠いており `satisfies` が偽だった**ので併せて閉じた。一時 tsconfig で 4 件とも型として成立することを確認）
- [should][conv:-] `packages/server/src/session-manager.ts:92-94` `IdleLimit` 再エクスポートのコメントが「各所に在るので」と書いていたが、実際の輸入元はテスト 1 件だけで `src` からは 0 件。引いた AC6 も型の再エクスポートを直接は含まない / 対応: 修正済（T5・ラウンド1。事実に合わせて書き直し）
- [nit][conv:-] 同 型を移したのに「なぜこの形か」（`0` / `null` を「切らない」の印にしない）の JSDoc が移動元に残り、移動先には一行説明しか無かった——規則の在り処を 1 か所に畳むという狙いに反する / 対応: 修正済（T5・ラウンド1。`session-lifetime.ts` へ移した）
- [nit][conv:-] `packages/server/test/session-reconnect-grace.test.ts:55` のコメントが、この差分で消えたフィールド `heldUntil` を指したままだった / 対応: 修正済（T5・ラウンド1）
- [nit][conv:-] `packages/server/src/session-manager.ts:276-277` `holder` の JSDoc 冒頭が旧 `holderToken`（単調増加の番号）を指したまま残り、欄の型（`HolderState`）と食い違っていた / 対応: 修正済（T5・ラウンド2）
- [nit][conv:-] 同 `reapHold` の JSDoc が「`disposition` が決める」と書いていたが、この時点では `disposition()` に呼び出し箇所が無く、実際に決めているのは現行の `ws-handler.dispose` だった / 対応: 修正済（T5・ラウンド2。T6 で実際に接続する）
- [nit][conv:-] `packages/server/src/session-lifetime.ts:24` ラウンド1 で JSDoc を移した際、裸の出所「（spec 方針2）」が移動先で読み取れなくなった（この work 自身の design にも別内容の「方針2」がある） / 対応: 修正済（T5・ラウンド2。`20260729-session-lifetime-timeout` の spec 方針2 と明記。裏取り済み）
- [must][conv:-] `packages/server/src/ws-handler.ts:154-162` `attached` を消した際に JSDoc ブロックだけが残り、**次の宣言（`detachReport`）の説明として付いてしまっていた**（帳票フックの解除に「切断時にセッションを閉じてよいかの判断」は当てはまらない）。型検査もテストも通るので点検以外に検知手段が無い / 対応: 修正済（T6・ラウンド1。同じ区別は `link` の JSDoc が説明しているのでブロックごと削除）
- [nit][conv:-] `packages/server/test/ws-reconnect-resume.test.ts:156` のコメントが、この差分で消えた `attached` を指したまま残っていた（`heldUntil` と同種の取りこぼし） / 対応: 修正済（T6・ラウンド1）
- [should][conv:-] `packages/server/src/ws-handler.ts:229,917,1127` **畳み込みの副産物として振る舞いが 1 点変わっていた**——旧 `dispose` は `attached` を戻さない（スティッキー）ため、`open{sessionId}`(viewer) → `close` → 同じ接続で `open{host}` → `close` の列で 2 本目が孤児になった。`link` を 1 欄に畳んだ結果、id と一緒に役割も戻るようになり正しく閉じる / 対応: **受け入れ**（`decisions.md` D9）。旧に戻すには「役割をスティッキーにする」コードを新設計に書き足すことになり、前 work が D7 / D10 で戦った孤児化の再導入になる。回帰テストで固定し、**HEAD の実装では落ちること**を実測で確認した
- [nit][conv:-] `packages/server/src/ws-handler.ts:97-106` `WsConnection` のクラス JSDoc が `emptyVtFrame` の上に浮いている / 対応: **対象外**（HEAD の同位置に既存で、本差分が作ったものではない。指摘者も誤検知回避のための記載と明示）
- [must][conv:-] `packages/web-ui/src/session-link.ts:80` `nextLink` の `transport` 保護が `lost` にしか効かず、**`reconnecting` を潰していた**。現行の `connected = false` は `s.reconnect` を消さないので門4（二重起動防止）が効き続けるが、畳み込み後は `attempt`/`max` が消えて `isResumable` が真を返し、**はしごが 1 段目から二重に回る**（`research.md` F17-(4) の未テストの穴に当たる経路） / 対応: 修正済（T7・ラウンド1。`reconnecting` も保護対象に）
- [must][conv:-] 同 `LinkEvent` に `retryReconnect` の「門の**前**に `delete s.reconnect` / `delete s.reconnectFailed`」に対応する遷移が無く、`gone` でも押し直せるという現行の振る舞い（`research.md` F17-(5)）を表現できなかった / 対応: 修正済（T7・ラウンド1。`retryRequested` を追加。`endedByHost` だけは解かない——現行に削除経路が無いため）
- [should][conv:-] 同 `{to:"connected"}` / `{to:"reconnecting"}` が `hostEnded` を無条件に消すが、現行の `endedByHost` には削除経路が 0 件で、「同値」というコメントの主張が成り立たなかった / 対応: **受け入れ**（`decisions.md` D10）。到達しない組合せなので振る舞いは変わらない。表現力の差である旨をコメントに明記した
- [nit][conv:-] 同 `Attempt` の docstring が「4 系統を畳む」と書いていたが、`s.reconnect` を代表するのは `SessionLink.reconnecting` 側だった / 対応: 修正済（T7・ラウンド1）
- [nit][conv:-] 同 「12〜15 か所」を**クライアント側 2 規則だけの数**として引いていたが、出所のデバッグ D1 では 4 規則・両側を合わせた数だった / 対応: 修正済（T7・ラウンド1）
- [nit][conv:-] 同 冒頭コメントが、この時点では実在しない `SessionState.link` / `resumability` を現在形で参照していた / 対応: 修正済（T7・ラウンド1）
- [should][conv:-] `packages/web-ui/src/session-link.ts` `isResumable()` は真偽しか返さないが、現行の 4 門は**門1 だけが `MSG_CONNECTION_LOST` を書き、門2〜4 は黙る**という非対称を持つ。この出し分けが純粋モジュール側に記録されておらず、T9 で「`false` なら一律に通知を書く」と実装すると**黙るべき枝で嘘の理由（待てば戻る含み）を出す**——前 work の review ラウンド2 が潰した退行そのもの / 対応: 修正済（T7・ラウンド2〈同一セッション〉。docstring に明記して T9 への申し送りにした）
- [must][conv:-] `packages/web-ui/src/session-controller.ts:625` 旧フィールド `attachedOnly` の**書き手が残っていた**。`SessionStateInit` から消えているのにスプレッド内は TS の余剰プロパティ検査を通り抜けるため、クリーンな型検査でも無警告だった / 対応: 修正済（T8・ラウンド1。**T11 の走査テストが同時に同じものを検出**——型で見えないものを走査が捕まえた実例）
- [should][conv:-] `packages/web-ui/src/stores/sessions.ts` `updateScreen` の遷移が旧より広い（旧は `connected = true` だけで `reconnect` / `reconnectFailed` を残したが、union では理由も消える） / 対応: **受け入れ**（差が出る経路は `tryResume` の既存ガードが塞ぐので到達しない）。根拠をコメントに明記
- [should][conv:-] 同 「再定義は `TypeError` になる」が事実と違った（`configurable: true` なので通る） / 対応: 修正済（T8・ラウンド1）
- [should][conv:-] 同 「12 箇所が `connected` へ直接書いており」が誤り（`connected` への代入は 9 箇所。12 は 4 フィールド全部の合計） / 対応: 修正済（T8・ラウンド1）
- [should][conv:-] 同 `beginReconnect` の「確定した理由を解く唯一の口」が誤り（`requestRetry` と `markConnected` も解く） / 対応: 修正済（T8・ラウンド1）
- [should][conv:-] 同 削除した `attachedOnly` / `endedByHost` の旧 JSDoc が現在形のまま残置されていた / 対応: 修正済（T8・ラウンド1）
- [should][conv:-] 同 `reconnect` / `reconnectFailed` の JSDoc が導出化前の「書き手」を述べたままだった / 対応: 修正済（T8・ラウンド1）
- [should][conv:-] 同 JSDoc ブロックが 2 連で並び、`defineDerivedLink` の説明が `createSessionState` に押し出されて当の関数に doc が付いていなかった / 対応: 修正済（T8・ラウンド1）
- [nit][conv:-] 同 引いているコマンドが実在しない（`vue-tsc -b tsconfig.test.json` → 実際は 2 つ渡す） / 対応: 修正済（T8・ラウンド1）
- [nit][conv:-] 同 `add()` の JSDoc の例が違う（`busy` は `get()` 経由で書かれる。参照を握って書くのは `notice`） / 対応: 修正済（T8・ラウンド1）
- [should][conv:-] `packages/web-ui/src/session-controller.ts:278-305` `startReconnect` の JSDoc が、あとから挿入した `displayResumability` の JSDoc に押し出され、**当の関数にヘッダが付いていなかった**（TS/エディタ上は後者だけが結び付く） / 対応: 修正済（T9・ラウンド1。`displayResumability` を丸ごと上へ出した。**T8 で同じ指摘を受けた手癖の再発**——関数の前に説明を書き足すとき、直前の JSDoc が誰に付くかを見ていない）
- [nit][conv:-] 同 `clearReconnectTimer` の JSDoc「繋ぎ直しの**待ち**を畳む」が畳み込み後の実態と不一致。`Attempt.timer` は待ちと飛行中の黙り込み打ち切りの兼用枠になり、`abortReconnect` は飛行中の deadline もここで畳んでいる（旧 `cancel()` の代替） / 対応: 修正済（T9・ラウンド1。両方の相を説明に含めた）
- [nit][conv:-] 同 `:239` 「判定が **4 系統**に散っていた」が出所と食い違う。research.md F4 と `session-link.ts:146` はいずれも **5 系統**と記録している（F4 の文言を借りて数だけ変えていた） / 対応: 修正済（T9・ラウンド1。5 系統に揃え、「この Map が畳むのはうち 3 つ」と内訳の在処を明記）
- [nit][conv:-] 同 `:750`（VT）/`:920`（プリンター）の `closed` が `msg.ended === true` を `hostEnded` として**記録するようになった**（旧は両経路とも `connected = false` だけで `endedByHost` を立てず、あれは表示セッション専用の印だった） / 対応: **受け入れ**（`hostEnded` の読み手は `canSendToHost` のみ。VT の送信は `VtPane.vue` が `client.send` を直に呼んで通らず、プリンターは `readOnly` で送信経路が無い。`isResumable` も両者 `not-resumable` で結論が変わらず、派生アクセサ 3 つの値も一致するので**現状は同値**）。将来 VT に送信ガードを付けた瞬間に文言が変わる点を理由付きでコメントに明記
- [should][conv:-] `packages/web-ui/src/session-link.ts` `Attempt.seq` が**誰も読まない死んだ状態**だった（参照は生成側の 1 行だけ。コメントの理由「ログと突き合わせる」がコード上で成立していない）。振る舞い不変の畳み込みで状態を増やしていた / 対応: 修正済（T9-2・ラウンド1。`seq` と `attemptSeq` を削除）
- [should][conv:-] `packages/web-ui/src/session-controller.ts:466` 全メッセージ共通の門だけが `isCurrentAttempt` を通さず `attempts.get(id) !== a` の形で同じことを問うていた（research F4 が (2) として名指しした当の判定）。**現状は等価**（`settled` を立てる 4 経路がいずれも同じ同期ブロックで `attempts` からも外すので `get(id)===a && settled` は到達しない）だが、`session-link.ts` が宣言する「R4 の唯一の答え」が成立していなかった / 対応: 修正済（T9-2・ラウンド1。`isCurrentAttempt` に寄せた）
- [nit][conv:-] 同 `opened` 成功時の `clearReconnectTimer` が確実な no-op（14 行上の `attempts.delete` 以降に再登録経路が無い） / 対応: 修正済（T9-2・ラウンド1。削除）
- [nit][conv:-] 同 `abortReconnect` の `const inflight = { client: a.client }` が旧 `pendingResumes` の値の形の名残で、何もしていなかった / 対応: 修正済（T9-2・ラウンド1）
- [nit][conv:-] 同 `scheduleReconnect` の `attempts.set` が既存エントリのタイマーを畳まずに上書きする（「セッションごとに高々 1 つ」を壊しうる唯一の場所）。呼び手 2 つとも先に代表を降ろすので到達せず、畳み込み前の `reconnectTimers.set` も同じ形だったので退行ではない / 対応: **受け入れ**（不変条件が成り立つ理由をコメントに残した）
- [should][conv:-] 同 `closed`（VT）のコメント「いま `hostEnded` を読むのは `canSendToHost` だけ」が誤り。`isResumable` と `nextLink` も理由を読む（結論の「同値」自体は別の理由で成り立つ） / 対応: 修正済（T9・ラウンド2。**ラウンド1 で私が足した根拠そのものの誤り**——読み手を数え切らずに書いた）
- [should][conv:-] 同 `closed`（プリンター）のコメント「`readOnly` で送信経路が無く」が誤り。`setPrinterOutput` / `startPrinter` / `stopPrinter` が `client.send` を直に呼んでおり、`readOnly` は送信の門としてどこからも読まれていない。同値の本当の理由は「`refuseIfDisconnected` を通らない」 / 対応: 修正済（T9・ラウンド2。同じくラウンド1 の記述の誤り）
- [nit][conv:-] 同 `displayResumability` の JSDoc が門1 の 3 つを「ここで 1 度だけ判定する」と書くが、関数が答えるのは 2 つ（プリンターは `openPrinterSession` の状態リテラルが直に置く） / 対応: 修正済（T9・ラウンド2。ラウンド1 で移動した当のコメント）
- [nit][conv:-] 同 `clearReconnectTimer` の JSDoc「どちらの相でもここが畳む」が成功経路で成り立たない（成功・失敗の各経路は代表を降ろすのと同じブロックでタイマーも畳む。この関数が飛行中の相を畳むのは `abortReconnect` 経由だけ） / 対応: 修正済（T9・ラウンド2。ラウンド1 の修正の言い過ぎ）
- [nit][conv:-] 同 `startReconnect` 末尾「前者 2 つは次の打鍵で `refuseIfDisconnected` が具体的な理由を出し」が `gone` で成り立たない。`canSendToHost` が固有の理由に写すのは `hostEnded` だけで、`gone` の文言は `giveUpReconnect` が書いたものが残っているだけ / 対応: 修正済（T9・ラウンド2）
- [must][conv:-] `packages/web-ui/test/lifetime-flag-containment.test.ts:48` **走査集合から `settled` が落ちていた**（design「AC2 の詳細」と tasks T11 が挙げる 5 つのうち 4 つしか見ていない）。点検者が実測で確認——`StatusBar.vue` に `const settled = true` を足しても 4 テストとも緑。`settled` は `Attempt` の欄として正当に残るので「0 件」は成立しないが、集合から外すなら `viewers` を外したとき（D14）と同じく記録が要る / 対応: 修正済（T11・ラウンド1。0 件ではなく**封じ込め**の形で追加し、混入で赤くなること・違反ファイル名が出ることを実測）
- [should][conv:-] 同 `:73-74` `resumability` の it 名は 2 ファイルを名乗るのに許可集合は 3 ファイルで、余分な `session-link.ts` は本文に小文字の出現が 0（型は `Resumability`、引数名は `r`）。将来 `session-link.ts` が読み始めても緑のままだった / 対応: 修正済（T11・ラウンド1。許可集合を 2 つに絞り、入れない理由を残した）
- [should][conv:-] 同 `:58` 「畳み込み前は 12 箇所が `connected` へ直接書いており」が出所（`stores/sessions.ts:295`）の 9 と矛盾。HEAD `90f5636f` 実測でも 9 箇所（12 にするには初期化リテラル 3 件を足す必要があり、「どこで切断が記録されたか」の根拠にならない） / 対応: 修正済（T11・ラウンド1。**T8 で同じ誤りを直したのに、対のテスト側に古い数が残っていた**）
- [must][conv:-] `packages/web-ui/src/session-link.ts:67` 恒久コメントが `session-controller.ts:482-483` を行番号で指していたが、**その 2 行は本 work で `requestRetry` に畳まれて消える**（着地後は別物を指す） / 対応: 修正済（T9-2・ラウンド2。HEAD `90f5636f` のコミット ID 付きで「畳み込み前の `retryReconnect`」と書き直した）
- [should][conv:-] `packages/web-ui/src/session-controller.ts:361-363` ラウンド1 で足した「不変条件が成り立つ理由」が実際の担保と違った。`startReconnect` を守っているのは**直前の行の `abortReconnect`** であって `isResumable` の門ではなく（`updateScreen` が `connected` を打つので門は走行中でも真になりうる）、`next()` も代表のときしか降ろさない / 対応: 修正済（T9-2・ラウンド2。「代表でない生きた試行は作れない」という帰納の形に書き直した。**コードは正しく、誤っていたのは理由だけ**）
- [nit][conv:-] 同 `clearReconnectTimer` の JSDoc が、ラウンド1 で消した呼び出し側の話を残していた（呼び手は `abortReconnect` 1 つだけになった） / 対応: 修正済（T9-2・ラウンド2）
- [nit][conv:-] 同 `tryResume` の防御的な早期 return が `attempts` にエントリを残す（畳み込み前は発火時に `reconnectTimers.delete` を先に打っていた）。`closeSession` が手前で `abortReconnect` を通すので到達しない / 対応: **受け入れ**（到達しない理由をコメントに残した）
- [should][conv:-] `packages/web-ui/test/lifetime-flag-containment.test.ts` `settled` を「0 件」から「封じ込め」に変えたことが design / tasks に反映も記録もされていなかった（`viewers` を外したときは D14 を立てている） / 対応: 修正済（T11・ラウンド2。**D15** を立て、テストのコメントからも参照）
- [should][conv:-] 同 `code()` が**正規表現リテラル内の `/*` をブロックコメント開始と誤読**し、そこから次の閉じまでを本文から消していた。点検者が in-memory で実測——`screenFonts.ts:90` の窓に違反を置くと 5 テストすべて素通り。サーバー側も `admin.ts:43` / `app.ts:352` が同じ窓 / 対応: 修正済（T11・ラウンド2。**D16**。開始を「行頭か空白の直後」に限り、両側で同じ形に。旧・死角への混入で赤くなること・偽陽性 0 件を両側とも実測）
- [should][conv:-] 同 `resumability` の why が許可集合と対応していなかった（見出しは「規則と…」だが規則の `session-link.ts` は除外側で、内側に居るのは欄を宣言する `stores/sessions.ts`）。design から緩めた側の理由が書かれていない / 対応: 修正済（T11・ラウンド2）
- [nit][conv:-] 同 「9 箇所」は正しいが、このテストが数える `.link =` は 4 フィールド分なので、同じ数え方なら 12。括弧の内訳を落としたため効き目が実際より小さく読めた / 対応: 修正済（T11・ラウンド2。**T8→T11ラウンド1→ここで 3 回続けて同じ 9/12 を取り違えている**）
- [nit][conv:-] 同 `settled` の why が走査では観測できない性質（閉包に隠れていたこと）を根拠にしていた。HEAD でもこのテストは緑 / 対応: 修正済（T11・ラウンド2。「今後 2 ファイルの外へ広がらないこと」を守る、と書き直した）
- [nit][conv:-] 同 `code()` の説明「コメントを落とした本文」が `.vue` では成り立たない（テンプレートの `<!-- -->` が落ちず偽陽性側に出る） / 対応: 修正済（T11・ラウンド2。`<!-- -->` も落とすようにし、サーバー側との差である旨を明記）
- [must][conv:-] `review.md`「T12 変異注入の結果」R4 行 **記録した「0 →（テスト追加後）1」が再現しない**。design 指定の変異（`Attempt.settled` を常に偽）は追加テストを含めて 1 件も落とさない（点検者・私の実測とも web-ui 全 2014 件緑） / 対応: 修正済（T12・ラウンド1。実測し直して記録を全面的に書き直した）
- [must][conv:-] 同 そもそも `current === a && a.settled` は**到達しない＝等価変異**（`settled` を立てる 4 経路がいずれも同じブロックで `attempts` から外す）。どんなテストを足しても殺せないので、AC5 の「R4 の表が空振りでない」は主張できていなかった / 対応: **設計の指定を差し替え**（**D17**。規則そのものを潰す `return true` に替えて 2 件を確認）。`!a.settled` 自体は保険として残す
- [must][conv:-] `packages/web-ui/test/session-lifetime-matrix.test.ts` 追加テストの JSDoc「この 1 本を足すまでどのテストも落ちなかった」が事実と違う。`session-reconnect.test.ts`「打ち切った試行から遅れて届いた画面で、接続中に戻らない」が**T12 より前から在り**、同じ変異で落ちる（実測 2 件）。**自分の research F16 に記録した事実と矛盾していた** / 対応: 修正済（T12・ラウンド1。実際に埋めたのは `opened` の経路だけと書き直し、`error` の経路が未被覆であることを明記）
- [should][conv:-] 同 3 つの assert のうち `expect(s.client).not.toBe(clients[1])` が**構造上つねに真**（モックは `WsClient` 本体ではなく別のオブジェクトを積む）。テスト名が掲げる「口を差し替えない」を見ている行が効いていなかった / 対応: 修正済（T12・ラウンド1。`s.client.send` が元の口のままであることを見る形にし、変異でこの行が落ちることを実測）
- [should][conv:-] 同 R1 の記録が壊した場所を特定できず、字義どおりでは **0 件**（`decideDisposition` は `HolderState` ではなく `hasHolder: boolean` を受け取るので、表は `session-lifetime.ts` 内の `.held` の読みを通らない）。6 件は規則側 `i.hasHolder` を潰したときの値。あわせて `lifetimeOf` を表がまったく覆っていない事実が 1 つの数字に埋もれていた / 対応: 修正済（T12・ラウンド1。両方の実測値と理由を記録し、未被覆は D17 の積み残しへ）
- [should][conv:-] 同 R2 の記録「`isHeldAt()` の返り値を反転」は **design が明示的に禁じた形**（導出を潰すと、その導出を使わない経路が見えない）。その形では 22 件で、記録の 4 は design 指定どおり `hold.holding` の読みを反転したときの値 / 対応: 修正済（T12・ラウンド1。記述を design 指定の形に直した。数字は元から正しかった）
- [nit][conv:-] 同 R3 の記録も壊した場所が特定できず、`link.state` をファイル全体で潰すと 7 件（記録の 4 は `isResumable` 内の 2 読みだけ） / 対応: 修正済（T12・ラウンド1。`isResumable` の読みと明記）
- [nit][conv:-] 同 追加テストの `openSession({ type: "open", host: "h" } as never, "t")` の `as never` が不要（同ファイル :157 は無キャストで同じ値を渡している）。曲げた理由のコメントも無い / 対応: 修正済（T12・ラウンド1。キャストを外して型検査緑を確認）
- [nit][conv:-] 同 追加テストを**既存の JSDoc とそのテストのあいだに挟んで**おり、心拍テストのヘッダが宙に浮いていた。字下げも崩れていた（`it` が列 0） / 対応: 修正済（主エージェントが T12 点検の委譲前に自己検出。**T8・T9 に続く 3 度目の同じ誤り**）
- [must][conv:-] `review.md`「T12 変異注入の結果」R1 の見立てが誤り。「表が通らない `releaseHolder` / `lifetimeOf`」と一括りにしていたが、**`releaseHolder` は表が通る**（門を丸ごと真にすると 22 件落ちる。実測）。0 件なのは `!prev.held` が隣の `prev.token !== token` に包含される**等価変異**だから——**ラウンド1 で R4 について直したのと同じ誤りが R1 側に残っていた** / 対応: 修正済（T12・ラウンド2。理由を 2 つに分けて実測値つきで記録。`lifetimeOf` が表を通らないことは別途測って確認）
- [must][conv:-] `decisions.md` D17 R4 の差し替え変異（`isCurrentAttempt` を `return true`）は **design が明示的に禁じた「導出関数の戻り値を差し替える」形**そのもので、同じ記録が R2 についてはこの形を禁じ手として退けている。D17「影響」が R1 と R4 をまとめて「規則が読む所を壊す形」と書いていたのも事実と違う（R1 の `:185` は読み取り、R4 は戻り値） / 対応: 修正済（T12・ラウンド2。禁じ手であることを明記し、**2 項のどちらを単独で潰しても 0 件**（`current === a` 単独も実測 0）＝規則全体としてしか殺せないので他に手が無い、と理由を書いた。ずれの判断は 60 review へ）
- [should][conv:-] 同 R4 の「2」が、同じ節が宣言した計測スコープ（AC4 の表 2 本）では再現しない（スコープ内は 1 件。2 件目は範囲外の `session-reconnect.test.ts`） / 対応: 修正済（T12・ラウンド2。表を「1（＋スコープ外の既存 1）」に）
- [should][conv:-] 同 D17 が引く T9-2 の内容が出所と食い違う。「この 2 項が**別のことを問うている**ことを根拠に等価性を確認している」と書いたが、T9-2 の記録は逆に門が「**同じことを問うていた**」とし、等価の根拠を到達不能性に置いている（「別のことを問うている」は 5 つ目の系統の話） / 対応: 修正済（T12・ラウンド2。当該の引用を落とした）
- [should][conv:-] `packages/web-ui/src/session-link.ts:174-186` D17 で「`!a.settled` は保険として残す」と決めたのに、その要点も D17 への参照も**コード側に無かった**（`grep D17 packages/` が 0 件）。読み手は 2 項とも効いていると読む。AGENTS.md の二層構成（深い判断は `decisions.md`、コード側は要点＋参照）に反する / 対応: 修正済（T12・ラウンド2。`isCurrentAttempt` の JSDoc に「効いているのは第 1 項だけ・第 2 項は保険」と D17 参照を追記）
- [must][conv:-] `cross` **T10（サーバーの走査テスト）の独立点検が 1 度も回っていなかった**（他 12 タスクは 1〜2 ラウンドずつ在る）。`mode: autonomous` は自前の差分を生む全タスクに点検を求めている / 対応: 実施（`cross` 点検の指摘を受けて T10 ラウンド1 を委譲。9 件の指摘を得た——**回していれば下の `holdTimer` は T10 で出ていた**）
- [must][conv:-] `cross` **AC2 の対象フラグ `holdTimer` が走査テスト 2 本のどちらからも漏れていた**。requirements / design / tasks は「全ファイル 0 件」と書くが `gone` は 3 つだけで、「残るもの」側の `/\.hold\b/` も `\b` のせいで `.holdTimer` に当たらない＝**定義の外へ持ち出しても CI が落ちない** / 対応: 修正済（**D18**。タイマーの実体は `HoldState` に入らないので封じ込めの形で `session-manager.ts` 限定に。混入で赤くなることを実測）
- [should][conv:-] `cross` **R1 / R2 の答えが `session-manager.ts` の中で再計算されていた**（走査は同ファイルを丸ごと「内側」に置くので**構造的に検知できない**）。(1) `hasHolder()` と `disposition` のインライン、(2) `holdForReconnect()` の 3 条件と `holdable` 式、(3) `isHeldAt()` と `sweepIdle` のインライン比較 / 対応: **(1)(3) は畳んだ**（**D19**。同値を確認のうえ `this.hasHolder(id)` / `!isHeldAt(...)` へ。server 全数 1416 passed）。(2) は `holdForReconnect` が公開メソッドで自前の門を持つ必要があり畳まない——`disposition` が戻り値を捨てる脆さを D19 に明記して review へ
- [should][conv:-] `cross` `session-lifetime.ts:184` の `` `decisions.md` D10 `` が別文書を指す（この行は前 work の D10）。**直前に私が「表記を揃える」として入れた変更が原因** / 対応: 修正済（`前 work の D10` に戻した）
- [should][conv:-] `cross` T7 が `tasks.md` で `[ ]` のまま。D6 の「`tasks_done` は 12 / 14」も D12 で T9 が割れた後の 15 タスクと合わない / 対応: 修正済（T7 に `[x]`、D6 を 13 / 15 に。経緯も追記）
- [should][conv:-] `cross` AC2 の封じ込めが両側で非対称（サーバーは定義のあらゆる出現を禁じるのに、クライアントは `.link` への**代入だけ**を見る。`s.link.state` の読みは型でも走査でも止まらない） / 対応: **受け入れ**（`link` の読みは表示側にも要るので 0 件にはできない。型の壁は `connected` / `reconnect` / `reconnectFailed` に効いており、2 本目の門が生えたかは review で見る）
- [should][conv:-] `cross` 走査が縛るのは「規則」ではなく「名前」で、`/\.holder\b/` は R1 の `entry.holder` と `SessionReservation.holder`（予約者の表示名）を区別できない / 対応: **受け入れ**（改名は requirements が対象外と明記。曖昧さが網の前提になっている点は review へ）
- [nit][conv:-] `cross` 2 つの規則モジュールで語彙が揃っていない（サーバー `WsConnection.link` とクライアント `SessionState.link` が別概念、遷移の形も個別関数 vs `nextLink` 1 本） / 対応: **受け入れ**（振る舞いを変えない work で改名はできない。review の判断材料へ）
- [nit][conv:-] `cross` `packages/web-ui/test/vt-pane.test.ts:238` のインデント崩れ（web-ui は eslint 対象外で機械では止まらない） / 対応: 修正済
- [must][conv:-] `packages/server/test/lifetime-flag-containment.test.ts:44-47` D16 の why コメントが機構を誤って書いていた。サーバー側の実例は 3 件とも**文字列リテラルのルートパターン**（`"/api/admin/*"` など）で、正規表現リテラルは src に 1 件も無い——**クライアント側の文言をそのまま当てた誤り**。読み手が「該当する正規表現が無い＝この制限は不要」と読んで穴を開け直せる / 対応: 修正済（T10・ラウンド1。両側とも「文字列・テンプレート・正規表現」と実例つきで書き直した）
- [should][conv:-] 同 **行コメント除去に D16 と同種の盲点が残っていた**——文字列中の `//` を開始と誤読する。サーバーは潜在だが、**クライアントには生きた実例**（`ws-client.ts:22` の `` `${proto}//...` ``）があり、その行に違反を置くと素通りした / 対応: 修正済（T10・ラウンド1。**両側とも**行コメントも「行頭か空白の直後」に限る形へ。塞がったことと偽陽性 0 件を実測。D16 を更新）
- [should][conv:-] 同 5 本目「`disposition()` を呼ぶのは ws-handler.ts の **1 か所**だけ」が design の退けた**件数固定**（正当な後始末経路が増えただけで落ちる） / 対応: 修正済（T10・ラウンド1。「このファイル以外に出ない」の形へ）
- [should][conv:-] 同 3 本目のテスト名が `viewers` を名指しするのに走査していない（D14 で対象外にしたのが正しい）。緑を根拠に「viewers も閉じている」と読める / 対応: 修正済（T10・ラウンド1。名前から外した）
- [should][conv:-] 同 `viewers` を外した出所として D4 を引いていたが、実際に外した決定は **D14** / 対応: 修正済（T10・ラウンド1）
- [nit][conv:-] 同 `attached` の 1 本だけ `toBe(false)` で、失敗しても場所が出ない / 対応: 修正済（T10・ラウンド1。他 4 本と同じ offender 一覧の形へ）
- [nit][conv:-] 同 `inside` に `session-lifetime.ts` を足したのは design の文言より緩い側への逸脱だが、出所（architecture A1）を引いていない / 対応: 修正済（T10・ラウンド1）
- [nit][conv:-] 同 **分割代入は 5 本とも素通りする**（`const { hold } = e` は `.hold` を作らない）。design 指定の正規表現どおりで両側共通の限界 / 対応: **受け入れ**（限界としてコメントに明記）
- [nit][conv:-] 同 サーバーだけパス区切りの正規化が無い（サブディレクトリを足すと Windows で緩む側にずれる） / 対応: 修正済（T10・ラウンド1。クライアント側と揃えた）
- [should][conv:-] `packages/server/test/lifetime-flag-containment.test.ts` 5 本目の `inside` に入れた `session-manager.ts` が**効かない許可**（`\.disposition\(` は定義側にドットが無いので元から当たらない）。テスト名は 1 ファイルを約束するのに集合は 2 ファイルで、`session-manager` が `this.disposition(` を呼び始めても素通りする / 対応: 修正済（T10・ラウンド2。`ws-handler.ts` だけに絞った）
- [should][conv:-] 同 修正後も**文字列中の「空白＋`//`」は盲点のまま**で、「盲点を作るより偽陽性側に倒す」は言い過ぎだった（塞いだのではなく狭めただけ） / 対応: 修正済（T10・ラウンド2。**正規表現の重ね掛けをやめて簡易スキャナに置き換え**。D16 を更新）
- [should][conv:-] 同 **行コメントの中に `/*` を書くと、ブロック除去が先に走って次の `*/` までを領域ごと食う**（1 行ではなく領域が消えるのでこちらが重い。この PJ はコメント記法を地の文で論じるので現実味がある） / 対応: 修正済（同上のスキャナで解消。実測で赤化を確認）
- [nit][conv:-] 同 クライアントの `<!--` 除去だけ位置無制限で、硬くした 2 つと非対称だった / 対応: 修正済（スキャナで一様に扱う。実測で赤化を確認）
- [nit][conv:-] 同 出所の取り違え——行コメント側の穴を見つけたのは **T10** の点検なのに「T11 の点検が見つけた」と書いていた（段落を広げた際に古い出所が残った） / 対応: 修正済（T10・ラウンド2）
- [nit][conv:-] 同 「分割代入が素通りするのは**両側共通**の限界」が誤り。ドットで固定しているサーバー側 3 本だけの限界で、クライアントの `\bsettled\b` などは分割代入を捕まえる / 対応: 修正済（T10・ラウンド2。ドットを外せない理由（`SessionReservation.holder` を拾う）も併記）
- [should][conv:-] `cross`(r2) コメント除去 `code()` が走査テスト 2 本へ**逐語複製**されており、同一性を守る仕組みが無かった（現時点は 42 行バイト一致だが、この work は片方だけ直る事故を 3 度踏んでいる）。architecture A4 と組合せ表は同じ形を明示的に退けている / 対応: 修正済（`packages/web-ui/test/source-scan.ts` に切り出し、表と同じ向き（server/test → web-ui/test）で両側から import。5+5 本緑・型検査 0・死角の赤化を再確認）
- [should][conv:-] `cross`(r2) **AC2 の対象集合が requirements と design/D4 で食い違う**（`resumability` が design 側にだけ在る。requirements は「13 個そのものだけ」と宣言） / 対応: **D20-1 として review へ**（実装は design に従っている。規範の側を直すかは設計判断）
- [should][conv:-] `cross`(r2) **AC1 は導出の戻り値を「列挙された状態」と定めるのに、R3 / R4 の導出は真偽値**（design 自身が `resumable(s): boolean` と書いており、食い違いは design の時点で生じていた）。実際 `startReconnect` が門1 を規則の外で再評価しており、走査はファイル粒度なので構造的に検知できない / 対応: **D20-2 として review へ**
- [nit][conv:-] `cross`(r2) D18 の「走査が 4 本になる」が実際は 5 本 / 対応: 修正済
- [nit][conv:-] `cross`(r2) D19 の引く行番号が 1 行ずれ（`:1505` はコメント行。実体は `:1506`） / 対応: 修正済
- [nit][conv:-] `cross`(r2) D14 が `viewers` を外した理由「公開メソッドを足すことになり AC6 の趣旨に反する」が、**本 work 自身が `disposition()` を足していること**と矛盾（AC6 が禁じるのは削除・シグネチャ変更） / 対応: 修正済（結論は別の理由で立つので、理由の側だけ訂正）
- [nit][conv:-] `cross`(r2) design が 2 か所で指定した `idleLimitOf` → `lifetimeOf` の改名が未実施（tasks T5 は `[x]`） / 対応: **D20-3 として review へ**（純粋側の `lifetimeOf` と同名になるため、どちらを正とするかは設計判断）

## T12 変異注入の結果（T13 で `test-result.md` へ写す）

**計測スコープ**は AC4 の表 2 本——`packages/server/test/session-lifetime-matrix.test.ts` と
`packages/web-ui/test/session-lifetime-matrix.test.ts`。**変異は作業ツリーに残していない**（design「対象範囲」）。
design「AC5」の指示どおり**導出関数の戻り値ではなく定義を読む所**を壊した。

| 規則 | 入れた変異（そのまま再現できる形） | 落ちた件数 |
| --- | --- | --- |
| R1 持ち主 | `session-lifetime.ts:146,238` の `prev.held` / `holder.held` の読みを `true` に | **0** |
| R1 持ち主（規則側） | 同 `:185` `decideDisposition` の `i.hasHolder` を `true` に | 6 |
| R2 猶予 | 同 `:165,193` の `hold.holding` の読みを反転 | 4 |
| R3 繋ぎ直し | `session-link.ts` `isResumable` の `r` / `link.state` の読みを `"resumable"` / `"lost"` に | 4 |
| R4 試行 | 同 `:186` の `!a.settled` を `!false` に（design が指定した形） | **0（等価変異）** |
| R4 試行（規則側） | 同 `:186` を `return true;` に | 1（＋スコープ外の既存 1） |

**この表の 3 行が、当初の記録の誤りを正したもの**（T12 のタスク点検が [must] 3 件で指摘し、実測で確認した）。

- **R1 は design の字義どおりでは 0 件だが、理由は 2 つに分かれる**（当初は「表が通らない」と
  一括りにしていた。R4 で直したのと同じ誤りが R1 側に残っていた）。
  - `releaseHolder:146` は**表が通る**——門を丸ごと真にすると 22 件落ちる。`!prev.held` 単独が 0 なのは
    **等価変異**で、`held: false` の枝は `token` を持たないため `prev.token !== token` が包含するから。
  - `lifetimeOf:238` は**表がまったく通らない**——門を丸ごと真にしても 0 件。
    server 全体では `session-reconnect-grace.test.ts` の 3 件が落ちる。
  - 規則が読む「持ち主が居るか」（`:185` の `i.hasHolder`）を潰すと 6 件。
    `decideDisposition` は `HolderState` ではなく `hasHolder: boolean` を入力として受け取る設計で、
    `HolderState` を読むのは呼び出し側（`session-manager.ts:1496`）。
- **R2 は当初「`isHeldAt()` の返り値を反転」と記録していたが、これは design が明示的に禁じた形**
  （導出を潰すと、その導出を使っていない経路が見えないままになる）。その形では 22 件落ちる。
  定義の読みを反転した 4 件が正しい値。
- **R4 は design が指定した形が等価変異だった**（D17）。`current === a && a.settled` は到達しない
  ——`settled` を立てる 4 経路（`next()` / `opened` / `error` / `abortReconnect`）がいずれも
  同じ同期ブロックで `attempts` から当該試行を外すので、第 1 項だけで必ず偽になる。
  **どんなテストを足しても殺せない**ので、規則そのものを潰す形に替えて 2 件を確認した。

**当初「R4 は 0 件だった」と書いたのは、原因の見立ても間違っていた。** 「どのテストも覆っていなかった」
としたが、`screen` の経路は `session-reconnect.test.ts`「打ち切った試行から遅れて届いた画面で、
接続中に戻らない」が前から押さえている（research F16 に自分で記録していた）。**実際に穴だったのは
`opened` の経路だけ**（F17-(3)）で、そこを足した 1 本と既存の 1 本が `return true` で揃って落ちる。
**`error` の経路（`session-controller.ts:465`）は依然として覆われていない**——本 work では埋めない
（振る舞いを変えないため）。T14 で backlog へ回す。

## ラウンド 1（2026-09-10T04:15:00Z）

観点は protocol.md「2.5」の三段階。PJ 固有のレビュー skill は無いので、**組み込みの `/code-review`（high, `packages` 限定）を併用**し、
そこがカバーしない**要件適合 / 価値適合 / 規約適合**はこの工程で自分で見た。
`aidev coverage` は gap 0（tasks 承認時と同じ。`ac_drift` 無し）。
**coding のタスク点検（124 件）で既に潰れた指摘は再掲しておらず、件数にも数えていない。**

### 指摘

- [must][conv:-] **AC1 の「導出の戻り値は列挙された状態」が R3 で満たされておらず、AC1 が防ごうとしている失敗が実際に起きている。**
  `isResumable` が `boolean` を返すため、`session-controller.ts:344` が
  `if (s.resumability === "not-resumable") s.notice = MSG_CONNECTION_LOST;` と**規則の外で門1 を再評価**している
  （`:331` で `isResumable` を呼んだ直後に、同じ入力から別の答えを組み立て直している）。
  requirements AC1 は「呼び出し側は下位フラグを読まず、導かれた関数の**戻り値だけ**で分岐している。
  その戻り値は列挙された状態で、呼び出し側が真偽値を組み合わせ直せない形」と定める。
  design が `resumable(s): boolean` と書いていたので**実装は design どおり**だが、
  design と requirements が食い違っており、**受け入れ基準の側が「完了」の定義**なので満たしていない。
  これは前 work が 3 ラウンド繰り返した「直した項の隣が壊れる」の芽そのもの——通知の出し分けを変えたい人は、
  いま `isResumable` と `startReconnect` の 2 か所を直す必要がある。
  **直し方**: `isResumable` を `{ resume: true } | { resume: false; why: "notResumable" | "reconnecting" | "hostEnded" | "gone" }`
  のような列挙に変え、`startReconnect` は `why` で分岐する（現行の 4 門と 1:1 なので振る舞いは変わらない）。
  design の当該行もあわせて直す。
- [should][conv:-] **価値適合: 「写しが再び増えたら CI が落ちる」（目的 3 つ目・US3）が `session-manager.ts` の中では成立していない。**
  走査は同ファイルを丸ごと「内側」に置くので、**同一ファイル内の再計算は構造的に見えない**。
  実際 D19 の 2 件（`hasHolder` の重複・`isHeldAt` の重複）を見つけたのは CI ではなく `cross` 点検で、
  いま同じ写しが再発しても CI は落ちない。**投資が次の変更で消える**という US3 の懸念がそのまま残っている。
  少なくとも「走査が守る範囲」と「守らない範囲」を requirements / design に明記し、follow-up を backlog に起こすこと。
- [should][conv:-] `packages/web-ui/src/session-link.ts:155-157` `Attempt` の docstring が
  「5 つ目（`s.client === client`）は畳まない」とだけ書き、**その項が必要な場所で欠けている事実に触れていない**。
  メッセージ共通のガード（`session-controller.ts:479`）は `isCurrentAttempt` だけを見るため、
  **繋ぎ直し成功後の全フレームが落ちる**（D13）。読み手はこの docstring から「畳み込みは完全」と読める。
  D13 は本 work では直さない方針なので、**直さないことと、その帰結を docstring から辿れるようにする**。
- [should][conv:-] D19 の畳み込み（`session-manager.ts:1496` / `:1751`）が、コメントで「`cross` 点検」とだけ書き
  **`decisions.md` D19 を参照していない**。AGENTS.md「深い設計判断は `decisions.md` に切り出し、コードから参照する（二層構成）」。
  **T12 ラウンド2 で D17 について同じ指摘を直したばかりの再発。**
- [should][conv:-] **requirements の AC2 対象集合（3 列目・13 個）と、design / 実装が守っている集合が `resumability` の 1 件ずれている。**
  D4 は「R3 の静的な性質を `resumability` に畳んで**そちらを対象に含める**／requirements の表はこの変更に合わせて更新した」と
  書いているが、表に `resumability` は無い（`grep` で requirements 全体に 1 箇所＝D4 の説明文のみ）。
  requirements は「3 列目に挙げた 13 個そのものだけ／『等』で開かない」と宣言しているので、
  **規範として宣言した集合と CI が守っている集合が食い違う**。実装のほうが広い（＝穴ではない）が、表を直すこと。
- [nit][conv:-] `isCurrentAttempt` も `boolean` を返し AC1 の文言とは合わないが、
  呼び出し側 3 箇所はいずれも純粋なガード（`if (!isCurrentAttempt(...)) return;`）で**組み合わせ直していない**ので、
  AC1 が防ごうとしている失敗は起きていない。R3 と同時に直すなら揃えてよいが、単独では直す理由が無い。
- [nit][conv:-] `SessionManager.releaseHolder` / `hasHolder` が `disposition` とテストからしか到達しない公開面になった
  （`/code-review` の指摘）。**AC6 が「1 つも消さない」と定めているので意図どおり**。将来 AC6 の縛りが外れたら整理の候補。

### `/code-review`（組み込み・high）の結果

HIGH 1 件。**D13 と同じ箇所**（`session-controller.ts:479`）を、より具体的な失敗像つきで挙げた——
繋ぎ直し成功後は `screen` / `key-done` / `reserved` / `pc-command` / `jobinfo` / `closed` / `error` が
**すべて `applyDisplayMessage` に届かない**。実測での帰結は「利用者が Enter を押しても画面が更新されず、
`setBusy(false)` に到達しないので**スピナーと入力保護が永久に残る**」。
`HEAD` の `pendingResumes.get(id)?.client !== client` も同じ効果なので **pre-existing** という判定は D13 と一致。
→ requirements の非機能要件（バグは直さず記録して backlog へ）に従い**直さない**。
この失敗像を D13 に取り込み、T14 の起票に載せる。

同レビューは他に、`decideDisposition` の門の順序 / `holdable` / `sweepIdle` の `!isHeldAt` /
`lifetimeOf` / `nextLink` / `abortReconnect` を旧実装と 1 つずつ突き合わせ、**いずれも同値**と確認している。
また `updateScreen` の遷移が広がった件について「**D13 を直すためにガードを緩めるなら、到達しない根拠を検査し直す必要がある**」と
注意を付けており、これは D13 の「影響」に加える。

### 判定

**must 1 / should 4** のため coding へ差し戻す。nit 2 は差し戻しの理由にしない。

### ラウンド 1 の対応（coding 差し戻し後）

- **must（AC1 / R3）**: 修正済。`isResumable`（真偽）→ **`resumeVerdict`（列挙）**。
  `startReconnect` は `v.why` で分岐し、`s.resumability` の読み直しを消した。
  真偽を返す名前のままにできないので改名した（`is` 接頭辞は真偽の含み）。
  **同値性は全分岐で確認**（D21）。design の該当行（`resumable(s): boolean`）も直した。
  副次的に **AC5 の R3 変異が 4 → 5 件**に増えた。
- **should（価値適合 / 走査の穴）**: design「AC2 の詳細」に**「走査が守らない範囲」**を 3 つ明記し、
  D19 の「影響」にも追記。同一ファイル内の再計算は architecture A1 の粒度に由来するので本 work の手段では塞げない
  ——**follow-up として T14 で backlog へ回す**。
- **should（`Attempt` の docstring）**: 修正済。畳まなかった 5 つ目の項が**必要なのに欠けている場所**（D13）と、
  その帰結（繋ぎ直し後に画面が固まる）、直さない理由を docstring から辿れるようにした。
- **should（D19 の参照）**: 修正済。`session-manager.ts` の 2 箇所が `decisions.md` D19 を参照するようにした。
- **should（requirements の表）**: 修正済。`resumability` を 3 列目に追加し「13 個」→「14 個」に。
  表の更新履歴（D4 で足した／D14 で外した／ラウンド1 で導出を改名した）を注記として残した。
- **nit 2 件**: 対応しない（`isCurrentAttempt` の真偽は組み合わせ直しが起きていない／
  `releaseHolder`・`hasHolder` の公開面は AC6 が残すと定めている）。

検証: server 1416 passed / 3 skipped、web-ui 2014 passed、型検査 0、lint 0。

## ラウンド 2（2026-09-10T04:40:00Z）

**ラウンド1 の修正そのもの**を見た（この work は「ラウンド2 の指摘がラウンド1 の修正から出る」が繰り返し起きている）。
must の同値性は D21 のとおり全分岐で確認済みで、**振る舞いに関わる指摘は無い**。
コメントの正確性で 2 件。どちらもその場で直した。

### 指摘

- [nit][conv:-] `packages/web-ui/src/session-link.ts` `resumeVerdict` の JSDoc に**ラウンド1 で私が足した例が誤り**。
  「門1 と門4 は同時に成り立ちうる」と書いたが、`reconnecting` になるのは門を通った後だけなので
  `resumability` は必ず `resumable`——**門4 とは重ならない**。同時に成り立つのは**門1 と門2/門3**
  （見に来ただけのタブでホストが終わった、など）で、順序が `why` を決めるのはそちら / 対応: 修正済（ラウンド2）
- [nit][conv:-] `packages/web-ui/src/session-controller.ts` の `review ラウンドN` 参照が **work をまたいで曖昧**になった。
  既存 6 件は**前 work**のラウンドを指すのに、ラウンド1 で私が足した 2 件は**本 work**を指し、
  同じコメント塊に混在していた（`:337` の「review ラウンド2」と `:347` の「review ラウンド1 の must」）。
  同ファイル内の他の参照は `前 work の D10` のように work を明示している / 対応: 修正済（ラウンド2。
  8 件すべてを `前 work の` / `本 work の` で明示。**ラウンド1 の追記が、既存の曖昧さを実害に変えた形**）

### 判定

**must 0 / should 0 / nit 2**。差し戻しはしない（nit はその場で修正済み）。
検証: 型検査 0、関係するテスト 67 件緑。全数はラウンド1 対応後に取得済み（5664 passed / 0 failed / 41 skipped）。

### 通算（work 全体）

| ラウンド | must | should | nit |
|---|---|---|---|
| 1 | 1 | 4 | 2 |
| 2 | 0 | 0 | 2 |
| **計** | **1** | **4** | **4** |

（coding のタスク点検 124 件は母集団が違うので数えていない。`taskcheck status` の記録が別に残っている）

## 条項タグについて（retro への材料）

`.aidev/conventions/` が空なので、全指摘を `[conv:-]` にしてある（protocol.md「8.」——
「PJ に条項がまだ無いなら全て `[conv:-]` でよい。それ自体が最初の材料になる」）。
当初 `conv:agents` という id を書いていた 32 件は実在しない id で、`aidev approve review` が警告した。

**ただしその 32 件は 1 つの観点に集中している**——AGENTS.md「コメントの残し方（意図中心）」の
うち**判断の出所の書き方**。内訳は **must 6 / should 12 / nit 14**。具体的には:

- 実在しない D 番号・別 work の D 番号を引く
- **同じ work で消える行**を恒久コメントから行番号で指す
- 出所に書かれた数と食い違う数を書く（`9` と `12` の取り違えは 3 回連続で出た）
- 「読むのは X だけ」と、読み手を数え切らずに書く
- work をまたぐ参照（`前 work の D10` / `review ラウンド2`）を修飾せずに書く

**この観点は型検査でも変異注入でも検出できない**——独立点検だけが見つけている。
条項として起こすなら `aidev-95-retro` が担当（`protocol-conventions.md`「条項を起こす」）。
baseline はこの work 単体で **32 件**（must 6 / should 12 / nit 14）。
