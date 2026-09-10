/**
 * **走査テストが共有する「コメントを落とした本文」**（`20260908-session-lifetime-rules-fold` AC2）。
 *
 * サーバーとクライアントの走査テスト（`lifetime-flag-containment.test.ts` の 2 本）が
 * これを使う。**複製しないこと**——この work は片方だけ直る事故を 3 度踏んでいる
 * （`settled` はクライアントだけ＝D15、`holdTimer` はサーバーだけ＝D18、
 * 行コメントの盲点は両方＝D16）。組合せ表（`session-lifetime-matrix.ts`）と同じ理由で、
 * 同じ向きの依存（server/test → web-ui/test）に寄せる（`architecture.md` A4）。
 *
 * **なぜ web-ui/test に置くか。** `packages/web-ui` は `tsconfig.test.json` が `composite: true` で
 * `include: ["src","test"]` なのでその外を取り込めず、サーバーのテストは型検査の対象外
 * （`packages/server/tsconfig.json` の `include` が `["src"]`）なのでここから相対パスで読める。
 * 向きが一方しか成立しない。
 */
/**
 * コメントを落とした本文。**判定は実コードにしか無い**ので、コメント中の言及
 * （由来の説明）を違反として数えない。
 *
 * **正規表現の重ね掛けではなく簡易スキャナで走る**（`decisions.md` D16）。
 * 「コメントを消す」を正規表現でやると、**文字列やテンプレートの中のコメント記号を開始と
 * 誤読して領域ごと走査から消える**——この work で 3 度踏んだ:
 * ルートパターンの文字列（`"/api/admin/*"`）、URL のテンプレート（`` `${proto}//...` ``）、
 * 行コメントの中に書いた `/*`（次の `*​/` までが丸ごと消える）。
 *
 * スキャナは (1) 文字列・テンプレートの中ではコメントを開始しない、
 * (2) コメントの開始は**行頭か空白の直後**に限る（正規表現の文字クラスに入った `/*` を
 * 誤読しないため。実例は web-ui の `sanitizeFamily`）、の 2 つだけを守る。
 * 構文解析はしないので、`[ //]` のように**空白の直後に書いた正規表現**は依然として誤読する
 * ——盲点は消し切れないが、**盲点を狭めるより偽陽性側に倒す**方針は変えていない。
 */
export function code(text: string): string {
  let out = "";
  let i = 0;
  const opensComment = (at: number): boolean => at === 0 || /\s/.test(text[at - 1]!);
  while (i < text.length) {
    const two = text.slice(i, i + 2);
    if (two === "//" && opensComment(i)) {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (two === "/*" && opensComment(i)) {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 2;
      continue;
    }
    if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      i = end < 0 ? text.length : end + 3;
      continue;
    }
    const q = text[i]!;
    if (q === '"' || q === "'" || q === "`") {
      out += q;
      i++;
      while (i < text.length && text[i] !== q) {
        if (text[i] === "\\") {
          out += text.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += text[i];
        i++;
      }
      out += q;
      i++;
      continue;
    }
    out += q;
    i++;
  }
  return out;
}
