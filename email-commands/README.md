# Email → website updater

Send a plain-English email to a special address and it adds/edits/removes
one or more shows in `shows.json`, commits it to GitHub, and GitHub Pages
redeploys automatically (same pipeline as pushing manually). `shows.html`
builds its show list from `shows.json` at load time, so editing the data file
is all that's needed — no HTML to touch.

Nothing runs on this laptop — it's a Google Apps Script that Google runs on a
timer, checking your Gmail every 10 minutes.

## How it works

1. You email `cloe.creativeworks+website@gmail.com` (a "+alias" of your normal
   Gmail — mail to it still lands in your regular inbox).
2. Every 10 minutes, a script checks for new mail sent **to that alias and
   from your own address** that it hasn't already handled (tracked via Gmail
   labels, not read/unread status — opening or starring the email doesn't
   affect anything). Anything else is ignored, so a stranger emailing that
   alias can't do anything.
3. The email body is sent to Gemini (Google's AI, free tier) with instructions
   to extract a list of structured commands (add/edit/remove + fields), one
   per distinct change in the email — Gemini never touches the JSON file
   directly, it only fills in a fixed form.
4. The script applies those commands one by one to the `shows.json` array (add
   an entry, change some fields on one, remove one) — skipping any that can't
   be applied — renumbers every show by date (earliest = `#1`), then commits
   the result straight to GitHub via the API in a **single commit**, and
   replies to you with what changed and what was skipped. Only if no command
   could be applied is nothing committed.

New/edited shows automatically land in the right place — the page sorts
shows by date into Upcoming/Past on every load, so you never need to say
which section something belongs in. The `#` badge follows date order too, so
adding a show between two existing dates renumbers the rest.

Each change is applied on its own: the ones that work get committed, and the
reply email lists any that were skipped (ambiguous, bad match, missing info)
so you can re-send just those. Only if **nothing** in the email works does
nothing get committed.

## Command examples

Just write like you're texting yourself. Examples:

- "Add a show: Craft Comedy at Two Three Comedy on Oct 3rd, 8pm."
- "Change the time for Craft Comedy on Sep 12 to 9pm."
- "Remove the Japanese Open Mic on Sep 5, it got cancelled."
- "Update Funny Women Taipei (Sep 4): venue is Legacy Taipei, https://maps.app.goo.gl/xyz"
- "Add a note to Taipei Comedy Live on Sep 26: opening for a touring comic."

One email can carry several changes — the ones that work are committed
together:

- "Bump Craft Comedy (Sep 12) to 9pm, cancel the Japanese Open Mic on Sep 5,
  and add a note to Taipei Comedy Live on Sep 26: opening for a touring comic."
- "Add two shows: Craft Comedy at Two Three on Oct 3 8pm, and Open Mic at
  Revolver on Oct 10 7:30pm."

You can also change **several shows at once** with a plural — each matching
show is updated separately:

- "Change the venue for both Japanese Open Mic shows to Riff Bar."
- "Add a note to all the Funny Women Taipei shows: 10 min set."

If one change in the email can't be done (ambiguous, no match, missing info)
the rest still go through, and the reply email lists what was skipped and why.

The one thing you can't do in a single email is add a show and then edit that
same just-added show in the same email — send that as two.

Good to include when adding a show: **name** and **date** are required
(everything else defaults to TBD or is left off). For edits/removes, identify
the show by **name + date** — that's what the script matches on, and it stays
valid even as numbers shift (see below). A `#N` still works if it's current,
but name + date is safer. If a single show can't be pinned down, you'll get an
email asking you to be specific about that one.

## One-time setup

### 1. GitHub token

1. Go to https://github.com/settings/tokens?type=beta → **Generate new token**.
2. Repository access → **Only select repositories** → `chloericeball/standup`.
3. Permissions → **Contents: Read and write**. Nothing else.
4. Generate, copy the token (starts `github_pat_...`) — you won't see it again.

### 2. Gemini API key (free tier)

1. Go to https://aistudio.google.com/apikey → **Create API key**.
2. Choose to create it in a new or existing Google Cloud project — no billing
   account or credit card is needed for the free tier.
3. Copy the key (starts `AIza...`).

Note: on the free tier, Google's terms allow them to use the content you send
(and the model's output) to improve their products. What you'd be sending
here is show logistics — name, date, venue, maybe a ticket link — not
sensitive data, but worth knowing. If you'd rather not have any data leave
Google's own sandbox at all, ask for the "strict format, no AI" version of
this script instead.

### 3. Apps Script project

1. Go to https://script.google.com → **New project**.
2. Name it "Website Email Commands".
3. Delete the placeholder `Code.gs` contents and paste in the contents of
   `email-commands/Code.gs` from this repo.
4. **Project Settings** (gear icon) → **Script Properties** → add:

   | Property | Value |
   |---|---|
   | `GITHUB_TOKEN` | the token from step 1 |
   | `GITHUB_REPO` | `chloericeball/standup` |
   | `GITHUB_FILE_PATH` | `shows.json` |
   | `GITHUB_BRANCH` | `main` |
   | `GEMINI_API_KEY` | the key from step 2 |
   | `TRUSTED_SENDER` | `cloe.creativeworks@gmail.com` |
   | `COMMAND_ALIAS` | `cloe.creativeworks+website@gmail.com` |

5. In the editor toolbar, select the function dropdown → `setup` → **Run**.
   The first run will prompt you to authorize the script (Gmail + external
   requests) — approve it. This creates the Gmail labels and the 10-minute
   trigger.
6. Select `testConnections` → **Run**. Check **Executions** (left sidebar) —
   it should log a successful GitHub read and a successful Gemini extraction
   (`{"commands":[...]}`), with no errors. This doesn't touch email or commit
   anything.

### 4. Try it

Email `cloe.creativeworks+website@gmail.com` from
`cloe.creativeworks@gmail.com` with something like:

> Add a show called Test Show at Test Venue on 2099-01-01, just testing.

Within 10 minutes you should get a reply confirming it was added, and see a
new commit on GitHub. Then send a follow-up to remove it:

> Remove the Test Show at Test Venue on 2099-01-01

## Notes / limits

- **Show numbers track date order.** After every change, all shows are
  renumbered by date (earliest = `#1`), so a show slotted between two existing
  dates takes the number in between and everything after it shifts up by one.
  The number is just the badge on the page — where a show lands (Upcoming vs.
  Past, and its order) is worked out from the date on every page load.
- Because numbers shift, **identify shows by name + date in your emails**, not
  by `#N`. Confirmation emails lead with name + date for the same reason. A
  `#N` you cite still works when it's current; it's only a fallback.
- Renumbering only rewrites the `number`/`color` of shows whose position
  actually changed — the rest of `shows.json` is untouched, so diffs stay
  small.
- Several changes in one email are applied independently: the ones that work
  are committed together in one commit, and the reply email lists any that
  were skipped (bad match, missing field, couldn't tell which show) so you
  can re-send just those. Nothing is committed only if *none* of them work.
  A skipped change is not retried automatically — re-send it.
- "Both" / "all" / plurals fan out: "change the venue for both Open Mics" or
  "add a note to all the Funny Women shows" updates each matching show
  separately. You only get asked to clarify when it genuinely can't tell
  which shows you mean.
- Edits change only the fields you mention on the matching show's JSON entry
  — everything else (including Instagram icon and YouTube video, if any) is
  left untouched.
- Instagram-icon links and YouTube video strips on a show aren't settable by
  email (rare, better done by hand or by asking Claude Code directly) — they
  just won't be present on shows added by email, which is fine since they're
  normally added after the fact anyway.
- Gemini's free tier has generous but real rate limits (per-minute and
  per-day request caps). A few emails a month is nowhere close to them; this
  would only matter if you started sending many commands in quick succession.
- The trigger runs every 10 minutes; there's no instant mode. If you need
  something applied right now, open the Apps Script project and run
  `processCommandEmails` manually.
- **The email script commits straight to GitHub — it never touches this
  laptop.** Your local clone will drift out of date any time a command runs.
  Run `git pull origin main` before doing any local work on this repo (e.g.
  editing `shows.html` by hand, or asking Claude Code to change something) so
  you're not working from a stale copy. Since the script only ever touches
  `shows.json`, this is normally a clean fast-forward with no conflicts.
