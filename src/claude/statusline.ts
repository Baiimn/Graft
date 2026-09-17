import { readFileSync } from 'node:fs';
import { renderStatusline, renderSubagent } from './format.js';
import { readStats, readSession, emptyStats, type Stats } from './state.js';
import { readWiring, computeStats } from './stats.js';

/**
 * The statusline's fast path is the hook-maintained cache (graft/.cache/stats.json).
 * When it's absent — a fresh checkout, or a plain `graft build` that doesn't write the
 * cache — fall back to reading the graph itself (wiring.json) so the bar reflects reality
 * immediately instead of showing "not built". An empty wiring.json is still a graph
 * (docs-only repos legitimately have 0 nodes); "not built" is only when the artifact
 * is missing. The graph carries no drift signal, so it reads as synced until the next
 * edit repopulates the cache. Still a pure read (no subprocess): the cache is preferred
 * because it carries live dirty/stale state.
 */
export function resolveStats(dir: string): Stats | null {
  const cached = readStats(dir);
  if (cached && cached.nodeCount > 0) return cached;
  const wiring = readWiring(dir);
  if (wiring) return { ...emptyStats(), ...computeStats(wiring) };
  return null;
}

export function main(): void {
  let input: any = {};
  try { input = JSON.parse(readFileSync(0, 'utf8')); } catch { /* no/invalid stdin */ }
  const dir = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const session = readSession(dir, input.session_id || 'default');
  const agent = input?.agent?.name;
  if (agent) { process.stdout.write(renderSubagent(agent, session)); return; }
  const stats = resolveStats(dir);
  const pct = (v: unknown): number | null => (typeof v === 'number' ? Math.round(v) : null);
  const ctxPct = pct(input?.context_window?.used_percentage);
  const fiveHourPct = pct(input?.rate_limits?.five_hour?.used_percentage);
  const weekPct = pct(input?.rate_limits?.seven_day?.used_percentage);
  process.stdout.write(renderStatusline(stats, session, { ctxPct, fiveHourPct, weekPct }).join('\n'));
}
