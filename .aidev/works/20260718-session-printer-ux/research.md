# 調査: セッション情報表示とプリンター UX 改善

## 調査の問い
- Q1: プリンターセッションが CPA3394（用紙タイプ問い合わせ）で MSGW 停止し、手動「I」応答が要る原因。
  クライアント（TN5250E プリンターセッション）から手動応答を不要にできるか。
- Q2: 接続設定情報をタブ情報（`SessionInfo`）に載せるためのデータ経路。
- Q3: プリンターペインのサイドバー/フィルタ・新着バッジの実装可否。

## 判明した事実

### F1（重要）: CPA3394 は writer ジョブ側のメッセージで、プリント data stream に乗らない
- 我々のプリンターセッション（`packages/core/src/session/printer-session.ts`）は TN5250E で**仮想プリンター
  デバイスを作成**し（NEW-ENVIRON で IBMFONT=12 / IBMTRANSFORM=0 / deviceName / CCSID を申告）、SCS を受信して
  帳票に展開するだけ。**用紙タイプ（FORMTYPE）を制御する要素は持たない**（`terminal-type.ts` の `deviceEnvFor` /
  `printerTerminalTypeFor`＝IBM-3812-1 にも form 関連はない）。
- CPA3394 は**プリンターライター（STRPRTWTR で起動するジョブ）**が、スプールの用紙タイプと現在ロード中の用紙が
  異なるときにオペレーターへ出す**外部メッセージ**（`Load form type … into device …. Reply I(gnore)…`）。これは
  writer ジョブのメッセージ待ち（MSGW）であって、**SCS/TN5250E の印刷ストリームには含まれない**。
- したがって**プリンターセッション（クライアント）からこのメッセージを受信・自動応答することはできない**
  （コードにも CPA3394/MSGW を扱う箇所は無い＝grep 済み）。推測ではなく、印刷ストリームに存在しないという事実。

### F1.1: 実メッセージ（ユーザー提供）で裏付け
```
Message ID: CPA3394  type: Inquiry  Severity 99
Message: Load form type '*STD' device PRT_TEST writer PRT_TEST. (G B I H R C)
Cause:   The file on output queue PRT_TEST in library QUSRSYS requires form type '*STD'
         to be loaded on device PRT_TEST. …
```
- 送信元は **writer PRT_TEST**（プリンターライタージョブ）。スプールの用紙タイプ `*STD` の「用紙ロード確認」。
- 応答選択肢は **G/B/I/H/R/C**（G=フォーム位置合わせ後に印刷 / I=Ignore で印刷続行 など）。これは writer の
  外部照会メッセージで、TN5250E プリンターセッションには届かない＝F1 のとおりクライアント自動応答は不可。

### F2: 実務的な回避策（ホスト側 writer の起動オプション）
- writer を **`STRPRTWTR DEV(<dev>) FORMTYPE(*ALL)`** で起動すると、用紙タイプ不一致でも停止せず全スプールを
  印刷する（＝毎回の CPA3394 が出ない）。既存 writer は **`CHGWTR WTR(<dev>) FORMTYPE(*ALL)`** で変更可。
- あるいは QSYSOPR 等の応答メッセージキューを**自動応答（`CHGMSGQ … DLVRY(*DFT)` や `ADDRPYLE`＋`CHGJOB INQMSGRPY(*SYSRPYL)`）**に
  すれば I が自動返る。ただしこれらはホスト側の運用設定で、我々のアプリからは常時制御できない。
- **writer の起動はホスト側でユーザーが行う**（我々のアプリは仮想デバイスを待ち受けるだけ）。よって「手動 I の
  不要化」は、**writer 起動を FORMTYPE(*ALL) にする運用**へ誘導するのが素直で確実。

### F3: 我々のアプリから能動的に応答/コマンド実行する余地（stretch）
- ユーザーは実運用で**表示（5250）セッションも併用**している。表示セッション経由で `STRPRTWTR … FORMTYPE(*ALL)` や
  メッセージ応答（`SNDRPY`）を送ることは技術的に可能だが、**プリンターセッション単体では完結しない**（別セッション・
  資格情報・画面操作が必要）。本要件の主目的（受信/閲覧の UX）に対して重く、まずは運用誘導＋UI 案内が費用対効果が高い。

### F4: 情報表示（項目1〜4）のデータ経路
- 接続カード/一覧は `PublicConnection` / `PublicProfile` を持つ（host/port/ccsid/screenSize/deviceName/tls/
  sessionType/autoSignon/signonUser）。**カードの ⓘ 全情報表示・デバイス名表示はこの場で完結**（追加取得不要）。
- タブ情報（`SessionInfo`）は `SessionState` を見るが、現状 `host/port/deviceName/screenSize/tls/sessionType` を
  持たない（`stores/sessions.ts`）。→ **open 時に接続メタを `SessionState` へ載せる**必要がある（`session-controller`
  の `openSession`/`openPrinterSession` に meta を渡し、`ConnectView` が `PublicConnection`/`PublicProfile` から供給）。
  資格情報の平文は載せない（表示は user 名まで）。
- タブ情報の閉じ方: `PaneTabs.vue` が `infoFor` で開閉。**バックドロップ**（画面全体のクリック捕捉）を足せば外側
  クリックで閉じられる。カードの ⓘ も同方式。

### F5: プリンターペイン（項目6〜7）
- `PrinterPane.vue` は左サイドバー（スプール一覧）＋ビューアの 2 ペイン。**サイドバー開閉トグル**と**上部フィルタ
  入力**（`reportTitle`/本文で絞り込み）はコンポーネント内で完結。
- 新着バッジ: `SessionState.reports` に受信が積まれる。**未読数**を持たせ（受信で++、タブアクティブ化で 0）、
  `PaneTabs.vue` のタブに件数バッジを出す。`workspaceStore` のアクティブタブ切替でクリアする。

## 実現性 / リスク
- 項目1〜4・6〜7 は**フロントエンドで実現可能**（新規サーバー API 不要）。
- **項目5 はクライアント側で自動応答できない**（F1）。実現手段は「writer を FORMTYPE(*ALL) で起動する運用誘導＋
  プリンターペインの UI 案内」。アプリから能動的に応答する自動化は別セッション前提で重く、本作業では stretch/対象外。
- 実機確認: FORMTYPE(*ALL) は文書化された OS 挙動だが、PUB400 での最終確認は test 工程で行う価値がある。

## spec への申し送り
- **項目5 の落とし方をユーザーに確認**（spec ゲート）: (a) 運用誘導＋プリンターペインの UI 案内に留める［推奨・軽量］/
  (b) 表示セッション経由で writer 起動/メッセージ応答を代行する helper を作る［重い・別セッション前提］。
- 情報表示は「カード ⓘ（PublicConnection/Profile を全表示）」と「タブ情報（SessionState＋open 時の接続メタ）」の
  2 経路。項目セット・並び順・重複統合ルールを spec で確定（例: ccsid・画面サイズ・デバイス名は 1 か所に統合）。
- 新着バッジの解消条件は「タブをアクティブ化で 0」を既定とする（requirement Q3）。
