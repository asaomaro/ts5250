# テスト結果: Shift+Enter で画面を送信する

## 実行したもの
```
$ cd packages/web-ui && npx vitest run test/keymap.test.ts test/newline-key.test.ts
  Tests  13 passed (13)
```
全量・lint・build はバッチの節目でまとめて回す（利用者の方針）。

## 受け入れ基準ごとの判定
- AC1: pass — Shift+Enter は AID を送らず Newline になる。次の行の最初の入力欄へ移り、
  下に無ければ先頭へ巡回する。
- AC2: pass — 下記 mutation。

## 失敗の証跡
このラウンドでは失敗が発生していない。

## mutation（条項 `verify-by-mutation`）
```
Shift を見ずに Enter を送る（旧挙動）→ Tests  3 failed | 10 passed (13)
巡回を外す                           → Tests  1 failed | 12 passed (13)
復元                                 → Tests  13 passed (13)
```

## 原典で確かめたこと
- `PS5250.processNewline` は次の行の先頭位置を起点に、そこが入力欄ならそこへ、
  でなければ `FFT5250.nextNonByPassInputFieldPos` で次の入力欄を探す（ループで回り込む）。

## 未検証の穴・未対応の差
- **次の行の先頭が「前の行から続く行またぎ欄の中」に当たる場合**、ACS はその欄の中へ置くが、
  当方は次の行で**始まる**欄だけを見る。行またぎ欄では着地がずれうる（コードに注記）。
- **Ctrl 系の割り当て（ACS の `C17 = [newline]`）は未対応**。キーの特定をしていない
  （推測で割り当てない）。
smoke: /healthz ok, / が Web UI を返した (port 46473)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
