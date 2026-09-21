# テスト結果: HLLAPI の Tab・Backtab

## 実行したもの
- tn5250: `tab-backtab-position.test.ts` — 11 passed。server: `hllapi.test.ts` — 78 passed（@B・@T の 2 件を足した）。
- mutation 7 通り（`scratchpad/mut-tab.py`）: 1 回目に 2 通り生き残った——@B のテストが「回り込み」でも同じ答えになる位置を使っていた・欄の 2 桁目の場合が無かった。
  テストを締めて当て直し、すべて検出。
- 全量は次の節目でまとめて回す。

## 受け入れ基準ごとの判定
- AC1: pass — 欄の途中・2 桁目・直後の桁・先頭・回り込み・保護欄と継続欄・逆向きのカーソル送り・SO。HLLAPI の @B（3,22 → 3,20）。
- AC2: pass — 次の欄・回り込み・カーソル送り・継続欄と保護欄。HLLAPI の @T。
- AC3: pass — 上の mutation。

## 失敗の証跡

```
$ python3 mut-tab.py   # 1 回目
SURVIVED HLLAPI の @B が使わない :: 78 passed (78)
SURVIVED 途中で先頭に止まらない :: 10 passed (10)
```
テストの弱さ（@B は 7,22 から始めていて、壊した版の「最後の欄へ回り込む」と答えが同じだった。欄の 2 桁目の場合が無かった）。3,22 から始める形と 7,21 の場合を足して検出。

## 起動確認（smoke）
```
$ aidev smoke
smoke: pass (exit 0)
```

## 未検証の穴
- HLLAPI の実機での操作は測っていない（行き先の規則は ACS の原典と、ペインの作業の実測）。
