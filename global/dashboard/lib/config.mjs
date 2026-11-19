// Dashboard settings: defaults, overlaid by <dashHome>/config.json. Thresholds are minutes unless a count.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dashHome } from './paths.mjs';

export const DEFAULTS = Object.freeze({
  port: 47800,
  thresholds: Object.freeze({
    quiet: 20, hungTool: 20, apiError: 5, waiting: 5, waitingEscalate: 15,
    subagentQuiet: 20, loopCount: 6, loopWindow: 10, idleGap: 15, autoStop: 30,
  }),
});

/**
 * When the Dashboard component was first installed (ms), from <dashHome>/installed.json `{installedAt: ISO}`,
 * which the installer writes once. Plans added before it fold as "Before the dashboard". Null when missing or
 * unreadable: then nothing folds that way.
 * @returns {number|null}
 */
export function readInstalledAt() {
  try {
    const at = JSON.parse(readFileSync(join(dashHome(), 'installed.json'), 'utf8'))?.installedAt;
    const ms = typeof at === 'string' ? Date.parse(at) : NaN;
    return Number.isFinite(ms) ? ms : null;
  } catch { return null; }
}

export function loadConfig() {
  let user = {};
  try {
    const parsed = JSON.parse(readFileSync(join(dashHome(), 'config.json'), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) user = parsed;
  } catch { /* missing or broken: defaults */ }
  const t = user.thresholds && typeof user.thresholds === 'object' && !Array.isArray(user.thresholds) ? user.thresholds : {};
  return {
    port: Number.isInteger(user.port) ? user.port : DEFAULTS.port,
    thresholds: { ...DEFAULTS.thresholds, ...t },
  };
}
