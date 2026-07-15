# タスク: 01-core-sbcs

- [x] T1: モノレポ scaffold — npm workspaces（packages/core・server・web-ui の空箱＋tools/gen-tables）、
      tsconfig（base＋project refs・ESM）、vitest、eslint（`no-console` 含む）、pino stderr 共通ラッパ、
      .gitignore、ルート README 骨子
- [x] T2: tools/gen-tables — .ucm パーサ（SBCS セクション）と TS テーブル生成、ibm-37 .ucm 同梱＋
      Unicode License V3 表記、`npm run gen:tables`、生成物 `codec/tables/ibm37.ts` コミット（依存: T1）
- [x] T3: codec — CcsidCodec の SBCS encode/decode（未定義は U+FFFD / SUB 0x3F＋警告）、既知コード
      ポイント対照ユニットテスト（依存: T2）
- [x] T4: transport — Transport インターフェース＋TcpTransport（平文・接続タイムアウト・エラー変換）（依存: T1）
- [x] T5: telnet/TelnetLayer — IAC ネゴ状態機械（BINARY/EOR/SGA/TERMINAL-TYPE=IBM-3179-2/
      NEW-ENVIRON DEVNAME）、IAC エスケープ、EOR レコード切り出し、バイト列シナリオテスト（依存: T4）
- [x] T6: trace — TraceRecorder（JSONL・方向・ts・送信データ伏字化既定 ON）＋ReplayTransport、テスト（依存: T4）
- [x] T7: PUB400 疎通＆trace 採取 — サインオン画面 trace を採取し fixtures に保存（メニュー遷移 trace は
      資格情報未設定のため T13 へ移動。decisions.md D1）（依存: T5, T6）
- [x] T8: protocol 基盤 — constants（コマンド/オーダー/AID/FFW/属性。SC30-3533 名）、ByteReader/Writer、
      GDS ヘッダ解析、テスト（依存: T1）
- [x] T9: screen/ScreenBuffer — cells グリッド（24x80）・アドレス変換（0 始まり線形⇔1 始まり row/col）・
      FieldTable（SF 由来・setField 検証・MDT）・snapshot()（nonDisplay/hidden マスク・不変条件）、テスト（依存: T8）
- [x] T10: protocol/WtdApplier — WTD/CLEAR/SAVE/RESTORE＋オーダー SBA/SF/SOH/IC/RA/EA/TD/MC、
      CC1/CC2、属性バイトデコード（カラー/reverse/underline/blink/colsep/nonDisplay）、未知オーダーの
      警告＋読み飛ばし。T7 の trace リプレイでサインオン画面スナップショット検証（依存: T9, T7）
- [x] T11: protocol/ReadResponseBuilder — カーソル＋AID＋MDT フィールドの Read MDT Fields 応答生成
      （codec 再エンコード・IAC エスケープ・EOR）、バイト列検証テスト（依存: T9, T3）
- [x] T12: session/Session5250 — 状態機械（Connecting→Negotiating→Ready⇄Locked→Closed）、connect/
      setField/sendAid/disconnect/snapshot、screen/closed イベント、AID タイムアウト（timedOut 返却）、
      KEYBOARD_LOCKED 等のエラーコード。リプレイでサインオン→メニューの E2E テスト（依存: T10, T11, T5）
- [x] T13: 実機検証＆追加 trace — PUB400 で **RFC 4777 自動サインオン→Query Reply→IBM i Main Menu 到達**を
      実機確認（decisions.md D3: 画面フィールド方式は PUB400 に拒否され、NEW-ENVIRON 自動サインオン＋
      WSF Query Reply が必要と判明）。自動サインオンフローの trace を fixtures 追加（tx 伏字化済み）（依存: T12）
- [ ] T14: core パッケージ公開整理 — index.ts エクスポート（型・Session5250・エラー）、Tn5250Error/
      ErrorCode 共通定義、core README（使い方・trace の採り方）（依存: T12）
