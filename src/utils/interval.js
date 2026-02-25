// Convert displayed value + unit → interval_ms
export function toIntervalMs(value, unit) {
  const n = parseFloat(value);
  if (!isFinite(n) || n <= 0) return 1;
  switch (unit) {
    case "cps": {
      const ms = Math.round(1000.0 / n);
      return Math.max(1, ms);
    }
    case "ms":
      return Math.max(1, Math.round(n));
    case "s":
      return Math.max(1, Math.round(n * 1000));
    case "min":
      return Math.max(1, Math.round(n * 60 * 1000));
    default:
      return Math.max(1, Math.round(n));
  }
}

// Convert interval_ms → display value for a given unit
export function fromIntervalMs(ms, unit) {
  switch (unit) {
    case "cps": {
      const cps = 1000.0 / ms;
      // Show up to 2 decimal places, trim trailing zeros
      return parseFloat(cps.toFixed(2));
    }
    case "ms":
      return ms;
    case "s":
      return parseFloat((ms / 1000).toFixed(3));
    case "min":
      return parseFloat((ms / 60000).toFixed(4));
    default:
      return ms;
  }
}

// Human-readable summary shown on collapsed card
export function intervalSummary(ms, unit) {
  const val = fromIntervalMs(ms, unit);
  const labels = { cps: "CPS", ms: "ms", s: "s", min: "min" };
  return `${val} ${labels[unit] ?? unit}`;
}
