//! 交換する 4 項目ぶんだけの JSON。
//!
//! **外部クレートを使わない**方針（`Cargo.toml` の注記）なので手で書く。
//! 扱う形は決まっている:
//!
//! ```text
//! 要求: {"function":3,"data":"…","length":5,"pos":0}
//! 応答: {"rc":0,"data":"…","length":12}
//! ```
//!
//! **手書きの JSON は誤りやすい**ので、エスケープの往復は単体テストで固める。
//! ここが崩れると、画面に `"` や `\` や日本語が出た瞬間に壊れる。

/// JSON の文字列リテラルとして書き出す（前後の `"` を含む）。
///
/// **制御文字は `\uXXXX` に落とす。** そのまま出すと不正な JSON になる。
pub fn escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for ch in s.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0C}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            // **日本語などはそのまま出す**（JSON は UTF-8 を許す）。
            // `\u` に落とすとサロゲートペアの組み立てが要り、誤りの種を増やす
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// `"…"` を読み、中身と「次の位置」を返す。開始位置は `"` を指していること。
fn unescape_at(bytes: &[u8], start: usize) -> Option<(String, usize)> {
    if bytes.get(start) != Some(&b'"') {
        return None;
    }
    let mut out = String::new();
    let mut i = start + 1;
    while i < bytes.len() {
        match bytes[i] {
            b'"' => return Some((out, i + 1)),
            b'\\' => {
                let esc = *bytes.get(i + 1)?;
                i += 2;
                match esc {
                    b'"' => out.push('"'),
                    b'\\' => out.push('\\'),
                    b'/' => out.push('/'),
                    b'n' => out.push('\n'),
                    b'r' => out.push('\r'),
                    b't' => out.push('\t'),
                    b'b' => out.push('\u{08}'),
                    b'f' => out.push('\u{0C}'),
                    b'u' => {
                        let hex = std::str::from_utf8(bytes.get(i..i + 4)?).ok()?;
                        let code = u32::from_str_radix(hex, 16).ok()?;
                        i += 4;
                        // **サロゲートペアを組み立てる。** 片割れだけを捨てると
                        // 絵文字や一部の漢字が黙って消える
                        let ch = if (0xD800..0xDC00).contains(&code) {
                            if bytes.get(i) == Some(&b'\\') && bytes.get(i + 1) == Some(&b'u') {
                                let lo_hex = std::str::from_utf8(bytes.get(i + 2..i + 6)?).ok()?;
                                let lo = u32::from_str_radix(lo_hex, 16).ok()?;
                                i += 6;
                                char::from_u32(0x10000 + ((code - 0xD800) << 10) + (lo - 0xDC00))?
                            } else {
                                return None;
                            }
                        } else {
                            char::from_u32(code)?
                        };
                        out.push(ch);
                    }
                    _ => return None,
                }
            }
            _ => {
                // UTF-8 の続きバイトをまとめて拾う
                let len = utf8_len(bytes[i]);
                let s = std::str::from_utf8(bytes.get(i..i + len)?).ok()?;
                out.push_str(s);
                i += len;
            }
        }
    }
    None
}

fn utf8_len(first: u8) -> usize {
    match first {
        b if b < 0x80 => 1,
        b if b >> 5 == 0b110 => 2,
        b if b >> 4 == 0b1110 => 3,
        _ => 4,
    }
}

/// 応答から `"key":"…"` を読む。無ければ `None`。
pub fn string_field(json: &str, key: &str) -> Option<String> {
    let bytes = json.as_bytes();
    let needle = format!("\"{key}\"");
    let mut from = 0;
    while let Some(rel) = json[from..].find(&needle) {
        let at = from + rel + needle.len();
        let mut i = at;
        while i < bytes.len() && (bytes[i] as char).is_whitespace() {
            i += 1;
        }
        if bytes.get(i) == Some(&b':') {
            i += 1;
            while i < bytes.len() && (bytes[i] as char).is_whitespace() {
                i += 1;
            }
            if let Some((s, _)) = unescape_at(bytes, i) {
                return Some(s);
            }
            return None;
        }
        from = at;
    }
    None
}

/// 応答から `"key":123` を読む。無ければ `None`。
pub fn number_field(json: &str, key: &str) -> Option<i64> {
    let bytes = json.as_bytes();
    let needle = format!("\"{key}\"");
    let mut from = 0;
    while let Some(rel) = json[from..].find(&needle) {
        let at = from + rel + needle.len();
        let mut i = at;
        while i < bytes.len() && (bytes[i] as char).is_whitespace() {
            i += 1;
        }
        if bytes.get(i) == Some(&b':') {
            i += 1;
            while i < bytes.len() && (bytes[i] as char).is_whitespace() {
                i += 1;
            }
            let start = i;
            if bytes.get(i) == Some(&b'-') {
                i += 1;
            }
            while i < bytes.len() && bytes[i].is_ascii_digit() {
                i += 1;
            }
            return json[start..i].parse::<i64>().ok();
        }
        from = at;
    }
    None
}

/// 要求の JSON を組み立てる。**この 4 項目しか送らない**。
/// `data_b64` は既に base64 なので、実質エスケープは要らないが規約どおり通す。
pub fn build_request(function: i32, data_b64: &str, length: i32, pos: i32) -> String {
    format!(
        "{{\"function\":{function},\"dataB64\":{},\"length\":{length},\"pos\":{pos}}}",
        escape(data_b64)
    )
}
