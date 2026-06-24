const express = require('express');
const path = require('path');
const { Client } = require('@notionhq/client');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
app.use(express.json());
const crypto = require('crypto');

// ---- AUTH (set COCKPIT_PASSWORD in Render env to activate) ----
const PASS = process.env.COCKPIT_PASSWORD || '';
const SECRET = crypto.createHash('sha256').update('ck|' + PASS + '|' + (process.env.NOTION_TOKEN || '')).digest('hex');
const sign = () => crypto.createHmac('sha256', SECRET).update('ok').digest('hex');
const getCookie = (req, k) => (req.headers.cookie || '').split(';').map(c => c.trim().split('=')).find(([n]) => n === k)?.[1];
const isAuthed = (req) => !PASS || getCookie(req, 'cockpit_auth') === sign();

const LOGIN_HTML = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:-apple-system,sans-serif;background:#0f1115;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0"><form method="POST" action="/login" style="text-align:center"><h2 style="margin-bottom:4px">Outreach Cockpit</h2><p style="color:#888;margin-top:0">Enter password</p><input type="password" name="password" autofocus style="padding:12px;font-size:16px;border-radius:8px;border:1px solid #333;background:#1a1d24;color:#eee;width:220px"><br><button style="margin-top:12px;padding:12px 32px;font-size:16px;border-radius:8px;border:0;background:#3b82f6;color:#fff">Enter</button></form></body>`;

app.use(express.urlencoded({ extended: false }));
app.post('/login', (req, res) => {
  if (PASS && req.body.password === PASS) {
    res.setHeader('Set-Cookie', `cockpit_auth=${sign()}; HttpOnly; Secure; SameSite=Lax; Max-Age=31536000; Path=/`);
    return res.redirect('/');
  }
  res.status(401).send(LOGIN_HTML);
});
app.use((req, res, next) => { if (isAuthed(req)) return next(); res.status(401).send(LOGIN_HTML); });
// ---- END AUTH ----

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const notion = new Client({ auth: process.env.NOTION_TOKEN });
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const DB = process.env.NOTION_DATABASE_ID;
const today = () => new Date().toISOString().slice(0, 10);

const txt = (rt) => (rt || []).map(t => t.plain_text).join('');
function mapPage(p) {
  const x = p.properties;
  return {
    id: p.id,
    created: p.created_time,
    name: txt(x['Name']?.title),
    lane: x['Lane']?.select?.name || '',
    stage: x['Stage']?.select?.name || '',
    warmth: x['Warmth']?.select?.name || '',
    amount: x['$ Potential']?.number ?? null,
    nextStep: txt(x['Next Step']?.rich_text),
    nextTouch: x['Next Touch']?.date?.start || null,
    lastContact: x['Last Contact']?.date?.start || null,
    notes: txt(x['Notes']?.rich_text),
    phone: x['Phone']?.phone_number || '',
    source: x['Source']?.select?.name || '',
    response: x['Response']?.select?.name || '',
    community: (x['Community']?.multi_select || []).map(s => s.name).join(', '),
    email: x['Email']?.email || ''
  };
}

async function queryDue() {
  const res = await notion.databases.query({
    database_id: DB,
    filter: { and: [
      { property: 'Next Touch', date: { on_or_before: today() } },
      { property: 'Stage', select: { does_not_equal: 'Won' } },
      { property: 'Stage', select: { does_not_equal: 'Not Now' } }
    ]},
    sorts: [
      { property: 'Warmth', direction: 'ascending' },
      { property: '$ Potential', direction: 'descending' }
    ],
    page_size: 100
  });
  let results = res.results, cursor = res.next_cursor;
  while (cursor) {
    const more = await notion.databases.query({ database_id: DB, filter: { and: [
      { property: 'Next Touch', date: { on_or_before: today() } },
      { property: 'Stage', select: { does_not_equal: 'Won' } },
      { property: 'Stage', select: { does_not_equal: 'Not Now' } }
    ]}, start_cursor: cursor, page_size: 100 });
    results = results.concat(more.results); cursor = more.next_cursor;
  }
  return results.map(mapPage);
}

// ---- PRIORITY ENGINE (The Board, in code) ----
function daysAgo(d) { return d ? Math.floor((Date.now() - new Date(d)) / 864e5) : null; }
function classify(o) {
  const booked = /booked/i.test(o.nextStep || '');
  const la = daysAgo(o.lastContact);
  if (booked && o.nextTouch === today()) return 'today';
  if (booked && o.nextTouch < today()) return 'owe';      // booked date passed — close the loop
  if (o.response === 'Positive') return 'owe';            // they engaged, ball in your court
  if (o.response === 'Awaiting') return 'nudge';
  if (la === null && (o.source === 'Austin' || o.source === 'Community')) return 'fresh';
  if ((la === null || la >= 14) && (o.warmth === 'Hot' || (o.amount || 0) >= 100000)) return 'dark';
  return 'due';
}
const wW = { Hot: 3, Warm: 2, Cold: 1 };
const STAGE_W = { 'Open + Fund': 50, 'Transition': 50, 'Allocation': 45, 'Structuring': 40, 'Stress Test': 35, 'Due Diligence': 35, 'Enrollment Conversation': 30, 'Intro Made': 25, 'John Conversation': 22, 'Track-Record Review': 22, 'Statements + Intro to John': 20, 'Discovery Call': 12, 'Active': 15, 'Exploring': 10, 'Qualify': 8, 'Identified': 6, 'Intro/Reconnect': 5 };
const score = o => (STAGE_W[o.stage] || 0) * 1e7 + (wW[o.warmth] || 0) * 1e6 + (o.amount || 0);
const SECTIONS = [
  ['today', "📅 Today's calls", 'Booked — prep, show up'],
  ['owe',   '🔴 You owe a move', 'They engaged or a loop is open — nothing scheduled. Clear these first.'],
  ['nudge', '🟡 Awaiting reply', 'You reached out; ball is theirs. Nudge if 2+ days quiet.'],
  ['fresh', '🌅 Fresh — first touch', 'Met recently, never touched. Decays in days.'],
  ['dark',  '🌑 Going dark', 'Real money or heat, 14+ days quiet. Rescue or release.'],
  ['due',   '⚪ Also due', 'The rest of the due list, by weight.']
];
app.get('/api/board', async (req, res) => {
  try {
    const all = await queryDue();
    const by = {}; for (const o of all) (by[classify(o)] = by[classify(o)] || []).push(o);
    for (const k in by) by[k].sort((a, b) => score(b) - score(a));
    const live = (by.today||[]).length + (by.owe||[]).length + (by.nudge||[]).length + (by.fresh||[]).length;
    const verdict = (by.owe||[]).length + (by.fresh||[]).length > 20
      ? `Over capacity — ${ (by.owe||[]).length } owed. Clear 🔴 first. Open nothing new.`
      : live < 8 ? 'Capacity open — pull from the reservoir.' : `Work top to bottom. ${live} live loops.`;
    res.json({ verdict, total: all.length, sections: SECTIONS.map(([key, title, hint]) => ({ key, title, hint, items: by[key] || [] })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// ---- END PRIORITY ENGINE ----

// ---- FUNNEL / SCOREBOARD (all active, grouped lane x stage) ----
const LANE_PATHS = {
  'PM Retail': ['Intro/Reconnect', 'Discovery Call', 'Statements + Intro to John', 'Stress Test', 'Open + Fund', 'Won'],
  'Advisor Recruit': ['Qualify', 'John Conversation', 'Due Diligence', 'Transition', 'Won'],
  'AIM Allocation': ['Intro/Reconnect', 'Track-Record Review', 'Allocation', 'Won'],
  'Coaching': ['Exploring', 'Enrollment Conversation', 'Active', 'Won'],
  'Partnership/JV': ['Exploring', 'Structuring', 'Active', 'Won'],
  'Referral': ['Identified', 'Intro Made', 'Won'],
  'Connector/JV': ['Intro/Reconnect', 'Active', 'Won']
};
let funnelCache = { t: 0, data: null };
app.get('/api/funnel', async (req, res) => {
  try {
    if (funnelCache.data && Date.now() - funnelCache.t < 180e3) return res.json(funnelCache.data);
    let results = [], cursor = undefined;
    do {
      const r = await notion.databases.query({ database_id: DB,
        filter: { property: 'Stage', select: { does_not_equal: 'Not Now' } },
        start_cursor: cursor, page_size: 100 });
      results = results.concat(r.results); cursor = r.next_cursor;
    } while (cursor);
    const all = results.map(mapPage);
    const lanes = {};
    for (const o of all) {
      const lane = o.lane || 'Unsorted';
      const L = lanes[lane] = lanes[lane] || { lane, count: 0, dollars: 0, won: 0, wonDollars: 0, stages: {}, people: {} };
      L.count++; L.dollars += o.amount || 0;
      if (o.stage === 'Won' || o.stage === 'Active') { L.won++; L.wonDollars += o.amount || 0; }
      const st = o.stage || '—';
      L.stages[st] = L.stages[st] || { count: 0, dollars: 0 };
      L.stages[st].count++; L.stages[st].dollars += o.amount || 0;
      (L.people[st] = L.people[st] || []).push({ id: o.id, name: o.name, amount: o.amount, warmth: o.warmth, nextStep: o.nextStep, notes: o.notes, nextTouch: o.nextTouch, lastContact: o.lastContact, phone: o.phone });
    }
    for (const k in lanes) for (const st in lanes[k].people) lanes[k].people[st].sort((a,b)=>(b.amount||0)-(a.amount||0));
    const wk = Date.now() - 7 * 864e5;
    let entered = 0, enteredD = 0, bookedAhead = 0;
    for (const o of all) {
      if (o.created && new Date(o.created) > wk) { entered++; enteredD += o.amount || 0; }
      if (/booked/i.test(o.nextStep || '') && o.nextTouch >= today()) bookedAhead++;
    }
    let read = '';
    const pm = lanes['PM Retail'];
    if (pm) {
      const path = LANE_PATHS['PM Retail'];
      let bi = -1, bd = 0;
      path.forEach((st, i) => { const c = pm.stages[st]; if (c && c.dollars > bd && st !== 'Won') { bd = c.dollars; bi = i; } });
      if (bi >= 0 && bd > 0) {
        const nxt = path[bi + 1];
        const nc = (pm.stages[nxt] || {}).count || 0;
        if (nxt && nxt !== 'Won' && nc === 0) read = `$${Math.round(bd/1000)}K massed at ${path[bi]}, nothing at ${nxt} — that's the week's strategic read.`;
        else if (path[bi] !== 'Intro/Reconnect') read = `Biggest mass: $${Math.round(bd/1000)}K at ${path[bi]}.`;
      }
    }
    const data = { goal: 10000000, momentum: { entered, enteredD, bookedAhead }, read, lanePaths: LANE_PATHS, lanes: Object.values(lanes).sort((a,b)=>b.dollars-a.dollars) };
    funnelCache = { t: Date.now(), data };
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// ---- END FUNNEL ----

// ---- UPCOMING MEETINGS (booked, next 7 days) ----
app.get('/api/upcoming', async (req, res) => {
  try {
    const end = new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10);
    let results = [], cursor = undefined;
    do {
      const r = await notion.databases.query({ database_id: DB, filter: { and: [
        { property: 'Next Touch', date: { after: today() } },
        { property: 'Next Touch', date: { on_or_before: end } },
        { property: 'Next Step', rich_text: { contains: 'ooked' } }
      ]}, sorts: [{ property: 'Next Touch', direction: 'ascending' }], start_cursor: cursor, page_size: 100 });
      results = results.concat(r.results); cursor = r.next_cursor;
    } while (cursor);
    res.json(results.map(mapPage));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// ---- END UPCOMING ----

// ---- CALL-DOWN LIST (all active, sortable) ----
app.get('/api/calldown', async (req, res) => {
  try {
    let results = [], cursor = undefined;
    do {
      const r = await notion.databases.query({ database_id: DB, filter: { and: [
        { property: 'Stage', select: { does_not_equal: 'Won' } },
        { property: 'Stage', select: { does_not_equal: 'Not Now' } }
      ]}, start_cursor: cursor, page_size: 100 });
      results = results.concat(r.results); cursor = r.next_cursor;
    } while (cursor);
    const out = results.map(mapPage).map(o => ({ id: o.id, name: o.name, warmth: o.warmth, lane: o.lane, stage: o.stage,
      amount: o.amount, phone: o.phone, email: o.email, nextStep: o.nextStep, nextTouch: o.nextTouch, response: o.response,
      source: o.source, community: o.community, notes: o.notes, lastContact: o.lastContact,
      scope: (o.warmth === 'Cold' && !o.lastContact) ? 'Reservoir' : 'Active',
      sinceDays: o.lastContact ? Math.floor((Date.now() - new Date(o.lastContact)) / 864e5) : null }));
    res.json(out);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// ---- END CALL-DOWN ----




async function updateOpp(id, f) {
  const props = {};
  if (f.stage) props['Stage'] = { select: { name: f.stage } };
  if (f.warmth) props['Warmth'] = { select: { name: f.warmth } };
  if (f.response) props['Response'] = { select: { name: f.response } };
  if (f.next_step !== undefined) props['Next Step'] = { rich_text: [{ text: { content: String(f.next_step) } }] };
  if (f.next_touch !== undefined) props['Next Touch'] = f.next_touch ? { date: { start: f.next_touch } } : { date: null };
  if (f.last_contact) props['Last Contact'] = { date: { start: f.last_contact } };
  if (f.notes_append) {
    const page = await notion.pages.retrieve({ page_id: id });
    const cur = txt(page.properties['Notes']?.rich_text);
    props['Notes'] = { rich_text: [{ text: { content: (cur ? cur + '\n' : '') + f.notes_append } }] };
  }
  await notion.pages.update({ page_id: id, properties: props });
  return { ok: true, id };
}

app.get('/api/today', async (req, res) => {
  try { res.json(await queryDue()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/capture', async (req, res) => {
  try { const out = await updateOpp(req.body.id, req.body); funnelCache = { t: 0, data: null }; res.json(out); } catch (e) { res.status(500).json({ error: e.message }); }
});

const tools = [
  { name: 'list_due', description: 'List opportunities due today or overdue (active).', input_schema: { type: 'object', properties: {} } },
  { name: 'search_by_name', description: 'Find opportunities by partial name.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'update_opportunity', description: 'Update a person after a touch. ALWAYS set a future next_touch unless closing (Won/Not Now). Set last_contact to today when he reached out.', input_schema: { type: 'object', properties: {
    id: { type: 'string' }, stage: { type: 'string', description: 'Intro/Reconnect | Statements + Intro to John | Stress Test | Open + Fund | Won | Not Now' },
    warmth: { type: 'string' }, next_step: { type: 'string' }, next_touch: { type: 'string', description: 'YYYY-MM-DD' },
    last_contact: { type: 'string' }, notes_append: { type: 'string' } }, required: ['id'] } }
];

async function runTool(name, input) {
  if (name === 'list_due') return await queryDue();
  if (name === 'search_by_name') {
    const q = (input.name || '').trim();
    const tries = [q, ...q.split(/\s+/).filter(w => w.length > 2).sort((a, b) => b.length - a.length)];
    const seen = new Set(); let out = [];
    for (const t of tries) {
      const res = await notion.databases.query({ database_id: DB, filter: { property: 'Name', title: { contains: t } }, page_size: 10 });
      for (const p of res.results.map(mapPage)) if (!seen.has(p.id)) { seen.add(p.id); out.push(p); }
      if (out.length >= 3 && t === q) break;
    }
    return out.slice(0, 10);
  }
  if (name === 'update_opportunity') return await updateOpp(input.id, input);
  return { error: 'unknown tool' };
}

app.post('/api/chat', async (req, res) => {
  try {
    const system = `You are Zachary's outreach concierge inside his cockpit app. Today is ${today()}.
He works his outreach list and tells you the outcome of each touch in plain language ("texted Lee, wants a call Thursday").
Your job: find the right record (search_by_name) and update it (update_opportunity).
GOVERNING LAW: every active opportunity must end with a FUTURE next_touch — never leave it blank unless you set Stage to Won or Not Now. Set last_contact to today whenever he reached out.
CALENDAR TRUTH: records whose Next Step starts with "Booked:" carry dates synced FROM his real calendar by the morning dispatch. You CANNOT see the calendar. NEVER re-date a Booked record from vague phrasing ("tomorrow", "next week") — relative words are unreliable across midnight. Only change a date when he gives an explicit one ("move Pam to 6/14"). If he says booked dates look wrong, reply that the dispatch reconciles them from the calendar each morning and you've flagged it — do not guess.
SEARCH: if a name misses, retry with single words (last name, company word) before saying someone isn't in the system. People are often saved with middle initials or company suffixes.
Keep replies to ONE short line: confirm what you logged + who's next. Compliance: never advise tying free coaching to investing (enticement risk).`;
    let messages = req.body.messages || [{ role: 'user', content: req.body.message }];
    for (let i = 0; i < 6; i++) {
      const r = await anthropic.messages.create({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024, system, tools, messages });
      messages.push({ role: 'assistant', content: r.content });
      const toolUses = r.content.filter(c => c.type === 'tool_use');
      if (!toolUses.length) {
        const text = r.content.filter(c => c.type === 'text').map(c => c.text).join('');
        return res.json({ reply: text, messages });
      }
      const results = [];
      for (const tu of toolUses) {
        const out = await runTool(tu.name, tu.input);
        results.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(out).slice(0, 6000) });
      }
      messages.push({ role: 'user', content: results });
    }
    res.json({ reply: '(thinking loop ended)', messages });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(process.env.PORT || 3000, () => console.log('Cockpit running on ' + (process.env.PORT || 3000)));
