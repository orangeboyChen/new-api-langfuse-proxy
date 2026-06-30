import crypto from "node:crypto";
import Elysia from "elysia";
import {
  buildResponseHeaders,
  buildUpstreamHeaders,
} from "@/api/lib/header-forwarding";
import { jsonError } from "@/api/lib/http";
import {
  parseLangfuseMetadata,
  parseLangfuseTags,
} from "@/api/lib/langfuse-headers";
import logger from "@/api/lib/logger";
import config from "@/config";
import { reportErrorToLangfuse, reportToLangfuse } from "./proxy.telemetry";
import type { ProxyRequestContext } from "./proxy.types";

async function readRequestBodyForTelemetry(
  request: Request,
  contentType: string,
): Promise<{
  bodyForUpstream: string | ReadableStream<Uint8Array> | null;
  bodyTextForTelemetry: string | null;
}> {
  if (request.method === "GET" || request.method === "HEAD") {
    return { bodyForUpstream: null, bodyTextForTelemetry: null };
  }

  let bodyTextForTelemetry: string | null = null;

  if (contentType.includes("application/json")) {
    try {
      const cloned = request.clone();
      bodyTextForTelemetry = await cloned.text();
      return {
        bodyForUpstream: request.body,
        bodyTextForTelemetry,
      };
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
      return {
        bodyForUpstream: request.body,
        bodyTextForTelemetry,
      };
    } catch {
      /* best-effort */
    }
  }

  return { bodyForUpstream: request.body, bodyTextForTelemetry };
}

/**
 * Model catalog endpoints (list/retrieve models) carry no prompt/completion and
 * are pure metadata lookups, so there is nothing meaningful to trace. Matches
 * e.g. `/v1/models`, `/v1/models/{id}`, `/deepseek/v1/models`, `/v1beta/models`.
 */
function isNonTracedPath(path: string): boolean {
  return /\/models(\/|$)/.test(path);
}

function buildUpstreamUrl(
  baseUrl: string,
  path: string,
  search: string,
): string {
  const url = new URL(baseUrl);
  const basePath = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
  const requestPath = path.startsWith("/") ? path : `/${path}`;
  url.pathname = `${basePath}${requestPath}`;
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
    if (!isNonTracedPath(requestPath)) {
      reportErrorToLangfuse({
        traceId,
        startTime,
        path: requestPath,
        requestBody: bodyTextForTelemetry || "",
        error: message,
      });
    }
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

  // 3. Telemetry context
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

  // 4. Single-reader pump (NOT body.tee()).
  //
  // We forward upstream -> client through a single reader while collecting the
  // bytes on the side for telemetry. We deliberately avoid `upstreamRes.body
  // .tee()`: when the client disconnects mid-stream, Bun cancels one tee branch
  // (its controller becomes null) while the upstream abort errors the shared
  // source. The native tee implementation then dispatches that error onto the
  // already-nulled controller, throwing `TypeError: null is not an object`
  // inside a stream callback that escapes every `.catch()` and Elysia's
  // onError, crashing the whole process. A single reader has no second
  // controller to race, so this can't happen.
  const reader = upstreamRes.body.getReader();
  const collected: Uint8Array[] = [];
  let telemetryFired = false;
  const fireTelemetry = () => {
    if (telemetryFired) return;
    telemetryFired = true;
    // Skip tracing for non-traced paths (e.g. model catalog endpoints). The
    // client stream is pumped independently, so skipping here does not affect
    // draining or backpressure.
    if (isNonTracedPath(requestPath)) return;
    const telemetryStream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of collected) controller.enqueue(chunk);
        controller.close();
      },
    });
    reportToLangfuse(telemetryStream, ctx).catch((err) =>
      logger.error({ err }, "Langfuse telemetry failed"),
    );
  };

  const clientStream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          fireTelemetry();
          return;
        }
        collected.push(value);
        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
        fireTelemetry();
      }
    },
    cancel() {
      // Client disconnected: stop pulling upstream, then report what we have.
      abortController.abort();
      reader.cancel().catch(() => {});
      fireTelemetry();
    },
  });

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
