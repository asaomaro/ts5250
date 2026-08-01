# 仕様: 設定モデルと軸の分離

`design.md` のうち、**D3（フラグ 2 つ）と D5（状態の語彙）** をこの work で実装する。
D1（状態機械の実装）・D2（定義と実体の分離）・D4（権限）は**次の work**（decisions D1）。

## 対象範囲

| ファイル | 変更 |
|---|---|
| `packages/server/src/service-state.ts` | **新設**。`ServiceState`（4 状態）/ `holdsConnection` / `autoStartOf` |
| `packages/server/src/config-types.ts` | `printer.service`（サービス ✅）・`session.autoStart`（自動で待ち受け開始） |
| `packages/server/src/config-resolver.ts` | `service` を 5 層目で解決・`autoStart` を解決 |
| `packages/server/src/session-manager.ts` | `resident` の導出を `service` フラグへ（PR #252 の作り直し） |
| `packages/server/src/ws-handler.ts` | `service` の配線 |
| `packages/server/test/service-state.test.ts` | 新規 |
| `packages/server/test/printer-residency.test.ts` | 新しいモデルへ更新 |

## 振る舞いの詳細

### 既定は変わらない

- `autoStart` 未設定 → `true`（**いまある定義が「開いても何も起きない」に変わらない**）
- `service` 未設定 → `false`（常駐は明示的に選ぶもの）

既存の定義をそのまま読むと、**いまと同じ挙動**になる。

### 軸が分かれたことで表現できるようになったもの

| 設定 | 結果 |
|---|---|
| サービス ✅ ＋ 出力あり | 常駐して PDF に落とす（従来の唯一の形） |
| **サービス ☐ ＋ 出力あり** | **開いている間だけ PDF に落とす**（従来は表現できなかった） |
| **サービス ✅ ＋ 出力なし** | **常駐して溜めるだけ**（後で画面で見る。従来は表現できなかった） |
| サービス ☐ ＋ 出力なし | 従来の対話型 |

### 信頼境界

`service` は `printerSchema` の中＝**サーバー設定側のスキーマにしかない**。
解決も `source === "server"` を条件にしており、**出力設定と同じ 5 層目**。
新しい判定軸を作っていないので、二つがずれることがない。

`autoStart` は**信頼設定ではない**（パス書込・コマンド実行・秘密に触れない）ので、
個人設定でも持てる——`dtaqWatch` と同じ理屈。

## 受け入れ基準との対応

requirement の完了条件のうち、本 work が満たすのは
「サービス ✅ が admin 限定」「既定の挙動が変わらない」「`resident` 導出の置き換え」
「build / lint / test」。**残りは次の work**（`decisions.md` D1 に一覧）。
