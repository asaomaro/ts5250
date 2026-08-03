//! base64 の符号化・復号。**バイト列をそのまま運ぶための器**。
//!
//! PS は **CP932 のバイト列**（1 位置 = 1 バイト、全角は 2 バイト）で、
//! JSON は UTF-8 のテキストしか運べない。任意のバイト列を素通しするために base64 を挟む。
//!
//! **この層は中身を解釈しない。** CP932 かどうかも知らないし、知る必要もない
//! ——符号を解いてバッファへ置くだけ。

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn encode(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { ALPHABET[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { ALPHABET[n as usize & 63] as char } else { '=' });
    }
    out
}

fn value_of(c: u8) -> Option<u32> {
    match c {
        b'A'..=b'Z' => Some((c - b'A') as u32),
        b'a'..=b'z' => Some((c - b'a') as u32 + 26),
        b'0'..=b'9' => Some((c - b'0') as u32 + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// 復号。**壊れた入力では `None`**（黙って途中まで返さない）。
pub fn decode(input: &str) -> Option<Vec<u8>> {
    let raw: Vec<u8> = input.bytes().filter(|b| !b.is_ascii_whitespace()).collect();
    if raw.len() % 4 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(raw.len() / 4 * 3);
    for chunk in raw.chunks(4) {
        let pad = chunk.iter().filter(|&&c| c == b'=').count();
        if pad > 2 {
            return None;
        }
        let mut n = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            let v = if c == b'=' {
                // 埋めは末尾にしか来ない
                if i < 2 { return None; }
                0
            } else {
                value_of(c)?
            };
            n = (n << 6) | v;
        }
        out.push((n >> 16) as u8);
        if pad < 2 {
            out.push((n >> 8) as u8);
        }
        if pad < 1 {
            out.push(n as u8);
        }
    }
    Some(out)
}
