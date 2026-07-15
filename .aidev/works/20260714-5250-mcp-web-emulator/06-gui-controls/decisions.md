# 決定記録: 06-gui-controls

## D1: GUI 構造体は WSF(0xF3) ではなく WTD オーダー 0x15(WDSF) で受ける

- 背景: plan/tasks の T2 は「`applyStructuredField`（top-level WSF 0xF3）を拡張して class 0xD9 の
  type を振り分ける」と記していた。実装調査（GNU tn5250 session.c）で、拡張 5250 GUI 構造体
  （Create Window / Define Selection Field / Define Scroll Bar / Remove 群）は **WTD の中の
  オーダー 0x15（WDSF = Write to Display Structured Field）** として届くことが判明した。
  top-level WSF(0xF3) は 5250 QUERY（type 0x70）専用で、Query Reply を返す経路。
- 決定: GUI 構造体の解析は `applyWtd` のオーダーループに `ORDER.WDSF(0x15)` ケースを追加して行う。
  `applyStructuredField`（0xF3 経路）は QUERY 検出のまま据え置く。パーサは新規 `wdsf-parser.ts`。
- 理由 / 代替案: tn5250 のワイヤ実装に忠実。0xF3 経路に GUI を足すと実機の実データストリームと
  食い違い、合成 trace も誤ったバイト構造になる。
- 影響: T2 の実装位置が tasks.md の字面（applyStructuredField）と異なるが、意図（class 0xD9 type の
  振り分け）は満たす。tasks.md の T2 はこの決定に沿って読む。

## D2: enhanced 広告は ConnectOption でオプトイン（既定 OFF）

- 背景: Query Reply の capability バイト t[53]/t[54] で拡張 5250 を広告すると、ホストが GUI 構造体を
  送るようになる。既存の非 GUI フロー（自動サインオン→メニュー・MCP/WS E2E）への影響が懸念。
- 決定: `ConnectOptions.enhanced`（既定 false）を追加。true のときのみ `buildQueryReply(..., true)` で
  t[4]=0x40 / t[53]=0x02 / t[54]=0x80 を広告する（tn5250 query_reply の enhanced と一致）。
- 理由 / 代替案: 常時 ON にすると実機の全画面挙動が変わり回帰リスク。オプトインで既存経路を不変に保つ。
- 影響: web/MCP から GUI を使う場合は接続時に enhanced=true を指定する。既定接続は従来通り。

## D3: 選択入力の応答は AID 経路（メニュー/プッシュボタン主経路）

- 背景: 選択フィールドの確定は本来、選択肢の数字選択文字を裏の入力フィールドへ書いて Read 応答する
  経路と、選択肢が AID を持つ場合にその AID を返す経路がある。実機 GUI 画面が PUB400 標準メニューに
  無く（DBCS と同様、合成 trace を正とする）、裏フィールド連動の実装は検証手段が乏しい。
- 決定: `submitGuiSelection(fieldId)` は、選択済み選択肢が AID を持てばその AID を、無ければ既定 Enter を
  Read MDT 応答として送る。選択状態のローカル反映は `selectGuiChoice` で行い snapshot.gui に出す。
- 理由 / 代替案: メニューバー・プッシュボタン（AID で動作識別）が IBM i GUI の主用途。数字選択文字の
  裏フィールド書き戻しは検証不能なため本サブセットでは AID 経路に限定し、合成 trace で検証する。
- 影響: チェックボックス/ラジオの選択インデックスをホストへ厳密に返す経路は将来拡張。親統合 test でも
  実機 GUI が出れば探索的に確認する。

## D4: REM_GUI_* は位置一致除去、無ければ同種全除去

- 背景: REM_GUI_SEL_FIELD/WINDOW/SCROLL_BAR は対象位置を伴うが、正確なヒットテストは実装が重い。
- 決定: 現在アドレス（row/col）に一致する構造体を除去。一致が無ければその種別を全除去。
  REM_ALL_GUI_CONSTRUCTS と画面クリア（CLEAR UNIT 等）は全 GUI を除去。
- 理由: プルダウンの開閉（remove→再構築）という典型用途を満たしつつ実装を単純に保つ。
