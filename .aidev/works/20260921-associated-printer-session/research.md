# 調査: 関連付けプリンター（プリンターセッションを指す方式）

## 調査の問い
- Q1: ACS はプリンターセッションを指したとき、どの順で何をするか（起こす・待つ・関連付ける・止める・閉じる）。
- Q2: 待ち時間切れ・指した設定が無いとき、ACS はどうするか。
- Q3: 当 PJ のどこに差し込めるか。

## 判明した事実
- F1（原典 `AssociatedPrinterSession5250` のコンストラクタ）: 待ち時間は `5250AssocPrinterSessionConnectionTimeout`（無ければ 5）。設定画面は負・1〜4 を 5、600 超を 600 に丸め、
  0 は待ち続ける（`DataPanel5250ConAssocPrinter.propertyChange`・コンストラクタの `l < 5 → 5`・`l > 600 → 600`・`connectionTimeout != 0` のときだけ時限）。
- F2（同）: 同じホストで動いている同じ名前のプリンターセッションがあれば、その `getWorkstationID()` をすぐ使う（起こさない。表示が繋がったときに起こす＝F5）。
  無ければ `SessionManager.startAssociatedPrinterSession(名前)` で起こし、`isWorkstationIDReady()` になるまで 200 ms おきに待つ。~~時間切れなら記録だけして抜け、
  `getWorkstationID()`（起動応答で決まる前は設定の値のまま）で関連付ける。~~ → **原典の読み違いだった**（節目 10 の独立点検 C-S1。自分でも読み直して確認）:
  コンストラクタは冒頭（プリンターを起こす前）で `startTheTimer()` を呼び、`connectionTimeout`（生の秒。丸めない）だけ待つスレッドを起こす（`run`）。
  そのスレッドは時間が来ても表示が始まっていなければ `createAndRunTerminal()` で**関連付けなしの表示を開く**（`Icon5250.start` が表示の開始前に `associatedDeviceName` を消してある）。
  待ちループの後の `createTerminal()`（`associatedDeviceName` を入れる唯一の場所）は、表示が既に始まっていると何もしない（`tSession` が入っていて `reconnectTerminal` が偽）。
  したがって**時間切れなら関連付けなしで開く**。プリンターとの組（連動）は残る——装置名が後で決まれば `pWorkstationID` でその相手を探し続ける。
  設定が見つからなければ注意（`KEY_5250_ASSOC_INVALID_PROFILE`）を出して**関連付けなしで**表示を開く。`getWorkstationID()` が null なら注意（`KEY_NO_ASSOC_PRINTER`）を出して表示を開かない。
- F3（同 `createTerminal`）: 装置名を表示の `associatedDeviceName` に入れて表示を開く（IBMASSOCPRT。`20260921-associated-printer`）。
- F4（同 `CommEvent`）: 表示の通信状態 2（切れた）で、**ほかに同じ装置名へ関連付けた表示が同じホストで繋がっていなければ**プリンターの通信を止める（`isOtherDisplayAssociated`）。
  状態 4（繋がり始めた）で、プリンターが止まっていれば起こす。
- F5（同 `sessionLabelEvent`・`SessionManager.stopAssociatedPrinterSession`）: 表示を閉じたとき、`close5250AssocPrinterWithLastSession`（既定 false）なら、
  ほかに関連付けた表示が無ければプリンターのセッションごと閉じる。
- F6（当 PJ）: プリンターは `SessionManager.openPrinter`（`packages/server/src/session-manager.ts:1011`）が `ref`＋持ち主で使い回し、`startPrinter`（:1109）で起こし、
  `stopPrinter`（:1226）で止め（エントリは残る）、`close`（:1919）で閉じる。常駐（サービス ✅）のプリンターは `resident`。
- F7（当 PJ）: プリンターの装置名は `PrinterSession.deviceName`（`packages/tn5250/src/session/printer-session.ts:229`。起動応答の装置名、無ければ送った名前）。
- F8（当 PJ）: 表示をブラウザから開くのは `WsConnection.onOpen`（`packages/server/src/ws-handler.ts:556`〜）。プリンターを設定から開く材料の組み立ては `onOpenPrinter`（:838〜）。
  解決結果は `ResolvedTarget`（`session`・`source` を持つ。`packages/server/src/config-resolver.ts:40`）。
- F9（当 PJ）: 設定のファイル内の参照は `session.system` だけで、`addSession` / `updateSession` / `assertIntegrity` が存在を検査する（`packages/server/src/config-store.ts:78`・:300・:314）。
  個人設定は 1 ファイルに複数の持ち主が同居する（`owner`）。

## 実装アンカー
- A1: 設定の形と検査 `packages/server/src/config-types.ts` `sessionBase` `assertTypeConsistent` / `packages/server/src/config-store.ts` `addSession` `updateSession` `assertIntegrity` `publicSession`
- A2: 表示を開く `packages/server/src/ws-handler.ts` `onOpen` / プリンターの材料 `onOpenPrinter`
- A3: 組と連動 `packages/server/src/session-manager.ts` `SessionEntry` `close`（新しく `linkAssociatedPrinter`）
- A4: 設定カード `packages/web-ui/src/components/ConfigCard.vue`（関連付けプリンターの欄）

## 実装時の注意
- 待ち時間は ACS と同じく秒。0 は待ち続ける。
- プリンターを開くときの信頼設定の扱いは、プリンターを直接開くときと同じ材料の組み立てを通す（分けると片方だけ直る）。
- 常駐のプリンター（サービス）は ACS に無い概念。表示に合わせて止める・閉じると、ほかの利用者が頼る待ち受けまで止まる。

## design への申し送り
- 常駐のプリンターを止める・閉じるかは design で決める。MCP から開く表示は対象外（要件）。
