# 仕様: SCS の DBCS ラン中に制御コードを食わない

requirement.md の「【重要】調査の結論」により、**SO/SI の桁勘定は変更しない**。
本仕様の対象は 1 か所だけ。

## 変更

`packages/scs/src/scs.ts` の DBCS 分岐に **`b >= 0x40` の判定**を足す
（`packages/core/src/protocol/wtd-applier.ts` の `applyWtd` と同一の条件式）。

```ts
if (this.isDbcs && dbcsMode) {
  if (b === SI) { dbcsMode = false; continue; }
  if (b === SO) { continue; }          // 冗長 SO
  if (b >= 0x40) {                      // ← 追加。0x40 未満は先行バイトにしない
    const b2 = next();
    if (b2 < 0) break;
    putWide(String.fromCodePoint(this.codec.decodeDbcsPair!(b, b2)));
    continue;
  }
  // 0x40 未満＝制御。dbcsMode は維持したまま下の switch で処理させる
}
```

**なぜ 0x40 で切れるか**: SCS の制御はすべて 0x40 未満（NOOP 0x00 / TRANSPARENT 0x03 /
HT 0x05 / RNL 0x06 / FF 0x0C / CR 0x0D / NL 0x15 / ORDER_2B 0x2B / PP 0x34 / RFF 0x3A）。
DBCS の先行バイトは 0x40 以上（0x4040 の全角空白を含む）。`wtd-applier` が既にこの境界で
分けており、**両経路で同じ判定にする**ことが要点。

**フォールスルー後の扱い**: `dbcsMode` は落とさない。制御を処理したあとも DBCS ランは
継続しているとみなす（ホストが SI を送るまで）。表示だけが欠け、同期は保たれる。

## 対象外（requirement.md 参照）

SO/SI の桁勘定・CCSID 既定値・1399 と 930/939 の表差・PDF レンダラ。

## テスト（`packages/scs/test/scs.test.ts` に追加）

| # | 内容 |
|---|---|
| T1 | SI を閉じずに NL → 改行が効き、両行が化けずに出る |
| T2 | SI を閉じずに FF → 改ページが効く |
| T3 | 奇数バイトの DBCS ラン（`SO 機 0x40 能 SI`）で以降が延々と化け続けない |
| T4 | 全角空白（0x4040）が行中で 2 桁の U+3000 として出る（退行防止） |

**PUB400 実採取フィクスチャの既存アサーション（説明欄が桁 38 で揃う）が変わらないこと**が
最重要の回帰条件——これが動いたら SO/SI 相当の桁変更を誤って入れたことになる。

## 検証

```
npm run build
cd packages/scs && npx vitest run
cd packages/core && npx vitest run
npx eslint packages/scs/src/scs.ts packages/scs/test/scs.test.ts
```
