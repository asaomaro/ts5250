# タスク: 基本 TN3270E

- [x] T1: `telnet/constants.ts` に `OPT.TN3270E = 0x28` を追加
- [x] T2: `telnet/tn3270e.ts` — 定数（CMD / FUNC / REASON / DATA_TYPE）と 5 バイトヘッダの `splitHeader` / `withHeader`＋単体（依存: T1）
- [x] T3: `telnet/tn3270e.ts` — `Tn3270eNegotiator`（DEVICE-TYPE / FUNCTIONS の状態機械。空集合要求・対案・上限・REJECT）＋単体（依存: T2）
- [x] T4: `telnet/terminal-type.ts` に `deviceTypeFor()`（`IBM-3278-*`）を追加＋単体（依存: なし）
- [x] T5: `telnet/telnet.ts` へ統合（`DO TN3270E` の受理・SB の委譲・ヘッダの付け外し・`isTn3270e`／`deviceName` の公開・`onNegotiated` の発火条件）＋単体（依存: T3, T4）
- [x] T6: `session/session.ts` から `deviceType` / `deviceName` / `tn3270e` を渡す（依存: T5）
- [x] T7: `test/harness/mini3270.ts` を **RFC 準拠の TN3270E サーバ**に拡張し、**s3270 が受理することを先に確認**（依存: T2）
- [x] T8: 照合 — 自実装 × ハーネス、および **s3270 と自実装の交渉列の突き合わせ**（依存: T6, T7）
- [x] T9: TN3270E セッションを fixture 化して replay 回帰に還元（依存: T8）
- [x] T10: 退行確認 — TK4- と IBM i の既存 E2E、全パッケージのテスト、build / lint（依存: T6）
- [x] T11: `decisions.md` に D1 / D3 / D5 / D6 を記録（依存: T8）
