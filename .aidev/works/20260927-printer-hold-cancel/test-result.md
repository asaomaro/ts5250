# テスト結果: プリンターの応答を止めている間にホストが帳票を取り消したとき

## 実行したもの
- `npx vitest run packages/tn5250/test/printer-session.test.ts` — 22 passed / 0 failed
- 変異: 溜めたレコードを解いた後に処理しない → 2 件落ちる
- 実機（2026-09-27・社内機）: `scripts/verify-printer-hold-cancel.mjs`（取り消し 2 通り × 3 回）・`HOLD_IDLE_MIN=17`（1 回）。片付けの後「残り: (無し)」

## 受け入れ基準ごとの判定
- AC1: pass — research F1（HLDSPLF → HELD・ENDWTR → READY、接続は切れない、帳票は失われない）
- AC2: pass — research F2・F3・F6。単体テストで並びを固定（CLEAR・FF を溜め、解いた後の CLEAR と合わせて 4 本の応答）
- AC3: pass — research F7（17 分止めても切れない。解くと印刷済み）
- AC4: pass — 作ったスプールは消した（開始前からあったものは触らない）。装置は作っていない

## 失敗の証跡
このラウンドでは失敗が発生していない（測定スクリプトの段取りの失敗——書き出しプログラムの MSGW——は research F0 に記録）。

## 起動確認（smoke）
```
smoke: /healthz ok, / が Web UI を返した (port 45391)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

## 未検証の穴（skip / 環境不足）
- FF だけの帳票（取り消しの後）の ACS の実際の出力の実測（原典では既定の JPS は白紙 1 ページで当 PJ と一致。`ECLHostPrintSession` で当てられるかは未確認。decisions D2・backlog）
- PUB400（書き出しプログラムを止める権限が無い）では測っていない
- DLTSPLF は対象外
