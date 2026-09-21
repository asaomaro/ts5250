# 調査: 関連付けプリンター（IBMASSOCPRT）

## 調査の問い
- Q1: ACS はどの条件で・どこに・どんなバイト列で IBMASSOCPRT を送るか。
- Q2: ACS の設定は何を持つか（指定方法・既定・正規化）。
- Q3: ホストは IBMASSOCPRT を受けて何をするか。存在しない装置名ではどうなるか。
- Q4: 当 PJ で申告を足す位置・設定の通り道はどこか。

## 判明した事実
- F1（Q1・原典）: `NVT5250.getHostDeviceOptions` が `ECLSession.getAssociatedDeviceName()`（プロパティ `associatedDeviceName` の生の値）を `assocDeviceName` に取る。
  変数表を組むとき、変数表の組（表示は DEVNAME・KBDTYPE・CODEPAGE・CHARSET）→ 自動サインオンの 21・22 → `startupResponse` なら 20（IBMSENDCONFREC）→
  **`assocDeviceName` が `trim()` して空でなければ 19（IBMASSOCPRT）**の順に積む（`startupResponse` が偽なら 20 も足す）。値は `charAt` を `(byte)` にして
  そのまま書く（空白を落とさない・大文字にしない・ESC を挟まない）。
- F2（Q1・実測）: ACS のコア（`scripts/acs-probe.mjs` に `PROBE_ASSOC_PRINTER` を足した）を `tap-proxy.mjs` 経由で社内機に当てた。
  関連付けありの NEW-ENVIRON IS は、関連付け無しと**同じ並びの最後に** `USERVAR IBMASSOCPRT VALUE <装置名>` が 1 つ増えるだけだった
  （`DEVNAME(値なし) / KBDTYPE / CODEPAGE / CHARSET / IBMSENDCONFREC=YES / IBMASSOCPRT`。自動サインオンは使っていない）。
  値にコメントごと渡してしまった回では、空白・`#`・日本語の下位バイトまでそのまま載った（ACS は値を加工しない。F1 と一致）。
- F3（Q2・原典）: 設定は `DataPanel5250ConAssocPrinter`（ACS の `SessionConfig.is5250PrinterAssociationEnabled` / `SessionManager.stopAssociatedPrinterSession`
  が同じプロパティを読む）。`enable5250PrinterAssociation`（既定 false）・`5250PrinterAssociation`（true＝プリンターセッションを指す /
  false＝装置名を書く）・`5250PrinterSession`・`close5250AssocPrinterWithLastSession`（既定 false）・`5250AssocPrinterSessionConnectionTimeout`
  （既定 5 秒・5〜600 に丸める・0 は待ち続ける）・`5250AssocPrinterDeviceName`（自由入力。検査・大文字化なし）。
  装置名を書く方式では `AssociatedPrinterSession5250` が `5250AssocPrinterDeviceName` を `associatedDeviceName` に写すだけで、空なら注意を出して関連付け無しで繋ぐ。
- F4（Q2・原典）: プリンターセッションを指す方式は、同じホストで動いているその名前のプリンターセッションがあればその装置名を使い、無ければ起こして
  装置名が決まるのを待つ（時間切れなら関連付けを諦める）。表示の切断でプリンターを止め、表示の接続でプリンターを起こし、
  `close…WithLastSession` なら最後の表示と一緒に閉じる（`AssociatedPrinterSession5250.CommEvent` / `sessionLabelEvent`）。→ 本 work の対象外（台帳へ割る）。
- F5（Q3・実測。ACS のコア・社内機・2026-09-21）: 関連付け無しでは `DSPJOB OPTION(*DFNA)` の印刷装置がシステム既定の装置、
  関連付け（`.env.verify` の `AS400_PRTDEV`）ありではその装置になった。起動応答はどちらも I902。
- F6（Q3・実測）: 存在しない装置名（`NOSUCHPRT`）を関連付けると、起動応答が **I901**（仮想装置の機能が元の装置より少ない）になり、
  接続・サインオンはそのまま通って印刷装置はシステム既定のままだった。
- F7（Q3・原典）: ACS は I901 を成功として扱い（`DS5250.processDiagnosticInformation` が 0 を返す）、通信状態 37 を立てる。
  状態行は 37 で `KEY_I901`（「仮想装置の機能が元の装置より少ない」の意味）を出す（`HODStatusBar`）。
  当 PJ は I901 を成功として扱う（`packages/tn5250/src/telnet/startup-codes.ts:7`）が、表示セッションでは何も出さない
  （起動コードを web-ui へ渡すのはプリンターだけ。`packages/server/src/ws-handler.ts:913`）。→ 本 work の対象外（台帳へ割る）。
- F8（Q4）: NEW-ENVIRON の応答は `TelnetLayer.handleSubnegotiation`（`packages/tn5250/src/telnet/telnet.ts:280-`）が組む。
  並びは DEVNAME → `userVars` → KBDTYPE/CODEPAGE/CHARSET → IBMSENDCONFREC → USER・IBMRSEED・IBMSUBSPW（`finish`）→ `sendSb`。
  表示の `TelnetLayer` は `Session5250.establish`（`packages/tn5250/src/session/session.ts:276-290`）が作り、`userVars` を渡していない。
- F9（Q4）: 設定は `sessionBase`（`packages/server/src/config-types.ts:250-`）が両ファイル共通のセッションの形。`deviceName` と同じ並びに置ける。
  接続の選択肢は `ConfigResolver.buildConnect`（`packages/server/src/config-resolver.ts:173-`）が作り、`SessionManager.open` が `Session5250.connect` へ
  `...opts` でそのまま渡す（`packages/server/src/session-manager.ts:845`）。web-ui は `ConfigCard.vue` の `sesForm`。

## 影響範囲
- tn5250 の telnet 層・セッションの接続の選択肢、server の設定スキーマ・解決、web-ui の設定カード、README。

## 実現性 / リスク
- 申告は末尾に 1 変数足すだけ。関連付けを書かない設定のバイト列は変わらない。
- 並びの残りの差（ACS は IBMSUBSPW・IBMRSEED を IBMSENDCONFREC より前に置く）は台帳の別項目「自動サインオンの変数の順」。本 work では触らない。

## 実装アンカー
- A1: NEW-ENVIRON の応答（`packages/tn5250/src/telnet/telnet.ts` `handleSubnegotiation` の `finish` の `sendSb` の直前）
- A2: 表示の接続の選択肢（`packages/tn5250/src/session/session.ts` `ConnectOptions` と `establish` の `new TelnetLayer`）
- A3: 設定スキーマ（`packages/server/src/config-types.ts` `sessionBase` の `deviceName` の隣・`assertTypeConsistent`）
- A4: 解決（`packages/server/src/config-resolver.ts` `buildConnect` の `if (session)`）
- A5: 設定カード（`packages/web-ui/src/components/ConfigCard.vue` の `sesForm`・読み込み・保存・装置名の入力欄）

## 実装時の注意
- 値は ACS と同じく加工しない（空白を落とさない・大文字にしない）。送るかどうかだけ Java の `trim()` で見る（`telnet.ts` の `javaTrim`）。
- 測定の手順ファイル・値は実機の識別子を含めない（装置名は `.env.verify` から採る）。

## design への申し送り
- 設定名・種別の制約（表示の 5250 だけ）を design で決める。I901 の表示とプリンターセッションを指す方式は台帳へ割る。
