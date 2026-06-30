import crypto from "node:crypto";
import Elysia from "elysia";
import {
  reportErrorToLangfuse,
  reportToLangfuse,
} from "@/api/features/proxy/proxy.telemetry";
import type { ProxyRequestContext } from "@/api/features/proxy/proxy.types";
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

export const anthropicController = new Elysia({ prefix: "/v1" }).all(
  "/messages",
  async ({ request }) => {
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

    // 1. Read request body
    const contentType = request.headers.get("content-type") || "";
    const isJsonRequest = contentType.includes("application/json");
    let bodyForUpstream: string | ReadableStream<Uint8Array> | null = null;
    let bodyTextForTelemetry: string | null = null;

    if (request.method !== "GET" && request.method !== "HEAD") {
      if (isJsonRequest) {
        bodyTextForTelemetry = await request.text();
        bodyForUpstream = bodyTextForTelemetry;
      } else {
        bodyForUpstream = request.body;
      }
    }

    // 2. Build upstream URL
    const url = new URL(request.url);
    const upstreamUrl = `${config.upstreamBaseUrl}/v1/messages${url.search}`;

    // 3. Build upstream headers
    const upstreamHeaders = buildUpstreamHeaders(request.headers, traceId);

    // 4. Fetch upstream with timeout and client disconnect propagation
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
        path: "/v1/messages",
        requestBody: bodyTextForTelemetry || "",
        error: message,
      });
      return jsonError(message, "server_error", code, 502);
    }

    // 5. Build response
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

    // 6. Tee stream for telemetry
    const [clientStream, telemetryStream] = upstreamRes.body.tee();

    // 7. Background telemetry (non-blocking)
    const ctx: ProxyRequestContext = {
      traceId,
      sessionId,
      userId,
      langfuseTags,
      langfuseMetadata,
      startTime,
      method: request.method,
      path: "/v1/messages",
      requestBody: bodyTextForTelemetry || "",
      contentType,
      responseContentType:
        upstreamRes.headers.get("content-type") || "application/octet-stream",
      isStreaming,
      statusCode: upstreamRes.status,
      latencyMs,
      provider: "anthropic",
    };
    reportToLangfuse(telemetryStream, ctx).catch((err) =>
      logger.error({ err }, "Langfuse telemetry failed"),
    );

    // 8. Return response immediately
    return new Response(clientStream, {
      status: upstreamRes.status,
      headers: responseHeaders,
    });
  },
);
