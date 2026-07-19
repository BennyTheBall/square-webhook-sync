const levels = { error: 0, warn: 1, info: 2, debug: 3 };
const configuredLevel = process.env.LOG_LEVEL || "info";
const threshold = levels[configuredLevel] ?? levels.info;

export function log(level, message, fields = {}) {
  if ((levels[level] ?? levels.info) > threshold) return;
  const record = {
    level,
    time: new Date().toISOString(),
    message,
    ...redact(fields)
  };
  console.log(JSON.stringify(record));
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
