# レビュー: 06-gui-controls

## ラウンド 1（2026-07-15）

対象: 拡張 5250 GUI コントロール（T1–T11）の差分。subtask 単独レビュー（局所欠陥）。

### 点検観点と結果

- **要件適合**: 親 spec/decisions D2 の「enhanced 広告・WSF GUI 構造体（選択フィールド=ラジオ/チェック/
  プッシュボタン・ウィンドウ・スクロールバー）の解析・HTML 描画・入力送信」を満たす。選択の入力は
  AID 経路（decisions D3）。MCP は structuredContent＋text 両面で露出。
- **正確性**:
  - WDSF は WTD オーダー 0x15 経路で解析（tn5250 準拠。decisions D1）。長さ・class 0xD9・type を検証し
    未知 type/破損長は警告読み飛ばし（レコード境界で再同期）。
  - パーサの境界処理を精査: 選択フィールドのマイナー構造ループ（`minorTotal-2` の content 長、`>remaining` で
    break）、選択項目の可変長オプション（offset/AID/numeric を `remaining>0` ガード）、ウィンドウ境界構造
    （`borderLen-1` の content、タイトル抽出）、スクロールバー 10 進 4 桁。いずれも ByteReader が
    オーバーランで例外→applyWdsf が捕捉し警告。合成リプレイ（unit + session E2E）で実バイトを検証。
  - 位置採番は現在書き込みアドレス（SBA 由来）の 1 始まり row/col。session E2E で SBA 位置と一致を確認。
  - GUI 空時は `snapshot.gui` を省略（undefined）。CLEAR UNIT / resize / REM_ALL で確実にクリア。
    save/restore にも GUI を含めた。
  - enhanced 経路は ConnectOptions→session→buildQueryReply(enhanced) まで結線。実機で非 GUI 回帰なしを確認。
- **規約適合**: `console.*`/TODO 残置なし。ログは warn 経由。lint clean。周辺コードのスタイル（ByteReader
  逐次読み・型で閉じる・オプショナルは存在時のみ付与）に一致。
- **保守性**: パーサは新規ファイルに分離、buffer/session/format/mcp-tools/ws への追加は既存パターン踏襲。
  型は core から一元 export。

### 指摘

- must: なし
- should: なし
- nit（サブセットの既知制約。decisions に記録済み・親統合 test/将来拡張に引き継ぎ）:
  1. 選択肢テキストの DBCS（SO/SI 混在）デコードは SBCS デコード前提の主要サブセット（choice text が DBCS の
     ケースは対象外）。
  2. REM_GUI_* は位置一致除去、無ければ同種全除去（decisions D4）。厳密ヒットテストは将来拡張。
  3. 実機 PUB400 に GUI 画面が無く、実機 GUI 疎通は未検証（合成 trace を正）。Playwright の GUI 選択操作は
     コンポーネントテストで代替。→ deliver の既知の制約へ。

### 判定

must/should なし。subtask review 通過。カーソルは次の未完 subtask（07-screen-links）へ前進。
