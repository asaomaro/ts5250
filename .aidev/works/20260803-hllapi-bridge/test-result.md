# テスト結果: HLLAPI / EHLLAPI 対応

## 自動テスト

`npm test` **3,883 件緑**（差し戻し前 3,846 → +37）。lint も緑。

| 追加した検査 | 何を固定したか |
|---|---|
| `session-manager.test.ts`（予約 10 件） | 締め出し・期限・延長・強制解除・購読 |
| `hllapi.test.ts`（予約 7・指定 9） | `rc` の対応、**当たらなければ繋がない** |
| `ws-handler.test.ts`（3 件） | **経路側から**締め出しが効くこと |
| `pane-reserved.test.ts`（7 件） | 覆い・入力停止・打ちかけ破棄。**対照つき** |

## 実機 C ABI（実機・日本語画面）— 33/33

`node --env-file=.env scripts/verify-hllapi.mjs`。Python `ctypes` で本物の C ABI。

```
OK  予約前は人間が打てる（対照）
OK  Reserve (11) — rc=0
OK  **予約中は人間の入力が断られる**
OK  **予約中も自動化自身は読める** — rc=0
OK  Release (12) → **解除で人間が打てるようになる**
OK  **Disconnect で予約も外れる**
```

`extern "system"` へ変えた後に再実行して同じ結果（Linux では `C` と同一のため）。

## E2E（DLL → 実機 → 実物のブラウザ）— 14/14

`node --env-file=.env scripts/verify-hllapi-browser.mjs`。Playwright で実物の Chromium。

```
OK  ブラウザで「検証」を開いた — サイン・オン
OK  **開いていないセッション（本番）は掴めない（rc=1）**
OK  **名前で指して繋げる（"A 検証"）** — rc=0
OK  **Query Sessions が指定の書き方を出す** — A 192.0.2.1 24x80 検証
OK  **掴んだ画面がブラウザの画面と一致する**（別のセッションを掴んでいない）
OK  **ブラウザに触らずに画面が描き直された**（DLL の操作が push で届く）
OK  **予約すると覆いが出る** ／ **誰が触っているか出る**（HLLAPI が自動操作中です）
OK  **覆いが画面を塞いでいる**（クリックが下へ抜けない）
OK  **「解除して操作する」で覆いが消える**
```

**これで「ブラウザが HLLAPI の操作で描き直される」が主張できる**——
前回は理屈だけで、見ていなかった。

## 途中で見つけた欠陥

1. **固定長バッファの NUL 埋めが名前に混ざる。** VBA の `String * 64` や C の `char[64]` は
   余りが NUL のまま届く。`trim()` は NUL を落とさないので `検証\0\0…` になって当たらなかった。
   最初の NUL で切るようにした。**この作業で 2 度目**（前は検索語で踏んだ）
2. **32bit Office からの呼び出しでスタックが壊れる。** エクスポートが `extern "C"`（cdecl）
   だったが、WinHLLAPI と VBA の `Declare` は `stdcall`。`extern "system"` に変えた
   ——32bit Windows で `stdcall`、他は `C` になる唯一正しい書き方

## 確かめていないこと

- **Windows でビルドも動作確認もしていない**（開発環境に MSVC / mingw が無い）。
  呼び出し規約は直したが、**直したこと自体を Windows で確かめていない**
- **VBA の `Declare` を通した動作は未検証。** `docs/hllapi-sample.bas` は書いたが動かしていない
- **`.xlsm` を生成していない。** VBA プロジェクトは OLE 複合ファイルで Linux 側では組めないので、
  Windows 上の Excel に作らせる PowerShell（`scripts/make-hllapi-xlsm.ps1`）を用意した。
  **このスクリプトも実行していない**
