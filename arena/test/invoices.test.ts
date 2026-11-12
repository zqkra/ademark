import test from "node:test";
import assert from "node:assert/strict";
import { subtotalCents, taxCents, totalCents } from "../src/invoices.ts";
import type { Invoice } from "../src/invoices.ts";

function invoiceWith(items: Invoice["items"]): Invoice {
  return {
    id: "INV-09001",
    client: "Acme Corp",
    issued: "2026-03-01",
    netDays: 30,
    status: "draft",
    currency: "USD",
    items,
  };
}

test("subtotal adds quantity times unit price", () => {
  const invoice = invoiceWith([
    { description: "Design", quantity: 3, unitPriceCents: 1000, taxRate: 0 },
    { description: "Hosting", quantity: 2, unitPriceCents: 250, taxRate: 0 },
  ]);
  assert.equal(subtotalCents(invoice), 3500);
});

test("tax rounds once per line, not on the sum", () => {
  const invoice = invoiceWith([
    { description: "A", quantity: 1, unitPriceCents: 100, taxRate: 0.005 },
    { description: "B", quantity: 1, unitPriceCents: 100, taxRate: 0.005 },
  ]);
  assert.equal(taxCents(invoice), 2);
});

test("tax rounds half up on each line", () => {
  const invoice = invoiceWith([
    { description: "Half", quantity: 1, unitPriceCents: 999, taxRate: 0.05 },
    { description: "Round", quantity: 3, unitPriceCents: 1000, taxRate: 0.0825 },
  ]);
  assert.equal(taxCents(invoice), 50 + 248);
});

test("total is subtotal plus tax in cents", () => {
  const invoice = invoiceWith([
    { description: "Audit", quantity: 2, unitPriceCents: 12_500, taxRate: 0.16 },
    { description: "Support", quantity: 1, unitPriceCents: 4_900, taxRate: 0.21 },
  ]);
  assert.equal(subtotalCents(invoice), 29_900);
  assert.equal(taxCents(invoice), 5029);
  assert.equal(totalCents(invoice), 34_929);
});

test("an invoice without items totals zero", () => {
  const invoice = invoiceWith([]);
  assert.equal(subtotalCents(invoice), 0);
  assert.equal(taxCents(invoice), 0);
  assert.equal(totalCents(invoice), 0);
});
