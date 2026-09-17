import { parse } from 'smol-toml';

export function parseToml(text) {
  try { return parse(text); }
  catch { throw new Error('Invalid TOML configuration'); }
}
