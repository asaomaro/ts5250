# タスク: 06-gui-controls

## core: パース・モデル
- [x] T1: enhanced 5250 広告 — `query-reply.ts` の controller/display capability（t[53]/t[54]）で拡張 5250 を
      広告。端末タイプ別に慎重に有効化。ユニット。実機で非 GUI 画面に悪影響が出ないか確認【実機】
      → `enhanced` 引数追加。`ConnectOptions.enhanced`（既定 OFF）でオプトイン（decisions D2）
- [x] T2: WSF GUI 構造体ルーティング — class 0xD9 の type（0x50/0x51/0x53/0x58/0x59/0x5B/0x5F）を各ハンドラへ
      振り分け（未知 type は警告読み飛ばし）。ユニット → 実際は WTD オーダー 0x15(WDSF) 経路で実装（decisions D1）
- [x] T3: 選択フィールドモデル — `DEFINE_SELECTION_FIELD`(0x50) を解析し、選択タイプ（単一=ラジオ/複数=チェック/
      プッシュボタン）・選択項目（テキスト・位置・状態・選択値）を GuiSelectionField モデルに。tn5250 準拠。ユニット
- [x] T4: ウィンドウモデル — `CREATE_WINDOW`(0x51) を解析し、位置・サイズ・境界・タイトルを GuiWindow モデルに。
      `REM_GUI_WINDOW`/`REM_ALL_GUI_CONSTRUCTS` で除去。ユニット
- [x] T5: スクロールバーモデル — `DEFINE_SCROLL_BAR_FIELD`(0x53) を解析し、位置・範囲・つまみ位置を
      GuiScrollBar モデルに。`REM_GUI_SCROLL_BAR_FIELD` で除去。ユニット
- [x] T6: snapshot 露出＋選択入力応答 — ScreenSnapshot に `gui`（選択フィールド/ウィンドウ/スクロールバー）を付与、
      ScreenBuffer が GUI 構造体を保持。選択→AID Read 応答（decisions D3）。ユニット

## web: 描画・入力
- [x] T7: web GUI 描画 — 選択フィールドをラジオ/チェック/プッシュボタン、ウィンドウを枠付きオーバーレイ、
      スクロールバーを表示。snapshot.gui を ScreenGrid 上に重ねる。コンポーネントテスト
- [x] T8: web GUI 入力 — 選択（クリック）→ ws gui-select/gui-submit でセッションへ送信。
      ボタン/メニューは即送信、ラジオは選択、チェックはトグル。コンポーネントテスト

## MCP 表現
- [x] T9: MCP GUI 露出 — screenResult の structuredContent に gui、text に GUI セクション。
      select_gui_choice / submit_gui_selection ツール追加。ユニット

## 検証・仕上げ
- [x] T10: 合成 trace ＋実機探索 — WDSF 合成バイトのリプレイ検証（unit + セッション E2E）、web/MCP 描画確認、
      実機 PUB400 で enhanced 広告の非 GUI 回帰なしを確認・GUI 画面探索（標準画面は非 GUI＝合成 trace を正）【実機】
- [x] T11: 仕上げ — core/web-ui/server エクスポート・README 更新、decisions 整理
