import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/api.ts";

test("GET /health returns ok", () => {
  const app = createApp({ invoices: [] });
  const response = app.handle({ method: "GET", path: "/health" });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, { ok: true });
  assert.equal(response.headers["content-type"], "application/json");
});
