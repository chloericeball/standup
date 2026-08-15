# Email → website updater

Send a plain-English email to a special address and it adds/edits/removes a
show in `shows.json`, commits it to GitHub, and GitHub Pages redeploys
automatically (same pipeline as pushing manually). `shows.html` builds its
show list from `shows.json` at load time, so editing the data file is all
that's needed — no HTML to touch.

Nothing runs on this laptop — it's a Google Apps Script that Google runs on a
timer, checking your Gmail every 10 minutes.

## How it works

1. You email `cloe.creativeworks+website@gmail.com` (a "+alias" of your normal
   Gmail — mail to it still lands in your regular inbox).
2. Every 10 minutes, a script checks for new unread mail sent **to that alias
   and from your own address**. Anything else is ignored, so a stranger
   emailing that alias can't do anything.
3. The email body is sent to Gemini (Google's AI, free tier) with instructions
   to extract a structured command (add/edit/remove + fields) — Gemini never
   touches the JSON file directly, it only fills in a fixed form.
4. The script applies that command to the `shows.json` array (add an entry,
   change some fields on one, or remove one), commits straight to GitHub via
   the API, and replies to you confirming what changed (or explaining why it
   didn't do anything, if something didn't parse).

New/edited shows automatically land in the right place — the page sorts
shows by date into Upcoming/Past on every load, so you never need to say
which section something belongs in.

If anything is ambiguous or fails, **nothing is committed** — you just get an
email explaining why.

## Command examples

Just write like you're texting yourself. Examples:

- "Add a show: Craft Comedy at Two Three Comedy on Oct 3rd, 8pm."
- "Change the time for show #29 to 9pm."
- "Remove show #31, it got cancelled."
- "Update #28's venue to Legacy Taipei, https://maps.app.goo.gl/xyz"
- "Add a note to #30: opening for a touring comic."

Good to include when adding a show: **name** and **date** are required
(everything else defaults to TBD or is left off). For edits/removes, include
the **show number** (e.g. `#29`) if you know it — it's unambiguous. Without a
number, it'll try to match by name, and will ask you to clarify if more than
one show matches.

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
   it should log a successful GitHub read and a successful Gemini extraction,
   with no errors. This doesn't touch email or commit anything.

### 4. Try it

Email `cloe.creativeworks+website@gmail.com` from
`cloe.creativeworks@gmail.com` with something like:

> Add a show called Test Show at Test Venue on 2099-01-01, just testing.

Within 10 minutes you should get a reply confirming it was added, and see a
new commit on GitHub. Then send a follow-up to remove it:

> Remove the Test Show, #whatever number it got

## Notes / limits

- New shows are always numbered `max + 1`. Where they land on the page
  (Upcoming vs. Past, and their order) is worked out automatically from the
  date every time the page loads — you never need to specify that.
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
