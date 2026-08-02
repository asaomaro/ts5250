# 仕様: 純 DBCS と BLOB の 64KB 超を実測で閉じる

## 概要

実測が主で、コード変更は research F3 が見つけた 1 点だけ。

| 系統 | 結果 |
|---|---|
| 純 DBCS（CCSID 300） | **UTF-16 と同じ道を通る**（実測で確認。変更なし） |
| BLOB | **CCSID は `65535`**。`decodeLobBytes` の判定が欠けていた（要修正） |

## 設計方針

### 判定を 1 か所に寄せる（`isBinaryCcsid`）

「バイナリ（文字コードを持たない）」は `0` と `65535` の 2 値。この判定が 3 か所に散り、
`decodeLobBytes` だけ `0` しか見ていなかった。**`catch` に落ちて偶然バイト列を返していた**
——65535 に codec を足した瞬間に BLOB が文字列へ化ける形だった。

`db-decode.ts` に `isBinaryCcsid` を置き、3 か所すべてをそこに寄せる。
`20260801-dbclob-locator-decode` が同じ形（判定の重複）で集約したのと同じ扱い。

**振る舞いは変わらない**（今も結果はバイト列）。変わるのは「偶然」から「明示」へ。

## 対象範囲

| ファイル | 変更 |
|---|---|
| `db-decode.ts` | `isBinaryCcsid` を追加。`decodeLobBytes` の判定と doc |
| `db-reply.ts` | 直書きの `0 \|\| 65535` を寄せる |
| `marker-encode.ts` | 同上 |
| `test/lob-ccsid-units.test.ts` | `isBinaryCcsid` と 65535 の復号 |
| `test/lob-multi-segment.test.ts` | 純 DBCS（300）と BLOB（65535）の分割 |
| `scripts/research-lob-big-dbcs-blob.mjs`（作成済み） | 事実の採取 |
| `scripts/verify-lob-big-dbcs-blob.mjs`（新規） | 実機確認 |

## 振る舞いの詳細

- `isBinaryCcsid(0) === true` / `isBinaryCcsid(65535) === true`、それ以外は false。
- `decodeLobBytes(bytes, 65535)` は**同じ配列**を返す（コピーしない。従来どおり）。
- 分割受信は変更なし——純 DBCS は `perChar=2`、BLOB は `perChar=1` で既存の枝に乗る。

## テストの循環を避ける

偽ホストの `perChar` は**引数で渡す**。`isTwoByteCcsid`（こちら側の判定）から導くと、
「自分の判定で自分の判定を試す」循環になり、判定が間違っていても通ってしまう。
ホストの振る舞いは**実機で測った値をそのまま書く**。

## 受け入れ基準との対応

| 完了条件 | 満たし方 |
|---|---|
| 純 DBCS の 64KB 超を作れた | research F1（1200 経由の種＋倍々） |
| 純 DBCS が先頭から連続 | 実機 1 |
| BLOB がバイト単位で一致・化けない | 実機 2 ＋ `isBinaryCcsid` |
| 上限ちょうど・`too-large` | 実機 1〜3 |
| 実機なしの回帰 | `lob-multi-segment` に 2 件、`lob-ccsid-units` に 4 件 |
| backlog を実測で閉じる | deliver で該当行を `[x]` |
