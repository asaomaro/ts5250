# テスト結果: 関連付けプリンター（プリンターセッションを指す方式）

## 実行したもの（関係するテストだけ。全量・独立点検は節目で）
- `cd packages/server && npx vitest run test/associated-printer-link.test.ts test/associated-printer-session.test.ts test/ws-associated-printer.test.ts test/config-associated-printer.test.ts test/config-resolver.test.ts test/config-store.test.ts test/config-routes.test.ts test/ws-service-reject.test.ts test/printer-manager.test.ts test/session-manager.test.ts` — 153 passed / 0 failed
- `cd packages/web-ui && npx vitest run test/config-card-associated-printer.test.ts test/config-card-terminal.test.ts test/config-card-idle-timeout.test.ts test/config-card-ownership.test.ts` — 46 passed / 0 failed
- mutation（`scratchpad/mut-aps.py` 27 通り＋`mut-aps2〜4.py`）— 等価な 2 通りを除いて全部 KILLED（下の証跡）

## 受け入れ基準ごとの判定
- AC1: pass — `config-associated-printer.test.ts`（書ける・参照で返る・指した先の検査〔無い・プリンターでない・他人の〕・装置名の方式と排他・待ち時間と一緒に閉じるはプリンターセッションを指したときだけ・5250 の表示だけ・読み込みの検査）。
- AC2: pass — `ws-associated-printer.test.ts`（開いて起こす・使い回す・待ち時間切れでも表示は開く〔設定の装置名〕・装置名が決まるのを待つ・指した設定が無い/プリンターでないなら関連付けなし）と、
  `config-associated-printer.test.ts` の解決（既定 5 秒・1〜4 は 5 秒・600 超は 600 秒・0 は待ち続ける）。
- AC3: pass — `associated-printer-session.test.ts`（切れたら止め繋ぎ直せたら起こす・ほかの表示が使っていれば止めない・全部切れたら最後が止める・常駐は止めない・ホストが終わらせても止める）。
- AC4: pass — 同（閉じたら止める・一緒に閉じるなら閉じる・ほかの表示が使っていれば閉じない・常駐は閉じない・閉じた後の遅れたイベントに反応しない）。
- AC5: pass — `config-card-associated-printer.test.ts`（同じ保存先のプリンターだけ・選ぶと参照が入り装置名は送らない・待ち時間と一緒に閉じるは既定なら送らない・排他・「指定しない」・5250 の表示だけ・詳細）。
- AC6: pass — 実機（社内機・2026-09-22。`scratchpad/ap/ws-assoc-session.mjs` / `ws-assoc-two.mjs`。ws 経由で表示を開いた）:

  | 手順 | 結果 |
  |---|---|
  | プリンターの設定を指した表示を開く | 表示が開く（I902）・プリンターが起きる（listening・装置名は `.env.verify` のプリンター装置） |
  | 表示のジョブで `DSPJOB OPTION(*DFNA)` の印刷装置 | **指したプリンターの装置**（関連付けなしではシステム既定。`20260921-associated-printer` の実測） |
  | 表示を閉じる | プリンターは止まる（stopped）・エントリは残る |
  | 「最後の表示と一緒に閉じる」を付けて閉じる | プリンターのエントリごと消える |
  | 同じプリンターを 2 本の表示で共有 | プリンターは 1 つだけ開く（使い回す）・1 本目を閉じても動き続け（listening）・2 本目を閉じて止まる |
- AC7: pass — mutation 27 通りのうち等価な 2 通りを除いて KILLED（下）。

## 失敗の証跡
書いたテストの 1 回目は、テスト側の誤りで落ちた（プリンターの起動応答の装置名を EBCDIC に直す表で、S〜Z の添字が 1 つずれて `PRTA` が `PRSA` になった）:

```
     × **プリンターを開いて起こし、その装置名（起動応答の名前）で関連付けて表示を開く** 22ms
     × **同じ持ち主・同じ設定のプリンターが開いていれば使い回す**（開き直さない） 11ms
AssertionError: expected 'PRSA' to be 'PRTA' // Object.is equality
```

「待ち時間切れでも表示は開く」は 15 秒で時間切れになった。`PrinterSession.connect` は起動応答が来るまで戻らない（最大 15 秒）ので、待ち時間を「起動を待つ」ループにだけ掛けていると、
起動応答が来ないプリンターでは `open()` の中で止まっていた。開く・起こすにも同じ待ち時間を掛けて直した:

```
     × **待ち時間切れでも表示は開く**（プリンターの設定の装置名で関連付ける。ACS は設定の値のまま） 15015ms
Error: Test timed out in 15000ms.
      Tests  1 failed | 5 passed (6)
```

mutation で生き残った変異にテストを足した（1 回目 → 足した後）:

```
SURVIVED 閉じても組を外さない :: 42 passed (42)                     → KILLED（組を外すことを固定するテスト）
SURVIVED プリンターでない設定でも進む :: 42 passed (42)             → KILLED
SURVIVED 装置名を待たない :: 45 passed (45)                         → KILLED（使い回すプリンターが起動中なら待つテスト）
SURVIVED 閉じたらプリンターに触らない :: 42 passed (42)             （等価: 下）
SURVIVED 閉じた後の遅れたイベントにも反応する :: 45 passed (45)    （等価: 下）
```

等価な 2 通りの理由: `close` の中の `releaseAssociatedPrinter` は、直前の `entry.session.disconnect()` が発火する `closed` からも同じ処理が走るので、消しても挙動が変わらない（二重の保険）。
「遅れたイベントにも反応する」は、組を外した後は `this.sessions.get(displayId)` が `undefined` になって同じ効果を持つ二重の守り。

## 起動確認（smoke）

```
$ node launcher/smoke.mjs
smoke: /healthz ok, / が Web UI を返した (port 44895)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

新しい入口（サブコマンド・オプション）は足していないので `smokeCommands` は据え置く。

## 未検証の穴（skip / 環境不足）
- 実ブラウザで設定カードから保存して開く経路は jsdom まで（サーバーの ws まで実機で通した）。
- 表示がホストに切られて繋ぎ直す経路の実機は測っていない（連動は `SessionManager` のテストと、同じ `reconnecting` / `reconnected` イベントの購読まで。イベント自体は `20260921-auto-reconnect` で実機確認済み）。
- ACS の GUI の状態（プリンターのウィンドウの表示・タブ）は写していない。

## 節目 10 の対応（ラウンド 2 の指摘を直した回）

### 実行したもの
- `npm test`（全量）— 6,619 passed / 0 failed / 41 skipped（10 ワークスペース）
- `npm run lint` — exit 0 / `npm run build`（web-ui の `vue-tsc` を含む）— exit 0（途中の 1 回は `field-exit-checks-wiring.test.ts` の型で落ち、`NonNullable<Field["dbcsType"]>` に直した）
- mutation（`scratchpad/mut-trust.py`）— 13 通りとも落ちた（持ち主・認可・削除・種別変更・準備中の切断・相乗り・掃除・時間切れ）
- mutation（`scratchpad/mut-c10b.py` 8 通り）— 理由の返却。初回に 3 通り生き残ったのでテストを 3 件足し、8 通りとも落ちた
- mutation（`scratchpad/mut-c10c.py` 4 通り）— REST の参照変換（POST・PUT）。初回に 1 通り生き残ったのでテストを足して落ちた
- mutation（`scratchpad/mut-c10d.py` 6 通り）— 切断後の後始末・組を解くときの数え・接続中の印。初回に 2 通り生き残ったのでテストを 2 件足し、6 通りとも落ちた
- mutation（`scratchpad/mut-c10e.py` 5 通り）— 設定ストアの参照検査の入口。5 通りとも落ちた（探りの 1 通りは数えない）
- mutation（`scratchpad/mut-c10.py`）— 待ち時間の空欄 1 通りが落ちた

### 受け入れ基準の再確認
- AC1〜AC7: pass（全量）。REST の往復（POST → GET → PUT）・参照されているプリンターの保護・信頼境界の 3 パターンを `config-routes-associated-printer.test.ts`（11 件）で固定

### 失敗の証跡
点検役の再現（直す前の HEAD。`scratchpad/rv10/route-roundtrip.test.ts`・`p4-route2.test.ts`・`p4-route3.test.ts`）:

```
POST /api/sessions-config  associatedPrinterSession: "srv:prt"  → 404  session d references missing printer session srv:prt
id（"prt"）なら 201、返る値は "srv:prt"、それを PUT → 404
DELETE（指されているプリンター）→ 200・ファイルに参照が残る・ServerConfigStore.fromFile が CONFIG_ERROR を投げる
PUT で printer → display → 200・再読込が CONFIG_ERROR
```

直した後の mutation の 1 回目（`scratchpad/mut-c10b.py`・`mut-c10c.py`・`mut-c10d.py`）で生き残ったもの:

```
SURVIVED C-S5 開けなかったときに理由を付けない :: 52 passed (52)
SURVIVED C-S1 起動失敗に理由を付けない :: 52 passed (52)
SURVIVED C-S1 時間切れに理由を付けない :: 52 passed (52)
SURVIVED C-M1 文字列でない値を通さない（検査に届かず落ちる） :: 27 passed (27)
SURVIVED この open の前に disposed を戻さない :: 56 passed (56)
SURVIVED 開く待ちの間に切れても表示を閉じない :: 56 passed (56)
```
足したテストで 6 通りとも落ちた。

### 起動確認（smoke）

```
$ node launcher/smoke.mjs
smoke: /healthz ok, / が Web UI を返した (port 45959)
smoke: {"status":"ok","sessions":0}
smoke: pass (exit 0)
```

### 未検証の穴
- 実機のプリンターへは今回は当てていない（前回の実機確認〔指した装置がジョブの印刷装置になる・表示に合わせて止まる・共有〕のまま）
- 表示の切断→繋ぎ直しでのプリンターの止まり方・起き方の実機、ACS の GUI 状態は測っていない（台帳）
- 「一緒に閉じる」の数え方・状態 4 で起こす規則は原典の読みまで（台帳）
