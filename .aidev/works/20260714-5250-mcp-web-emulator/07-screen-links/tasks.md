# タスク: 07-screen-links

- [x] T1: リンク検出ユーティリティ — `composables/linkify.ts`: 文字列 → `{start,end,href,kind}[]`＋`splitLinks`。
      http/https URL とメールを保守的正規表現で検出。href は http/https/mailto のみ（危険スキーム不生成）。
      URL 末尾句読点除去・URL 内メールの二重検出防止。ユニット 9。
- [x] T2: ScreenGrid リンク描画 — text セグメントを splitLinks でプレーン/リンクに分割、リンクは
      `<a target="_blank" rel="noopener noreferrer" @click.stop>`。input/dbcs・カタカナ表示中は対象外。
      1 文字=1ch 維持。コンポーネントテスト 6。
- [x] T3: 表示トグル — workspaceStore に `linkify`（既定 ON）追加、App に 🔗 トグル併設、EmulatorPane 経由で伝播。
      ScreenGrid は withDefaults で既定 ON（Vue の Boolean prop 既定 false 対策）。
- [x] T4: 仕上げ — README にリンク化を追記。decisions は追加判断なし（サブセットは plan に記載済み）。
