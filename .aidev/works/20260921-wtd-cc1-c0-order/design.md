# 仕様: WTD の CC1=0xC0 で欄が消えない

## 概要
**達成したい状態**: 入力を消すべき画面で打った値が残らない。
実現は `case 0xc0` の**2 行の順序を入れ替えるだけ**。

## 設計方針
- **消してから MDT を落とす**（ACS と同じ順序。原典で確認）。
- **他の case は触らない**——`0xa0` / `0xe0` は `nullNonBypass(false)`（全欄）なので
  順序で結果が変わらない。触ると差分が増えるだけ。
- 順序に意味があることを**コメントに残す**——将来「整理」で戻されないように。

## 対象範囲
| ファイル | 変更内容 |
|---|---|
| `packages/tn5250/src/protocol/wtd-applier.ts` | `case 0xc0` の 2 行を入れ替え＋出所コメント |
| `packages/tn5250/test/wtd-applier.test.ts` | 値が消えること・MDT が落ちることを固定 |

## 依拠する既存の事実
- `nullNonBypass(onlyMdt: boolean)`（`packages/tn5250/src/screen/buffer.ts:1240`）。
  `true` で**MDT の立った欄だけ**が対象。
- `case 0xa0` / `0xe0` は `nullNonBypass(false)`（`wtd-applier.ts` の `applyCc`）＝全欄。
- ACS `DS5250.processWCC1` の case 6 は `clearNonbypassFields(true)` → `resetMDTFields(true)`
  （requirements に逆アセンブルの抜粋）。

## インターフェース / データ構造
変更なし（関数の中の順序だけ）。

## 振る舞いの詳細
CC1=0xC0 → MDT の立った非バイパス欄の値が空になり、MDT が落ちる。キーボードは施錠（既存）。

## エラー処理 / 異常系
変更なし。

## 要件との対応
- AC1 / AC2: 順序の入れ替えで満たす。テストで固定。
- AC3: 順序を戻す mutation で落ちることを確かめる。
- AC4: `case 0xc0` に ACS のメソッド名と順序を書く。
- AC5: `wtd-applier.test.ts` を回す。
