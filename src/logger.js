const levels = { error: 0, warn: 1, info: 2, debug: 3 };
const configuredLevel = process.env.LOG_LEVEL || "info";
const threshold = levels[configuredLevel] ?? levels.info;

export function log(level, message, fields = {}) {
  if ((levels[level] ?? levels.info) > threshold) return;
  const fieldText = formatFields(redact(fields));
  const line = `${easternTimestamp()} ${message}`;
  console.log(fieldText ? `${line} ${fieldText}` : line);
}

export const logger = {
  error: (message, fields) => log("error", message, fields),
  warn: (message, fields) => log("warn", message, fields),
  info: (message, fields) => log("info", message, fields),
  debug: (message, fields) => log("debug", message, fields)
};

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack
    };
  }
  if (!value || typeof value !== "object") return value;

  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (/token|secret|password|signature|access_key/i.test(key)) {
      output[key] = item ? "[redacted]" : item;
    } else {
      output[key] = redact(item);
    }
  }
  return output;
}

function formatFields(fields) {
  if (!fields || typeof fields !== "object") return "";
  return Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null && value !== "")
    .map(([key, value]) => `${key}=${formatValue(value)}`)
    .join(" ");
}

function formatValue(value) {
  if (value instanceof Error) return value.message;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value).replace(/\s+/g, " ");
}

function easternTimestamp() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    timeZoneName: "short"
  }).formatToParts(new Date());

  const get = (type) => parts.find((part) => part.type === type)?.value || "";
  return `[${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")} ${get("timeZoneName")}]`;
}
