# 決定記録

## D1: プリンターセッションは対象外にする

- 背景: T6 の実装時、`printerOptsFrom`（プリンターを開く材料の組み立て）にも `ccsid` と同様
  `katakanaVariant` を転記しようとしたが、型検査で `OpenPrinterOptions`（`PrinterConnectOptions`
  を継ぐ）にそのフィールドが無く失敗した。
- 決定: プリンターセッションには `katakanaVariant` を持たせない。
- 理由: `packages/tn5250/src/session/printer-session.ts` はそもそも KBDTYPE/CODEPAGE/CHARSET の
  RFC 2877 申告をしない設計（コメント: 「以前は KBDTYPE / CODEPAGE / CHARSET・IBMFONT=12・
  IBMSENDCONFREC を送っていて、DBCS では装置が 3812 にされ日本語の帳票が CPA3303 で止まった」——
  過去に意図的に外した）。`deviceEnvFor` も呼ばない。持たせても読み手が無く、死んだフィールドになる。
- 影響: design.md の対象範囲にあった「関連する箇所は転記漏れに注意」の一般論は、この 1 点では
  当てはまらない（転記すること自体が誤り）。要件・design の変更はしない（AC はどれもプリンターに
  触れていない）。

## D2: ブラウザ直指定（ad-hoc 接続）にも足す

- 背景: design.md は「system/session 設定の階層」だけを対象に書いていたが、`ws-handler.ts` の
  `buildDirect`（`system`/`session` 参照を持たない、ブラウザが host を直接指定する接続経路）にも
  既存の `ccsid` と並んで通っていることに実装中に気付いた。
- 決定: `WsOpen.katakanaVariant` / `buildDirect` にも `katakanaVariant` を足す。
- 理由: 足さないと、保存済み設定からの接続では選べるのに ad-hoc 接続では常に既定（折衷）のまま
  という食い違いが生まれる。`ccsid` 自体が両経路をサポートしているので、対称性を保つ。
- 影響: tasks.md T6 に追記。要件・AC の変更は無い（AC はどの接続経路かを問わない書き方のまま）。
