import test from "node:test";
import assert from "node:assert/strict";
import { sampleInvoices } from "../src/invoices.ts";

test("sampleInvoices is deterministic for the same seed", () => {
  assert.deepEqual(sampleInvoices(8, 1234), sampleInvoices(8, 1234));
});

test("sampleInvoices uses the default seed when none is given", () => {
  assert.deepEqual(sampleInvoices(6), sampleInvoices(6));
});

test("sample invoices start at INV-01001 and count up", () => {
  const invoices = sampleInvoices(7, 99);
  assert.equal(invoices.length, 7);
  assert.deepEqual(
    invoices.map((invoice) => invoice.id),
    ["INV-01001", "INV-01002", "INV-01003", "INV-01004", "INV-01005", "INV-01006", "INV-01007"],
  );
});

test("sample invoice ids are unique", () => {
  const invoices = sampleInvoices(57, 7);
  assert.equal(new Set(invoices.map((invoice) => invoice.id)).size, 57);
});

test("a different seed changes the generated content", () => {
  const first = sampleInvoices(10, 1);
  const second = sampleInvoices(10, 2);
  assert.notDeepEqual(first, second);
});
