# 仕様: プリンターセッションの申告・ジョブの終わり・CLEAR への応答

## 設計方針
- telnet 層に**順序つきの USERVAR の並び**（`userVars`）と、IBMSENDCONFREC を送らない指定（`sendConfRec: false`）を足す。
  プリンターは従来の個別の口（ibmFont / ibmTransform / ibmMfrTypMdl / kbdType ほか）を使わず、ACS の組をそのまま並べて渡す。
  表示セッションの申告は変えない。
- 申告の組は純関数 `printerDeclaration(ccsid, transformTo)` に置き、端末タイプと並びを返す（テストしやすく、原典の表と 1 対 1）。
- 受信は ACS の状態を写す: 「いまの応答」（なし / NO_ERROR / CLEAR_PROCESSED）をセッションが持ち、レコードの処理の後に送る。
  データ（opcode 1・本体あり・終わりでない）→ 足して NO_ERROR、終わり（フラグ 0x08 ＋ 本体が空か 0x00）→ 確定（応答は変えない）、
  CLEAR → 受けかけを確定して CLEAR_PROCESSED、それ以外の opcode → 何もしない。

## 依拠する既存の事実
- 表示セッションの NEW-ENVIRON（`telnet.ts` の `handleSubnegotiation`）は DEVNAME・KBDTYPE ほか・IBMSENDCONFREC・自動サインオンを送る。
  プリンターの資格情報（USER / IBMRSEED / IBMSUBSPW）は同じ関数で送っており、この work では変えない。

## 受け入れ基準との対応
- AC1: `printerDeclaration` と `telnet.ts` の `userVars` / `sendConfRec`。テストで 4 通りの並びをバイトで固定する。
- AC2: 実機（日本語機）で PrinterSession（CCSID 5035）を事前作成の装置に繋ぎ、IGC 帳票が `report` になるのを確かめる（検証スクリプト）。
- AC3: `handleRecord` の書き換え。16/17 バイトの終わり・CLEAR・応答の持ち越しをテストで固定する。
- AC4: mutation。
