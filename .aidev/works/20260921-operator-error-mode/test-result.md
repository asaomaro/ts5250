# テスト結果: 操作員エラーでキーボードを施錠し、Reset キーで解く

## 実行したもの
- `cd packages/web-ui && npx vitest run test/operator-error-mode.test.ts` — 18 passed / 0 failed / 0 skipped
  （D3 で挿入モードの解ける時点を訂正したあとの 2 ラウンド目。1 ラウンド目は 16 件）
- 関係する既存テスト（保護領域入力・無応答通知・最下行メッセージ・ペースト検証・日付ピッカー・
  挿入／キーマップ／在席／SysReq／表示切替／マクロ系）と本 work のテスト、計 16 ファイル — 226 passed / 0 failed
- **全量（`npm test`）・lint・build は節目でまとめて回す**（利用者の指示。バッチの ①〜③ の後）

## 受け入れ基準ごとの判定
- AC1: pass — エラー中の文字・Backspace・Delete で欄の値が変わらず、メッセージが残る。
- AC2: pass — 右・左矢印・Tab・Home・クリックで抜け、その後の文字が入る。挿入モードが「上書き」に戻る。
  **エラーに入った時点で**挿入モードが「上書き」に戻る。情報の通知では施錠も挿入解除もしない。
  AID は `onAid` が `exitErrorMode` を呼ぶ（コード読解）。
- AC3: pass — 左 Ctrl の押下→解放で抜ける。エラーでなくても挿入モードが解ける。押しただけ・Shift を挟んだ・右 Ctrl では働かない。
- AC4: pass — mutation がすべて落ちた:
  M1 拒否しない → 3 件落ち / M3 挟んでも Reset を取り消さない → 1 件 / M4 クリックで抜けない → 1 件 /
  M5 エラーで挿入を解かない → 1 件 / M6 Reset で挿入を解かない → 1 件 / M7 情報の通知でも挿入を解く → 1 件。
  （1 ラウンド目の M2「抜けるときに挿入を解かない」は、D3 で抜けるときに解かない実装になったので対象外）

## 失敗の証跡
テストを書いた最初のラウンドで 2 件落ちた（実装ではなくテストの観測点の誤り）:

```
 FAIL  test/operator-error-mode.test.ts > Reset（左 Ctrl を単独で押して離す） > **Ctrl+C のように他のキーを挟んだら Reset にしない**
AssertionError: Ctrl+C で Reset が走った: expected '' to be 'この項目には英字しか入力できません' // Object.is equality
 FAIL  test/operator-error-mode.test.ts > そのほかの抜け方 > エラーでない通知（情報）は次のキーで消えるだけで、文字は入る
AssertionError: expected '表示 :  切替' to be '表示: 切替' // Object.is equality
      Tests  2 failed | 14 passed (16)
```

- 1 件目: `c` の打鍵そのものが「抜ける」側のキーなので、Reset の取り消しを観測できない。
  挟むキーを Shift（修飾キー単独は抜けない）に替えた。
- 2 件目: 最下行はセル描画で全角の間に空白が入る。空白を除いて比べた。

## 起動確認（smoke）

```
$ aidev smoke
smoke: /healthz ok, / が Web UI を返した (port 45691)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- **実ブラウザ・実機での操作確認は未実施**（jsdom のみ）。IME（`Process`）・コピー／貼り付けの
  エラー中の振る舞いは ACS 側も未測定（`decisions.md` D2）。
