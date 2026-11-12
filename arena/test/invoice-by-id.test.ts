import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/api.ts";
import type { Invoice } from "../src/invoices.ts";

const invoice: Invoice = {
  id: "INV-05001",
  client: "Globex",
  issued: "2026-01-15",
  netDays: 15,
  status: "sent",
  currency: "EUR",
  items: [{ description: "Audit", quantity: 1, unitPriceCents: 180_000, taxRate: 0 }],
};

test("GET /invoices/:id returns the invoice", () => {
  const app = createApp({ invoices: [invoice] });
  const response = app.handle({ method: "GET", path: "/invoices/INV-05001" });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, invoice);
});

test("GET /invoices/:id returns 404 for an unknown id", () => {
  const app = createApp({ invoices: [invoice] });
  const response = app.handle({ method: "GET", path: "/invoices/INV-09999" });
  assert.equal(response.status, 404);
  assert.deepEqual(response.body, { error: "not_found" });
});
