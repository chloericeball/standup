/**
 * Email → website updater for chloericeball/standup (shows.json).
 *
 * Send a natural-language email to your command alias (see README) describing
 * a show to add, edit, or remove. This script reads it, asks Gemini to turn
 * it into a structured command, applies that command to the shows.json array
 * with plain array operations (never lets the model touch the file directly),
 * and commits the result to GitHub. shows.html renders itself from that file
 * at load time, so nothing else needs to change. You always get a reply
 * email confirming what happened, or explaining why nothing changed.
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

  if (command.action === 'unsupported' || command.clarification_needed) {
    throw new Error(command.clarification_needed || "Didn't recognize this as a show add/edit/remove request.");
  }

  let result;
  if (command.action === 'add_show') {
    result = addShow_(shows, command.fields || {});
  } else if (command.action === 'edit_show') {
    result = editShow_(shows, command);
  } else if (command.action === 'remove_show') {
    result = removeShow_(shows, command);
  } else {
    throw new Error('Unknown action: ' + command.action);
  }

  const newContent = JSON.stringify(result.shows, null, 2) + '\n';
  commitGithubFile_(props, newContent, file.sha, result.summary);

  const repo = props.getProperty('GITHUB_REPO');
  const branch = props.getProperty('GITHUB_BRANCH') || 'main';
  GmailApp.sendEmail(
    props.getProperty('TRUSTED_SENDER'),
    'Website updated: ' + result.summary,
    'Done.\n\n' + result.summary + '\n\n' +
    'Live site: https://chloericeball.github.io/standup/shows.html\n' +
    'Commit history: https://github.com/' + repo + '/commits/' + branch
  );
}

// ── Gemini: natural language → structured command ──────────────────────────
// Free tier (aistudio.google.com/apikey) — no billing needed. Gemini only
// ever fills in this fixed schema; it never sees or edits shows.json itself.

// gemini-2.0-flash was retired; Google's replacement is the Interactions API.
const GEMINI_MODEL = 'gemini-3.6-flash';

const COMMAND_SCHEMA = {
  type: 'object',
  properties: {
    action: { type: 'string', enum: ['add_show', 'edit_show', 'remove_show', 'unsupported'] },
    clarification_needed: {
      type: ['string', 'null'],
      description: 'Set (and leave other fields null) if required info is missing or the request is ambiguous. Otherwise null.'
    },
    target_show_number: { type: ['integer', 'null'], description: 'For edit_show/remove_show: the #N in the email, if given.' },
    target_match_name: { type: ['string', 'null'], description: 'For edit_show/remove_show without a number: show name to match.' },
    target_match_date: { type: ['string', 'null'], description: 'For edit_show/remove_show without a number: ISO date (YYYY-MM-DD) to help match.' },
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
  required: ['action', 'fields']
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
    '- add_show requires at minimum fields.name and a resolvable fields.date (absolute YYYY-MM-DD; relative dates like "next Friday" are fine to resolve using today\'s date). If name or a resolvable date is missing, set clarification_needed instead and leave action as add_show.\n' +
    '- edit_show and remove_show must identify a target. If you can confidently match the email to exactly one show in the list above (even if the wording does not exactly match, e.g. plural/singular or approximate name), set target_show_number to that show\'s exact number. Only use target_match_name/target_match_date instead when you cannot confidently pick a single number from the list. If the email could refer to more than one show in the list and you cannot tell which, set clarification_needed and list the matching numbers.\n' +
    '- Never invent venue names, URLs, or ticket links that are not stated or clearly implied in the email — leave those null rather than guessing.\n' +
    '- If the email is not a request to add/edit/remove a show, set action to "unsupported".\n' +
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
  command.fields = command.fields || {};
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
  if (command.target_show_number) {
    const show = shows.find(s => s.number === command.target_show_number);
    if (!show) throw new Error('Could not find show #' + command.target_show_number + '.');
    return show;
  }
  if (command.target_match_name) {
    const needle = command.target_match_name.toLowerCase();
    let candidates = shows.filter(s => s.name.toLowerCase().includes(needle));
    if (command.target_match_date) {
      const withDate = candidates.filter(s => s.date === command.target_match_date);
      if (withDate.length) candidates = withDate;
    }
    if (candidates.length === 1) return candidates[0];
    if (candidates.length === 0) throw new Error('Could not find a show matching "' + command.target_match_name + '".');
    const nums = candidates.map(s => '#' + s.number).join(', ');
    throw new Error('Found ' + candidates.length + ' shows matching "' + command.target_match_name + '" (' + nums + ') — please specify the show number.');
  }
  throw new Error('Could not tell which show to change — please include the show number (e.g. #29).');
}

function addShow_(shows, fields) {
  if (!fields.name || !fields.date) throw new Error('Missing show name or date.');
  const maxNumber = shows.reduce((max, s) => Math.max(max, s.number || 0), 0);
  const number = maxNumber + 1;
  const show = {
    number,
    color: ['coral', 'gold'][number % 2],
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
  const updated = shows.concat([show]);
  return { shows: updated, summary: 'Added #' + number + ' ' + show.name + ' (' + show.date + ')' };
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
  return { shows: shows, summary: 'Updated #' + target.number + ' (' + changed.join(', ') + ')' };
}

function removeShow_(shows, command) {
  const target = findTargetShow_(shows, command);
  const updated = shows.filter(s => s !== target);
  return { shows: updated, summary: 'Removed #' + target.number + ' ' + target.name };
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
