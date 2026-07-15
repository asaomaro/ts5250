/**
 * 端末タイプ名の決定（RFC 4777 / spec）。
 * SBCS 24x80 = IBM-3179-2、SBCS 27x132 = IBM-3477-FC、
 * DBCS 24x80 = IBM-5555-C01、DBCS 27x132 = IBM-5555-B01。
 */
const DBCS_CCSIDS = new Set([930, 939, 1399, 931, 5035, 5026]);

export function terminalTypeFor(ccsid: number, screenSize: "24x80" | "27x132"): string {
  const dbcs = DBCS_CCSIDS.has(ccsid);
  if (dbcs) return screenSize === "27x132" ? "IBM-5555-B01" : "IBM-5555-C01";
  return screenSize === "27x132" ? "IBM-3477-FC" : "IBM-3179-2";
}

export function isDbcsCcsid(ccsid: number): boolean {
  return DBCS_CCSIDS.has(ccsid);
}
