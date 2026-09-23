import fs from 'node:fs';
import path from 'node:path';
import { ROOT, expandUser, loadConfig } from './worker.js';
import { ensurePrivateDirectory, privateRead, privateWrite } from './private-files.js';

export function pilotSettingsFile(credentialsFile = expandUser(loadConfig().credentials.env_file)) {
  return path.join(path.dirname(credentialsFile), 'settings.json');
}

function readSettings(file) {
  const text = privateRead(file);
  if (text === null) return null;
  let settings;
  try { settings = JSON.parse(text); }
  catch { throw new Error('Invalid DeepCodex settings file'); }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)
    || (settings.jev_compaction !== undefined && (!settings.jev_compaction
      || typeof settings.jev_compaction !== 'object' || Array.isArray(settings.jev_compaction)
      || typeof settings.jev_compaction.enabled !== 'boolean'))) {
    throw new Error('Invalid DeepCodex settings file');
  }
  return settings;
}

export function loadPilotConfig(root = ROOT, credentialsFile = expandUser(loadConfig().credentials.env_file)) {
  const config = JSON.parse(fs.readFileSync(path.join(root, 'config/pilot.json'), 'utf8'));
  const settings = readSettings(pilotSettingsFile(credentialsFile));
  if (settings?.jev_compaction) {
    config.jev_compaction = { ...config.jev_compaction, enabled: settings.jev_compaction.enabled };
  }
  return config;
}

export function saveJevCompactionEnabled(credentialsFile, enabled) {
  if (typeof enabled !== 'boolean') throw new Error('Jev compaction choice must be boolean');
  const file = pilotSettingsFile(credentialsFile);
  ensurePrivateDirectory(path.dirname(file));
  const settings = readSettings(file) ?? {};
  settings.jev_compaction = { ...settings.jev_compaction, enabled };
  privateWrite(file, JSON.stringify(settings, null, 2) + '\n');
}
