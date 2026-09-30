# 調査: ACS の keepalive の扱い（端末・プリンター・ホストサーバー）

## 判明した事実（デコンパイル済みの ACS。事実だけを書き起こした）
- F1: 端末（5250・3270・VT）とプリンターは、どちらも HOD の `Session` の 1 つの設定 `keepAlive` を使う（`Terminal.isKeepAlive()` も `HostPrintTerminal.isKeepAlive()` も `session.isKeepAlive()`）。
  ECL 側の名前は `SESSION_KEEPALIVE`、既定は `"false"`（`ECLSession.SESSION_KEEPALIVE_DEFAULT`・`HODDefaults` の `keepAlive`）。**端末の種類とプリンターで既定は分かれない**
- F2: `Transport` は接続したソケット（平文・SSL）に、この値で `setKeepAlive(socket, keepAlive)` を呼ぶ。false のときも明示的に false を設定する。true のときは Java の `Socket.setKeepAlive(true)` だけで、
  無通信の時間・間隔・回数は OS の既定（Windows は無通信 2 時間・1 秒間隔・10 回）——当 PJ の「無通信 60 秒」とは違う
- F3: ACS の製品側（`acsbase.jar`・`acsutils.jar`・`acsmaingui.jar`）に、セッションの keepalive を上書きする箇所は見つからなかった（`keepalive` の語は HMC の接続だけ）
- F4: ホストサーバーの接続は ACS 同梱の `jt400.jar` の `SocketProperties`。`keepAlive` は「設定した」印（`keepAliveSet_`）が既定で偽で、設定しなければ JVM の既定（入れない）
- F5: 当 PJ の現状: 5250 の表示は #460 で既定 false。3270・VT の表示は既定 true（各 `tcp.ts`）。プリンター（5250）・ホストサーバー（`hostserver/src/transport/host-connection.ts` の 60 秒）は既定 true。
  プリンターは常駐で無通信が正常な使い方で、15 分のアイドルで届かなくなる実測がある（`20260823`・#354）。ただし ACS でその環境の同じ条件（既定の keepalive なし）でどうなるかは測っていない

## 判断
- 3270・VT の表示は F1 のとおり 5250 と同じ設定なので、5250 と同じく既定 false にする（この work）
- プリンターとホストサーバーは、常駐して無通信が正常な当 PJ の使い方（サービス）で、実測に基づく既定 true。ACS 既定と違うが、**ACS が情報を捨てているのではなく、使い方が違う**ので変えていない。決めるのは利用者
