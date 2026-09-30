# 調査: ホストサーバーの keepalive

## 判明した事実
- F1: ACS 同梱の `jt400.jar` の `SocketProperties` は `keepAlive` を「設定した」印（`keepAliveSet_`）と値（`keepAlive_`）で持ち、どちらも既定 false。設定しなければ JVM の既定（入れない）（`20260930-display-keepalive-off-3270-vt` research F4）
- F2: 当 PJ は `host-connection.ts`・`ddm-transport.ts` で `setKeepAlive(true, 60 秒)` を無条件に呼んでいた。理由は常駐監視（DTAQ の `wait=-1`）が read タイムアウトを無効にして待つので、相手が黙って消えると永久に待つこと（`20260723-dtaq-watch-notify` research R3）
- F3: 長命の接続は常駐監視（`watch-source.ts`・`host-msgwatch.ts`）で、他は要求ごとの短い接続（`host-connect.ts` の注記）。監視は解決したセッション設定の接続材料（`ConnectOptions`）を `hostAuthFrom` 経由でホストサーバーの接続クラスへ渡す
- F4: 6 種の接続クラスは先に signon で認証し、そのあと目的のサーバーへ `openHostConnection`（DDM は `openDdmTransport`）で繋ぐ。signon の接続は短い

## 判断（利用者の指示）
- ACS（jt400）に合わせて既定は入れない。副作用: 途中の機器が無通信の接続を落とす環境の常駐監視は、設定 `keepAlive: true` を書かないと、落ちたことに気づけない（README に明記）
