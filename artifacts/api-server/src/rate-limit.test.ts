import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { Request } from "express";
import app from "./app";
import { clientIp } from "./utils/clientIp";
import { closeRoomStorage, initializeRoomStorage } from "./lib/rooms";

test("clientIp helper unit tests", async (t) => {
  await t.test("extracts single IPv4 from cf-connecting-ip", () => {
    const req = {
      headers: { "cf-connecting-ip": "203.0.113.195" },
      ip: "127.0.0.1",
    } as unknown as Request;

    assert.equal(clientIp(req), "203.0.113.195");
  });

  await t.test("takes the first IP when cf-connecting-ip is comma-separated", () => {
    const req = {
      headers: { "cf-connecting-ip": "203.0.113.195, 198.51.100.1" },
      ip: "127.0.0.1",
    } as unknown as Request;

    assert.equal(clientIp(req), "203.0.113.195");
  });

  await t.test("takes the first value when cf-connecting-ip is an array", () => {
    const req = {
      headers: { "cf-connecting-ip": ["203.0.113.195", "198.51.100.1"] },
      ip: "127.0.0.1",
    } as unknown as Request;

    assert.equal(clientIp(req), "203.0.113.195");
  });

  await t.test("handles array of comma-separated cf-connecting-ip values", () => {
    const req = {
      headers: { "cf-connecting-ip": ["203.0.113.195, 1.2.3.4", "198.51.100.1"] },
      ip: "127.0.0.1",
    } as unknown as Request;

    assert.equal(clientIp(req), "203.0.113.195");
  });

  await t.test("normalizes IPv6 cf-connecting-ip via ipKeyGenerator", () => {
    const req = {
      headers: { "cf-connecting-ip": "2001:0db8:85a3:0000:0000:8a2e:0370:7334" },
      ip: "127.0.0.1",
    } as unknown as Request;

    assert.equal(clientIp(req), "2001:db8:85a3::/56");
  });

  await t.test("falls back to req.ip when cf-connecting-ip is absent", () => {
    const req = {
      headers: {},
      ip: "198.51.100.55",
    } as unknown as Request;

    assert.equal(clientIp(req), "198.51.100.55");
  });

  await t.test("falls back to req.ip when cf-connecting-ip is whitespace", () => {
    const req = {
      headers: { "cf-connecting-ip": "   " },
      ip: "198.51.100.55",
    } as unknown as Request;

    assert.equal(clientIp(req), "198.51.100.55");
  });

  await t.test("returns empty string if neither cf-connecting-ip nor req.ip is present", () => {
    const req = {
      headers: {},
    } as unknown as Request;

    assert.equal(clientIp(req), "");
  });
});

test("HTTP rate limiting & client IP integration tests", async (t) => {
  process.env.TEST_MOCK_STORAGE = "true";
  process.env.RATE_LIMIT_ROOM_CREATE_MAX = "2"; // Low limit for fast test execution

  await initializeRoomStorage();

  const server = createServer(app);
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (typeof addr === "object" && addr !== null) {
        resolve(addr.port);
      } else {
        throw new Error("Unable to obtain port");
      }
    });
  });

  const baseUrl = `http://127.0.0.1:${port}`;

  t.after(async () => {
    delete process.env.RATE_LIMIT_ROOM_CREATE_MAX;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeRoomStorage();
  });

  await t.test("GET /api/debug-ip returns expected diagnostic fields and resolved IP", async () => {
    const res = await fetch(`${baseUrl}/api/debug-ip`, {
      headers: {
        "cf-connecting-ip": "203.0.113.88, 198.51.100.2",
        "x-forwarded-for": "198.51.100.2",
      },
    });

    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      ip: string;
      xff?: string;
      cfConnectingIp?: string;
      trustProxy?: unknown;
      resolved: string;
    };

    assert.equal(body.cfConnectingIp, "203.0.113.88, 198.51.100.2");
    assert.equal(body.xff, "198.51.100.2");
    assert.equal(body.trustProxy, 1);
    assert.equal(body.resolved, "203.0.113.88");
  });

  await t.test("Two clients with different cf-connecting-ip do NOT share rate-limit counter", async () => {
    const ipClientA = "192.0.2.101";
    const ipClientB = "192.0.2.102";

    // Client A makes 1st request
    const resA = await fetch(`${baseUrl}/api/rooms`, {
      method: "POST",
      headers: { "cf-connecting-ip": ipClientA },
    });
    assert.equal(resA.status, 201);
    const rlHeaderA = resA.headers.get("ratelimit") || "";
    const remainingA = Number(rlHeaderA.match(/r=(\d+)/)?.[1]);
    assert.equal(remainingA, 1, "Client A remaining counter should be 1 after 1st request");

    // Client B makes 1st request from different IP
    const resB = await fetch(`${baseUrl}/api/rooms`, {
      method: "POST",
      headers: { "cf-connecting-ip": ipClientB },
    });
    assert.equal(resB.status, 201);
    const rlHeaderB = resB.headers.get("ratelimit") || "";
    const remainingB = Number(rlHeaderB.match(/r=(\d+)/)?.[1]);

    // Client B must start fresh (remaining = 1), NOT shared (which would be 0)
    assert.equal(remainingB, 1, "Client B should start with fresh rate-limit bucket");

    // Verify distinct partition keys in ratelimit-policy
    const policyA = resA.headers.get("ratelimit-policy") || "";
    const policyB = resB.headers.get("ratelimit-policy") || "";
    const pkA = policyA.match(/pk=([^;\s]+)/)?.[1];
    const pkB = policyB.match(/pk=([^;\s]+)/)?.[1];
    assert.ok(pkA && pkB, "Both responses should include a partition key (pk)");
    assert.notEqual(pkA, pkB, "Client A and Client B partition keys must be distinct");
  });

  await t.test("Exceeding limit on Client A returns 429 while Client C still gets 201", async () => {
    const ipClientA = "192.0.2.101";
    const ipClientC = "192.0.2.103";

    // Client A already made 1 request (limit is 2).
    // Client A makes 2nd request (uses remaining limit).
    const resA2 = await fetch(`${baseUrl}/api/rooms`, {
      method: "POST",
      headers: { "cf-connecting-ip": ipClientA },
    });
    assert.equal(resA2.status, 201);

    // Client A makes 3rd request (exceeds limit of 2) -> must get 429
    const resA3 = await fetch(`${baseUrl}/api/rooms`, {
      method: "POST",
      headers: { "cf-connecting-ip": ipClientA },
    });
    assert.equal(resA3.status, 429, "Client A must receive HTTP 429 upon exceeding limit");
    const errBody = (await resA3.json()) as { error?: string };
    assert.equal(errBody.error, "Too many rooms created. Try again in a few minutes.");

    // Client C with different IP makes a request -> must get 201 (unaffected by Client A's block)
    const resC = await fetch(`${baseUrl}/api/rooms`, {
      method: "POST",
      headers: { "cf-connecting-ip": ipClientC },
    });
    assert.equal(resC.status, 201, "Client C with different IP must still succeed with HTTP 201");
  });
});

