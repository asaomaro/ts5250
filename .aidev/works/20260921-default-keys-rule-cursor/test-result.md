# テスト結果: Ctrl+Home・Ctrl+F11

## 実行したもの（関係するテストだけ。全量・独立点検は節目で）
- `npx vitest run test/keybindings.test.ts test/acs-default-keys.test.ts` — 37 passed / 0 failed / 0 skipped（3 件を足した）
- mutation（`scratchpad/mut-dk.py`）— 3 通りすべて落ちた（Ctrl+Home を入れない・Ctrl+F11 を罫線にする・Ctrl+Home をカーソルの形にする）
- 実機: 該当なし（GUI 層のキー割り当て）
- web-ui の型検査（`vue-tsc -b tsconfig.json tsconfig.test.json`）— エラーなし。全量と lint は節目で回す

## 受け入れ基準ごとの判定
- AC1: pass — 既定に入り、押すと `viewCycle` が呼ばれ、AID は送らない
- AC2: pass — 版 4 の保存値へ追加分だけが入り、使用中のキーは奪わない。mutation 3 通りとも落ちる

## 失敗の証跡
このラウンドでは失敗が発生していない（1 回目は import の不足〔`isViewBinding`〕でテストが落ちた。テスト側の不備）。

## 起動確認（smoke）
```
$ node launcher/smoke.mjs
smoke: /healthz ok, / が Web UI を返した (port 45523)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- 実ブラウザでの Ctrl+Home・Ctrl+F11（ブラウザ・OS が奪わないか）
