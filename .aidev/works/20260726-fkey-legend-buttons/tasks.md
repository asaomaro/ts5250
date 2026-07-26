# タスク: 機能キー凡例のボタン化

- [x] T1: `composables/fkeyLegend.ts` を新規作成し、**桁空間の行モデル**（DBCS tail を除いた表示文字列と
      `index → 桁` の対応）と**凡例検出**（`F<n>=` の語境界・n=1〜24・ラベル境界は空白2個以上・
      末尾の罫線除去・空ラベル破棄）を純関数で実装する。ユニットテスト:
      PUB400 fixture 再生でメニュー 6 キー検出／サインオン 0 件、DBCS 行で桁が正しいこと。
- [x] T2: `detectWindowRect()` を実装する（`gui.windows` があれば最前面を優先、無ければ罫線から検出:
      横罫8桁以上・上下の桁範囲が8割重なる・間の行の半数以上に縦罫・最大面積）。検出結果を
      **窓の内側に収まる凡例だけ**に絞る。ユニットテスト: F1 ヘルプ相当の合成データで
      `F3@2`（下の画面）と `F13@2`（切れたラベル）が除外され、窓内の 6 件が残ること。（依存: T1）
- [x] T3: `stores/viewSettings.ts` に `buttons: ButtonStyle`（`none`/`underline`/`filled`/`rich`・既定 `none`）を
      追加し、`VIEW_ITEMS` に「ボタン意匠」を登録する（`wide: true`・コントロール表現の直後）。
      設定メニューとキー設定の順送りに自動で載ることをテストで確認する。
- [x] T4: `ScreenGrid.vue` の `Segment` に **開始桁 `col`** を持たせる（`rows()` で text セグメント生成時に記録）。
      既存の描画・テストが壊れないことを確認する。
- [x] T5: `ScreenGrid.vue` の text セグメント描画で、そのセグメントに完全に収まる凡例を
      `<button type="button" class="fkey-btn" tabindex="-1">` に分割する（`linkify` の分割とマージし、
      重なりは凡例優先／セグメントに収まらない span は捨てる／`font:inherit; padding:0; border:0;
      background:none` で桁を動かさない／色は指定せずホスト色を継ぐ）。`(e:"aid", key)` を emit する。
      意匠 `none` のときはボタン化しない。（依存: T1, T2, T4）
- [x] T6: `EmulatorPane.vue` で `@aid` を受け、`sendKey(sessionId, key, cursor)` へ配線する。
      `busy` / `keyboardLocked` のときは送らない。ボタンの `mousedown` は `preventDefault` して
      フォーカス（＝カーソル位置）を奪わない。（依存: T5）
- [x] T7: 意匠 CSS を実装する。`.pane[data-buttons="…"]` で `.fkey-btn` と `.gui-choice` の両方に
      4 種（なし/下線/塗り/枠）を適用する。`none` は `.gui-choice` を**現状の意匠のまま**にし、
      全意匠で `selected` / `unavailable` の区別を保つ。色替えは `box-shadow` と限定的な背景のみ。（依存: T3, T5）
- [x] T8: `gui.selectionFields` が存在する**行**では凡例検出を行わない（ホスト宣言優先）。（依存: T1）
- [x] T9: コンポーネントテストを追加する: 入力欄の `F12=X` を検出しない／クリックで `sendKey` が呼ばれる・
      `busy` では呼ばれない／意匠 4 種が `.fkey-btn` と `.gui-choice` の両方に効き `selected`・`unavailable` が残る／
      **ボタン化 ON/OFF で桁位置が変わらない**（DBCS を含む行）。（依存: T5, T6, T7）
- [x] T10: `docs/UI-DESIGN.md` に規約を追記する（桁空間で検出する理由・窓の内側限定・
      ボタン意匠は「押せるもの」に一律で効く・`--mono`/`--screen-mono` と同じく桁を崩さない描画）。（依存: T7）
