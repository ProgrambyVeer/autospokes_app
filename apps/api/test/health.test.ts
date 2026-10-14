import { afterAll, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { MemoryAuthRepository } from "./support/memory-auth-repository.js";

const app = buildApp({
  authRepository: new MemoryAuthRepository(),
  jwtSecret: "test-only-secret-with-more-than-thirty-two-characters",
  nodeEnv: "test",
});

afterAll(async () => {
  await app.close();
});

describe("GET /health", () => {
  it("returns the shared health response shape", async () => {
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ok",
      service: "autospokes-api",
    });
  });
});
