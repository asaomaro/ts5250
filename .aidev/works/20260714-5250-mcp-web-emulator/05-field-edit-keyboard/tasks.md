# タスク: 05-field-edit-keyboard

## フィールド編集モデル
- [x] T1: 編集モデル（純ロジック）— `fieldEdit` composable/関数: value・フィールド内カーソル・insert/overwrite
      モードを保持し、印字文字入力（上書き既定/挿入）・Backspace（5250 流: カーソル左＋左詰め）・Delete・
      カーソル移動・Home/End を計算する。フィールド長でクランプ。ユニット
- [x] T2: ScreenGrid 統合 — native `<input>` の keydown を preventDefault して T1 モデルで value/selection を
      自前管理。composition（IME）中は自前制御を無効化し確定後に規則適用。caret 同期。コンポーネントテスト（依存: T1）
- [x] T3: 入力検証の web 反映 — 型（数値/A/O/J）・コードページ許容文字を入力時に拒否（core validateFieldContent と
      整合する許容集合をクライアントに用意）。beforeinput/keydown 両方で検証。コンポーネントテスト（依存: T2）
- [x] T4: コピペ整形 — paste（insertFromPaste）・cut・選択削除で上書き/型/バイト長規則を維持。貼り付け超過は
      切り詰め、型違反文字は除去/拒否。コンポーネントテスト（依存: T2, T3）
- [x] T5: DBCS 入力桁維持 — DBCS フィールドのバイト長を web で厳密判定（SO/SI 込み）、入力中の桁（全角=2桁）を
      維持した表示。コンポーネントテスト（依存: T2）

## モード表示・キーボード
- [x] T6: Insert/上書き OIA 表示 — StatusBar に現在の編集モード（上書き/挿入）を表示、Insert キーでトグル。
      コンポーネントテスト（依存: T2）
- [x] T7: キーバインド編集 — `stores/keybindings`（localStorage・action→key マップ・既定値）、設定 UI（一覧・
      再割り当て・リセット）、useKeymap がストアを参照。コンポーネントテスト（依存: なし）

## カタカナ表示トグル
- [x] T8: 生バイト保持（core）— SBCS セルに生 EBCDIC バイトを保持（Cell に rawByte 追加。DBCS 対象外）。
      ユニット（既存 snapshot 非回帰）
- [x] T9: カタカナ⇔英小文字トグル（web）— rawByte を代替コードページ（037 英小文字／Katakana）で再解釈する
      表示トグル（Ctrl+F 相当）。ScreenGrid が toggle 時に再デコード。コンポーネントテスト（依存: T8）

## 検証・仕上げ
- [x] T10: Playwright 検証 — 上書きモードで途中入力が後続桁をシフトしない、Insert トグル、Backspace、型違反
      キー拒否、コピペ整形、既存フロー非回帰、`fill` 依存を `type`/`press` に置換【実機・PUB400】（依存: T2-T7, T9）
- [x] T11: 仕上げ — web-ui README 更新（編集モデル・キーバインド・カタカナトグル）、decisions 整理（依存: T10）
