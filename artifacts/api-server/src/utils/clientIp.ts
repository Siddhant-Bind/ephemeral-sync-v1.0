import type { Request } from "express";
import { ipKeyGenerator } from "express-rate-limit";

/**
 * Extracts and normalizes the client IP address.
 * Prioritizes Cloudflare's CF-Connecting-IP header if present, falling back to req.ip.
 * Handles array and comma-separated header values.
 * Passes the resulting IP through express-rate-limit's IPv6-safe ipKeyGenerator helper.
 */
export function clientIp(req: Request): string {
  const cfHeader = req.headers["cf-connecting-ip"];
  let rawIp: string | undefined;

  if (Array.isArray(cfHeader)) {
    rawIp = cfHeader[0];
  } else if (typeof cfHeader === "string") {
    rawIp = cfHeader;
  }

  if (rawIp) {
    const first = rawIp.split(",")[0]?.trim();
    if (first) {
      return ipKeyGenerator(first);
    }
  }

  const fallback = (req.ip || "").trim();
  if (!fallback) {
    return "";
  }

  return ipKeyGenerator(fallback);
}

export default clientIp;

