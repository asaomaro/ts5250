# 決定記録

## D1: 資格情報のハッシュを Web Crypto に寄せ、ソケット I/O を transport/ へ移した

- 背景: 初回実装で `hostserver/` から `node:net` / `node:tls` / `node:crypto` を import したところ、
  lint の `no-restricted-imports` に 4 件かかった。core のピュアロジック層は Node API 非依存
  （I/O は `transport/` と `log.ts` に隔離）という既存の設計規約に反していた。
- 決定: 規約を緩めず、設計に合わせた。
  - ソケットとフレーム分割 → 新設 `transport/host-connection.ts`（`openHostConnection` / `queryPortMapper`）
  - ポートマッパー応答の**解釈** → `hostserver/port-mapper.ts` に純関数 `parseMapperResponse` として残す
  - SHA-1 と乱数 → `node:crypto` ではなく **Web Crypto の標準グローバル**（`crypto.subtle` / `crypto.getRandomValues`）
- 理由 / 代替案: eslint 設定に例外を足す案もあったが、自分の都合で規約を曲げることになる。
  Web Crypto なら Node API を import せずに済み、ブラウザでも動く形に保てる。
  代償は `passwordSubstituteSha` が `subtle.digest` の仕様で**非同期になる**こと。認証は元々
  非同期フローの中なので実害はないと判断した。
- 影響: `passwordSubstituteSha` が `Promise<Uint8Array>` を返す。固定ベクタは Web Crypto でも
  一致したため、アルゴリズムの等価性は確認済み。

## D2: ポートマッパーの TLS はサービス名に "-s" を付ける

- 背景: `--tls --resolve-port` で認証が失敗した。ポートマッパーが平文ポート 8476 を返し、
  そこへ TLS を張ろうとして切断されていた。
- 決定: TLS 要求時はサービス名に `-s` を付ける（`as-signon-s`）。`ResolvePortOptions.tls` を追加した。
- 理由: JTOpen の PortMapper が `serviceName + "-s"` としており、実機でも裏が取れた。

  ```
  as-signon   -> 8476    as-signon-s   -> 9476
  as-database -> 8471    as-database-s -> 9471
  drda        -> 446     drda-s        -> 拒否(0x2d)
  ```
- 影響: `DEFAULT_PORT.ddm` も誤りだったので訂正（8471 → **446**。DRDA は他と違い標準ポート）。

## D3: VRM の version は上位 16 ビット（4 バイト分割ではない）

- 背景: 実機確認でサーバー版数が `0.7.5.0` と表示された。IBM i 7.5 として不自然だった。
- 決定: `V{(raw>>>16)&0xffff}R{(raw>>>8)&0xff}M{raw&0xff}` 形式にする（0x00070500 → `V7R5M0`）。
- 理由: JTOpen の `ServerVersion.getVersion()` が `vrm_ >> 16 & 0x0000ffff` で、
  表示も `String.format("V%dR%dM%d", ...)` だった。単純な 4 バイト分割は誤り。

## D4: 応答のパラメータ開始位置は template 長から求める（24 決め打ちにしない）

- 背景: 単体テストで「要求を応答として解析する」往復テストを書いたところ失敗した。
- 決定: 応答の戻りコードは template（長さ 4）として運ばれると理解し、
  パラメータ開始位置を `HEADER_LEN + templateLen` で求める。
- 理由: 実機の交換属性応答はヘッダーの template 長が 4 で、オフセット 20〜23 が戻りコードだった。
  24 決め打ちでも実機では動くが、template 長が異なる応答で壊れる。
- 影響: `parseReply` が template 長 4 未満の応答を `PROTOCOL_ERROR` にする。
