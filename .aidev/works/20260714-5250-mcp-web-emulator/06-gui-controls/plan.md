# 計画: 06-gui-controls — 拡張 5250 GUI コントロール

親: 20260714-5250-mcp-web-emulator（親 decisions D2 で追加。分解のみ・再分割なし）
依存: 05-field-edit-keyboard（review 承認済み）

## 実装方針

- 拡張 5250（Enhanced 5250 interface）の GUI 構造体を実装する。ワイヤ上は **WSF（0xF3）class 0xD9** の
  各 type（tn5250 codes5250.h）:
  - `DEFINE_SELECTION_FIELD`(0x50) → ラジオ/チェック/プッシュボタン
  - `CREATE_WINDOW`(0x51) → ウィンドウ枠
  - `DEFINE_SCROLL_BAR_FIELD`(0x53) → スクロールバー
  - `REM_GUI_SEL_FIELD`(0x58) / `REM_GUI_WINDOW`(0x59) / `REM_GUI_SCROLL_BAR_FIELD`(0x5B) /
    `REM_ALL_GUI_CONSTRUCTS`(0x5F) → 除去
- **前提: Query Reply で enhanced 5250 を広告**（現状 `query-reply.ts` t[53]=0x00 を有効化）。これでホストが
  GUI 構造体を送ってくる。
- 実装の根拠は **GNU tn5250**（define_selection_field / create_window_structured_field / define_scrollbar）と
  **SC30-3533**。GPL の tn5250 はコード移植せず挙動・バイト仕様の参考のみ。
- GUI 構造体は ScreenSnapshot に **guiConstructs**（選択フィールド/ウィンドウ/スクロールバー）として付与し、
  web は HTML コントロール、MCP は structuredContent＋テキストで表現する。
- 選択の入力は、選択フィールドの選択状態を Read 応答（MDT/AID）としてホストへ返す。

## 検証方針（ユーザー選択: 合成 trace ＋実機探索）

- **合成 trace リプレイ（主軸・決定的）**: tn5250 準拠のバイト列で GUI 構造体を含む WTD/WSF レコードを組み、
  リプレイでパース・snapshot・描画を検証。
- **実機探索**: PUB400 で GUI 構造体を使う画面（あれば）を探して疎通確認。標準メニューは非 GUI のため、
  出なければ合成 trace を正とする（DBCS と同方針。decisions に記録）。

## リスク / 留意点

- **DEFINE_SELECTION_FIELD の構造は複雑**（選択タイプ・選択項目・状態・位置のネスト）。tn5250 の実装を
  読み解き、主要サブセット（単一選択=ラジオ / 複数選択=チェック / プッシュボタン）に絞る。
- enhanced 広告を有効化すると、既存の非 GUI 画面のデータストリームに影響が出ないか実機で確認する
  （出たら広告フラグを慎重に調整）。
- ウィンドウは「枠＋オーバーレイ」で描画（背景画面の上に重ねる）。スクロールバーは表示と位置通知に留める。

## テスト方針（protocol 2.8・この subtask の範囲）

- ユニット: WSF GUI 構造体パーサ（各 type→モデル）、選択フィールドモデル（type/choices/state）、
  ウィンドウモデル、除去、選択入力の Read 応答構築。
- コンポーネント: web の選択フィールド（ラジオ/チェック/プッシュボタン）・ウィンドウ・スクロールバー描画。
- 契約: MCP の structuredContent/text に GUI 構造体が表れる。
- リプレイ: 合成 GUI trace の snapshot 検証。実機は探索的疎通のみ。
- 受け入れ基準 13 項目の総点検は親の統合 test に委ねる。
