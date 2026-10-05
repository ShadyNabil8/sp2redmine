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
  --activity <id|name>     Redmine time entry activity
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

async function resolveActivity(value) {
  if (!value) return undefined;
  if (/^\d+$/.test(String(value))) return Number(value);
  const { time_entry_activities: list } = await redmine('GET', '/enumerations/time_entry_activities.json');
  const match = list.find((a) => a.name.trim().toLowerCase() === String(value).trim().toLowerCase());
  if (!match) fail(`Unknown activity "${value}". Available: ${list.map((a) => `${a.id}=${a.name}`).join(', ')}`);
  return match.id;
}

async function printActivities() {
  try {
    const { time_entry_activities: list } = await redmine('GET', '/enumerations/time_entry_activities.json');
    console.log(`\nAvailable activities: ${list.map((a) => `${a.id}=${a.name}${a.is_default ? ' (default)' : ''}`).join(', ')}`);
    console.log('Re-run with e.g. --activity "<name>" --save-activity');
  } catch {}
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

// ---------- preview ----------
const pad = (s, n) => String(s).padEnd(n).slice(0, n);
const padL = (s, n) => String(s).padStart(n);
console.log(`SP data:  ${source.path}  (saved ${source.mtime.toLocaleString()})`);
console.log(`Redmine:  ${host}  as ${me.login}`);
console.log(`Range:    ${from}${to !== from ? ` .. ${to}` : ''}\n`);

if (!rows.length) console.log('No Redmine-linked time in this range.');
else {
  console.log(`${pad('Date', 11)}${pad('Issue', 10)}${pad('Task', 46)}${padL('SP h', 7)}${padL('RM h', 7)}  Action`);
  console.log('-'.repeat(92));
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
      `${pad(r.date, 11)}${pad(`#${r.issue}`, 10)}${pad(r.title, 46)}${padL(r.hours.toFixed(2), 7)}${padL(r.entry ? r.entry.hours.toFixed(2) : '-', 7)}  ${r.action}${note}`
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
if (!args.yes) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(`\nApply ${changes.length} change(s)? [y/N] `);
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) {
    console.log('Aborted.');
    process.exit(0);
  }
}

// ---------- apply ----------
const activityId = await resolveActivity(args.activity ?? config.activity);
if (args['save-activity'] && args.activity) {
  writeFileSync(CONFIG_PATH, JSON.stringify({ ...config, activity: args.activity }, null, 2));
  console.log(`Saved activity "${args.activity}" to ${CONFIG_PATH}`);
}

let failed = 0;
let activityMissing = false;
for (const r of changes) {
  const label = `${r.date} #${r.issue} ${r.hours.toFixed(2)}h`;
  try {
    if (r.action === 'create') {
      const time_entry = { issue_id: Number(r.issue), spent_on: r.date, hours: r.hours, comments: MARKER };
      if (activityId) time_entry.activity_id = activityId;
      const { time_entry: created } = await redmine('POST', '/time_entries.json', { time_entry });
      console.log(`  created  ${label}  (entry ${created.id})`);
    } else {
      await redmine('PUT', `/time_entries/${r.entry.id}.json`, { time_entry: { hours: r.hours } });
      console.log(`  updated  ${label}  (entry ${r.entry.id}, was ${r.entry.hours}h)`);
    }
  } catch (err) {
    failed++;
    if (err.errors?.some((e) => /activity/i.test(e))) activityMissing = true;
    console.log(`  FAILED   ${label}  ${err.message}`);
  }
}
if (activityMissing) await printActivities();
console.log(`\nDone: ${changes.length - failed} applied, ${failed} failed.`);
process.exit(failed ? 1 : 0);

function fail(msg) {
  console.error(`Error: ${msg}`);
  process.exit(1);
}
