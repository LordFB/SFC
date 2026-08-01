export function projectName(value) {
  const name = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(name) || name === '.' || name === '..') {
    throw new Error('Project names may contain lowercase letters, numbers, dots, dashes, and underscores.');
  }
  return name;
}

export function identifier(value, label = 'Name') {
  const name = String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error(`${label} must start with a letter and use letters, numbers, or dashes.`);
  return name;
}

export function envPrefix(value) {
  return identifier(value).replaceAll('-', '_').toUpperCase();
}

export function jsIdentifier(value) {
  const parts = identifier(value).split('-');
  return parts[0] + parts.slice(1).map(part => part[0].toUpperCase() + part.slice(1)).join('');
}
