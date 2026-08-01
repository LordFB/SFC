const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function parseAssignment(value) {
  const separator = value.indexOf('=');
  if (separator < 1) throw new Error(`Invalid assignment "${value}"; expected NAME=value.`);
  const name = value.slice(0, separator).trim();
  const assigned = value.slice(separator + 1);
  if (!ENV_NAME.test(name)) throw new Error(`Invalid environment variable name: ${name}`);
  if (/[\r\n\0]/.test(assigned)) throw new Error(`Environment value for ${name} cannot contain newlines or null bytes.`);
  return [name, assigned];
}

export function parseEnvText(source) {
  const values = new Map();
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator > 0 && ENV_NAME.test(trimmed.slice(0, separator))) {
      values.set(trimmed.slice(0, separator), trimmed.slice(separator + 1));
    }
  }
  return values;
}

export function quoteEnv(value) {
  if (value === '') return '';
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) return value;
  return JSON.stringify(value);
}

export function serializeEnv(values, mode) {
  const lines = [`# SFC ${mode} environment. Local-only: never commit this file.`];
  for (const [name, value] of [...values].sort(([a], [b]) => a.localeCompare(b))) lines.push(`${name}=${quoteEnv(value)}`);
  return `${lines.join('\n')}\n`;
}
