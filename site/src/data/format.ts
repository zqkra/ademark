// Number formats shared by the server render and the browser scripts.

export type Unit = "s" | "ms" | "MB" | "%" | "tokens" | "USD";

const group = (v: number, digits = 0) =>
  v.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** The value without its unit, for table cells. */
export function bare(v: number, unit: Unit): string {
  switch (unit) {
    case "s":
      return v < 10 ? v.toFixed(2) : v.toFixed(1);
    case "ms":
      return group(Math.round(v));
    case "MB":
      return v < 100 ? v.toFixed(1) : group(Math.round(v));
    case "%":
      return v < 1 ? v.toFixed(2) : v.toFixed(1);
    case "tokens":
      return v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : `${(v / 1e3).toFixed(1)}K`;
    case "USD":
      return `$${v.toFixed(3)}`;
  }
}

/** The value with its unit, for labels. */
export function fmt(v: number, unit: Unit): string {
  const b = bare(v, unit);
  switch (unit) {
    case "s":
      return `${b} s`;
    case "ms":
      return `${b} ms`;
    case "MB":
      return `${b} MB`;
    case "%":
      return `${b}%`;
    default:
      return b;
  }
}

/** How a value compares with the Bare CLI: "same", "+11%", "3.9x" or "−46%". */
export function delta(v: number, ref: number): string {
  if (!ref) return "";
  const r = v / ref;
  if (Math.abs(r - 1) < 0.005) return "same";
  if (r >= 1.995) return `${r.toFixed(1)}x`;
  if (r > 1) return `+${Math.round((r - 1) * 100)}%`;
  return `−${Math.round((1 - r) * 100)}%`;
}

/** Keeps a number on the same line as its unit in headlines. */
export function nb(text: string): string {
  return text.replace(/(\d) (?=(s|ms|MB|min|of|tokens)\b)/g, "$1\u00a0");
}
