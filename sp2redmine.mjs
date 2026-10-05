#!/usr/bin/env node
// Push time tracked in Super Productivity to Redmine as time entries.
// One entry per (issue, day), tagged "[sp]" in the comment and updated in place on re-runs.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';

const MARKER = '[sp]';
const CONFIG_PATH = join(homedir(), '.sp2redmine.json');
const BACKUP_DIR = join(process.env.APPDATA ?? join(homedir(), '.config'), 'superProductivity', 'backups');

const { values: args } = parseArgs({
  options: {
    date: { type: 'string' },
    from: { type: 'string' },
    to: { type: 'string' },
    file: { type: 'string' },
    host: { type: 'string' },
    activity: { type: 'string' },
    'save-activity': { type: 'boolean' },
    'dry-run': { type: 'boolean' },
    'include-manual': { type: 'boolean' },
    yes: { type: 'boolean', short: 'y' },
    help: { type: 'boolean', short: 'h' },
  },
});

if (args.help) {
  console.log(`Usage: sp2redmine [options]
  --date YYYY-MM-DD        one day (default: today)
  --from / --to YYYY-MM-DD date range (inclusive)
  --dry-run                preview only
  --include-manual         also log issue/days you already logged by hand
  -y, --yes                apply without asking
  --activity <id|name>     use this activity for all new entries (otherwise you are asked)
  --save-activity          remember --activity in ${CONFIG_PATH}
  --file <path>            use this SP backup/export instead of the latest backup
  --host <url>             override the Redmine host`);
  process.exit(0);
}

const config = existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) : {};

// ---------- dates ----------
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const today = new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD
const from = args.from ?? args.date ?? today;
const to = args.to ?? args.date ?? (args.from ? today : from);
for (const d of [from, to]) if (!DATE_RE.test(d)) fail(`Invalid date "${d}", expected YYYY-MM-DD`);
if (from > to) fail(`--from ${from} is after --to ${to}`);

function datesBetween(a, b) {
  const out = [];
  for (let t = Date.parse(`${a}T12:00:00Z`); t <= Date.parse(`${b}T12:00:00Z`); t += 86400000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}
const dates = datesBetween(from, to);

// ---------- Super Productivity data ----------
function latestBackup() {
  if (!existsSync(BACKUP_DIR)) fail(`Backup folder not found: ${BACKUP_DIR} (use --file)`);
  const files = readdirSync(BACKUP_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => ({ path: join(BACKUP_DIR, f), mtime: statSync(join(BACKUP_DIR, f)).mtime }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!files.length) fail(`No backups in ${BACKUP_DIR}`);
  return files[0];
}

const source = args.file ? { path: args.file, mtime: statSync(args.file).mtime } : latestBackup();
const raw = JSON.parse(readFileSync(source.path, 'utf8'));
const sp = raw.data ?? raw; // manual exports wrap the state in "data"

const tasks = [
  ...Object.values(sp.task?.entities ?? {}),
  ...Object.values(sp.archiveYoung?.task?.entities ?? {}),
  ...Object.values(sp.archiveOld?.task?.entities ?? {}),
];
const byId = new Map(tasks.map((t) => [t.id, t]));
const issueOf = (t) => (t?.issueType === 'REDMINE' && t.issueId ? String(t.issueId) : null);

// A parent's timeSpentOnDay already includes its subtasks, so only count each task's own share
// and attribute it to its own issue, or to its parent's issue.
const spHours = new Map(); // "date|issue" -> { date, issue, ms, titles:Set }
const unsyncedMs = new Map(); // date -> ms
for (const t of tasks) {
  const children = (t.subTaskIds ?? []).map((id) => byId.get(id)).filter(Boolean);
  const issue = issueOf(t) ?? issueOf(byId.get(t.parentId));
  for (const date of dates) {
    const own = (t.timeSpentOnDay?.[date] ?? 0) - children.reduce((s, c) => s + (c.timeSpentOnDay?.[date] ?? 0), 0);
    if (own <= 0) continue;
    if (!issue) {
      unsyncedMs.set(date, (unsyncedMs.get(date) ?? 0) + own);
      continue;
    }
    const key = `${date}|${issue}`;
    const row = spHours.get(key) ?? { date, issue, ms: 0, titles: new Set() };
    row.ms += own;
    const owner = issueOf(t) ? t : byId.get(t.parentId);
    row.titles.add(owner.title.replace(/^#\d+\s*/, ''));
    spHours.set(key, row);
  }
}

// ---------- Redmine ----------
const provider = Object.values(sp.issueProvider?.entities ?? {}).find((p) => p.issueProviderKey === 'REDMINE' && p.host);
const host = (args.host ?? config.host ?? provider?.host ?? '').replace(/\/+$/, '');
const apiKey = process.env.REDMINE_API_KEY ?? config.apiKey ?? provider?.api_key;
if (!host || !apiKey) fail('No Redmine host/API key found in SP data. Use --host and REDMINE_API_KEY.');

async function redmine(method, path, body) {
  const res = await fetch(`${host}${path}`, {
    method,
    headers: { 'X-Redmine-API-Key': apiKey, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text.trim() ? JSON.parse(text) : {};
  if (!res.ok) {
    const err = new Error(`${method} ${path} -> ${res.status} ${json.errors?.join('; ') ?? text.slice(0, 200)}`);
    err.status = res.status;
    err.errors = json.errors ?? [];
    throw err;
  }
  return json;
}

let activitiesCache;
async function getActivities() {
  activitiesCache ??= (await redmine('GET', '/enumerations/time_entry_activities.json')).time_entry_activities
    .filter((a) => a.active !== false)
    .map((a) => ({ id: a.id, name: a.name.trim() }));
  return activitiesCache;
}

// Match by id, exact name, or unique name prefix ("dev" -> Development). Returns { activity } or { error }.
async function findActivity(value) {
  const list = await getActivities();
  const v = String(value).trim().toLowerCase();
  if (/^\d+$/.test(v)) {
    const byId = list.find((a) => a.id === Number(v));
    return byId ? { activity: byId } : { error: `No activity with id ${v}` };
  }
  const exact = list.find((a) => a.name.toLowerCase() === v);
  if (exact) return { activity: exact };
  const prefixed = list.filter((a) => a.name.toLowerCase().startsWith(v));
  if (prefixed.length === 1) return { activity: prefixed[0] };
  if (prefixed.length > 1) return { error: `"${value}" matches ${prefixed.map((a) => a.name).join(', ')}` };
  return { error: `Unknown activity "${value}" (type ? to list all)` };
}

async function resolveActivity(value) {
  const { activity, error } = await findActivity(value);
  if (error) fail(error);
  return activity.id;
}

async function activityName(id) {
  return (await getActivities()).find((a) => a.id === id)?.name ?? `#${id}`;
}

const me = (await redmine('GET', '/users/current.json')).user;

const existing = [];
for (let offset = 0; ; offset += 100) {
  const page = await redmine('GET', `/time_entries.json?user_id=${me.id}&from=${from}&to=${to}&limit=100&offset=${offset}`);
  existing.push(...page.time_entries);
  if (offset + 100 >= page.total_count) break;
}
const markedEntries = new Map(); // "date|issue" -> entry
const manualHours = new Map(); // "date|issue" -> hours
for (const e of existing) {
  if (!e.issue) continue;
  const key = `${e.spent_on}|${e.issue.id}`;
  if ((e.comments ?? '').includes(MARKER)) markedEntries.set(key, e);
  else manualHours.set(key, (manualHours.get(key) ?? 0) + e.hours);
}

// ---------- plan ----------
const round2 = (h) => Math.round(h * 100) / 100;
const rows = [];
for (const r of spHours.values()) {
  const hours = round2(r.ms / 3600000);
  if (hours <= 0) continue;
  const key = `${r.date}|${r.issue}`;
  const entry = markedEntries.get(key);
  const manual = !entry && !args['include-manual'] && manualHours.has(key);
  const action = manual ? 'skip' : !entry ? 'create' : Math.abs(entry.hours - hours) >= 0.005 ? 'update' : 'unchanged';
  rows.push({ ...r, key, hours, entry, action, title: [...r.titles].join(' / ') });
}
for (const [key, entry] of markedEntries) {
  if (!rows.some((r) => r.key === key)) {
    rows.push({ key, date: entry.spent_on, issue: String(entry.issue.id), hours: 0, entry, action: 'stale', title: '(no SP time any more — not deleted)' });
  }
}
rows.sort((a, b) => a.date.localeCompare(b.date) || a.issue.localeCompare(b.issue, undefined, { numeric: true }));

// ---------- activities ----------
// New entries need an activity. Default per issue: --activity, then the one remembered for the
// issue, then the one on your latest Redmine entry for the issue, then the saved global one.
const creates = rows.filter((r) => r.action === 'create');
const forcedActivity = args.activity ? await resolveActivity(args.activity) : undefined;
let topActivities = [];
if (creates.length) {
  const recent = (await redmine('GET', `/time_entries.json?user_id=${me.id}&limit=100`)).time_entries; // newest first
  const lastByIssue = new Map();
  const usage = new Map();
  for (const e of recent) {
    if (e.issue && !lastByIssue.has(String(e.issue.id))) lastByIssue.set(String(e.issue.id), e.activity.id);
    usage.set(e.activity.id, (usage.get(e.activity.id) ?? 0) + 1);
  }
  const known = new Set((await getActivities()).map((a) => a.id));
  const fallback = config.activity ? await resolveActivity(config.activity) : undefined;
  for (const r of creates) {
    const id = forcedActivity ?? config.issueActivities?.[r.issue] ?? lastByIssue.get(r.issue) ?? fallback;
    r.activityId = known.has(id) ? id : undefined;
  }
  topActivities = (await Promise.all(
    [...usage].filter(([id]) => known.has(id)).sort((a, b) => b[1] - a[1]).slice(0, 8).map(async ([id]) => ({ id, name: await activityName(id) }))
  ));
}
for (const r of creates) r.activityName = r.activityId ? await activityName(r.activityId) : '?';

// ---------- preview ----------
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const padL = (s, n) => String(s).padStart(n);
console.log(`SP data:  ${source.path}  (saved ${source.mtime.toLocaleString()})`);
console.log(`Redmine:  ${host}  as ${me.login}`);
console.log(`Range:    ${from}${to !== from ? ` .. ${to}` : ''}\n`);

if (!rows.length) console.log('No Redmine-linked time in this range.');
else {
  console.log(`${pad('Date', 11)}${pad('Issue', 10)}${pad('Task', 46)}${padL('SP h', 7)}${padL('RM h', 7)}  ${pad('Action', 11)}Activity`);
  console.log('-'.repeat(110));
  let lastDate = null;
  let dayTotal = 0;
  const flush = () => lastDate && console.log(`${pad('', 67)}${padL(dayTotal.toFixed(2), 7)}  (${lastDate} total)\n`);
  for (const r of rows) {
    if (r.date !== lastDate) {
      flush();
      lastDate = r.date;
      dayTotal = 0;
    }
    dayTotal += r.hours;
    const manual = manualHours.get(r.key);
    const note = manual ? `  ${r.action === 'skip' ? '' : '! '}logged manually: ${round2(manual)}h` : '';
    console.log(
      `${pad(r.date, 11)}${pad(`#${r.issue}`, 10)}${pad(r.title, 46)}${padL(r.hours.toFixed(2), 7)}${padL(r.entry ? r.entry.hours.toFixed(2) : '-', 7)}  ${pad(r.action, 11)}${r.activityName ?? ''}${note}`
    );
  }
  flush();
}
for (const date of dates) {
  const ms = unsyncedMs.get(date);
  if (ms) console.log(`(not synced, no Redmine issue: ${date} ${round2(ms / 3600000)}h)`);
}

const changes = rows.filter((r) => r.action === 'create' || r.action === 'update');
if (!changes.length) {
  console.log('\nNothing to change.');
  process.exit(0);
}
if (args['dry-run']) {
  console.log(`\nDry run: ${changes.length} change(s) not applied.`);
  process.exit(0);
}
// The line iterator buffers input, so piped answers aren't lost; EOF aborts.
let rl, lines;
const ask = async (question) => {
  rl ??= createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
  lines ??= rl[Symbol.asyncIterator]();
  process.stdout.write(question);
  const { value, done } = await lines.next();
  if (done) abort();
  if (!process.stdin.isTTY) process.stdout.write(`${value}\n`);
  return value.trim();
};
const abort = () => {
  console.log('\nAborted.');
  process.exit(0);
};

// Shortlist of your most-used activities; also accepts any id/name, "?" lists all.
async function pickActivity(defaultId) {
  const shortlist = topActivities.map((a, i) => `${i + 1}) ${a.name}`).join('  ');
  if (shortlist) console.log(`    ${shortlist}`);
  const hint = defaultId ? `Enter = ${await activityName(defaultId)}` : 'number, name or ?';
  for (;;) {
    const input = await ask(`    Activity [${hint}]: `);
    if (!input) {
      if (defaultId) return defaultId;
      continue;
    }
    if (input === '?') {
      console.log((await getActivities()).map((a) => `      ${padL(a.id, 5)}  ${a.name}`).join('\n'));
      continue;
    }
    const n = Number(input);
    if (Number.isInteger(n) && n >= 1 && n <= topActivities.length) return topActivities[n - 1].id;
    const { activity, error } = await findActivity(input);
    if (activity) return activity.id;
    console.log(`    ${error}`);
  }
}

const describe = (r) => `${r.date} #${r.issue} ${r.title.slice(0, 50)} ${r.hours.toFixed(2)}h`;
const missing = creates.filter((r) => !r.activityId);

if (args.yes) {
  if (missing.length) fail(`${missing.length} new entr${missing.length > 1 ? 'ies have' : 'y has'} no activity. Run without -y to choose, or pass --activity.`);
} else if (!creates.length || forcedActivity) {
  if (!/^y(es)?$/i.test(await ask(`\nApply ${changes.length} change(s)? [y/N] `))) abort();
} else {
  const answer = (await ask(`\nApply ${changes.length} change(s)? [y = yes · a = one activity for all · e = choose per entry · N = abort] `)).toLowerCase();
  if (answer === 'a') {
    console.log('\n  Activity for all new entries:');
    const id = await pickActivity();
    for (const r of creates) r.activityId = id;
  } else if (answer === 'e' || ((answer === 'y' || answer === 'yes') && missing.length)) {
    const toAsk = answer === 'e' ? creates : missing;
    if (answer !== 'e') console.log(`\n  ${missing.length} entr${missing.length > 1 ? 'ies need' : 'y needs'} an activity:`);
    for (const r of toAsk) {
      console.log(`\n  ${describe(r)}`);
      r.activityId = await pickActivity(r.activityId);
    }
  } else if (answer !== 'y' && answer !== 'yes') abort();
  console.log('');
}
rl?.close();

// ---------- apply ----------
let failed = 0;
const remembered = { ...config.issueActivities };
for (const r of changes) {
  const label = `${r.date} #${r.issue} ${r.hours.toFixed(2)}h`;
  try {
    if (r.action === 'create') {
      const time_entry = { issue_id: Number(r.issue), spent_on: r.date, hours: r.hours, comments: MARKER, activity_id: r.activityId };
      const { time_entry: created } = await redmine('POST', '/time_entries.json', { time_entry });
      remembered[r.issue] = r.activityId;
      console.log(`  created  ${label}  ${await activityName(r.activityId)}  (entry ${created.id})`);
    } else {
      await redmine('PUT', `/time_entries/${r.entry.id}.json`, { time_entry: { hours: r.hours } });
      console.log(`  updated  ${label}  (entry ${r.entry.id}, was ${r.entry.hours}h)`);
    }
  } catch (err) {
    failed++;
    console.log(`  FAILED   ${label}  ${err.message}`);
  }
}

const newConfig = { ...config, issueActivities: remembered };
if (args['save-activity'] && args.activity) newConfig.activity = args.activity;
if (JSON.stringify(newConfig) !== JSON.stringify(config)) writeFileSync(CONFIG_PATH, JSON.stringify(newConfig, null, 2));

console.log(`\nDone: ${changes.length - failed} applied, ${failed} failed.`);
process.exit(failed ? 1 : 0);

function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}
