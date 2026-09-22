# 仕様: 関連付けプリンター（プリンターセッションを指す方式）

## 概要
表示の 5250 の設定に、同じファイルのプリンターの設定を指す `associatedPrinterSession`（と待ち時間・一緒に閉じる）を足す。ブラウザから表示を開くとき、server がそのプリンターを
使い回すか開いて起こし、装置名を待ってから `associatedPrinter`（IBMASSOCPRT）として表示を開き、表示の切断・繋ぎ直し・終了に合わせてプリンターを止める・起こす・閉じる
（ACS `AssociatedPrinterSession5250`。research F1〜F5）。

## 設計方針
- 設定: `associatedPrinterSession`（プリンターの設定の id。`system` と同じく同じファイルの中だけ）・`associatedPrinterTimeout`（秒。0 は待ち続ける。1〜4 は 5、600 超は 600 に丸める＝ACS）・
  `closeAssociatedPrinterWithLastSession`（既定 false）。**装置名の方式（`associatedPrinter`）とは排他**（ACS も方式を 1 つ選ぶ）。後ろ 2 つは `associatedPrinterSession` があるときだけ。
- 開く順序（ACS F2）: 同じ持ち主・同じ設定のプリンターが開いていればそれ（止まっていれば起こす）、無ければ開いて起こす。待ち時間まで起動を待ち、繋がっていれば起動応答の装置名、
  ~~そうでなければプリンターの設定の装置名をそのまま（ACS は時間切れで `getWorkstationID()`＝設定の値）、それも無ければ~~ → **時間切れ・起動の失敗なら関連付けなし**で表示を開く。指した設定が見つからない・プリンターでない・
  使えない（権限）なら、関連付けなしで開いて利用者に知らせる（ACS の `KEY_5250_ASSOC_INVALID_PROFILE`）。
- 連動（ACS F4・F5）: 表示がホストに切られた（繋ぎ直しに入った）・ホストが終わった・利用者が閉じたときに、ほかに同じプリンターへ関連付けた表示が繋がっていなければプリンターを止める。
  繋ぎ直せたらプリンターを起こす。閉じたときは、一緒に閉じる指定ならプリンターも閉じる。
- **常駐のプリンター（サービス ✅）は止めも閉じもしない**——ACS に無い概念で、ほかの利用者や自動出力が頼る待ち受けを 1 つの表示の都合で止めない（decisions D2）。
- 退けた案: 表示の側に装置名を覚えさせて繋ぎ直しのたびに問い合わせる——ACS は開くときに 1 度決める（F3）。

## 対象範囲
- `packages/server/src/config-types.ts`・`config-store.ts`・`config-resolver.ts`（`ResolvedTarget.associatedPrinterSession`）
- `packages/server/src/ws-handler.ts`（表示を開く経路・プリンターの材料の組み立ての共通化）
- `packages/server/src/session-manager.ts`（`linkAssociatedPrinter`・連動）
- `packages/web-ui/src/stores/systems.ts`・`components/ConfigCard.vue`・README

## 依拠する既存の事実
- プリンターの使い回し・起こす・止める・閉じる: `packages/server/src/session-manager.ts:1011`・`:1109`・`:1226`・`:1919`（research F6）
- プリンターの装置名: `packages/tn5250/src/session/printer-session.ts:229`（F7）
- 表示を開く経路・プリンターの材料: `packages/server/src/ws-handler.ts:556`〜・`:838`〜（F8）
- 設定の参照の検査: `packages/server/src/config-store.ts:78`・`:300`・`:314`（F9）
- 表示の繋ぎ直しのイベント: `Session5250` の `reconnecting` / `reconnected` / `closed`（`packages/server/src/ws-handler.ts:1005`〜 が購読している）

## インターフェース / データ構造
- 設定 `associatedPrinterSession?: string` / `associatedPrinterTimeout?: number`（0〜600）/ `closeAssociatedPrinterWithLastSession?: boolean`（`PublicSession` にも）
- `ResolvedTarget.associatedPrinterSession?: { ref: string; timeoutMs?: number; closeWithLast: boolean }`（`timeoutMs` 無し＝待ち続ける）
- `SessionEntry.associatedPrinter?: { printerId: string; closeWithLast: boolean }`、`SessionManager.linkAssociatedPrinter(displayId, printerId, closeWithLast)`
- ws `notice`（既存があればそれ）で「関連付けるプリンターセッションが見つかりません」を利用者へ

## 振る舞いの詳細
- 検査（保存時・読み込み時）: 指した id が同じファイルに無い・プリンターでない・（個人設定で）持ち主が違うなら 400 / 読み込みで CONFIG_ERROR。
- ほかの表示の数え方: 同じプリンターの id に関連付けた、自分以外の表示で、`closed` / `reconnecting` でないもの。

## エラー処理 / 異常系
- プリンターの起動の失敗は表示を止めない（関連付けの装置名を設定の値に倒す）。連動で起こすときの失敗は記録だけ。

## 受け入れ基準との対応
- AC1: スキーマ・ストアのテスト（書ける・排他・5250 の表示だけ・指した先の検査）。入力は保存の API と設定ファイル。
- AC2: ws のテスト（使い回し・開いて起こす・~~待ち時間切れで設定の装置名~~ 待ち時間切れは関連付けなし・指した設定が無い・同時に開いても接続は 1 本・失敗と切断の片付け）。入力は `open`（`session` 参照）。
- AC3: SessionManager のテスト（繋ぎ直しで止めて起こす・ほかの表示があれば触らない・常駐は触らない）。入力は表示のイベント。
- AC4: SessionManager のテスト（閉じて止める・一緒に閉じる・ほかの表示があれば触らない）。入力は `close`。
- AC5: ConfigCard のテスト。入力は設定カード。
- AC6: 実機（社内機）で、`.env.verify` のプリンター装置で開くプリンターの設定を指した表示の DSPJOB の印刷装置と、閉じたときのプリンターの状態。
- AC7: mutation。
