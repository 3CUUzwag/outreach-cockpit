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
    source: x['Source']?.select?.name || ''
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
  return res.results.map(mapPage);
}

async function updateOpp(id, f) {
  const props = {};
  if (f.stage) props['Stage'] = { select: { name: f.stage } };
  if (f.warmth) props['Warmth'] = { select: { name: f.warmth } };
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
  try { res.json(await updateOpp(req.body.id, req.body)); } catch (e) { res.status(500).json({ error: e.message }); }
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
    const res = await notion.databases.query({ database_id: DB, filter: { property: 'Name', title: { contains: input.name } }, page_size: 10 });
    return res.results.map(mapPage);
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
