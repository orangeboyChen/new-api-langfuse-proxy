import crypto from "node:crypto";
import Elysia from "elysia";
import { jsonError } from "@/api/lib/http";
import {
  parseLangfuseMetadata,
  parseLangfuseTags,
} from "@/api/lib/langfuse-headers";
import logger from "@/api/lib/logger";
import config from "@/config";
import { reportErrorToLangfuse, reportToLangfuse } from "./proxy.telemetry";
import type { ProxyRequestContext } from "./proxy.types";

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

function copyHeaders(headers: Headers): Record<string, string> {
  const copied: Record<string, string> = {};
  headers.forEach((value, name) => {
    if (!HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
      copied[name] = value;
    }
  });
  return copied;
}

function buildUpstreamHeaders(
  original: Headers,
  traceId: string,
): Record<string, string> {
  return {
    ...copyHeaders(original),
    "x-request-id": traceId,
  };
}

function buildResponseHeaders(
  upstream: Headers,
  traceId: string,
): Record<string, string> {
  return {
    ...copyHeaders(upstream),
    "x-request-id": traceId,
  };
}

async function readRequestBodyForTelemetry(
  request: Request,
  contentType: string,
): Promise<{
  bodyForUpstream: ReadableStream<Uint8Array> | null;
  bodyTextForTelemetry: string | null;
}> {
  if (request.method === "GET" || request.method === "HEAD") {
    return { bodyForUpstream: null, bodyTextForTelemetry: null };
  }

  const bodyForUpstream = request.body;
  let bodyTextForTelemetry: string | null = null;

  if (contentType.includes("application/json")) {
    try {
      bodyTextForTelemetry = await request.clone().text();
    } catch {
      /* best-effort */
    }
  } else if (contentType.includes("multipart/form-data")) {
    try {
      const cloned = request.clone();
      const formData = await cloned.formData();
      const fields: Record<string, string> = {};
      for (const [key, value] of formData.entries()) {
        if (typeof value === "string") {
          fields[key] = value;
        } else {
          fields[key] = `[file: ${value.name}, ${value.size} bytes]`;
        }
      }
      bodyTextForTelemetry = JSON.stringify(fields);
    } catch {
      /* best-effort */
    }
  }

  return { bodyForUpstream, bodyTextForTelemetry };
}

function buildUpstreamUrl(
  baseUrl: string,
  path: string,
  search: string,
): string {
  const url = new URL(path, baseUrl);
  url.search = search;
  return url.toString();
}

interface OpenAICompatibleProxyOptions {
  /** Route prefix this controller listens on (e.g. "/v1" or "/deepseek/v1"). */
  basePath: string;
  /** Lazily resolved so config overrides at runtime (tests) take effect. */
  resolveBaseUrl: () => string;
  provider: ProxyRequestContext["provider"];
}

function createOpenAICompatibleProxy({
  basePath,
  resolveBaseUrl,
  provider,
}: OpenAICompatibleProxyOptions) {
  return new Elysia({ prefix: basePath }).all("/*", async ({ request }) => {
    const url = new URL(request.url);
    const requestPath = url.pathname;
    const upstreamUrl = buildUpstreamUrl(
      resolveBaseUrl(),
      url.pathname,
      url.search,
    );

    return handleProxyRequest({
      request,
      requestPath,
      upstreamUrl,
      provider,
    });
  });
}

async function handleProxyRequest({
  request,
  requestPath,
  upstreamUrl,
  provider,
}: {
  request: Request;
  requestPath: string;
  upstreamUrl: string;
  provider: ProxyRequestContext["provider"];
}): Promise<Response> {
  const startTime = performance.now();
  const traceId = request.headers.get("x-request-id") || crypto.randomUUID();
  const sessionId = request.headers.get("x-session-id") || undefined;
  const userId = request.headers.get("x-user-id") || undefined;
  const langfuseTags = parseLangfuseTags(
    request.headers.get("x-langfuse-tags"),
  );
  const langfuseMetadata = parseLangfuseMetadata(
    request.headers.get("x-langfuse-metadata"),
  );

  const contentType = request.headers.get("content-type") || "";
  const { bodyForUpstream, bodyTextForTelemetry } =
    await readRequestBodyForTelemetry(request, contentType);
  const upstreamHeaders = buildUpstreamHeaders(request.headers, traceId);

  // 1. Fetch upstream with timeout and client disconnect propagation
  const abortController = new AbortController();
  const timeoutId = setTimeout(
    () => abortController.abort(new DOMException("Timeout", "TimeoutError")),
    config.proxyTimeoutMs,
  );
  request.signal.addEventListener("abort", () => abortController.abort());

  let upstreamRes: Response;
  try {
    upstreamRes = await fetch(upstreamUrl, {
      method: request.method,
      headers: upstreamHeaders,
      body: bodyForUpstream,
      signal: abortController.signal,
    });
    clearTimeout(timeoutId);
  } catch (err) {
    clearTimeout(timeoutId);
    const isTimeout =
      err instanceof DOMException && err.name === "TimeoutError";
    const message = isTimeout
      ? "Upstream request timed out"
      : "Upstream connection failed";
    const code = isTimeout ? "timeout" : "connection_error";
    logger.error({ err, upstreamUrl }, message);
    reportErrorToLangfuse({
      traceId,
      startTime,
      path: requestPath,
      requestBody: bodyTextForTelemetry || "",
      error: message,
    });
    return jsonError(message, "server_error", code, 502);
  }

  // 2. Build response
  const isStreaming =
    upstreamRes.headers.get("content-type")?.includes("text/event-stream") ??
    false;
  const latencyMs = performance.now() - startTime;
  const responseHeaders = buildResponseHeaders(upstreamRes.headers, traceId);

  if (!upstreamRes.body) {
    return new Response(null, {
      status: upstreamRes.status,
      headers: responseHeaders,
    });
  }

  // 3. Tee stream for telemetry
  const [clientStream, telemetryStream] = upstreamRes.body.tee();

  // 4. Background telemetry (non-blocking)
  const ctx: ProxyRequestContext = {
    traceId,
    sessionId,
    userId,
    langfuseTags,
    langfuseMetadata,
    startTime,
    method: request.method,
    path: requestPath,
    requestBody: bodyTextForTelemetry || "",
    contentType,
    responseContentType:
      upstreamRes.headers.get("content-type") || "application/octet-stream",
    isStreaming,
    statusCode: upstreamRes.status,
    latencyMs,
    provider,
  };
  reportToLangfuse(telemetryStream, ctx).catch((err) =>
    logger.error({ err }, "Langfuse telemetry failed"),
  );

  // 5. Return response immediately
  return new Response(clientStream, {
    status: upstreamRes.status,
    headers: responseHeaders,
  });
}

export const proxyController = createOpenAICompatibleProxy({
  basePath: "/v1",
  resolveBaseUrl: () => config.upstreamBaseUrl,
  provider: "openai",
});

export const deepseekController = createOpenAICompatibleProxy({
  basePath: "/deepseek/v1",
  resolveBaseUrl: () => config.upstreamBaseUrl,
  provider: "deepseek",
});

export const passthroughController = new Elysia().all(
  "/*",
  async ({ request }) => {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return jsonError("Not found", "invalid_request_error", "not_found", 404);
    }

    return handleProxyRequest({
      request,
      requestPath: url.pathname,
      upstreamUrl: buildUpstreamUrl(
        config.upstreamBaseUrl,
        url.pathname,
        url.search,
      ),
      provider: "openai",
    });
  },
);
