# タスク: 画面全体の自由カーソル

- [x] T1: 有効カーソルの一元化＋オーバーレイ追従 — `ScreenGrid` に `cursor:{row,col}` prop を追加し、カーソル
      オーバーレイを `snapshot.cursor` 固定から prop（有効カーソル）に。`EmulatorPane` の `cursor`（override ??
      snapshot.cursor）を AID と ScreenGrid の両方へ供給。まず「クリックで非入力にカーソルが見える」を通す。
- [x] T3: `composables/useCursor.ts`（純関数）— `moveCursor(cur,dir,rows,cols)`（左右=行送り/戻し、上下=同桁
      クランプ）、`fieldAt(row,col,fields)`、`caretInField(field,col)`。DOM 非依存。（依存: なし）
- [x] T2: クリック精度化＋モード調停 — `onGridClick` を実測字幅で `(row,col)` 算出に。クリック先が編集可欄なら
      該当 input を focus＋キャレット、非入力なら input を blur＋オーバーレイ表示（field/free 調停）。（依存: T1, T3）
- [x] T4: 矢印のセル移動＋モード調停 — `EmulatorPane` の矢印処理を、欄内はキャレット移動（既存）、フィールド端で
      外へ出る Left/Right と Up/Down は `moveCursor` でセル移動＋focus/blur 調停に。Tab はフィールド間ジャンプ据え置き。
      （依存: T1, T3）
- [x] T5: AID・端・DBCS・busy 仕上げ — AID 送信位置を有効カーソルに統一（確認）、行端の行送り/クランプ、
      DBCS lead 桁への丸め、busy 中のカーソル移動抑止。（依存: T1）
- [x] T6: テスト — useCursor ユニット＋ ScreenGrid/EmulatorPane コンポーネント（クリックで非入力カーソル・矢印
      セル移動・field⇄free 遷移・AID にカーソル反映・既存非回帰）。pane-nav の矢印テストをセル移動仕様へ更新。
      （依存: T2, T4, T5）
