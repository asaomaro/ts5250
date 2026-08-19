# 計画

## 順序

1. **`host-command.ts`**（server）——2 ルート。`host-program.ts` の作りをそのまま踏襲
2. **`app.ts`** に登録
3. **`CommandPane.vue`**（web-ui）——`ProgramPane.vue` を下敷きに
4. **`PanePool` / `paneLabels`** に `cmd:` を足す
5. **テスト**——server はルート単体（接続はモック）、web-ui はマウントして描画と検証

## 危ないところ

- **`paneLabels.ts` の `PANE_PREFIXES`**——ここに足し忘れるとタブが開かない。
  既存の注記に「タブを閉じる処理が壊れた前例がある」とあるので、**両方を必ず揃える**
- **既定値を欄に入れない**（spec D3）。入れると「消したのに既定が効かない」ことになる
- **`hostserver` を web-ui から import しない**（Node の層）。型だけ `@ts5250/server` 経由で取る
