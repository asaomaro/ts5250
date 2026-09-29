# テスト結果: READ SCREEN の応答の中身のタイミング

## 実行したもの
- `cd packages/tn5250 && npx tsc --noEmit -p .` — OK
- `cd packages/tn5250 && npx vitest run` — 1236 passed / 0 failed
- `node --env-file=.env --env-file=.env.verify scripts/verify-read-screen-timing.mjs` — `RESULT: pass=2 fail=0`（2 回。直す前は `pass=1 fail=1`）
- 変異 4 通り（セッション側の `slot.record` 無視・適用側の 0x62 と 0x66 の枠・セッションの callback 無し）— すべて検出

## 受け入れ基準ごとの判定
- AC1: pass — `packages/tn5250/test/read-screen-timing.test.ts`（3 件）
- AC2: pass — 実機の DSM の READSCRTIMING（OLD）・READSCRTIMING2（NEW）で当 PJ のコアが ACS のワイヤと同じ

## 失敗の証跡
直す前の実機（差の裏付け）:

```
  FAIL READSCRTIMING: 応答の画面は ["NEW"]（ACS: OLD）
  PASS READSCRTIMING2: 応答の画面は ["NEW"]（ACS: NEW）
RESULT: pass=1 fail=1
```

## 起動確認（smoke）
```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 40463)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- READ SCREEN EXTENDED（0x64・0x68）・READ IMMEDIATE（0x72）・READ MDT IMMEDIATE ALT（0x83）の応答の中身は未測定（台帳）
- SAVE SCREEN の本体は ACS が別の形（Java の直列化）で、画面に出ない差として直さない（decisions D1）
