import type { Invoice } from "./invoices.ts";

const DAY_MS = 86_400_000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Parses a calendar date in YYYY-MM-DD form. */
export function parseDay(day: string): Date {
  if (!DAY_PATTERN.test(day)) {
    throw new RangeError(`invalid day: ${day}`);
  }
  const date = new Date(day);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`invalid day: ${day}`);
  }
  return date;
}

/** Formats a date as YYYY-MM-DD. */
export function formatDay(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function addDays(day: string, days: number): string {
  return formatDay(new Date(parseDay(day).getTime() + days * DAY_MS));
}

export function dueDate(invoice: Pick<Invoice, "issued" | "netDays">): string {
  return addDays(invoice.issued, invoice.netDays);
}

/** Whole days past the due date. 0 when the invoice is not overdue. */
export function daysOverdue(invoice: Pick<Invoice, "issued" | "netDays">, today: string): number {
  const difference = parseDay(today).getTime() - parseDay(dueDate(invoice)).getTime();
  return Math.max(0, Math.round(difference / DAY_MS));
}

export function isOverdue(invoice: Pick<Invoice, "issued" | "netDays">, today: string): boolean {
  return daysOverdue(invoice, today) > 0;
}
