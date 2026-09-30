# 調査: プリンターの keepalive

## 判明した事実（デコンパイル済みの ACS。事実だけ）
- F1: プリンター（`HostPrintTerminal`）も端末と同じ HOD `Session` の `keepAlive`（`SESSION_KEEPALIVE`、既定 `"false"`）を使う。プリンターだけ既定が違う箇所は見つからなかった（`20260930-display-keepalive-off-3270-vt` research F1・F3）
- F2: 当 PJ のプリンター（`packages/tn5250/src/session/printer-session.ts`）は既定で `TcpTransport` の keepalive（60 秒）が掛かっていた。理由は常駐プリンターが 15 分のアイドルで届かなくなる実測（#354・`scripts/measure-printer-idle-drop.mjs`）
- F3: **ACS の既定でその環境がどうなるかは測っていない**。ACS が同じ環境で常駐プリンターを保てるかは不明で、当 PJ の実測が示すのは、途中の機器が 15 分の無通信で接続を落とす環境で、当 PJ が keepalive 無しだと届かなくなる、ということ
- F4: プリンターには常駐の自動復帰（`reconnectPrinter`）があるが、**無通信で落とされたことは検知できない**（落ちても `state` は `listening` のまま）。検知できるのは落ちたことがソケットの close で分かるときだけ

## 判断（利用者の指示）
- ACS のプリンターが入れていないなら合わせる。副作用: 途中の機器が無通信の接続を落とす環境の常駐プリンターは、設定 `keepAlive: true` を書かないと、また届かなくなる（README に明記）
