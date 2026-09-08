# レビュー記録

## タスク点検ログ（coding 工程内・`protocol.md`「3.3」(b)）

- [should][conv:-] `session-manager.ts:claim/isHolder` 表示セッションしか見ておらず、`ws-handler` の
  `sessionId` に入るプリンター id で「記録しないままトークンを返す」。`close`/`touch` と非対称 /
  対応: 修正済（両マップを見る。`PrinterEntry` にも欄を追加。T1・ラウンド1）
- [should][conv:agents] `SessionEntry.holder` が既存の `SessionReservation.holder`（予約の持ち主）と
  同名で別概念 / 対応: 修正済（`holderToken` に改名。T1・ラウンド1）
- [should][conv:agents!] 新設コメントが背景を散文で書くだけで出所を挙げていない（周辺は
  `research D5` / `design D3` のように必ず出典を書いている） / 対応: 修正済（decisions D7 を参照。T1・ラウンド1）
- [nit][conv:agents!] 「最大 90 秒」が裸の数字。定数名（`HEARTBEAT_DEAD_MS`）を併記しないと
  値を変えた瞬間にコメントが嘘になる / 対応: 修正済（T1・ラウンド1）
- [should][conv:-] 猶予タイマーが「どの猶予か」を見ておらず、解除後に張り直された別の猶予まで
  畳みうる（隣の `setReservation` は実体比較で同じ問題を閉じている） /
  対応: 修正済（`cur.holdTimer === timer` で同一性を見る。T2・ラウンド1）
- [should][conv:-] マップから消える他の 2 経路（`open` の `closed` ハンドラ・`closeAll`）が
  `holdTimer` を落としておらず、同じ id で開き直すと古いタイマーが新しい猶予を畳む /
  対応: 修正済（T2・ラウンド1）
- [should][conv:-] `sweepIdle` の猶予切れ刈りが `recorder.stop()` を呼ばず、`close` 経由と
  後始末が食い違う / 対応: 修正済（T2・ラウンド1）
- [should][conv:agents!] 猶予まわりのテストが 1 件も無い（AGENTS.md「変更ごとにユニット/
  コンポーネントテストを追加し回帰資産化する」） / 対応: T5 で消化（テストは独立タスク。T2・ラウンド1）
- [nit][conv:agents] `holdForReconnect` の `boolean` の意味が JSDoc に無く、`false` が 3 通りを
  兼ねるため「閉じてよい」と誤読されうる / 対応: 修正済（`@returns` に明記。T2・ラウンド1）
- [nit][conv:agents] `isHeld` が期限を見ておらず、`reservationOf` の「読み取り時に期限を見る」
  方針と揃わない / 対応: 修正済（T2・ラウンド1）
- [should][conv:-] 猶予中のセッションにも素の attach ができる（セッション管理・MCP）のに、
  猶予タイマーが `hasViewer` を見ずに無条件で閉じるため、**使っている人の足元で閉じる** /
  対応: 修正済（`reapHold` を新設し、見ている人が居れば猶予を解いて普通のセッションに戻す。
  `sweepIdle` の保険側も同じ規則に揃えた。T3・ラウンド1）
- [nit][conv:agents!] 更新した既存テスト 2 件が `mgr.size` しか見ておらず、「猶予に入る」を
  固定できていない（保持者照合が誤って false になる退行を緑のまま通す） /
  対応: 修正済（`isHeld` まで見る。T3・ラウンド1）
- [nit][conv:-] プリンターを同じ ref で 2 タブ開くと後のタブが保持者を奪い、先のタブの切断では
  閉じなくなる（従来は即閉じ） / 対応: 意図した改善として decisions D8 に記録（T3・ラウンド1）
- [nit][conv:agents!] 新設コメントの `decisions D5 / D7` が裸で、どの work の decisions か辿れない
  （`ws-handler.ts` は多数の work が触る合流点） / 対応: 修正済（work スラグを添えた。T3・ラウンド1）
- [should][conv:-] 2 つの接続が続けて `resume` すると、新しい持ち主が先に去った場合に
  **どちらもセッションを閉じない**（残った古い接続は「交代済み」として何もせず抜ける）。
  D4 が塞ごうとした孤児化が別経路で残る / 対応: 修正済（`isHolder`（見るだけ）を
  `releaseHolder`＋`hasHolder` に変え、「自分が持ち主だった」か「いま持ち主が居ない」の
  どちらかなら畳む。T4・ラウンド1。decisions D10）
- [should][conv:agents!] `attach` の JSDoc が `resume` に触れず、「状態を変えない」という
  ヘッダの記述が新しい振る舞いと矛盾する / 対応: 修正済（T4・ラウンド1）
- [should][conv:agents!] `resume` を通るテストが 1 件も無い / 対応: T5 で消化（T4・ラウンド1）
- [nit][conv:agents] `sessionId` 無しの `resume: true` が黙って新規 open になることが
  どこにも書かれていない / 対応: 修正済（`attach` の JSDoc に明記。T4・ラウンド1）
- [nit][conv:agents] `kind: "printer"` / `terminal: "3270"|"vt"` と併用した `resume` が
  黙って無視されることが読めない / 対応: 修正済（同上。T4・ラウンド1）
- [nit][conv:agents] `attach(sessionId, resume)` の位置引数 bool が、兄弟の
  `dispose(reason, { transportLost })` とスタイルが割れている /
  対応: 修正済（オプション object に寄せた。T4・ラウンド1）
- [must][conv:-] 「猶予の対象は 5250 表示セッションだけ（AC8）」の節にプリンター／3270／VT の
  検査が 1 件も無い（変異注入で、非常駐プリンターが永久に閉じなくなる退行が全緑のまま通った） /
  対応: 修正済（プリンターの即閉じ／`sessionId` 無しの `resume` を追加。T5・ラウンド1）
- [must][conv:-] 「復帰済みを古い接続が閉じない」が既存の `otherViewers` で先に抜けており、
  新設した保持者ガードを一切押さえていない（ガードを無効化しても全緑） /
  対応: 修正済（在席を数えないプリンター経路で書き直し。変異注入で落ちることを確認。T5・ラウンド1）
- [must][conv:-] 「resume 無しの attach は従来どおり」も `otherViewers` で通っており、
  `attached` の区別を押さえていない（全 attach を持ち主にする退行が全緑） /
  対応: 修正済（`mgr.open()` で開いて見る人だけ WS を持つ形に。変異注入で落ちることを確認。T5・ラウンド1）
- [should][conv:-] 「期限が来れば閉じる」が叩いているのは掃除役で、本筋のタイマー経路
  （`reapHold`）が一度も走っていない / 対応: 修正済（偽タイマーで本筋を通す検査を追加し、
  掃除役側は「保険の経路」として名前を分けた。T5・ラウンド1）
- [should][conv:-] 「期限を延ばさない」が返り値しか見ておらず、`heldUntil` を上書きする退行を
  捕まえられない / 対応: 修正済（元の期限で刈られることまで見る。T5・ラウンド1）
- [should][conv:-] 「resume が閉じる責任を引き継ぐ」のタイトルと assertion がずれている
  （猶予にも期限にも触れていない） / 対応: 修正済（タイトルを実態に直し、転送断で再び猶予に
  入る検査を別に追加。T5・ラウンド1）
- [should][conv:-] 他人のセッションの resume 拒否が `type === "error"` の有無だけで理由を問うて
  いない / 対応: 修正済（`code: "FORBIDDEN"` まで見る。T5・ラウンド1）
- [nit][conv:-] コメントが「心拍が尽きる」と書いているのに呼んでいるのは `onSocketClose` /
  対応: 修正済（同じ `transportLost` の経路である旨に書き換え。T5・ラウンド1）
- [nit][conv:-] `openNew` の `...(user ? {} : {})` が死コード / 対応: 修正済（T5・ラウンド1）
- [nit][conv:-] `session-attach.test.ts` に足した 2 本と実質重複 /
  対応: 修正済（`reconnectGraceMs: 0` の重複を新ファイルから外した。T5・ラウンド1）
- [nit][conv:-] `WsConnection` の心拍タイマーが残る（unref していない、との指摘） /
  対応: 対応不要——`ws-handler.ts:452` で `unref?.()` 済み。指摘の前提が誤り（T5・ラウンド1）
- [should][conv:-] 「`undefined` なら試していない」は誤り。`exactOptionalPropertyTypes` 下では
  `undefined` 代入は型エラーで、解除は `delete`（周辺の `setReserved` と同じ） /
  対応: 修正済（「未設定＝…、解除は `delete`」に。design.md の記述も揃えた。T8・ラウンド1）
- [should][conv:-] 解除の担い手がコメントにも store の操作にも無く、復帰後に `reconnectFailed`
  が残ると手動ボタンが出たままになる / 対応: 修正済（「立てるのも消すのも再接続ループ」と明記。
  T8・ラウンド1）
- [should][conv:-] 既存 `connected` との関係が書かれておらず、表示の優先順（切断 vs 再接続中）を
  T9 が取り違えうる / 対応: 修正済（`connected === false` の間だけ立つ・再接続中を優先、と明記。
  T8・ラウンド1）
- [should][conv:agents!] 判断の出所（work スラグ／design の節）が無く、周辺の新設フィールドの
  流儀（`spec D5` 等）と揃わない / 対応: 修正済（T8・ラウンド1）
- [nit][conv:-] `attempt` の基準（1 始まりか）と `max` の出所が無く、配線側が off-by-one を
  踏みやすい / 対応: 修正済（T8・ラウンド1）
- [nit][conv:-] 同じ interface の `state: "reconnecting"`（サーバー ↔ ホスト）と層が違うのに
  名前が近い / 対応: 修正済（「ブラウザ ↔ サーバー」と明記。T8・ラウンド1）
- [should][conv:-] 見張りが発火したあとの復帰が `close` イベント頼み一本で、半開きでは
  そのイベント自体が遅れる／来ない。90 秒かけて死を判定した意味が薄れる /
  対応: 修正済（`close()` 後 3 秒の保険を張り、後始末を `notifyClosed` に一本化して
  二重に流れないようにした。T6・ラウンド1）
- [should][conv:-] 監視コンソールの `WsClient` にも `ping` が来るので見張りが張られるが、
  あちらは `onClose` を渡しておらず、閉じると「接続中」の見た目のまま送信だけ捨てられる /
  対応: 修正済（**`onClose` を渡している相手のときだけ**見張る。T6・ラウンド1）
- [nit][conv:-] 同一インスタンスで `connect()` を 2 回呼ぶと、旧ソケットの `close` が
  新しい接続の見張りを外す / 対応: 修正済（ハンドラにソケットを添えて同一性を確かめる。
  T6・ラウンド1）
- [nit][conv:-] `armPingWatchdog` の JSDoc「受信のたび」が実際の「`ping` 受信のたび」より
  広く読める / 対応: 修正済（T6・ラウンド1）
- [nit][conv:-] 見張りの回帰テストが無い / 対応: T10 で消化（`FakeSocket.close()` が close
  イベントを発火しない点は T10 で手当てする。T6・ラウンド1）
- [nit][conv:-] `applyDisplayMessage` の JSDoc が「開いたあとの受信処理」と言い切っているが、
  `default:` 経由で `opened` 到達前（`sessionId` が空）のメッセージも流れる /
  対応: 修正済（「`opened` 以外の受信処理（`sessionId` が未確定のうちにも呼ばれうる）」に。
  T12・ラウンド1）
- [must][conv:-] `closeSession` が待ちタイマーしか畳まず、**発火済みで飛行中の試行を止められない**
  ——`opened` が返るとサーバー側は `cancelHold`＋`claim` 済みで、閉じたはずのセッションが
  持ち主不在で生き残る / 対応: 修正済（飛行中の口を `pendingResumes` で掴み、`abortReconnect`
  で畳む。`opened` 時に store から消えていたら `close` を送ってから畳む。T7・ラウンド1）
- [must][conv:-] 繋ぎ直しの `opened` から `reservedBy` / `pcCommands` / `job` を取り込んでおらず、
  切れている間に予約が解除／開始されていると覆いの有無が実態とずれる。「黙って実行しない」も
  繋ぎ直しでだけ破れる / 対応: 修正済（`ccsid` だけは既定値が返るので上書きしない。T7・ラウンド1）
- [must][conv:-] `retryReconnect` が走行中の印を残したままタイマーだけ畳むため、**二度と動かなく
  なる**（ボタン連打・キーリピートで踏める） / 対応: 修正済（印を先に落としてから入る。T7・ラウンド1）
- [should][conv:-] 1 回の試行に時間切れが無く、`opened` も `error` も返らない黙り方でループが
  止まる（半開きの見張りは最初の `ping` 前には張られない） /
  対応: 修正済（10 秒で口を閉じ、既存の `onClose` 経路へ合流。T7・ラウンド1）
- [should][conv:-] 未接続ガードの理由が事実と違う——`connected` はホスト側セッション終了でも
  落ちるが、そのとき転送は生きている / 対応: 修正済（`MSG_SESSION_ENDED` を分けた。T7・ラウンド1）
- [should][conv:-] 「もう再試行しない」という決定が状態に残らず、別経路の `startReconnect` で
  はしごを回し直せる / 対応: 修正済（`reconnectFailed` を `"retry" | "gone"` の理由に変え、
  `"gone"` では入り直さない。T7・ラウンド1）
- [nit][conv:-] `giveUpReconnect` の `retry` が常に false で、打ち切り側だけ状態の書き込みが
  別にある / 対応: 修正済（打ち切りも `giveUpReconnect` に寄せた。T7・ラウンド1）
- [nit][conv:-] テストの `advanceTimersByTime(1000)` が再接続の 1 回目（800〜1200ms）と重なり、
  実行のたびに通る経路が変わる / 対応: 修正済（700ms に。T7・ラウンド1）
- [must][conv:agents!] `.retry` の意匠が設置面（CRT ペイン）の系統から外れている
  （`docs/UI-DESIGN.md`「ボタン意匠（面の系統に合わせる）」はクローム側 `--accent` ではなく
  `.fk` に合わせよと定めている。既定ライトではコントラストも AA 未満） /
  対応: 修正済（`class="fk retry"` にして端末パレットの `--t-yellow` で差をつける。T9・ラウンド1）
- [should][conv:-] ボタンを Enter で押すと keydown がペインまでバブルして Enter AID も飛び、
  直後に無関係な操作員メッセージが出る（AC-I3 の経路でだけ起きる） /
  対応: 修正済（`@keydown.enter.stop`。T9・ラウンド1）
- [nit][conv:agents] `var(--accent, #6cf)` のフォールバックが到達不能かつ生色 /
  対応: 修正済（トークンだけを使う。T9・ラウンド1）
- [nit][conv:-] `title` が可視ラベルと同一で情報が増えない（このファイルは「表示は短く、
  意味は `title` へ」の使い分け） / 対応: 修正済（動作の説明に。T9・ラウンド1）
- [nit][conv:agents!] `.retry` の CSS コメントだけ出所が無い / 対応: 修正済（UI-DESIGN と
  work スラグを引いた。T9・ラウンド1）
- [nit][conv:-] `@reconnect="retryReconnect(props.sessionId)"` の `props.` がテンプレート内で
  唯一の書き方 / 対応: 修正済（T9・ラウンド1）
- [nit][conv:-] `role="status"` を本文の変化と同じパッチで後付けするため、最初の 1 回を
  読み上げない AT がある / 対応: 対応不要——同ファイルの `.macro` と同型で、design「4. 表示」
  どおり。2 回目以降は変化として読まれる（T9・ラウンド1）
- [nit][conv:agents] `.ime` の `min-width: 7em` が「再接続中 (1/5)」で効かず、右側が動く /
  対応: 対応不要——既存の「〜が操作中」も同じ長さで溢れており、この work だけの問題ではない
  （T9・ラウンド1）
- [nit][conv:-] Space では押せず「保護」メッセージが出る（`.fk` 等の既存ボタンも同じ） /
  対応: 対応不要——AC-I3 が求めるのは Enter。既存踏襲（T9・ラウンド1）
