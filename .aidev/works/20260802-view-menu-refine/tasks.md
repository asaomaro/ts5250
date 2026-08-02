# タスク: 表示メニューの整理と、プリンター／スプールへの展開

- [x] T1: `theme` の廃止（`viewSettings` / `EmulatorPane` / `useTheme`）と `styles.css` の巻き戻し
- [x] T2: 「既定に従う」の廃止・既定値の印・押下の意味（依存: T1）
- [x] T3: ボタンの高さを 22px に揃える（マクロ・表示・外観）
- [x] T4: `ViewSettingsMenu` に `keys`（項目の絞り込み）（依存: T2）
- [x] T5: `App` がプリンター／スプールでも `⚙ 表示` を出す（依存: T4）
- [x] T6: `PrinterPane` / `SpoolPane` に `linkify` と `font` を適用（依存: T5）
- [x] T7: テスト（依存: T1-T6）
- [x] T8: build / lint / スイート（依存: T7）
- [x] T9: 実機で実ブラウザ検証（巻き戻しで地色が変わらない・ボタンの高さ）（依存: T8）
