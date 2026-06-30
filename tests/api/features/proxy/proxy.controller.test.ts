import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { Elysia } from "elysia";
import {
  deepseekController,
  passthroughController,
  proxyController,
} from "@/api/features/proxy/proxy.controller";
import logger from "@/api/lib/logger";
import config from "@/config";

// Spin up a minimal upstream mock server
let mockServer: ReturnType<typeof Bun.serve>;
let mockBaseUrl: string;

beforeAll(() => {
  mockServer = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/v1/chat/completions") {
        return new Response(
          JSON.stringify({
            model: "gpt-4o-mini",
            choices: [{ message: { role: "assistant", content: "Hi there!" } }],
            usage: {
              prompt_tokens: 10,
              completion_tokens: 3,
              total_tokens: 13,
            },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      }

      if (url.pathname === "/v1/models") {
        return new Response(JSON.stringify({ data: [] }), {
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response(
        JSON.stringify({
          error: { message: "Not found", type: "invalid_request_error" },
        }),
        { status: 404, headers: { "Content-Type": "application/json" } },
      );
    },
  });
  mockBaseUrl = `http://localhost:${mockServer.port}`;
  config.upstreamBaseUrl = mockBaseUrl;
});

afterAll(() => {
  mockServer.stop();
});

const createApp = () => new Elysia().use(proxyController);

describe("proxyController", () => {
  test("forwards chat completions request", async () => {
    const app = createApp();
    const res = await app.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    );

    expect(res.status).toBe(200);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.model).toBe("gpt-4o-mini");
    expect(
      (data.choices as Array<{ message: { content: string } }>)[0]?.message
        .content,
    ).toBe("Hi there!");
  });

  test("forwards JSON body to upstream when telemetry reads a clone", async () => {
    let capturedBody = "";
    const captureServer = Bun.serve({
      port: 0,
      async fetch(req) {
        capturedBody = await req.text();
        return new Response(
          JSON.stringify({
            model: "gpt-4o-mini",
            choices: [{ message: { role: "assistant", content: "Hi there!" } }],
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    });

    const originalUrl = config.upstreamBaseUrl;
    config.upstreamBaseUrl = `http://localhost:${captureServer.port}`;
    try {
      const app = createApp();
      const payload = {
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: "hello" }],
      };
      const res = await app.handle(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        }),
      );

      expect(res.status).toBe(200);
      expect(capturedBody).toBe(JSON.stringify(payload));
    } finally {
      config.upstreamBaseUrl = originalUrl;
      captureServer.stop();
    }
  });

  test("returns x-request-id header", async () => {
    const app = createApp();
    const res = await app.handle(
      new Request("http://localhost/v1/models", { method: "GET" }),
    );

    expect(res.headers.get("x-request-id")).toBeTruthy();
  });

  test("preserves x-request-id from consumer", async () => {
    const app = createApp();
    const res = await app.handle(
      new Request("http://localhost/v1/models", {
        method: "GET",
        headers: { "x-request-id": "my-trace-id" },
      }),
    );

    expect(res.headers.get("x-request-id")).toBe("my-trace-id");
  });

  test("forwards consumer Authorization to upstream", async () => {
    let capturedAuth = "";
    const captureServer = Bun.serve({
      port: 0,
      fetch(req) {
        capturedAuth = req.headers.get("authorization") || "";
        return new Response(JSON.stringify({ data: [] }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    const originalUrl = config.upstreamBaseUrl;
    config.upstreamBaseUrl = `http://localhost:${captureServer.port}`;
    try {
      const app = createApp();
      await app.handle(
        new Request("http://localhost/v1/models", {
          method: "GET",
          headers: { Authorization: "Bearer client-key" },
        }),
      );

      expect(capturedAuth).toBe("Bearer client-key");
    } finally {
      config.upstreamBaseUrl = originalUrl;
      captureServer.stop();
    }
  });

  test("returns 502 for unreachable upstream", async () => {
    const originalUrl = config.upstreamBaseUrl;
    const originalLevel = logger.level;
    config.upstreamBaseUrl = "http://localhost:1";
    logger.level = "silent";
    try {
      const app = createApp();
      const res = await app.handle(
        new Request("http://localhost/v1/models", { method: "GET" }),
      );

      expect(res.status).toBe(502);
      const data = (await res.json()) as { error: { code: string } };
      expect(data.error.code).toBe("connection_error");
    } finally {
      config.upstreamBaseUrl = originalUrl;
      logger.level = originalLevel;
    }
  });

  test("forwards x-session-id without error", async () => {
    const app = createApp();
    const res = await app.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-session-id": "sess-abc-123",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    );

    expect(res.status).toBe(200);
  });

  test("forwards x-user-id without error", async () => {
    const app = createApp();
    const res = await app.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-user-id": "tenant-acme",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    );

    expect(res.status).toBe(200);
  });

  test("forwards x-langfuse-tags without error", async () => {
    const app = createApp();
    const res = await app.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-langfuse-tags": "premium, internal",
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    );

    expect(res.status).toBe(200);
  });

  test("forwards x-langfuse-metadata without error", async () => {
    const app = createApp();
    const res = await app.handle(
      new Request("http://localhost/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-langfuse-metadata": JSON.stringify({
            orgId: "org_123",
            region: "us-east",
          }),
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
    );

    expect(res.status).toBe(200);
  });

  test("strips compressed entity headers from upstream responses", async () => {
    const compressed = gzipSync(JSON.stringify({ data: [] }));
    const captureServer = Bun.serve({
      port: 0,
      fetch() {
        return new Response(compressed, {
          headers: {
            "Content-Type": "application/json",
            "content-encoding": "gzip",
            "content-length": String(compressed.byteLength),
          },
        });
      },
    });

    const originalUrl = config.upstreamBaseUrl;
    config.upstreamBaseUrl = `http://localhost:${captureServer.port}`;
    try {
      const app = createApp();
      const res = await app.handle(
        new Request("http://localhost/v1/models", { method: "GET" }),
      );

      expect(res.status).toBe(200);
      expect(res.headers.get("content-encoding")).toBeNull();
      expect(res.headers.get("content-length")).toBeNull();
    } finally {
      config.upstreamBaseUrl = originalUrl;
      captureServer.stop();
    }
  });

  test("preserves query string", async () => {
    let capturedUrl = "";
    const captureServer = Bun.serve({
      port: 0,
      fetch(req) {
        capturedUrl = req.url;
        return new Response(JSON.stringify({ data: [] }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });

    const originalUrl = config.upstreamBaseUrl;
    config.upstreamBaseUrl = `http://localhost:${captureServer.port}`;
    try {
      const app = createApp();
      await app.handle(
        new Request("http://localhost/v1/models?foo=bar&baz=1", {
          method: "GET",
        }),
      );

      expect(capturedUrl).toContain("?foo=bar&baz=1");
    } finally {
      config.upstreamBaseUrl = originalUrl;
      captureServer.stop();
    }
  });
});

describe("passthroughController", () => {
  const createPassthroughApp = () => new Elysia().use(passthroughController);

  test("continues passthrough for unmatched paths", async () => {
    let capturedPath = "";
    let capturedAuth = "";
    let capturedApiKey = "";
    let capturedGoogKey = "";
    const captureServer = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url);
        capturedPath = `${url.pathname}${url.search}`;
        capturedAuth = req.headers.get("authorization") || "";
        capturedApiKey = req.headers.get("x-api-key") || "";
        capturedGoogKey = req.headers.get("x-goog-api-key") || "";
        return new Response(
          JSON.stringify({
            path: capturedPath,
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    });

    const originalUrl = config.upstreamBaseUrl;
    config.upstreamBaseUrl = `http://localhost:${captureServer.port}`;
    try {
      const app = createPassthroughApp();
      const res = await app.handle(
        new Request("http://localhost/custom/route?foo=bar", {
          method: "POST",
          headers: {
            Authorization: "Bearer passthrough-key",
            "x-api-key": "plain-key",
            "x-goog-api-key": "goog-key",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ hello: "world" }),
        }),
      );

      expect(res.status).toBe(200);
      expect(capturedPath).toBe("/custom/route?foo=bar");
      expect(capturedAuth).toBe("Bearer passthrough-key");
      expect(capturedApiKey).toBe("plain-key");
      expect(capturedGoogKey).toBe("goog-key");
    } finally {
      config.upstreamBaseUrl = originalUrl;
      captureServer.stop();
    }
  });
});

describe("deepseekController", () => {
  const createDeepseekApp = () => new Elysia().use(deepseekController);

  test("forwards /deepseek/v1/* without rewriting path", async () => {
    let capturedPath = "";
    const captureServer = Bun.serve({
      port: 0,
      fetch(req) {
        capturedPath = new URL(req.url).pathname;
        return new Response(
          JSON.stringify({
            model: "deepseek-chat",
            choices: [{ message: { role: "assistant", content: "Olá!" } }],
            usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
          }),
          { headers: { "Content-Type": "application/json" } },
        );
      },
    });
    const original = config.upstreamBaseUrl;
    config.upstreamBaseUrl = `http://localhost:${captureServer.port}`;
    try {
      const app = createDeepseekApp();
      const res = await app.handle(
        new Request("http://localhost/deepseek/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            model: "deepseek-chat",
            messages: [{ role: "user", content: "oi" }],
          }),
        }),
      );

      expect(res.status).toBe(200);
      expect(capturedPath).toBe("/deepseek/v1/chat/completions");
      const data = (await res.json()) as Record<string, unknown>;
      expect(data.model).toBe("deepseek-chat");
    } finally {
      config.upstreamBaseUrl = original;
      captureServer.stop();
    }
  });

  test("forwards consumer Authorization to deepseek upstream", async () => {
    let capturedAuth = "";
    const captureServer = Bun.serve({
      port: 0,
      fetch(req) {
        capturedAuth = req.headers.get("authorization") || "";
        return new Response(JSON.stringify({ data: [] }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    const original = config.upstreamBaseUrl;
    config.upstreamBaseUrl = `http://localhost:${captureServer.port}`;
    try {
      const app = createDeepseekApp();
      await app.handle(
        new Request("http://localhost/deepseek/v1/models", {
          method: "GET",
          headers: { Authorization: "Bearer sk-deepseek-test" },
        }),
      );

      expect(capturedAuth).toBe("Bearer sk-deepseek-test");
    } finally {
      config.upstreamBaseUrl = original;
      captureServer.stop();
    }
  });

  test("coexists with OpenAI catch-all without route collision", async () => {
    const seenPaths: string[] = [];
    const deepseekServer = Bun.serve({
      port: 0,
      fetch(req) {
        const path = new URL(req.url).pathname;
        seenPaths.push(path);
        const model = path.startsWith("/deepseek/v1")
          ? "deepseek-chat"
          : "gpt-4o-mini";
        return new Response(JSON.stringify({ model, choices: [] }), {
          headers: { "Content-Type": "application/json" },
        });
      },
    });
    const original = config.upstreamBaseUrl;
    config.upstreamBaseUrl = `http://localhost:${deepseekServer.port}`;
    try {
      // Same mount order as app.ts: deepseek before the /v1/* catch-all
      const app = new Elysia().use(deepseekController).use(proxyController);

      // OpenAI path must still reach the OpenAI upstream, not deepseek
      const openaiRes = await app.handle(
        new Request("http://localhost/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "gpt-4o-mini", messages: [] }),
        }),
      );
      const openaiData = (await openaiRes.json()) as Record<string, unknown>;
      expect(openaiData.model).toBe("gpt-4o-mini");

      // DeepSeek path must reach the deepseek upstream
      const dsRes = await app.handle(
        new Request("http://localhost/deepseek/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: "deepseek-chat", messages: [] }),
        }),
      );
      const dsData = (await dsRes.json()) as Record<string, unknown>;
      expect(dsData.model).toBe("deepseek-chat");
      expect(seenPaths).toContain("/v1/chat/completions");
      expect(seenPaths).toContain("/deepseek/v1/chat/completions");
    } finally {
      config.upstreamBaseUrl = original;
      deepseekServer.stop();
    }
  });
});
