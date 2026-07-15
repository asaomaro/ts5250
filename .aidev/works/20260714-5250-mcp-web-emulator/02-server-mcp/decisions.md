# 決定記録（02-server-mcp）

## D1: subtask 01 の HDR_FLAG（SRQ/TRQ/HLP ビット値）の誤りを修正

- 背景: T1 で SysReq 送信（fetchJobInfo に必要）を実装するにあたり、ヘッダフラグ値を原典
  （GNU tn5250 record.h）と照合したところ、01 で定義した `HDR_FLAG` の SRQ/TRQ/HLP が誤っていた。
  - 01 の値: SRQ=0x10, TRQ=0x08, HLP=0x04（誤り）
  - 正しい値（tn5250 record.h）: ERR=0x80, ATN=0x40, SRQ=0x04, TRQ=0x02, HLP=0x01
- 決定: `packages/core/src/protocol/constants.ts` の `HDR_FLAG` を正しい値に修正する。
- 理由: 誤値のままだと SysReq/TestReq/Help のフラグ送受信が破綻する。01 のロジックは build/parse で同一
  定数を使うため roundtrip テストは通っていた（＝露見しなかった）が、ワイヤ上のビットが規格と不一致だった。
- 影響: 01 の core コードの修正（shared file）。SysReq 送信（本 subtask T1）が正しく動くようになる。
  既存の roundtrip テストは build/parse 対称のため影響なし。

## D2: fetchJobInfo は SysReq→3 ではなくコマンドライン DSPJOB 方式で実装する

- 背景: spec/plan は fetchJobInfo を「SysReq→"3"（現行ジョブ表示）」で想定していたが、PUB400 実機で
  SysReq を送っても**システム要求行のオーバーレイが返らず**（keyboard unlock されずタイムアウト）、
  この経路が機能しなかった（SAVE/RESTORE SCREEN・全 opcode 適用を実装した後も同様）。
- 決定: コマンド行（画面上の非保護入力フィールド）に **`DSPJOB` を入力→Enter** して「Display Job」画面を出し、
  ヘッダ行の `Job: / User: / Number:` をラベル走査で抽出、**F3 で元画面へ復帰**する方式に変更。
  実機で確実に動作（`Job: WEBEMU01  User: USER  Number: 200737` を取得、F3 で MAIN Menu 復帰を確認）。
- 理由 / 代替案: SysReq 方式はどの画面からでも使える利点があるが、PUB400 で不成立。DSPJOB 方式は
  **コマンド行のある画面（メニュー等・典型的な入口）で確実**。SysReq 方式は将来拡張（要調査）とする。
- 影響: fetchJobInfo は**コマンド行のある画面が前提**（無い場合 JOB_INFO_UNAVAILABLE）。spec の fetchJobInfo 節に
  方式を追記。SysReq/Attn 送信・SAVE/RESTORE SCREEN・全 opcode 適用の実装自体は正しく、他用途で活きる。
