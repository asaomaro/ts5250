# テスト結果: 挿入モードが画面をまたいで残る

## 実行したもの
```
$ cd packages/web-ui && npx vitest run test/insert-mode-reset-per-screen.test.ts
  Tests  1 passed (1)
```
**全量・lint・build はバッチの節目でまとめて回す**（利用者の方針）。

## 受け入れ基準ごとの判定
- AC1: pass — 新しい画面で `insertMode` prop が false に戻る。
- AC2: pass — 下記 mutation。
- AC3: pass — `initKeyboard` / `resetInsertMode` を出所コメントに明記。
- AC4: pass（節目でまとめて確認）。

## 失敗の証跡
このラウンドでは失敗が発生していない（テストは初回から通り、mutation で効きを確かめた）。

## mutation（条項 `verify-by-mutation`）
```
`insertMode.value = false;` を外す → Tests  1 failed (1)
復元                                → Tests  1 passed (1)
```

## 未検証の穴
- **実機で「画面をまたいで挿入モードが残る」を再現していない。** 単体で固定した。
- **Reset キーは未実装**（ACS は Reset でも戻す）。台帳の【まとめ】キー編集の細部に属する。
