# タスク: ホストサーバーの認証の置換値

## テスト方針
- jt400 の出力との一致（固定シード）、偽のサーバーで要求の種別、実機の回帰、mutation。

## タスク
- [x] T1: レベル 4 の計算と暗号化種別を `password.ts` に、前処理を `credentials.ts` に寄せ、サインオンとサーバー開始の両方から使う。テスト。
      対象: `packages/hostserver/src/password.ts` `packages/hostserver/src/credentials.ts` `packages/hostserver/src/signon.ts` `packages/hostserver/src/server-connect.ts` `packages/hostserver/src/bypass-signon.ts`
      依存: なし
      AC: AC1, AC2, AC3
