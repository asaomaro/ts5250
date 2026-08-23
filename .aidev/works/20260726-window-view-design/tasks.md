# タスク: ウィンドウ表示の見せ方

- [x] T1: `stores/viewSettings.ts` に `windowView`（none/shadow/smoke/smokeShadow/raised/outline・既定 none）を
      追加し、`VIEW_ITEMS` に「ウィンドウ設定」を `expandable: true` で登録する。
- [x] T2: `ScreenGrid.vue` で窓の矩形から**重ねる要素**を描く（枠 1 枚＋スモーク 4 枚）。
      設定が none のときは検出も描画もしない。`pointer-events: none`。（依存: T1）
- [x] T3: 意匠 CSS を `.pane[data-window="…"]` で実装する（影／スモーク／影＋スモーク／浮き出し／枠強調）。
      重なり順は文字より上・カーソル/矩形選択より下。（依存: T2）
- [x] T4: テストを追加する: 既定で要素ゼロ／文字の窓・拡張5250 の窓の両方で出る／窓なしで出ない／
      ON/OFF で行テキスト不変／ビルド後 CSS に `pointer-events:none` と 5 意匠がある。（依存: T2, T3）
- [x] T5: 実機で確認する: F1 ヘルプ（文字の窓）と TESTLIB/EXTPGM（拡張5250 の窓）。（依存: T3）
- [x] T6: `docs/UI-DESIGN.md` に規約を追記する（重ねるだけ・操作を透過・矩形は検出を再利用）。（依存: T3）
