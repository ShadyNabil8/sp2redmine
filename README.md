# sp2redmine

Logs time tracked in Super Productivity (SP) to Redmine.

It reads SP's latest automatic backup (`%APPDATA%\superProductivity\backups`). For every task linked to a Redmine issue, it adds up the time per day and creates **one Redmine time entry per issue per day**. Each entry gets the comment `[sp]`. When you run it again, those entries are updated to the current SP total, so it's safe to run as often as you like. Entries you logged by hand are never touched. If one sits on the same issue and day, the preview flags it.

The Redmine host and API key come from SP's Redmine integration settings, so no setup is needed.

## Install

```
npm link        # makes `sp2redmine` available everywhere
```

## Usage

```
sp2redmine                                   # today: preview, then confirm
sp2redmine --date 2026-10-04                 # one day
sp2redmine --from 2026-09-27 --to 2026-10-01 # a range
sp2redmine --dry-run                         # preview only
sp2redmine -y                                # apply without asking
sp2redmine --activity Development            # one activity for all, no picker
```

## Activities

Every new entry needs an activity. The preview shows the activity each entry will get. It is taken from, in order:
1. the activity you picked for that issue last time (saved in `~/.sp2redmine.json`)
2. the activity of your latest Redmine entry on that issue
3. a global default, if you saved one with `--activity X --save-activity`

`?` means none was found. At the prompt:
- `y`: apply. You're only asked about the `?` rows.
- `a`: pick one activity for all new entries.
- `e`: go through each new entry. Enter keeps the shown activity.

The picker lists your most-used activities by number. You can also type an id, a name, or the start of a name (`dev`, `code rev`). Type `?` to list them all. Whatever you pick is remembered for that issue.

Notes:
- SP refreshes its backup file every so often. If you just tracked time, wait a few minutes, or export your data from SP and pass it with `--file <export.json>`.
- If you already logged an issue/day by hand, that row is shown as `skip` and nothing is created. Pass `--include-manual` to log it anyway.
- Time on tasks with no Redmine issue is shown as "not synced" and is not logged.
- If SP's time for an issue drops to 0, the existing `[sp]` entry is reported as `stale`. It is **not** deleted.
