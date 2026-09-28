# 仕様: HLLAPI の AID の前の検査

## 概要
HLLAPI の `sendAid` の前に、ACS `processAIDCode` と同じ順（MF → 自己点検 → ME）で検査する。判定は `hllapi-leave-check.ts` の関数を使い回す。

## 設計方針
- `hllapi-leave-check.ts` から `fieldViolation(snapshot, field)`（MF・自己点検。`leaveViolation` の中身）と `mandatoryEnterViolation(snapshot)` を出す
- `hllapi.ts` の `sendKey` で AID キーのとき、除外キー以外なら検査。違反なら `conn.cursor` を置き直して `rc=5` で返す（Tab と同じ返し方。`20260927-hllapi-tab-mandatory` decisions D1）
- ME の「画面が変更済み」（ACS の masterMDT）はペインと同じく「どこかの欄に MDT がある」で近似する（HLLAPI の書き込みは core の MDT を立てる）

## 対象範囲
- `packages/server/src/hllapi-leave-check.ts`・`packages/server/src/hllapi.ts`・`docs/HLLAPI.md`

## 依拠する既存の事実
- ACS `PS5250.processAIDCode`: AID 4・242・251 と 61・248・243・189（Test・Record Backspace・Help・Clear）以外で、カーソル下の欄の `checkMandatoryFillField` → 20（欄頭）、
  右寄せ・符号付き数値の MDT で欄を出ていない → 32、`checkModulusField` → 21（欄頭）、`performMandatoryEnterFieldCheck`（CA キーを除く）→ 7（ME の欄の先頭へ）（原典）
- `FFT5250.checkMandatoryFieldCheck`: 表の順で最初の MDT の無い ME 欄。`masterMDT` のときだけ（原典）
- 実機の ACS のコア（ECL＝HLLAPI と同じ経路）: ADJPGM の 9 場合（`.aidev/works/20260921-mandatory-check-acs/research.md` F2。`scripts/acs-probe/mandatory-me-mf.txt`）
- ペインの除外キーは Attn・SysReq・Help・Clear・Record Backspace・Test Request（`packages/web-ui/src/session-controller.ts` の `sendKey`）
- HLLAPI の AID は `sendAid(deps, entry, conn, key)`（`packages/server/src/hllapi.ts`）。CA キーは `snapshot.caKeys`

## インターフェース / データ構造
- `fieldViolation(snapshot, field): boolean`・`mandatoryEnterViolation(snapshot): Field | undefined`

## 振る舞いの詳細
- 継続欄の ME は並びのどこかに MDT があれば満たす（`runHasMdt`）
- ME 欄の保護・バイパスは見ない（ACS `isByPassField`）

## エラー処理 / 異常系
- なし

## 受け入れ基準との対応
- AC1: `sendKey` の MF の分岐（単体・`scripts/verify-hllapi-tab-mandatory.mjs` に場合を足す）
- AC2: 自己点検の分岐（単体）
- AC3: ME・CA キー・未変更・除外キー（単体・実機）
