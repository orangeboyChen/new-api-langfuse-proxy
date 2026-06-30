const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

const ENTITY_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "content-md5",
]);

const PROXY_ONLY_HEADERS = new Set(["cookie", "x-session-id", "x-user-id"]);

function shouldStripUpstreamHeader(lowerName: string): boolean {
  return (
    HOP_BY_HOP_HEADERS.has(lowerName) ||
    ENTITY_HEADERS.has(lowerName) ||
    lowerName.startsWith("x-langfuse-") ||
    PROXY_ONLY_HEADERS.has(lowerName)
  );
}

function shouldStripResponseHeader(lowerName: string): boolean {
  return HOP_BY_HOP_HEADERS.has(lowerName) || ENTITY_HEADERS.has(lowerName);
}

export function buildUpstreamHeaders(
  original: Headers,
  traceId: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  original.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (!shouldStripUpstreamHeader(lower)) {
      headers[name] = value;
    }
  });
  headers["x-request-id"] = traceId;
  return headers;
}

export function buildResponseHeaders(
  upstream: Headers,
  traceId: string,
): Record<string, string> {
  const headers: Record<string, string> = {};
  upstream.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (!shouldStripResponseHeader(lower)) {
      headers[name] = value;
    }
  });
  headers["x-request-id"] = traceId;
  return headers;
}
