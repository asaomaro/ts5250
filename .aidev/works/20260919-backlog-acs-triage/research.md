# 調査: backlog 全件の要否判定と ACS との差異の洗い出し

> 変更前（HEAD `65f88e64`）のスナップショット。「判明した事実」と「design への申し送り」を混ぜない。
> 実機の識別子（システム名・ライブラリ名・装置名・ホスト）は書かない。実機とは `.env.verify` の `AS400_*` を指す。

## 調査の問い

- Q1: 未着手の backlog 16 件は、それぞれ今も対応が要るか（requirements の FR1 の区分で答える）。
- Q2: ACS のコアのうち未突き合わせの領域に、実害のある差異は残っているか。
  - 対象の領域は次の 3 つ。
    1. DS5250 の WTD 以外のコマンド
    2. キー入力・編集・AID・施錠
    3. telnet の交渉とプリンター
- Q3: 実測に使える手段は何か。requirements「未確定事項」の自動化の可否。
- Q4: 利用者の「待たされる」報告（backlog の項目 8）は、どの変更から来ているか。

## 検証の深さの表記

protocol「2.6」は、一次資料との照合をサブエージェントに任せ切らないことを求めている。
そのため、主エージェント（この文書の書き手）が**自分で確かめた深さ**を事実ごとに付ける。

| 記号 | 意味 |
|---|---|
| ◎ | 実機で実測した（ACS 側・当 PJ 側の一方または両方） |
| ○ | 主エージェントが ACS 側と当 PJ 側の両方を直読した |
| ◐ | 主エージェントは片側だけを直読した。残りの片側は委譲先の報告 |
| △ | 委譲先の報告だけ（委譲先は両側を読んだと報告しているが、主は再読していない）。**修正に着手する work で、最初に両側を再確認すること** |

## 判明した事実

### F0 調査の手段（Q3）

- **F0-1 ACS のデコンパイル。**
  - `IBMiAccess_v1r1/acsbundle.jar` から `plugins/emulator/acshod2.jar` と `acs5250.jar` を取り出し、CFR 0.152 で
    `com.ibm.eNetwork.{ECL,beans.HOD,HOD,HODUtil}` をデコンパイルした（1,322 ファイル）。置き場は scratchpad で、リポジトリには入れていない。
  - CFR には欠落がある。`DS5250.processWriteErrorCode` は、`processWriteToDisplay` の呼び出しが出力から抜けていた。
    見た目が不自然な箇所は `javap -c` で確かめる（委譲先 C の報告。バイトコードのオフセット 281）。
- **F0-2 ACS のコアを実機に当てる。** ◎
  - `acshod2.jar` の HACL（`ECLSession` / `ECLPS.SendKeys` / `GetScreen` / `GetCursorPos` / `ECLOIA.InputInhibited`）を
    自作の Java から呼ぶと、GUI 無しで ACS 側の画面・カーソル・入力禁止の状態が取れる。
  - これで「ACS の起動は利用者の協力が前提」という制約（acs-parity の項目 14・15）の前提が変わる。
    ただし取れるのはコアの挙動で、GUI 固有の経路（例: 打鍵が `ECLPS.SendKeys` を通るか）は取れない。
- **F0-3 当 PJ のコアを実機に当てる。** ◎
  - `packages/tn5250/dist` の `Session5250` に `traceRecords: true` を付けると、受信レコードの生バイトと到着時刻が取れる。
- **F0-4 ブラウザ経由の実測。** ◎
  - サーバー（`buildApp`）と Playwright の間に TCP 中継を挟むと、瞬断が作れる。作れるのは次の 3 通り。
    - RST で切る
    - 接続を拒否する
    - 黙って止める（半開き）
  - 時間を測るときは、**ページ内の時計**で WebSocket の送受信と DOM の変化に時刻を打つ。
    Playwright の `framesent` / `framereceived` は CDP 経由で約 200ms 遅れて届くので、使えない。

### F1 backlog 16 件の判定（Q1）

#### session-lifecycle.md

| # | 項目 | 判定案 | 根拠 | 深さ |
|---|---|---|---|---|
| 1 | 同一ファイル内の写しを CI が検知できない（D19） | **対応要・低** | 下記「F1-1」 | △ |
| 2a | R4 の `error` 経路が組合せ表に無い（D17） | **対応要・中** | 下記「F1-2a」 | △ |
| 2b | `lifetimeOf` が組合せ表に無い（D17） | **対応不要（実質的に覆われている）** | 下記「F1-2b」 | △ |
| 3 | 瞬断からの復帰を実機で確かめる | **対応不要（本 work で実測した）** | 下記 F2 | ◎ |
| 4 | `tab-visibility.test.ts` が 5 秒でタイムアウトする | **対応要・低〜中** | 下記「F1-4」 | ◎ |
| 5 | VT とプリンターの `onClose` に門が無い | **対応要・低（プリンターだけ）** | 下記「F1-5」 | △ |
| 6 | ホスト終了がはしごの最中に届くと取りこぼす | **対応不要（実ブラウザでは起きない）**。未マージの PR #394 の扱いを決める必要がある | 下記「F1-6」 | ◐ |
| 7 | `openSession` の Promise が settle しない | **対応要・中**（backlog の記述より影響が大きい） | 下記「F1-7」 | ◐ |
| 8 | 再接続対応以降、操作で待たされることがある | **対応要**（原因候補を 4 つに絞った。利用者に操作を確認する） | F3 | ◎ |

- **F1-1**（項目 1）
  - 走査テストは `session-manager.ts` / `session-lifetime.ts` をファイルごと「内側」に置いている（`packages/server/test/lifetime-flag-containment.test.ts:84`）。
  - 照合はドット付きの読み（`.holder` / `.hold` / `.resident`）だけで、分割代入は素通りする（同 `:88-91`）。
  - web-ui 側が見るのは `.link =` の代入だけ（`packages/web-ui/test/lifetime-flag-containment.test.ts:61-66`）。
  - 委譲先 A が変異で実証した。写しを入れても関連 92 件は緑のままだった。
  - 現時点で写しは実在しないので、利用者への実害の経路は無い。
- **F1-2a**（項目 2 の `error` 経路）
  - `session-controller.ts:483` の `&& !a.settled` を外しても、関連 6 ファイル 87 件は緑のままだった（委譲先 A の変異実証）。
  - 外すと、繋ぎ直しに成功した後の通常の `error` で、健全な接続が lost/gone になる。
  - 既存のテスト（`session-reconnect.test.ts:531-532`）は `notice` しか見ていないので、このガードを判別できていない。
- **F1-2b**（項目 2 の `lifetimeOf`）
  - 組合せ表には無いが、壊すと `session-reconnect-grace.test.ts` の 3 件が落ちる。部分的な変異でも 1〜2 件が検出する。
- **F1-4**（項目 4）
  - **主エージェントが単体実行で再現した**（load average 4.07、8 件中 1 件が落ちる、8.59s）。backlog の「単体では緑」は現状と食い違う。
  - 原因はテスト本体の `await import("../src/App.vue")`（`packages/web-ui/test/tab-visibility.test.ts:128`）。この動的 import が単体で 6.5〜7.1 秒かかる（委譲先 A の実測）。App.vue を使う他の 3 本（`tabs-own-system` など）は先頭で静的 import しているので落ちない。
- **F1-5**（項目 5）
  - 門が無い箇所: `session-controller.ts:861-867`（VT）、`:1035-1040`（プリンター）。
  - VT には到達しない。VT の id は毎回 `randomUUID()`（`packages/server/src/vt-manager.ts:87`）で、attach の経路も無いため。
  - プリンターは「＋新規」（`LauncherPane.vue:229`、force=true）で、しかも装置名が無い設定のときだけ到達する。
  - 同じ経路に、未起票の問題が 2 つある。
    - 古い口がリークする（close されない）。
    - サーバーの `detachReport`（`ws-handler.ts:812`）が、新しい接続の購読まで外しうる（コード読みのみ）。
- **F1-6**（項目 6）
  - WHATWG WebSockets Standard の規定: ready state が OPEN でなければ、message イベントを発火しない。
    したがって「`onClose` → 同じ口から `closed`」の順序は、実ブラウザでは起きない。
  - PR #394（`feature/session-closed-ladder-interrupt`、2026-09-10 作成）は **OPEN のまま main に入っていない**（`gh pr view 394`）。
  - 主エージェントが確かめたのは PR の状態だけ。仕様の文言は委譲先 A が一次資料を確認した。
- **F1-7**（項目 7）
  - `openSession` の `onClose` は、`sessionId` が `""` の間は門で何もしない（`session-controller.ts:749-755`）。解決済みの `connect()` に対する `rejectConnect` も no-op になる。
  - VT（`:861-863`）とプリンター（`:1035-1037`）にも同じ穴がある（委譲先 A がテストで pending を確認）。
  - 影響はスピナーが残るだけではない。`openConfigured.ts` の `connecting` はモジュールで共有されていて、`if (connecting.value) return` で止まる。
    そのため、**ページを再読み込みするまで、どの設定も開けなくなる**（主エージェントが該当行を確認）。

#### code-quality-checks.md

| # | 項目 | 判定案 | 現在の数字 | 深さ |
|---|---|---|---|---|
| 9 | 宙に浮く JSDoc の機械検知 | **対応要・中** | 下記「F1-9」 | ◐ |
| 10 | sharedFiles の宣言 | **対応不要（前提が崩れた）** | 下記「F1-10」 | ◐ |
| 11 | work をまたぐ参照に slug が付いていないことの検知 | **対応要・低**（対象の形を直してから） | 下記「F1-11」 | △ |
| 12 | 「網羅の主張」の目印 | **対応不要（費用に見合わない）** | 下記「F1-12」 | △ |

- **F1-9**（項目 9）
  - 空行なしで隣り合う JSDoc は 55 件あり、そのうち約 52 件が実際の事故（web-ui 20・server 18・hostserver 7・tn5250 4・tn3270 3・scs 3）。
  - 実例: `session-controller.ts:1128` の `sendKey` の直前に JSDoc が 2 つ続き、`@returns` を持つ方が結び付いていない（主エージェントが確認）。
  - 検査の仕組みは何も無い。正規表現の走査（`*/` の直後に空行なしで `/**`、前がファイル先頭でない）では 57 件がヒットし、TS 解析の 55 件とほぼ一致する（委譲先 B）。
- **F1-10**（項目 10）
  - 現在の `aidev doctor` が未宣言として挙げるのは `tn5250/src/screen/buffer.ts` と `session/session.ts` の 2 件（5/20）で、起票時の 4 件ではない（主エージェントが確認）。
  - 起票時の 4 ファイルは、直近 20 コミットで 0〜1 回まで落ちた（委譲先 B）。
  - CLI が sharedFiles を読むのは `worktree` と `doctor` だけで、タスク点検の発火には使われない。
  - autonomous の work はもともと全タスクを点検する。
- **F1-11**（項目 11）
  - 無修飾は 87 行（40 ファイル）。素の `spec D<n>` / `design D<n>` も含めると 261 行（委譲先 B）。
  - 条項（`3068238f`）ができて以降の新規は 0 行。
  - 条項の本文（`.aidev/conventions/comment-provenance.md` の規約 3）は `前 work の D10` を正しい例として挙げていて、起票の対象形と矛盾する。
  - 実際に起きているのは `research.md F<n>` の無修飾や、D 番号の無い `decisions.md` 参照（3 works で 4 件。委譲先 B）。
- **F1-12**（項目 12）
  - 網羅語を含むコメントは 2,186 行（src のコメント行 25,897 行の 8.4%。346 ファイル中 296 ファイル）で、一覧にするとノイズになる。「呼ぶ・読む・経路」と組み合わせても 162 行ある（委譲先 B）。
  - 09-14 以降の 7 works の review には該当の指摘が無い。直近 8 PR の追加コメントで網羅語を含むのは 0〜34 行（委譲先 B）。
  - 数え漏らしは 1 つの work の 3 件だけで、その多くは decisions.md 側だった。

#### acs-parity.md

| # | 項目 | 判定案 | 根拠 | 深さ |
|---|---|---|---|---|
| 13 | 黄・青緑以外の DSPATR(CS) の送信経路 | **対応不要（差異なし）** | 下記「F1-13」 | ○ |
| 14 | CURSORCL3 で ACS と実測で比較する | **対応不要（差異なし。実測した）** | 下記「F1-14」 | ◎ |
| 15 | 見た目のヒューリスティックの是非・DSPFMT の再現待ち | **対応不要（解決済み／具体的な対象なし）** | 下記「F1-15」 | ◐ |

- **F1-13**（項目 13）
  - ACS が桁区切りを決めるのは属性バイトだけ（`PS5250.setAttributeToPlanes`）。桁区切りが立つのは 0x30〜0x37 と 0x3F で、当 PJ の `packages/tn5250/src/screen/attributes.ts:61-76` と 1 対 1 で一致する。
  - ACS の WEA（`PS5250.writeExtAttribute`）が扱うのはタイプ 5（DBCS の拡張 NLS 区間。DBCS セッションのみ）だけで、それ以外はセンスコードで拒否する。つまり、色や桁区切りが WEA で届く経路は ACS に無い。
  - Query Reply は ACS の実測値と一致させてある（`query-reply.ts`）ので、ホストは両者に同じものを送る。
  - どちらの経路でも表示は ACS と同じになるので、送信経路の実測は判定に要らない。
- **F1-14**（項目 14）
  - 手順: 2 画面目で CODE 欄を保護し、そこに DSPATR(PC) を指定した画面で、Enter を押した後のカーソル位置を測った。
  - 結果: ACS（ECL 経由）は 3 行 12 桁（保護欄の中）、当 PJ（`scripts/diag-ic-on-protected.mjs`）も 3 行 12 桁で、一致した。
- **F1-15**（項目 15）
  - DSPFMT は #401 で解決済み（`20260915-dspfmt-reconnect-blank-redraw`、8/8 で解消を実測済み）。
  - 「見た目のヒューリスティック」には具体的な未解決の事例が残っていない。
  - 「ACS の起動が必要」という前提も F0-2 で変わった。今後の事例は個別に起票すればよい。

#### pc-command.md

| # | 項目 | 判定案 | 根拠 | 深さ |
|---|---|---|---|---|
| 16 | `CALL START` が消える根本原因 | **対応不要（実害なし・回避策あり）** | 下記「F1-16」 | ◐ |

- **F1-16**（項目 16）
  - 回避策 `stripCallBeforeStart` は、許可判定の後・実行の直前に適用されている（`packages/server/src/pc-command.ts:198` / `:223`）。
  - Windows 実機での回帰テストがある（`packages/server/test/pc-command-windows.test.ts`）。
  - 別の Windows 11 では 40 ケースで再現しなかった（`20260823-pccmd-windows-verify`）。
  - 根本原因は原資料の 1 台に届かない限り測れない。再発したときに測るものは docstring（`pc-command.ts:175-177`）に残してある。

### F2 瞬断からの復帰（項目 3 の実測）◎

条件: 実機、ブラウザ（Chromium headless）、HEAD の server / web-ui、ブラウザとサーバーの間に TCP 中継。

| シナリオ | 結果 |
|---|---|
| S1: ユーザー・タスク画面で中継を RST で切り、3 秒拒否する | 拒否を解いてから **1,117ms** で同じ画面（USER メニュー）に戻った。F3 がホストに通り、420ms でメインメニューへ戻った（同じジョブが続いている） |
| S2: `DLYJOB DLY(6)` の応答待ちの最中に、3 秒の断 | 拒否を解いてから **2,933ms** で、DLYJOB が終わった後の最新画面が出た。応答待ちも解けた。続けて `1` を送ると 781ms で遷移した |
| S3: 40 秒の断（はしごを使い切る）→ 手動の再接続 | 断から **29.7 秒**で「切断 ↻ 再接続」（OIA の `.fk.retry`）が出た。回線を戻してボタンを押すと、**1,374ms** で元の画面に戻った（サーバーの猶予 90 秒以内） |
| S4a: 半開き。**そのソケットで最初の ping を受ける前**に止める | research の時点では、110 秒で打ち切るまで切断と判断しなかった（表示は「入力可」のまま）。ページ内の記録では ping を 1 度も受けておらず、見張りが張られていなかった → **N19**。coding で中継を直した版（下の注）では、**130 秒たっても検出しなかった**（2026-09-19） |
| S4b: 半開き。**最初の ping を受けてから**止める | **93.3 秒**で「再接続中 (1/5)」になった（設計どおり: 90 秒＋保険 3 秒）。回線を戻すと **632ms** で復帰した |

> 注（coding で判明。decisions D10）: 最初の中継は、サーバー側の口が閉じるとブラウザ側の口も閉じていた。
> そのため S4a を 130 秒待つと、サーバーの心拍が死を判定して閉じたこと（約 120 秒）がブラウザに届き、
> 「120.1 秒で検出した」と出た。本物の半開き（回線が死んでいる）では、この閉鎖は届かない。
> 黙って止めている間は閉鎖を伝えない中継に直して測り直すと、S4a は 130 秒検出せず。
> S4b は中継の違いに左右されない（クライアントの見張りが約 93 秒で先に働き、サーバーの閉鎖は約 120 秒）。
> 表の 93.3 秒・632ms は research の時点の値で、直した版でも 93.4 秒・802ms と同じだった。

### F3 「待たされる」の原因の切り分け（項目 8）◎

- **F3-1 平常時の往復に問題は無い。**
  - 当 PJ のコア単体: メニューで `1` や F3 を送ると、ホストは **1 レコード**（READ MDT を含む）を 9〜75ms で返す。
  - ブラウザ経由（ページ内の時計、30 回の打鍵＝`1` と F3 の 15 往復）
    - 打鍵 → `screen` 受信: 38〜76ms
    - 描画と応答待ちの解除: 72〜137ms
    - 描画そのもの: 約 35〜45ms
  - `key-done` は `screen` の 50〜70ms 後に届くが、利用者に見える遅れではない。描画中にメッセージの処理が後回しになるためで、覆いは `screen` の適用で既に解けている。
  - 当初 p50 465ms と測れていたのは、並行して走っていた他の検証による CPU 負荷（load average 最大 25）と、CDP の遅れによるもの。
- **F3-2 #391〜#393 の差分は、健全時の打鍵経路に待ちを入れていない**（委譲先 F が差分を全部読んだ）。
  - 報告に出てくる「session-closed-ladder-interrupt 系」は PR #394 のことで、main に入っていない。
- **F3-3 間欠的な待ちの候補**
  - **D: リロード・タブを閉じた後、90 秒は同じ装置名で開けない。** ◎
    - web-ui にはタブを閉じるときに `close` を送る処理が無い（`pagehide` / `beforeunload` の grep は 0 件）。
    - サーバーはこれを転送断とみなし、セッションを 90 秒保持する（`ws-handler.ts` の `onSocketClose` → `transportLost`、`session-manager.ts:119` の `DEFAULT_RECONNECT_GRACE_MS`）。
    - 表示セッションの `open()`（`session-manager.ts:692`）には、同じ設定のセッションが保持中かを確かめる処理が無い。プリンター（`openPrinter`、`:885-889`）にはある。
    - 実機で確かめたこと: 同じ装置名の 2 本目は、1 本目が生きている間も、閉じた 0.3 秒後も、`8902 Device not available` で即座に拒否された。
    - ACS はウィンドウを閉じると接続も閉じる。装置名を固定する運用（利用者の設定がこれ）で当たる。
  - **H2: 施錠中・応答待ち中の打鍵（先行入力）を黙って捨てる。** ◐
    - ACS の `ECLPS.SendKeys` は、施錠中や READ が来ていない間の打鍵を `keyBuffer` に溜め、解錠や READ の到着時に送り直す。
      AID も `pending_aid` として溜める。既定は有効（`DISABLE_SESSION_TYPE_AHEAD` の既定 false。`ECLSession.java:681-682`、`beans/HOD/Session.java:836-842`、設定画面の「キーストロークのバッファリング」`KeyPanel.java:170`）。
    - 当 PJ は、`ScreenGrid.vue` の `onInputKeydown` が `inhibited` のときに捨て、`EmulatorPane.vue:851` が busy 中に Attn / SysReq 以外を捨てる。
    - 施錠中の先打ちを禁じたのは PR #388（09-03）。
    - GUI の打鍵経路が `ECLPS.SendKeys` を通るかは未確認（要実測）。
  - **A: 半開きになると、最大約 93 秒スピナーが出る。** ◎
    - `ws-client.ts:44` の `PING_DEAD_MS=90_000` と、`:53` の保険 3 秒。F2 の S4b で 93.3 秒を実測した。
    - **ソケットを開いてから最初の ping が届くまでの約 30 秒間**（繋ぎ直した直後も含む）に半開きになると、クライアントは永久に気づかない（N19、F2 の S4a）。
  - **H（#401、報告より後）: アンロックだけで READ の無い応答が来ると、応答待ちが解けない。** ◐
    - `session.ts:701-713` は `readSolicited` のときだけ `ready` にする。web-ui 経由の送信は `timeoutMs:"never"`。
    - ACS は WCC のアンロックで解錠し、AID は保留する（`DS5250.checkPendingAid`、委譲先 C/D）。
    - 実機ではまだ観測していない。

### F4 ACS との差異の新規洗い出し（Q2）

突き合わせた組の一覧は、委譲先 C・D・E の報告にある（全 70 組余り）。
以下は**差異として残ったもの**を、利用者への影響が大きい順に並べる。
ACS 側はクラス.メソッド（行は CFR の出力）、当 PJ 側は `file:line`（HEAD）で示す。

#### 高

- **N1 RESTORE SCREEN のとき、自分が送った退避イメージをもう一度画面に適用する。打鍵した文字と MDT が消える。** ◎
  - 当 PJ 側
    - `wtd-applier.ts:204` の `RESTORE_SCREEN` は、ローカルのスタックから戻した後 `break` するだけで、同じレコードに続く積荷（こちらが送った `ESC 11 …` の WTD）を次のコマンドとして適用する。
    - 冒頭コメント（`save-screen.ts:17-22`「こちらの RESTORE SCREEN はホストの積荷を読まない」）と実装が食い違っている。
    - 積荷を作る `writeCell` は `rawByte ?? 0x40` なので、打鍵した SBCS 文字は空白になる。SF は元の FFW を使うので MDT も落ちる（委譲先 C の報告）。
  - 実測（当 PJ のコア）: コマンド行に `WRKACTJOB` を打ち（MDT=true）、Attn → F12 と操作した。
    - ホストが送ってきたもの
      - Attn の応答: `ESC 02`（SAVE）を含むレコード
      - F12 の応答: `ESC 12` の後に `ESC 11` が続くレコード
    - 戻った後のコマンド行: **空欄・MDT=false**
  - 実測（ACS、ECL 経由）: 同じ操作の後も `WRKACTJOB` が残り、カーソルも 20 行 16 桁に戻った。
  - ACS の仕組み: 退避データに状態一式（`Save5250Net` の直列化）を持ち、0x12 で丸ごと戻す（`DS5250.processSaveScreen` 2741・`readNetSavedScreen` 3235。委譲先 C）。
  - 影響
    - Attn・SysReq・UIM ヘルプ・ブレークメッセージから戻ると、打った文字が消え、Enter で再送されない（データが黙って失われる）。
    - CA マスクも戻らない。そのため F12 で欄データが送られる（委譲先 C のプローブ）。
  - 到達性: 日常的。
- **N2 挿入モードの打鍵が、欄からあふれた末尾の文字を黙って捨てる。符号付き数値欄では値が化ける。** ○
  - 当 PJ 側: `packages/web-ui/src/composables/fieldEdit.ts:33-36` は splice の後、`chars.length = len` で切り詰める。
  - ACS 側: `PS5250.insertChar` → `reserveRoomForInsert` は、余地が無ければエラー（0012）を返し、値を変えない。
  - 貼り付けは既に ACS と同じ規則（余地が無ければ何も変えない）なので、打鍵とで食い違っている。
- **N3 先行入力。** ◐
  - F3-3 の H2 と同じ内容。**「待たされる」の有力な候補でもある。**
- **N4 DBCS プリンターの申告内容。** △
  - ACS（`DS5250P.initializeTelnet`）は、DBCS で HPT なしのとき `IBM-5553-B01` と申告し、NEW-ENVIRON では 6 変数だけを送る。
  - 当 PJ は常に `IBM-3812-1`（`terminal-type.ts:44-47`、◐）で、IBMFONT・KBDTYPE などを足して送る。
  - 日本語帳票を push で印刷できるか（README の既知制約。救出 pull で回避中）を分ける点。**要実測。**

#### 中

- **N5 CC1=0xC0 で、MDT の立った欄を消さない。** ○
  - ACS の `DS5250.processWCC1` case 6: 欄を消してから MDT を落とす。
  - 当 PJ の `wtd-applier.ts` の `applyCc` case 0xc0: `resetMdtNonBypass()` を先に呼ぶので、続く `nullNonBypass(true)` の対象が 0 件になる。
  - 0xC0 がどの DDS から出るかは要実測（候補は `ERASEINP MDTOFF`）。
- **N6 READ だけのレコード（WTD 無し）で、カーソルを先頭の入力欄へ動かす。** ○
  - ACS の `DS5250.processCommand` の 66/82/130 は、`pending_read` と CC を保存するだけでカーソルに触れない。
  - 当 PJ の `session.ts:666` は `readRequested && !cursorSet` なら `cursorToFirstInputField()` を呼ぶ。N1 の復元後などで、カーソルがずれる。
- **N7 Erase Input が消す範囲。** ○
  - ACS の `PS5250.processEraseInput` → `clearNonbypassFields(true)` は MDT の立った欄だけを消し、カーソルをホーム位置へ移す。
  - 当 PJ の `ScreenGrid.vue:2372` の `eraseInputKey` は、中身のある全入力欄を消して edit を出す（空白が「変更」として送られる）。
- **N8 挿入モードが画面をまたいで残る。** ○
  - ACS の `DS5250.initKeyboard`（2332、`resetInsertMode` は 2354）は、`processClearFMT`（1465）・WEC（1518）・書式の開始（1974）から呼ばれる。
  - 当 PJ の `EmulatorPane.vue:95` の `insertMode` は、利用者の切り替えでしか変わらない。N2 と重なると被害が増える。
- **N9 Shift+Enter で画面が送信される（ACS では Newline で、送信しない）。** ○
  - ACS の `AcsMapFunctions.MAP_5250` では `S10 = [newline]`。
  - 当 PJ の `useKeymap.ts:72-73` は Shift を見ずに Enter AID を返す。
- **N10 起動応答コード表の不足。** ○
  - ACS の `DS5250.processStartUpConfirmation` にある `2703`・`2777`・`8936`・`8937` が、当 PJ の `startup-record.ts` に無い。
  - 8936・8937 は自動サインオンの失敗・拒否。本当の理由が `closed during negotiation` に埋もれる。
- **N11 WRITE ERROR CODE TO WINDOW（0x22）を窓の中に描かない。エラー状態からメッセージ行を元に戻す処理も無い。** ◐
  - 当 PJ の `wtd-applier.ts:293-299` は、桁範囲を読み捨てて画面の最下行に描く（コメントで明記）。
  - ACS は MSGLOC / 窓の範囲に描き、Reset などでエラー前のメッセージ行に戻す（委譲先 C）。
- **N12 メッセージ待ち表示（MW）を出さない。** ◐
  - 当 PJ は `session.ts:147/592-593` で opcode だけを保持し、snapshot にも UI にも出していない。
  - ACS は CC2 のビットと opcode で OIA を更新する（委譲先 C）。
- **N13 キー編集の細部（要判断を含む）。** △（委譲先 D の M1・M2・M4・M5・M8・M9 と L 群）
  - 次の違いがある。
    - RB/RZ 欄を Field Exit 必須として扱うか
    - 右寄せ欄を出ないまま AID を押したときのエラー（0020）
    - Home の行き先（ACS は IC 位置、2 回目は Record Backspace）
    - Backtab が欄の先頭で止まるか
    - ME の判定基準（ACS は内容ではなく MDT で見る。変更が無ければ検査しない）
    - テンキーの ± を Field± として扱うか
  - このうち Enter のときだけ必須検証をする点は、意図的な差異（`20260729-ffw-behavior-bits` D1）として記録がある。
- **N14 画面イメージ応答の形式。** △
  - READ SCREEN（0x62/0x66/0x6A）で、カーソルの前置・opcode・NUL の扱いが ACS と違う。
  - 0x64 などで、打鍵した SBCS 文字を 0x40 として送る（N1 と同じ `writeCell`）。
  - 到達性は要実測。
- **N15 プリンター: 受信した瞬間に印刷完了を返す。CLEAR に応答しない。** ◐
  - 当 PJ の `printer-session.ts:183-185` は、opcode 2 なら return し、それ以外は即 `PRINT_COMPLETE` を返す。
  - ACS は書き終えてから応答し、失敗時は保留する（委譲先 E）。
  - PDF 出力や自動印刷が失敗すると、SAVE(*NO) のスプールは失われる。
- **N16 SCS の制御の対応範囲と、0x2B オーダーの消費長。** △
  - 対象: LF・IR・IRS・TRN・BS などを印字文字として置いてしまうこと、2BD1 SCG・2BFE で帳票の残りを打ち切ること、SO/SI の桁の扱い。
  - 出現頻度は要実測。
- **N17 自動サインオン・装置名の扱い。** △
  - IBMRSEED の書式（◐。当 PJ は `telnet.ts:250-253` で `ESC 00` の後にエスケープしない 00 を 7 個送る。PUB400 と実機では通っている）。
  - 装置名の大文字化・置換記号が無いこと。
  - `deviceNameRetry` が理由を問わずに再試行するため、QMAXSIGN を消費する恐れがあること（推測）。
- **N18 ホストから切られた後の自動再接続。** △・仕様判断
  - ACS は `autoReconnect` を持つ。当 PJ の表示セッションは、ホストに切られると破棄する。
- **N19 クライアントの ping の見張りが、最初の ping を受けるまで張られない。** ◎（ACS との差異ではなく、当 PJ の欠陥）
  - `ws-client.ts:199-200` は、`ping` を受けたときにだけ `armPingWatchdog()` を呼ぶ。接続を開いた時点では張らない。
  - これは意図した設計で、ping を送らないサーバーとの後方互換のため（同ファイルの注記、decisions D6）。
  - そのため、ソケットを開いてから最初の ping（30 秒周期）までの間に半開きになると、クライアントは切断に気づかない。
    - 繋ぎ直した直後も同じ区間ができる。
    - 打鍵は OPEN のソケットへ送られたまま消え、スピナーが残る。
  - F2 の S4a で、130 秒たっても検出しないことを実測した（中継を直した版。research の時点は 110 秒で打ち切り）。
  - 実機の回線断は「繋ぎ直した直後にもう一度切れる」形で起きやすい。F3 の候補 A を強める。

#### 低（台帳に 1 件ずつは起こさず、まとめて残す）

- WEA タイプ 5（拡張 NLS）を無視する（`wtd-applier.ts:555-575`、○。実機のトレースでは未観測）。
- 1399 の KBDTYPE/CHARSET の申告、DBCS 24x80 の端末タイプ（5555-G02 と C01）。
- 交渉前のテキスト、ROLL の空き行、CLEAR 系の付随処理、WSF D9/72、WDSF 0x52/0x54/0x55、負応答、Help/Clear/Print で欄データを送ること。
- 操作員エラーのコメントの番号違い（`opMessages.ts:215/217`）。

（いずれも委譲先 C・D・E の報告の「低」。深さは △）

### F5 ACS 側で裏付けが取れた、当 PJ の「未確認」の記述

- **930/5026 では全欄を大文字化する**（`20260729-ffw-behavior-bits` D2 の「未確認」）。ACS の `CodePage.toUpper`（2548）で裏付けが取れた（委譲先 D、△）。
- **逆向きのカーソル送り**は「ACS で確かめられない」ので未実装、とされていた（`EmulatorPane.vue:356-369`）。ACS は `FFT5250.previousNonByPassInputFieldPos` で実装している（委譲先 D、△）。

## 影響範囲

- この work で書き換えるのは台帳（`.aidev/backlog/session-lifecycle.md`・`code-quality-checks.md`・`acs-parity.md`・`pc-command.md`）だけ。製品コードは触らない（requirements）。
- 新しく起票する差異の修正は、後続の work の対象になる。主に波及する箇所は次のとおり。
  - `packages/tn5250/src/protocol/`（`wtd-applier.ts` / `save-screen.ts`）と `session/session.ts`
  - `packages/web-ui/src/components/ScreenGrid.vue` / `EmulatorPane.vue` / `composables/fieldEdit.ts` / `useKeymap.ts`
  - `packages/server/src/session-manager.ts` / `ws-handler.ts`
  - `packages/tn5250/src/session/printer-session.ts` と `packages/scs/src/scs.ts`

## 実現性 / リスク

- 台帳の更新そのものに技術的な障害は無い。
- **N1 の修正は、SAVE/RESTORE を使う全画面（Attn・SysReq・ヘルプ・窓）に波及する。** 退避スタックの持ち方（名指しで戻すか LIFO か）の設計が要る。
- N3（先行入力）と N13 の一部は UX の方針の判断を伴う。ACS に寄せると、既存のテストが固定している現状の振る舞いを変えることになる（`keyboard-locked-input.test.ts`、`ffw-behavior-bits.test.ts` など）。
- △ の差異は、委譲先の読み違いの可能性を残している。修正に着手する work の research で、最初に両側を再確認する。

## 実装アンカー

（この work の coding ＝台帳の更新のため、アンカーは台帳の行）

- A1: session-lifecycle.md の未着手 8 行（`.aidev/backlog/session-lifecycle.md:52, 58, 67, 70, 74, 84, 101, 107`）— F1 の判定を反映する。項目 2 は分割、6 は PR #394 の処置を併記する。
- A2: code-quality-checks.md の未着手 4 行（`.aidev/backlog/code-quality-checks.md:9-12`）。
- A3: acs-parity.md の未着手 3 行（`.aidev/backlog/acs-parity.md:33, 42, 44`。いずれも行頭 2 桁インデントの子項目）。**子項目の `- [ ]` は `aidev status` の件数に入らない**（AGENTS.md「記録の同期」）ので、閉じる行と兄弟の並びを確かめること。
- A4: pc-command.md の未着手 1 行（`.aidev/backlog/pc-command.md:70`）。
- A5: 新規の差異の起票先
  - N1〜N18 と低: `acs-parity.md`
  - F1-5 の未起票 2 件・F3-3 の D・N19: `session-lifecycle.md`
  - 粒度は design で決める。

## 実装時の注意

- **実機の固有名詞を台帳に書かない。**
  - 対象: システム名・ライブラリ名・装置名・ホスト。
  - 既存の台帳には書かれている箇所があるが、この work では増やさない。
- **ACS のコードを逐語で引き写さない。** 書くのはクラス.メソッドと、振る舞いを自分の言葉で言い直したものだけ。
- 台帳に根拠を書くときは、works slug・`file:line`・実測値をそろえる（AGENTS.md「記録の同期」）。
  PR 番号は deliver で決まる。
- 起票時の記述が事実と食い違う箇所は、**取り消し線で残す**。消さない。
  - 項目 4 の「単体では緑」
  - 項目 6 の「CLOSING でも配送は実在する」
  - 項目 10 の対象 4 ファイル

## design への申し送り

- **台帳の粒度**
  - N1〜N18 を 1 件ずつ起こすか、領域でまとめるか。
  - 案: 高 4 件と中のうち ○ 以上のもの（N5〜N10）は 1 件ずつ起こす。△ のものは領域ごとに 1 件へまとめ、「着手時に両側を再確認」と書き添える。
- **利用者の判断が要るもの**（design のゲートで確認する）
  - N3 先行入力: ACS に合わせて溜めるか。
  - N13 のうち Home・ME の意味: ACS に合わせるか、現状の意図的な差異として残すか。
  - N18 自動再接続: 入れるか。
  - PR #394 を閉じるか。F1-6 の判定では到達しないため、閉じる方向。
- **項目 8 の結論の書き方**
  - 平常時の往復は健全だった（F3-1）。
  - 候補は D・H2・A・H の 4 つ。
  - 利用者に「待たされた操作」を 1 つ確認できれば絞れる（リロード直後か、打鍵が欠けるのか、スピナーが長く出るのか）。
  - D と H2 は、利用者の確認を待たずに ACS との差異として起票できる。
- **検証用スクリプトをリポジトリに残すか**
  - 候補は次の 2 つ。
    - ECL で ACS のコアを当てる小さな Java（ACS の jar は含めない。F0-2）
    - ブラウザの瞬断を作る中継（F0-4）
  - どちらも再利用の価値がある。requirements では「design で判断」としている。
- 瞬断の実測（F2）は S1〜S4b をすべて取り終えた。項目 3 は閉じられる。ただし S4a で見つかった N19 は、別の項目として起票する。
