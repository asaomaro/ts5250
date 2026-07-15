# タスク: 04-dbcs-tls-wide

## DBCS
- [x] T1: gen-tables DBCS — .ucm パーサを EBCDIC_STATEFUL（uconv_class）対応に拡張、ibm-930/939/1399 の
      .ucm を同梱、DBCS テーブル（EBCDIC 2 バイト⇔Unicode の双方向 Map）を生成、`tables/ibm930.ts` 等コミット
- [x] T2: codec DBCS — EBCDIC_STATEFUL コーデック（SO=0x0E/SI=0x0F ステートマシン）、DBCS decode（2 バイト→
      Unicode）・encode（Unicode→DBCS＋SO/SI）、`codecForCcsid(930/939/1399)` が DBCS 対応コーデックを返す、
      未定義は U+FFFD/SUB。ユニット（依存: T1）
- [x] T3: screen SO/SI/DBCS セル — WtdApplier/ScreenBuffer が SO/SI を kind so/si の空白 1 桁セルとして配置、
      DBCS 2 バイトを lead/tail の 2 セルに割付、**cells 不変条件（全行 cols 個・桁位置 1:1）維持**、
      FCW の DBCS フィールド種別（pure/open/either）を解釈。ユニット（依存: T2）
- [x] T4: DBCS フィールド入力 — ReadResponseBuilder の DBCS 再エンコード（フィールド値 Unicode→DBCS＋SO/SI）、
      **バイト長検証**（SO/SI 込みで field length 超過は FIELD_OVERFLOW）、pure/open フィールド規則。ユニット（依存: T3）

## 端末タイプ・TLS・ワイド
- [x] T5: 端末タイプ — DBCS（IBM-5555-C01 等）・27x132（IBM-3477-FC）を RFC 4777 表に従い ConnectOptions
      （ccsid/screenSize）から決定、telnet TERMINAL-TYPE 応答に反映。ユニット＋PUB400 で受理確認【実機】（依存: T2）
- [x] T6: TLS transport — `TcpTransport` に TLS（node:tls）を追加、証明書検証既定 ON、`tls: true |
      { rejectUnauthorized, ca }`、既定ポート 992。TLS_CERT_INVALID エラー。ユニット（自己署名サーバ）（依存: なし）
- [x] T7: 27x132 ワイド画面 — ScreenBuffer に 27x132 代替バッファ、CLEAR UNIT ALTERNATE で切替、snapshot の
      rows/cols がアクティブバッファに追従、24x80 への ALTERNATE は警告。ユニット（依存: T3）
- [x] T8: WSF QUERY 応答拡充 — Query Reply に端末タイプ別の 27x132／DBCS 能力を広告（buildQueryReply を
      端末パラメータ化）。ユニット（依存: T5, T7）

## Web・MCP 表現
- [x] T9: web DBCS/ワイド描画 — ScreenGrid で DBCS セルを 2ch 幅、SO/SI・属性桁 1ch スペース、CJK 等幅フォント
      スタック実測選定（全角=半角×2）、27x132 レイアウト。コンポーネントテスト（依存: T3）
- [x] T10: MCP テキスト DBCS 桁維持 — screenToText が SO/SI・DBCS 桁を保持し、DBCS 行と SBCS 行で桁がズレない
      ことを検証。ユニット（依存: T3）

## 検証・仕上げ
- [x] T11: 実機/リプレイ検証 — PUB400 で TLS 接続（992）、DBCS 端末タイプ受理、`CHGJOB CCSID(1399)`＋IGCDTA
      ソース PF で日本語入出力の trace 採取＋リプレイ回帰 fixture、27x132 画面表示【実機・PUB400】（依存: T4, T5, T6, T7, T8, T9）
- [x] T12: 仕上げ — core/server/web-ui のエクスポート・README 更新（DBCS/TLS/27x132 対応を反映）、
      decisions 整理、検証スクリプト整備（依存: T11）

## フィールド入力検証・SO/SI 表示（追加・decisions D4）
- [x] T13: core フィールド入力内容検証 — `setField` で数値型（数字と `.`/`-` のみ）、A 型（SBCS のみ）、
      J 型=pure（DBCS のみ）、O 型=open（SBCS+DBCS）の内容規則と、コードページ許容文字（マップ不能文字は拒否）を
      検証し、違反は `FIELD_TYPE` エラー。MCP/Web 両方に効く。ユニット
- [x] T14: SO/SI 表示トグル — snapshot の so/si セルは kind で識別できるため、web の表示オプションで SO を `{`・
      SI を `}` に切替表示（既定は空白）。Ctrl+F 相当のトグル。コンポーネントテスト（依存: T13）
