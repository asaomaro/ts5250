# タスク: ホストのエラー（WRITE ERROR CODE）でも、ACS と同じくエラー状態に入る

## 実装方針
実機で ACS と当 PJ を並べ（全画面・窓）、差のあった全画面の WEC だけを直す。

## 作業順序と依存関係
下の `依存:` に従う。

## リスク / 留意点
- 画面の更新のたびに挿入モードを戻す既存の監視と重なる（WEC も画面として届く）。

## テスト方針
- コア: 通し番号。ブラウザ: エラー状態・挿入モード・隠す・入り直し。mutation。

## タスク
- [x] T1: 試験画面（ULKPGM の RANGE・WINDOW）で ACS と当 PJ を実機で並べる。
      対象: `scripts/acs-probe/window-error.txt` `scripts/verify-host-error.mjs` `scripts/acs-probe/host-error-mode.txt`
      依存: なし
      AC: AC1, AC2
- [x] T2: コアの通し番号。
      対象: `packages/tn5250/src/screen/buffer.ts` `nextSystemMessageSeq`、`wtd-applier.ts` `applyWriteErrorCode`
      依存: T1
      AC: AC1
- [x] T3: ブラウザのエラー状態とメッセージ行の復元。
      対象: `packages/web-ui/src/components/EmulatorPane.vue`
      依存: T2
      AC: AC1, AC2
- [x] T4: テストと mutation。
      対象: `system-message-lifetime.test.ts` `host-error-mode.test.ts`
      依存: T3
      AC: AC3
- [x] T5: エラー状態をセッション側へ移す（`SessionState.hostErrorDismissedSeq`）。CLEAR UNIT で操作員エラーを抜ける。
      対象: `stores/sessions.ts`、`EmulatorPane.vue` `hostErrorActive` `inErrorMode` `exitErrorMode` `watch(snapshot)`
      依存: T4
      AC: AC4
- [x] T6: エラー中の編集キーの拒否・空白だけの WEC。
      対象: `EmulatorPane.vue` `isEditingKey`、`useKeymap.ts` `localEditActionOf`、`wtd-applier.ts` `applyWriteErrorCode`
      依存: T4
      AC: AC5
- [x] T7: テストと mutation。
      対象: `host-error-mode.test.ts` `system-message-lifetime.test.ts`
      依存: T5, T6
      AC: AC3
