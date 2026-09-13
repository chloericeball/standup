/**
 * Email → website updater for chloericeball/standup (shows.json).
 *
 * Send a natural-language email to your command alias (see README) describing
 * one or more shows to add, edit, or remove. This script reads it, asks Gemini
 * to turn it into a list of structured commands, applies each one to the
 * shows.json array with plain array operations (never lets the model touch the
 * file directly), and commits the result to GitHub in a single commit. Commands
 * are applied independently: the ones that work are committed together, and the
 * reply email lists any that were skipped (bad match, missing field, ambiguous)
 * so you can re-send just those. Only if none of them work is nothing committed.
 * Show numbers are reassigned by date on every change (earliest = #1), so
 * slotting a show between two existing dates renumbers the rest. shows.html
 * renders itself from that file at load time, so nothing else needs to change.
 * You always get a reply email confirming what happened, or explaining why
 * nothing changed.
 *
 * Setup: see README.md in this folder.
 */

const LABEL_DONE = 'Website-Update/Processed';
const LABEL_FAILED = 'Website-Update/Failed';

// ── Entry point (run on a time-driven trigger) ─────────────────────────────

function processCommandEmails() {
  const props = PropertiesService.getScriptProperties();
  const trustedSender = requireProp_(props, 'TRUSTED_SENDER');
  const alias = requireProp_(props, 'COMMAND_ALIAS');

  ensureLabels_();
  const doneLabel = GmailApp.getUserLabelByName(LABEL_DONE);
  const failedLabel = GmailApp.getUserLabelByName(LABEL_FAILED);

  // Already-labeled threads (handled by a previous run) are excluded here, so
  // this doesn't depend on read/unread status at all — opening or starring
  // the email has no effect on whether it gets (re)processed.
  const query = 'to:(' + alias + ') from:(' + trustedSender + ') newer_than:7d ' +
    '-label:' + LABEL_DONE + ' -label:' + LABEL_FAILED;
  const threads = GmailApp.search(query, 0, 20);

  threads.forEach(thread => {
    thread.getMessages().forEach(message => {
      try {
        handleMessage_(message, props);
        message.markRead();
        thread.addLabel(doneLabel);
      } catch (err) {
        message.markRead();
        thread.addLabel(failedLabel);
        GmailApp.sendEmail(
          trustedSender,
          'Website update NOT applied',
          'Your command could not be applied, so nothing changed on the site.\n\n' +
          'Reason: ' + err.message + '\n\n' +
          '---\nYour message:\n' + message.getPlainBody().slice(0, 1000)
        );
      }
    });
  });
}

function handleMessage_(message, props) {
  const body = message.getPlainBody().trim();
  if (!body) throw new Error('Empty email body.');

  const file = getGithubFile_(props);
  const shows = JSON.parse(file.content);

  const command = extractCommand_(body, props, shows);

  const commands = command.commands || [];
  const clarification = command.clarification_needed;

  if (!commands.length) {
    throw new Error(clarification || "Didn't recognize this as a show add/edit/remove request.");
  }

  // Apply each command independently. A command that throws (bad match,
  // missing field) is recorded and skipped — the others still go through.
  let working = shows;
  const ops = [];
  const failures = [];
  commands.forEach(c => {
    try {
      let result;
      if (c.action === 'add_show') {
        result = addShow_(working, c.fields || {});
      } else if (c.action === 'edit_show') {
        result = editShow_(working, c);
      } else if (c.action === 'remove_show') {
        result = removeShow_(working, c);
      } else {
        throw new Error('Unknown action: ' + c.action);
      }
      working = result.shows;
      ops.push(result);
    } catch (err) {
      failures.push({ command: c, message: err.message });
    }
  });

  // Everything left undone: commands that failed to apply, plus anything
  // Gemini couldn't turn into a command in the first place.
  const skipped = failures.map(f => '- ' + describeCommandTarget_(f.command) + ': ' + f.message);
  if (clarification) skipped.push('- ' + clarification);

  if (!ops.length) {
    // Nothing applied — leave the thread as Failed and list every reason.
    throw new Error('None of the changes could be applied:\n' + skipped.join('\n'));
  }

  // Renumber every show by date (earliest = #1) so a show slotted between two
  // existing dates pushes the rest up, and recompute the coral/gold stripe.
  // Done once, after all commands, so any number the sender cited in the
  // email still refers to the show they were looking at.
  working = renumberByDate_(working);

  const summary = ops.map(describeOp_).join('; ');
  const newContent = JSON.stringify(working, null, 2) + '\n';
  commitGithubFile_(props, newContent, file.sha, summary);

  const skippedBlock = skipped.length
    ? '\n\nNot applied (left unchanged) — re-send these on their own:\n' + skipped.join('\n')
    : '';

  const repo = props.getProperty('GITHUB_REPO');
  const branch = props.getProperty('GITHUB_BRANCH') || 'main';
  GmailApp.sendEmail(
    props.getProperty('TRUSTED_SENDER'),
    'Website updated: ' + summary,
    'Done.\n\n' + summary + skippedBlock + '\n\n' +
    'The "#" is the current position by date and can shift when an earlier ' +
    'show is added — to change a show later, name it and give its date.\n\n' +
    'Live site: https://chloericeball.github.io/standup/shows.html\n' +
    'Commit history: https://github.com/' + repo + '/commits/' + branch
  );
}

// Describe one applied op for the commit message / confirmation email. Leads
// with name + date (stable) rather than the number (shifts on renumber).
function describeOp_(op) {
  if (op.kind === 'add') {
    return 'Added "' + op.show.name + '" (' + op.show.date + ') — now #' + op.show.number;
  }
  if (op.kind === 'edit') {
    return 'Updated "' + op.show.name + '" (' + op.show.date + ') [' +
      op.changed.join(', ') + '] — now #' + op.show.number;
  }
  return 'Removed "' + op.removed.name + '" (' + op.removed.date + ')';
}

// Describe an *attempted* command, for explaining what was skipped.
function describeCommandTarget_(c) {
  if (c.action === 'add_show') {
    const f = c.fields || {};
    return 'add "' + (f.name || '(unnamed)') + '"' + (f.date ? ' (' + f.date + ')' : '');
  }
  const verb = c.action === 'remove_show' ? 'remove ' : 'edit ';
  if (c.target_match_name) {
    return verb + '"' + c.target_match_name + '"' +
      (c.target_match_date ? ' (' + c.target_match_date + ')' : '');
  }
  if (c.target_show_number) return verb + '#' + c.target_show_number;
  return verb + '(unspecified show)';
}

// ── Gemini: natural language → structured command ──────────────────────────
// Free tier (aistudio.google.com/apikey) — no billing needed. Gemini only
// ever fills in this fixed schema; it never sees or edits shows.json itself.

// gemini-2.0-flash was retired; Google's replacement is the Interactions API.
const GEMINI_MODEL = 'gemini-3.6-flash';

const COMMAND_SCHEMA = {
  type: 'object',
  properties: {
    clarification_needed: {
      type: ['string', 'null'],
      description: 'A short note about any part of the email you could NOT turn into a command (a show added with no name/resolvable date, or a change where you cannot tell which show is meant). Set it ALONGSIDE whatever commands you can still produce — do not leave commands empty just because one part is unclear. Null if everything parsed.'
    },
    commands: {
      type: 'array',
      description: 'One entry per distinct show add/edit/remove requested in the email; expand "both"/"all"/plurals into one entry per matching show. Empty only if nothing in the email is actionable.',
      items: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['add_show', 'edit_show', 'remove_show'] },
          target_match_name: { type: ['string', 'null'], description: 'For edit_show/remove_show: the show name exactly as it appears in the list above. Primary way to identify the target.' },
          target_match_date: { type: ['string', 'null'], description: 'For edit_show/remove_show: the target show\'s date (YYYY-MM-DD) from the list above. Always set this alongside target_match_name.' },
          target_show_number: { type: ['integer', 'null'], description: 'For edit_show/remove_show: only when the email explicitly cites a #N. Site numbers renumber by date when an earlier show is added, so this is a fallback, not the primary handle.' },
          fields: {
            type: 'object',
            properties: {
              name: { type: ['string', 'null'] },
              date: { type: ['string', 'null'], description: 'ISO YYYY-MM-DD' },
              time: { type: ['string', 'null'], description: 'Display text, e.g. "8:00 PM" or "TBD"' },
              venueName: { type: ['string', 'null'] },
              venueUrl: { type: ['string', 'null'], description: 'Google Maps link or similar, only if stated' },
              ticketUrl: { type: ['string', 'null'] },
              notes: { type: ['array', 'null'], items: { type: 'string' } }
            }
          }
        },
        required: ['action']
      }
    }
  },
  required: ['commands']
};

function extractCommand_(body, props, shows) {
  const apiKey = requireProp_(props, 'GEMINI_API_KEY');

  const listing = (shows || [])
    .map(function(s) { return '#' + s.number + ': ' + s.name + ' (' + s.date + ')'; })
    .join('\n');

  const today = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd');
  const system =
    'You convert a personal email into a structured command for updating a standup comedy show-listing webpage.\n' +
    'Here is the current list of shows on the site, as "#number: name (date)":\n' +
    listing + '\n\n' +
    'Rules:\n' +
    '- One email may ask for several changes. Put one entry in "commands" per distinct show being added, edited, or removed, in the order the email presents them. The changes are applied independently, so still emit the commands you are sure about even if another part of the email is unclear.\n' +
    '- If the email deliberately targets several shows at once ("both", "all", "every X show", or a plural like "the Tuesday shows"), expand it into one command per matching show, each pinned to that show\'s own target_match_date (and target_show_number if the email gives one). Do NOT ask for clarification merely because more than one show matches — only when you genuinely cannot tell which shows are meant.\n' +
    '- add_show requires at minimum fields.name and a resolvable fields.date (absolute YYYY-MM-DD; relative dates like "next Friday" are fine to resolve using today\'s date). If a show being added lacks a name or resolvable date, describe it in clarification_needed instead of emitting an add_show for it.\n' +
    '- edit_show and remove_show must identify a target. Identify it by setting BOTH target_match_name (the show name exactly as it appears in the list above) AND target_match_date (that show\'s YYYY-MM-DD from the list), matching even if the email\'s wording is approximate (plural/singular, partial name). Additionally set target_show_number only if the email explicitly cites a #N. Site show numbers renumber by date whenever an earlier show is added, so name+date is the reliable handle. If one change could refer to more than one show and you cannot tell which, describe just that change in clarification_needed and still emit the other commands.\n' +
    '- Do not chain commands that depend on each other within one email (e.g. adding a show and then editing that same just-added show) — describe that in clarification_needed instead.\n' +
    '- Never invent venue names, URLs, or ticket links that are not stated or clearly implied in the email — leave those null rather than guessing.\n' +
    '- If the email is not a request to add/edit/remove any show, return an empty commands array and leave clarification_needed null.\n' +
    '- Today\'s date is ' + today + ' (Asia/Taipei), for resolving relative dates.';

  const url = 'https://generativelanguage.googleapis.com/v1beta/interactions?key=' + apiKey;
  const resp = UrlFetchApp.fetch(url, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify({
      model: GEMINI_MODEL,
      input: body,
      system_instruction: system,
      response_format: COMMAND_SCHEMA
    }),
    muteHttpExceptions: true
  });

  const data = JSON.parse(resp.getContentText());
  if (resp.getResponseCode() !== 200) {
    throw new Error('Gemini API error: ' + (data.error ? data.error.message : resp.getContentText()));
  }
  const steps = data.steps || [];
  const outputStep = steps.find(s => s.type === 'model_output') || steps[steps.length - 1];
  const textPart = outputStep && (outputStep.content || []).find(c => c.type === 'text');
  const text = textPart && textPart.text;
  if (!text) throw new Error('Model did not return a structured command. Raw response: ' + resp.getContentText().slice(0, 500));
  const command = JSON.parse(text);
  command.commands = command.commands || [];
  command.commands.forEach(c => { c.fields = c.fields || {}; });
  return command;
}

// ── GitHub: read + commit shows.json ────────────────────────────────────

function getGithubFile_(props) {
  const repo = requireProp_(props, 'GITHUB_REPO');
  const path = requireProp_(props, 'GITHUB_FILE_PATH');
  const branch = props.getProperty('GITHUB_BRANCH') || 'main';
  const url = 'https://api.github.com/repos/' + repo + '/contents/' + path + '?ref=' + branch;
  const resp = UrlFetchApp.fetch(url, {
    headers: {
      Authorization: 'Bearer ' + requireProp_(props, 'GITHUB_TOKEN'),
      Accept: 'application/vnd.github+json'
    },
    muteHttpExceptions: true
  });
  const data = JSON.parse(resp.getContentText());
  if (resp.getResponseCode() !== 200) throw new Error('GitHub read failed: ' + resp.getContentText());
  const content = Utilities.newBlob(Utilities.base64Decode(data.content.replace(/\n/g, ''))).getDataAsString('UTF-8');
  return { sha: data.sha, content };
}

function commitGithubFile_(props, newContent, sha, message) {
  const repo = requireProp_(props, 'GITHUB_REPO');
  const path = requireProp_(props, 'GITHUB_FILE_PATH');
  const branch = props.getProperty('GITHUB_BRANCH') || 'main';
  const url = 'https://api.github.com/repos/' + repo + '/contents/' + path;
  const encoded = Utilities.base64Encode(Utilities.newBlob(newContent, 'application/json').getBytes());
  const resp = UrlFetchApp.fetch(url, {
    method: 'put',
    contentType: 'application/json',
    headers: {
      Authorization: 'Bearer ' + requireProp_(props, 'GITHUB_TOKEN'),
      Accept: 'application/vnd.github+json'
    },
    payload: JSON.stringify({
      message: 'Website update via email: ' + message,
      content: encoded,
      sha: sha,
      branch: branch
    }),
    muteHttpExceptions: true
  });
  if (resp.getResponseCode() !== 200) throw new Error('GitHub commit failed: ' + resp.getContentText());
}

// ── shows.json editing (plain array operations) ────────────────────────────

function findTargetShow_(shows, command) {
  const byNumber = command.target_show_number
    ? shows.find(s => s.number === command.target_show_number)
    : null;

  let byName = null;
  if (command.target_match_name) {
    const needle = command.target_match_name.toLowerCase();
    byName = shows.filter(s => s.name.toLowerCase().includes(needle));
    if (command.target_match_date) {
      const withDate = byName.filter(s => s.date === command.target_match_date);
      if (withDate.length) byName = withDate;
    }
  }

  // Prefer the name/date match — it survives renumbering. The number is only a
  // fallback, and a tie-breaker when a name matches more than one show.
  if (byName && byName.length === 1) return byName[0];
  if (byName && byName.length > 1) {
    if (byNumber && byName.indexOf(byNumber) !== -1) return byNumber;
    const found = byName.map(s => '"' + s.name + '" (' + s.date + ')').join(', ');
    throw new Error('More than one show matches "' + command.target_match_name +
      '": ' + found + ' — please give the exact name and date.');
  }

  if (byNumber) return byNumber;

  if (command.target_show_number) {
    throw new Error('Could not find show #' + command.target_show_number +
      '. Numbers shift when an earlier show is added — try the show name and date.');
  }
  if (command.target_match_name) {
    throw new Error('Could not find a show matching "' + command.target_match_name + '".');
  }
  throw new Error('Could not tell which show to change — include the show name and date.');
}

function addShow_(shows, fields) {
  if (!fields.name || !fields.date) throw new Error('Missing show name or date.');
  // number/color are placeholders; renumberByDate_ sets the real values once
  // all commands in the email have been applied.
  const show = {
    number: 0,
    color: 'coral',
    name: fields.name,
    instagram: null,
    date: fields.date,
    time: fields.time || null,
    venueName: fields.venueName || 'TBD',
    venueUrl: fields.venueUrl || null,
    ticketUrl: fields.ticketUrl || null,
    notes: fields.notes || [],
    video: null
  };
  return { shows: shows.concat([show]), kind: 'add', show: show };
}

function editShow_(shows, command) {
  const target = findTargetShow_(shows, command);
  const f = command.fields || {};
  const changed = [];
  ['name', 'date', 'time', 'venueName', 'venueUrl', 'ticketUrl', 'notes'].forEach(key => {
    if (f[key] !== undefined && f[key] !== null) {
      target[key] = f[key];
      changed.push(key);
    }
  });
  if (!changed.length) throw new Error('Nothing to change was specified.');
  return { shows: shows, kind: 'edit', show: target, changed: changed };
}

function removeShow_(shows, command) {
  const target = findTargetShow_(shows, command);
  return {
    shows: shows.filter(s => s !== target),
    kind: 'remove',
    removed: { name: target.name, date: target.date }
  };
}

/**
 * Sort every show by date (earliest = #1), reassigning number and the
 * coral/gold stripe to match. Returns a new array in that order, so
 * shows.json is stored chronologically too — not just as rendered by
 * shows.html, which re-sorts by date on load regardless. Undated shows sort
 * last.
 */
function renumberByDate_(shows) {
  const sorted = shows.slice().sort((a, b) => {
    const da = a.date || '9999-12-31';
    const db = b.date || '9999-12-31';
    return da < db ? -1 : da > db ? 1 : 0;
  });
  sorted.forEach((s, i) => {
    s.number = i + 1;
    s.color = ['coral', 'gold'][(i + 1) % 2];
  });
  return sorted;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function requireProp_(props, key) {
  const v = props.getProperty(key);
  if (!v) throw new Error('Missing script property: ' + key + '. Set it in Project Settings > Script Properties.');
  return v;
}

function ensureLabels_() {
  [LABEL_DONE, LABEL_FAILED].forEach(name => {
    if (!GmailApp.getUserLabelByName(name)) GmailApp.createLabel(name);
  });
}

// ── One-time setup helpers (run manually from the Apps Script editor) ─────

/** Run once after filling in Script Properties, to create labels + trigger. */
function setup() {
  ensureLabels_();
  recreateTrigger_();
  Logger.log('Setup complete. Send a test command email, then wait for the trigger (or run processCommandEmails manually).');
}

function recreateTrigger_() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'processCommandEmails')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('processCommandEmails').timeBased().everyMinutes(10).create();
}

/** Run manually to sanity-check GitHub + Gemini credentials without touching any email. */
function testConnections() {
  const props = PropertiesService.getScriptProperties();
  const file = getGithubFile_(props);
  const shows = JSON.parse(file.content);
  Logger.log('GitHub read OK, shows.json has %s shows, sha %s', shows.length, file.sha);

  const command = extractCommand_('Add a show called Test Show on 2099-01-01, no venue yet.', props, shows);
  Logger.log('Gemini extraction OK: %s', JSON.stringify(command));
}
