export function getCorsOriginConfig(raw?: string): boolean | string[] {
  if (!raw || raw.trim() === "*" || raw.trim() === "") {
    // Reflect request origin so credentials work across all origins in dev/default
    return true;
  }
  const origins = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return origins.length > 0 ? origins : true;
}

