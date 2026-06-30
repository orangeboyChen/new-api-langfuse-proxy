import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Elysia } from "elysia";
import { healthController } from "@/api/features/health/health.controller";
import config from "@/config";

let mockServer: ReturnType<typeof Bun.serve>;
let mockBaseUrl: string;

beforeAll(() => {
  mockServer = Bun.serve({
    port: 0,
    fetch(req) {
      if (req.method === "HEAD") {
        const url = new URL(req.url);
        if (url.pathname === "/unreachable") {
          return new Response(null, { status: 503 });
        }
        return new Response(null, { status: 404 });
      }

      return new Response("ok");
    },
  });
  mockBaseUrl = `http://localhost:${mockServer.port}`;
});

afterAll(() => {
  mockServer.stop();
});

const createApp = () => new Elysia().use(healthController);

describe("healthController", () => {
  describe("GET /health", () => {
    test("returns response with package info", async () => {
      const originalUrl = config.upstreamBaseUrl;
      config.upstreamBaseUrl = mockBaseUrl;
      const app = createApp();
      try {
        const res = await app.handle(new Request("http://localhost/health"));

        expect(res.status).toBe(200);
        const data = await res.json();
        expect(data).toHaveProperty("name");
        expect(data).toHaveProperty("version");
        expect(data).toHaveProperty("status");
      } finally {
        config.upstreamBaseUrl = originalUrl;
      }
    });

    test("treats 404 health replies as reachable", async () => {
      const originalUrl = config.upstreamBaseUrl;
      config.upstreamBaseUrl = `${mockBaseUrl}/reachable`;
      const app = createApp();
      try {
        const res = await app.handle(new Request("http://localhost/health"));
        const data = (await res.json()) as {
          status: string;
          upstream: { newapi: string };
        };
        expect(data.status).toBe("ok");
        expect(data.upstream.newapi).toBe("ok");
      } finally {
        config.upstreamBaseUrl = originalUrl;
      }
    });

    test("marks 5xx health replies as unreachable", async () => {
      const originalUrl = config.upstreamBaseUrl;
      config.upstreamBaseUrl = `${mockBaseUrl}/unreachable`;
      const app = createApp();
      try {
        const res = await app.handle(new Request("http://localhost/health"));
        const data = (await res.json()) as {
          status: string;
          upstream: { newapi: string };
        };
        expect(data.status).toBe("degraded");
        expect(data.upstream.newapi).toBe("unreachable");
      } finally {
        config.upstreamBaseUrl = originalUrl;
      }
    });
  });
});
