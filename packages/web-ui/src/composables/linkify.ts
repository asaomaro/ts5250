/**
 * 画面テキストのリンク検出（07-screen-links）。
 * 文字列から http/https URL とメールアドレスの範囲を検出する純関数。
 * href は http/https/mailto のみ生成し、危険スキーム（javascript: 等）は作らない。
 */

export interface LinkSpan {
  /** 文字列中の開始インデックス（含む） */
  start: number;
  /** 終了インデックス（含まない） */
  end: number;
  /** アンカーの href（http(s):// そのまま、または mailto:） */
  href: string;
  kind: "url" | "email";
}

// http(s):// のみ。空白・山括弧・引用符で停止（保守的）
const URL_RE = /https?:\/\/[^\s<>"']+/gi;
// user@host.tld。前後の語境界は下で検証する
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// URL 末尾に付きやすい句読点（リンクから除外する）
const TRAILING = /[.,;:!?)\]}'"]+$/;

/** text 中の URL / メールの範囲を返す（開始位置順・非重複） */
export function linkify(text: string): LinkSpan[] {
  const spans: LinkSpan[] = [];

  URL_RE.lastIndex = 0;
  for (let m = URL_RE.exec(text); m !== null; m = URL_RE.exec(text)) {
    let matched = m[0];
    // 末尾の句読点を除去（"http://x." の "." など）
    const trimmed = matched.replace(TRAILING, "");
    if (trimmed.length < "http://a".length) continue;
    matched = trimmed;
    spans.push({ start: m.index, end: m.index + matched.length, href: matched, kind: "url" });
  }

  EMAIL_RE.lastIndex = 0;
  for (let m = EMAIL_RE.exec(text); m !== null; m = EMAIL_RE.exec(text)) {
    const start = m.index;
    const end = start + m[0].length;
    // URL 範囲と重なるメール（http://user@host 等の @）は二重検出しない
    if (spans.some((s) => start < s.end && end > s.start)) continue;
    spans.push({ start, end, href: `mailto:${m[0]}`, kind: "email" });
  }

  return spans.sort((a, b) => a.start - b.start);
}

export interface LinkPart {
  text: string;
  href?: string;
}

/** text をプレーン部分とリンク部分の連続に分割する（描画用） */
export function splitLinks(text: string): LinkPart[] {
  const spans = linkify(text);
  if (spans.length === 0) return [{ text }];
  const parts: LinkPart[] = [];
  let pos = 0;
  for (const s of spans) {
    if (s.start > pos) parts.push({ text: text.slice(pos, s.start) });
    parts.push({ text: text.slice(s.start, s.end), href: s.href });
    pos = s.end;
  }
  if (pos < text.length) parts.push({ text: text.slice(pos) });
  return parts;
}
