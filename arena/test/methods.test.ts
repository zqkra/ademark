import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/api.ts";
import { sampleInvoices } from "../src/invoices.ts";

test("DELETE returns 405", () => {
  const app = createApp({ invoices: sampleInvoices(3, 5) });
  assert.equal(app.handle({ method: "DELETE", path: "/health" }).status, 405);
});

test("PUT returns 405", () => {
  const app = createApp({ invoices: sampleInvoices(3, 5) });
  assert.equal(app.handle({ method: "PUT", path: "/invoices/INV-01001" }).status, 405);
});
