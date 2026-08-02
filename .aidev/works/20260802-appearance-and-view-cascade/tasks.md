# タスク: 「外観」と「表示」／表示設定の 2 段カスケード

## 土台

- [x] T1: `styles.css` — テーマのブロックを**自己完結・要素非依存**に
- [x] T2: `useTheme` — 解決済みの表示モードを読めるように
- [x] T3: `viewSettings` — 2 段カスケード（`defaults` / `overrides`）＋ `theme` 項目（依存: T2）
- [x] T4: `stores/appearance.ts` — `showTabSystemName`（アプリ全体・localStorage）

## 適用

- [x] T5: `EmulatorPane` — `.pane` に `data-theme`（依存: T1, T3）
- [x] T9: 閉じたセッションの上書きを捨てる（依存: T3）

## 画面

- [x] T6: `ViewSettingsMenu` — `⚙ 表示`・層の切替・`既定に従う`・実値の併記・一括解除（依存: T3）
- [x] T7: `DesignMenu` — `外観`・タブのシステム名トグル（依存: T4）
- [x] T8: `PaneTabs` — トグルに従う（色帯は残す）（依存: T4）

## 仕上げ

- [x] T10: テスト（カスケード・移行・トグル・メニューの層切替）
- [x] T11: build / lint / スイート
- [x] T12: 実機で実ブラウザ検証（移行前後の見え方・テーマがペインの中だけ）＋ `scripts/README.md`
