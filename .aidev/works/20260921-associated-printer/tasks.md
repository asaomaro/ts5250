# タスク: 関連付けプリンター（IBMASSOCPRT）

## 実装方針
tn5250（申告）→ server（設定・解決）→ web-ui（入力欄）の順に下から通し、最後に実機で当 PJ と ACS のコアを比べる。

## 作業順序と依存関係
- 下の `依存:` に従う。実機の確認（T5）は tn5250 の申告（T1）が入ってからでないと当 PJ 側を測れない。

## リスク / 留意点
- 既存の NEW-ENVIRON の応答の期待値を変えない（AC5）。
- 実機の装置名をリポジトリ・記録に書かない（`.env.verify` から採る）。

## テスト方針
- 関係するテストだけを都度（tn5250 の telnet・server の config・web-ui の ConfigCard）。全量・mutation・独立点検は節目で。

## タスク
- [x] T1: telnet 層とセッションに関連付けプリンターを足し、応答の最後に IBMASSOCPRT を置く（値は加工せず下位 8 ビット）
      対象: `packages/tn5250/src/telnet/telnet.ts` `handleSubnegotiation` / `packages/tn5250/src/session/session.ts` `establish` / 根拠: research A1, A2
      依存: なし
      AC: AC1, AC5
- [x] T2: 設定スキーマに `associatedPrinter` を足し、表示の 5250 以外では 400 にする。解決で表示の 5250 だけ渡す
      対象: `packages/server/src/config-types.ts` `sessionBase` `assertTypeConsistent` / `packages/server/src/config-resolver.ts` `buildConnect` / 根拠: research A3, A4
      依存: T1
      AC: AC2
- [x] T3: web-ui の設定カードに入力欄を足す（表示・5250 のときだけ。空なら送らない）
      対象: `packages/web-ui/src/stores/systems.ts` `SessionConfigForm` / `packages/web-ui/src/components/ConfigCard.vue` / 根拠: research A5
      依存: T2
      AC: AC3
- [x] T4: README とプローブの説明を足す
      対象: `README.md` の設定の節 / `scripts/README.md` の acs-probe の節
      依存: T1
      AC: なし
- [x] T5: 実機で当 PJ を ACS のコアと同じ手順で測り、記録する（消化は test 工程）
      対象: `scripts/acs-probe.mjs`（ACS 側は済み）/ scratch の測定スクリプト（当 PJ 側）
      依存: T1
      AC: AC4
- [x] T6: 条件を 1 つずつ外してテストが落ちることを確かめる（消化は test 工程）
      対象: T1〜T3 のテスト
      依存: T1, T2, T3
      AC: AC6
