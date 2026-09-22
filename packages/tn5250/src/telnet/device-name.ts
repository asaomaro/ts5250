/**
 * **装置名の置換記号の展開**（ACS `AutoDeviceName5250` と同じ規則。`20260921-device-name-acs`）。
 *
 * ACS は装置名（Workstation ID）を送るたびに（＝ホストが NEW-ENVIRON SEND で聞くたびに）ここを通し、
 * 結果を大文字にして送る（`NVT5250` の DEVNAME）。記号:
 * - `%` … 表示なら `S`、プリンターなら `P`
 * - `*` … セッション名の先頭 2 文字（1 文字の英小文字なら頭に `0`）。名前が無ければ `A`（ACS のコアの既定）
 * - `=` … **衝突を避ける番号**（0〜9・A〜Z）。聞かれるたびに進む——装置が使用中（8902）だとホストは同じ接続で
 *   聞き直してくるので、次の番号で答える。1 つなら開始番号（既定 0）から 35 まで、2 つ以上なら乱数の位置から
 *   36 進で数え、**先頭の `=` が最も速く回る**。使い切ったら記号のまま返す（ACS も同じ）
 * - `+` … `&COMPN` / `&USERN` が長すぎるとき、**右ではなく左**を残す
 * - `&COMPN` / `&USERN` … 機械名 / 利用者名。**`&` を含むパターンでは記号以外の文字は落ちる**（ACS の字面どおり。
 *   実測: `T%*&USERN` の `T` は送られない）。残す長さは「10 − パターン上の位置 − 残りの記号の数」
 *
 * 記号が 1 つも無ければそのまま（大文字にはする）。実測（PUB400・ACS のコア・タップ）で確かめたもの:
 * 小文字→大文字、`%`→`S`、`*`→`A`、`&` での文字落ち、`+` の有無での左右、`=` が使用中で同じ接続の中で 0→1 に進むこと、
 * 記号の無い名前が使用中だと同じ名前を送り直すだけで繋がらないこと。`=` が 2 つ以上のときの桁の順は原典の読み。
 */

/** 展開に使う外の値。**機械名・利用者名はここから渡す**（このパッケージは Node の API に触れない） */
export interface DeviceNameEnv {
  /** プリンターなら true（`%` が `P`） */
  printer?: boolean;
  /** セッション名（`*`）。無ければ `A` */
  sessionName?: string;
  /** `&COMPN` の値（機械名） */
  computerName?: string;
  /** `&USERN` の値（利用者名） */
  userName?: string;
  /** `=` の開始番号（ACS の「重複名を避ける」開始番号。0〜9、既定 0） */
  startIndex?: number;
  /** `=` が 2 つ以上のときの乱数（0 以上 1 未満）。テストで差し替える */
  random?: () => number;
}

const SYMBOLS = "*%=+";
const MAX_LEN = 10;
const KEYWORDS = ["COMPN", "USERN"] as const;

/** 36 進の 1 桁（0〜9・A〜Z） */
function digitChar(d: number): string {
  return d < 10 ? String.fromCharCode(48 + d) : String.fromCharCode(65 + d - 10);
}

/** 置換記号（`*` `%` `=` `+` か `&`）を含むか */
export function hasDeviceNameSymbols(pattern: string): boolean {
  return [...pattern].some((c) => SYMBOLS.includes(c) || c === "&");
}

/** ACS と同じ大文字化（トルコ語の `İ` は `I` に寄せる） */
export function upperDeviceName(name: string): string {
  return name.toUpperCase().replace(/\u0130/g, "I");
}

/** 装置名の末尾数字を繰り上げる（WEBEMU01 → WEBEMU02）。数字が無ければ 2 を足す（当 PJ の `deviceNameRetry`。ACS には無い） */
export function nextDeviceName(name: string): string | undefined {
  const m = /^(.*?)(\d+)$/.exec(name);
  if (!m) return name.length < MAX_LEN ? `${name}2` : undefined;
  const width = m[2]!.length;
  const digits = String(Number(m[2]) + 1).padStart(width, "0");
  if (digits.length > width) return undefined; // 桁が増えるなら打ち止め（装置名は 10 文字まで）
  return `${m[1]}${digits}`;
}

/**
 * **装置名を聞かれるたびに次の名前を出す**（1 本の接続につき 1 つ）。
 *
 * `retryPlain` は当 PJ の `deviceNameRetry`（記号の無い名前でも、使用中なら末尾の数字を繰り上げる。5 回まで）。
 */
export class DeviceNameGenerator {
  private collision: number;
  private start = 0;
  private seeded = false;
  private exhausted = false;
  private plainTries = 0;
  private last: string | undefined;
  private readonly session: string;

  constructor(
    private readonly pattern: string,
    private readonly env: DeviceNameEnv = {},
    private readonly retryPlain = false
  ) {
    this.collision = env.startIndex ?? 0;
    let s = env.sessionName ?? "";
    if (s.length > 2) s = s.slice(0, 2);
    if (s.length === 1 && s >= "a" && s <= "z") s = `0${s}`;
    this.session = s === "" ? "A" : s;
  }

  /** 最後に出した名前（大文字） */
  get current(): string | undefined {
    return this.last;
  }

  /** 使用中と言われたとき、**別の名前で答え直せるか**（`=` を含む・当 PJ の繰り上げが効く、かつ使い切っていない） */
  canRetry(): boolean {
    if (this.exhausted) return false;
    if (this.pattern.includes("=")) return true;
    return this.retryPlain && !hasDeviceNameSymbols(this.pattern) && this.plainTries < 5 && this.last !== undefined && nextDeviceName(this.last) !== undefined;
  }

  /** 次に送る名前（大文字） */
  next(): string {
    const name = upperDeviceName(this.expand());
    this.last = name;
    return name;
  }

  private expand(): string {
    const p = this.pattern;
    const hasAmp = p.includes("&");
    let remaining = [...p].filter((c) => SYMBOLS.includes(c)).length;
    const eqCount = [...p].filter((c) => c === "=").length;
    if (remaining === 0 && !hasAmp) {
      // 記号の無い名前: そのまま。当 PJ の繰り上げは 2 回目から
      if (this.last === undefined || !this.retryPlain) return p;
      const n = nextDeviceName(this.last);
      if (n === undefined) return this.last;
      this.plainTries++;
      return n;
    }
    if (!this.seeded) {
      if (eqCount >= 2) {
        const r = this.env.random ?? Math.random;
        this.start = this.collision = Math.floor(r() * (eqCount < 3 ? 1295 : 46655));
      }
      this.seeded = true;
    } else if (this.start === this.collision) {
      // 一巡した（乱数の位置から数えて元へ戻った）。記号のまま返す
      this.exhausted = true;
      return p;
    }
    let n3 = this.collision;
    let used = false;
    let trimLeft = false;
    let out = "";
    let len = 0;
    for (let i = 0; i < p.length && len < MAX_LEN; i++) {
      const c = p[i]!;
      if (c === "%") {
        remaining--;
        out += this.env.printer ? "P" : "S";
        len++;
      } else if (c === "*") {
        remaining--;
        out += this.session;
        len += this.session.length;
      } else if (c === "=") {
        remaining--;
        let d: number;
        if (used) {
          d = this.env.startIndex ?? 0;
        } else if (n3 < 36) {
          this.collision++;
          d = n3;
          used = true;
        } else if (remaining === 0) {
          // 最上位の桁があふれた。乱数の位置から始めたなら 35 を出して 1 へ回る。そうでなければ使い切り
          if (this.start > 1) {
            d = 35;
            this.collision = 1;
          } else {
            this.exhausted = true;
            return p;
          }
        } else {
          d = n3 % 36;
          n3 = Math.floor(n3 / 36);
        }
        out += digitChar(d);
        len++;
      } else if (c === "+") {
        remaining--;
        trimLeft = true;
      } else if (c === "&") {
        const key = KEYWORDS.find((k) => p.slice(i + 1, i + 1 + k.length).toUpperCase() === k);
        if (key === undefined) continue; // 知らない語は `&` だけ落とす（ACS は状態 9 にして続ける）
        let room = MAX_LEN - i - remaining + (trimLeft ? 1 : 0);
        let v = key === "COMPN" ? this.env.computerName : this.env.userName;
        if (v === undefined) {
          // 取れない。ACS は状態 9（ローカルの名前を得られない）にして記号のまま返す
          this.exhausted = true;
          return p;
        }
        if (v.length < room) room = v.length;
        else if (v.length > room) v = trimLeft ? v.slice(0, room) : v.slice(v.length - room);
        out += v.slice(0, room);
        len += room;
        i += key.length;
      } else if (!hasAmp) {
        out += c;
        len++;
      }
    }
    // 番号を 1 つも使わなかったら（`=` が無い・10 文字の外）-1 にしておく。0 のままだと、次に聞かれたとき
    // 「一巡した」と取り違える（ACS も同じく -1 にする）。`%` `*` だけのパターンは何度聞かれても同じ名前になる
    if (this.collision === 0) this.collision = -1;
    return out;
  }
}
