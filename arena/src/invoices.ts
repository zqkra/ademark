export type Currency = "USD" | "EUR" | "MXN";
export type Status = "draft" | "sent" | "paid" | "void";

export interface LineItem {
  description: string;
  quantity: number;
  unitPriceCents: number;
  /** 0.21 means 21%. */
  taxRate: number;
}

export interface Invoice {
  id: string;
  client: string;
  /** Calendar date, YYYY-MM-DD. */
  issued: string;
  netDays: number;
  status: Status;
  currency: Currency;
  items: LineItem[];
}

export function subtotalCents(invoice: Invoice): number {
  return invoice.items.reduce((sum, item) => sum + item.quantity * item.unitPriceCents, 0);
}

export function taxCents(invoice: Invoice): number {
  return invoice.items.reduce(
    (sum, item) => sum + Math.round(item.quantity * item.unitPriceCents * item.taxRate),
    0,
  );
}

export function totalCents(invoice: Invoice): number {
  return subtotalCents(invoice) + taxCents(invoice);
}

const CLIENTS = [
  "Acme Corp",
  "Globex",
  "Initech",
  "Umbrella",
  "Hooli",
  "Stark Industries",
  "Wayne Enterprises",
  "Soylent",
  "Tyrell",
  "Cyberdyne",
  'Wonka "Chocolate", Inc.',
  "Vandelay Industries",
] as const;

const PRODUCTS = [
  ["Design sprint", 450_000],
  ["Hosting (monthly)", 12_900],
  ["Support hours", 9_500],
  ["Audit", 180_000],
  ["Licenses", 4_900],
  ["Onboarding", 75_000],
  ["Data migration", 260_000],
  ["Training session", 32_000],
] as const;

const STATUSES: readonly Status[] = ["draft", "sent", "sent", "sent", "paid", "paid", "paid", "void"];
const CURRENCIES: readonly Currency[] = ["USD", "USD", "USD", "EUR", "MXN"];
const TAX_RATES = [0, 0.08, 0.16, 0.21] as const;
const NET_DAYS = [0, 15, 30, 30, 45, 60] as const;
const DAY_MS = 86_400_000;

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Deterministic fake invoices for demos and tests. */
export function sampleInvoices(count: number, seed = 1): Invoice[] {
  const random = mulberry32(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)]!;
  const firstDay = Date.UTC(2025, 0, 1);

  return Array.from({ length: count }, (_, index) => {
    const itemCount = 1 + Math.floor(random() * 4);
    const items: LineItem[] = Array.from({ length: itemCount }, () => {
      const [description, unitPriceCents] = pick(PRODUCTS);
      return {
        description,
        quantity: 1 + Math.floor(random() * 5),
        unitPriceCents,
        taxRate: pick(TAX_RATES),
      };
    });
    const issued = new Date(firstDay + Math.floor(random() * 638) * DAY_MS).toISOString().slice(0, 10);
    return {
      id: `INV-${String(1001 + index).padStart(5, "0")}`,
      client: pick(CLIENTS),
      issued,
      netDays: pick(NET_DAYS),
      status: pick(STATUSES),
      currency: pick(CURRENCIES),
      items,
    };
  });
}
