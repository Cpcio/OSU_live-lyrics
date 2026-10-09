// Small value, text and formatting helpers shared by the overlay.

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function parseBool(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "enabled", "on"].includes(normalized)) return true;
    if (["false", "0", "no", "disabled", "off"].includes(normalized)) return false;
  }
  return fallback;
}

function parseNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatSignedMs(value) {
  const number = Math.round(parseNumber(value, 0));
  const sign = number >= 0 ? "+" : "-";
  return `${sign}${Math.abs(number)}ms`;
}

function safeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function normalizeForSearch(value) {
  return safeText(value)
    .replace(/\[[^\]]*]/g, " ")
    .replace(/\([^)]*(?:TV Size|Short Ver\.?|Game Ver\.?|Cut Ver\.?|Extended|feat\.[^)]*)\)/gi, " ")
    .replace(/\b(TV Size|Short Ver\.?|Game Ver\.?|Cut Ver\.?|Extended|Mapped by .*)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeForCompare(value) {
  return normalizeForSearch(value)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

function uniqueStrings(values) {
  const seen = new Set();
  const output = [];

  for (const value of values.map(safeText).filter(Boolean)) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    output.push(value);
  }

  return output;
}

function formatTime(ms) {
  const safe = Math.max(0, Number(ms) || 0);
  const minutes = Math.floor(safe / 60000);
  const seconds = Math.floor((safe % 60000) / 1000);
  const millis = Math.floor(safe % 1000);

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`;
}
