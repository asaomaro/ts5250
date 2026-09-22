# タスク: 関連付けプリンター（プリンターセッションを指す方式）

## 実装方針
設定 → 解決 → server の開く順序と連動 → web-ui の順に通し、最後に実機で確かめる。

## 作業順序と依存関係
- 下の `依存:` に従う。

## リスク / 留意点
- プリンターを開く材料の組み立てを 2 か所に書かない（信頼設定の扱いが食い違う）。
- 常駐のプリンターを止めない（D2）。

## テスト方針
- 関係するテスト（server の config・ws・session-manager、web-ui の ConfigCard）。全量・独立点検は節目で。

## タスク
- [x] T1: 設定に 3 項目を足し、5250 の表示だけ・装置名の方式と排他・指した先（同じファイルのプリンター・同じ持ち主）を検査する
      対象: `packages/server/src/config-types.ts` `sessionBase` `assertTypeConsistent` `PublicSession` / `packages/server/src/config-store.ts` `addSession` `updateSession` `assertIntegrity` `publicSession` / 根拠: research A1
      依存: なし
      AC: AC1
- [x] T2: 解決で `associatedPrinterSession`（参照・待ち時間・一緒に閉じる）を返す
      対象: `packages/server/src/config-resolver.ts` `ResolvedTarget` `resolve`
      依存: T1
      AC: AC2
- [x] T3: ブラウザから表示を開くときにプリンターを使い回す・開いて起こす・待つ・装置名を決めて関連付ける（材料の組み立ては `onOpenPrinter` と共通）
      対象: `packages/server/src/ws-handler.ts` `onOpen` `onOpenPrinter` / 根拠: research A2
      依存: T2, T4
      AC: AC2
- [x] T4: 表示とプリンターの組を持ち、切断・繋ぎ直し・終了で止める・起こす・閉じる（常駐は触らない）
      対象: `packages/server/src/session-manager.ts` `SessionEntry` `close` / 根拠: research A3
      依存: なし
      AC: AC3, AC4
- [x] T5: 設定カードで方式・プリンターセッション・待ち時間・一緒に閉じるを入力できるようにし、README に書く
      対象: `packages/web-ui/src/stores/systems.ts` / `packages/web-ui/src/components/ConfigCard.vue` / `README.md` / 根拠: research A4
      依存: T1
      AC: AC5
- [x] T6: 実機で確かめる（消化は test 工程）
      対象: scratch の測定スクリプト
      依存: T3, T4
      AC: AC6
- [x] T7: mutation（消化は test 工程）
      対象: T1〜T5 のテスト
      依存: T1, T2, T3, T4, T5
      AC: AC7
