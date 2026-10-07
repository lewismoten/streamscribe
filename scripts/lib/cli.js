export const ansi = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  brightBlue: '\x1b[94m'
};

export function colorize(text, color) {
  const code = ansi[color];
  return code ? `${code}${text}${ansi.reset}` : text;
}

export function parsePositiveIntegerArg(flag, value) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    throw new Error(`Missing or invalid value for ${flag}`);
  }
  return parsed;
}

// Picks configured sources by key (all of them when no keys are given).
// `label` is the config key name used in error messages, e.g. 'sources'.
// With `allowEmpty`, returns an empty list instead of throwing when nothing matches.
export function selectConfiguredSources(sources, selectedKeys, label, { allowEmpty = false } = {}) {
  const configured = Array.isArray(sources) ? sources : [];
  if (configured.length === 0 && !allowEmpty) {
    throw new Error(`No ${label} are configured in config.local.js`);
  }

  if (!Array.isArray(selectedKeys) || selectedKeys.length === 0) {
    return configured;
  }

  const wanted = new Set(selectedKeys.map((item) => String(item || '').trim()).filter(Boolean));
  if (wanted.size === 0) {
    return configured;
  }

  const filtered = configured.filter((source) => wanted.has(source.key));
  if (filtered.length === 0 && !allowEmpty) {
    throw new Error(`No configured ${label} matched: ${selectedKeys.join(', ')}`);
  }
  return filtered;
}

// Stops with a clear message when a required config.local.js setting is empty.
export function requireConfigValue(value, configKey) {
  if (!String(value || '').trim()) {
    throw new Error(`Set ${configKey} in config.local.js (see config.example.js)`);
  }
  return value;
}
