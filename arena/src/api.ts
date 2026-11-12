import { dueDate } from "./dates.ts";
import { sampleInvoices, totalCents } from "./invoices.ts";
import type { Invoice } from "./invoices.ts";
import { paginate } from "./paginate.ts";

export interface Request {
  method: string;
  /** Path with an optional query string, for example `/invoices?page=2`. */
  path: string;
  /** Header names are lowercase. */
  headers?: Record<string, string>;
}

export interface Response {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

export interface AppOptions {
  invoices?: Invoice[];
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return { status, headers: { "content-type": "application/json", ...headers }, body };
}

function toSummary(invoice: Invoice) {
  return {
    id: invoice.id,
    client: invoice.client,
    status: invoice.status,
    currency: invoice.currency,
    totalCents: totalCents(invoice),
    due: dueDate(invoice),
  };
}

export function createApp(options: AppOptions = {}) {
  const invoices = options.invoices ?? sampleInvoices(57);
  const byId = new Map(invoices.map((invoice) => [invoice.id, invoice]));

  function handle(request: Request): Response {
    const url = new URL(request.path, "http://ledger.local");

    if (request.method !== "GET") {
      return json(405, { error: "method_not_allowed" });
    }
    if (url.pathname === "/health") {
      return json(200, { ok: true });
    }
    if (url.pathname === "/invoices") {
      const page = Number(url.searchParams.get("page") ?? "1");
      const pageSize = Number(url.searchParams.get("pageSize") ?? "20");
      try {
        const result = paginate(invoices, page, pageSize);
        return json(200, { ...result, items: result.items.map(toSummary) });
      } catch (error) {
        if (error instanceof RangeError) {
          return json(400, { error: "bad_request", message: error.message });
        }
        throw error;
      }
    }

    const match = /^\/invoices\/([\w-]+)$/.exec(url.pathname);
    if (match) {
      const invoice = byId.get(match[1]!);
      return invoice ? json(200, invoice) : json(404, { error: "not_found" });
    }
    return json(404, { error: "not_found" });
  }

  return { handle };
}
