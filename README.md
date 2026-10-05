# sp2redmine

Logs the time you track in **Super Productivity** to **Redmine**: one time entry per issue per day.

```
Super Productivity task  "#1000201 Checkout API development"   4h 31m on Oct 4
                       ↓  sp2redmine
Redmine time entry      issue #1000201 · 2026-10-04 · 4.51h · Development · comment "[sp]"
```

There's nothing to configure: the Redmine URL and API key come from your SP Redmine integration.

---

## 1. Setup (once)

```
cd sp2redmine
npm link
```

Now `sp2redmine` works from any folder.

---

## 2. End of the day: log today

```
$ sp2redmine
```
```
Date       Issue     Task                                    SP h   RM h  Action     Activity
2026-10-04 #1000201  Checkout API development …              4.51      -  create     Development
2026-10-04 #10000310 Daily standup                           0.92      -  create     Meeting
2026-10-04 #10000425 Fix date picker timezone bug…           0.56      -  create     ?
                                                             5.99  (2026-10-04 total)

Apply 3 change(s)? [y = yes · a = one activity for all · e = choose per entry · N = abort] y

  1 entry needs an activity:

  2026-10-04 #10000425 Fix date picker timezone bug… 0.56h
    1) Support  2) Development  3) Meeting  4) Analysis  5) Code review  6) Bug fixing
    Activity [number, name or ?]: 5

  created  2026-10-04 #1000201 4.51h  Development  (entry 51231)
  created  2026-10-04 #10000310 0.92h  Meeting  (entry 51232)
  created  2026-10-04 #10000425 0.56h  Code review  (entry 51233)
```

- Activities already filled in come from what you used on that issue before.
- `?` means the tool has no guess yet. With `y`, you're asked only about those rows.
- Your choice is saved, so next time that issue is filled in for you.

---

## 3. You kept working after logging

Run it again. Only what changed is touched:

```
$ sp2redmine
2026-10-04 #1000201  Checkout API …           5.10   4.51  update     
2026-10-04 #10000310 Daily standup            0.92   0.92  unchanged  

Apply 1 change(s)? [y/N] y
  updated  2026-10-04 #1000201 5.10h  (entry 51231, was 4.51h)
```

Run it as often as you like. It never creates a second entry for the same issue/day.

> SP refreshes its backup every few minutes. If a number looks old, wait a bit (the `SP data: … (saved 5:42 PM)` line tells you how fresh it is).

---

## 4. You forgot yesterday (or the whole week)

```
$ sp2redmine --date 2026-10-04
$ sp2redmine --from 2026-09-27 --to 2026-10-01
$ sp2redmine --from 2026-09-27          # Sep 27 → today
```

---

## 5. Just look, don't touch

```
$ sp2redmine --from 2026-09-27 --dry-run
...
Dry run: 7 change(s) not applied.
```

---

## 6. You already logged that day by hand

```
2026-09-30 #1000201  Checkout API …           5.38      -  skip       logged manually: 5.37h
```

`skip` means you already logged it in Redmine yourself, so nothing is created.
To log it anyway (you'll end up with two entries):

```
$ sp2redmine --date 2026-09-30 --include-manual
```

If you see `create … ! logged manually: 2h`, the tool will add on top of your manual entry. Check before saying `y`.

---

## 7. Choosing activities

**Same activity for everything today:** answer `a`.

```
Apply 6 change(s)? [...] a
  Activity for all new entries:
    1) Support  2) Development  3) Meeting ...
    Activity [number, name or ?]: dev
```

**Go through each entry** (e.g. to fix a wrong guess): answer `e`. Press Enter to keep what's shown.

```
Apply 6 change(s)? [...] e

  2026-10-04 #1000201 Checkout API development 4.51h
    Activity [Enter = Development]:            ← keep
  2026-10-04 #10000308 Sprint planning 0.08h
    Activity [Enter = Development]: meeting    ← change (remembered for #10000308)
```

**What you can type in the picker:**

| You type        | You get                                  |
|-----------------|------------------------------------------|
| *(Enter)*       | the activity shown in `[Enter = …]`      |
| `3`             | item 3 of the short list                 |
| `meeting`       | Meeting                                  |
| `code rev`      | Code review (the start of a name is enough) |
| `code`          | asks again: matches Code review, Code Support, … |
| `37`            | activity with id 37                      |
| `?`             | the full list with ids                   |

**Skip the picker entirely:**

```
$ sp2redmine --activity Development              # this run only
$ sp2redmine --activity Development --save-activity   # fallback for issues with no history
```

---

## 8. Time that isn't on a Redmine issue

```
(not synced, no Redmine issue: 2026-10-04 1.2h)
```

SP tasks like "Reading" or "Side project" have no Redmine issue, so they're only counted, never logged.

---

## 9. You removed time in SP after logging it

```
2026-10-04 #10000308 (no SP time any more — not deleted)   0.00   0.08  stale
```

The tool never deletes anything. Delete the entry in Redmine yourself if you want it gone.

---

## 10. No questions asked (scripts, scheduled task)

```
$ sp2redmine -y
```

This applies everything without prompting. If any new entry has no known activity, it stops and changes nothing:

```
Error: 2 new entries have no activity. Run without -y to choose, or pass --activity.
```

---

## 11. Use an SP export instead of the auto backup

Export your data from SP's settings (a `.json` file), then:

```
$ sp2redmine --file C:\Users\me\Downloads\super-productivity-backup.json
```

---

## Cheat sheet

| Command                                   | Does                                   |
|-------------------------------------------|----------------------------------------|
| `sp2redmine`                              | today: preview, then ask               |
| `sp2redmine --date 2026-10-04`            | one day                                |
| `sp2redmine --from 2026-09-27 [--to …]`   | range (to = today if omitted)          |
| `sp2redmine --dry-run`                    | preview only                           |
| `sp2redmine -y`                           | apply without asking                   |
| `sp2redmine --activity <name\|id>`        | one activity for all new entries       |
| `… --save-activity`                       | remember `--activity` as the fallback  |
| `sp2redmine --include-manual`             | log days you already logged by hand    |
| `sp2redmine --file <export.json>`         | read this file instead of the backup   |
| `sp2redmine --host <url>`                 | another Redmine (key from `REDMINE_API_KEY`) |

**Action column:** `create` new entry · `update` hours changed · `unchanged` nothing to do · `skip` logged by hand · `stale` no SP time any more (not deleted)

**Files:**
- `%APPDATA%\superProductivity\backups\*.json`: what the tool reads (newest file)
- `~/.sp2redmine.json`: your remembered activities, per issue:
  ```json
  { "issueActivities": { "1000201": 9, "10000310": 14 }, "activity": "Development" }
  ```
  Delete a line to make the tool ask again for that issue.
