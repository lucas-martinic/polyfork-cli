#!/usr/bin/env node
// Polyfork from the terminal: find a free 3D model and put it in your project.
// No dependencies, so `npx polyfork` starts fast and installs nothing else.
//
// ONE MODEL OR KIT AT A TIME, on purpose. polyfork.dev/licensing lets anything fetch a
// model when someone uses it, and calls a copy of the catalogue redistribution, so there
// is no "download everything" here and there should not be.
//
// Exit codes: 0 done, 1 failed, 2 bad usage or more than one match, 3 needs an account.

import { parseArgs } from 'node:util';
import { createWriteStream, existsSync, mkdirSync, openSync, readFileSync, readSync, closeSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { homedir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { createInterface } from 'node:readline/promises';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const SITE = (process.env.POLYFORK_URL || 'https://polyfork.dev').replace(/\/$/, '');
const UA = `polyfork-cli/${VERSION} (+https://polyfork.dev)`;
const FORMATS = ['glb', 'mjs', 'fbx', 'usdz', 'usda', 'obj'];
const TRIES = 7;              // an export can take a moment to build on first request
const LONGEST_WAIT = 60;      // seconds, whatever Retry-After says

const HELP = `polyfork ${VERSION}: free low-poly 3D models for your project

  polyfork search <words>      find models
  polyfork add <id or words>   put one model in your project
  polyfork kits [words]        list themed kits
  polyfork add --kit <id>      put a whole kit in your project (free account)
  polyfork login               connect a free account
  polyfork logout              forget it

Options
  --format <f>   glb (default), mjs, fbx, usdz, usda, obj
  --dir <path>   where to save (default public/models, or models)
  --first        take the best match instead of asking
  --force        replace a file that is already there
  --type <t>     search one type: prop, building, vehicle, character, animal...
  --limit <n>    search results (default 10)
  --json         machine-readable output

A .glb needs no account. The .mjs source, which you can change with knobs, and kit
zips need a free one. Models are free to use in your projects, with no attribution.
Please do not re-upload the files: https://polyfork.dev/licensing
`;

class Stop extends Error {
  constructor(message, code = 1) { super(message); this.code = code; }
}

const say = (s = '') => process.stderr.write(s + '\n');
const sleep = (s) => new Promise((r) => setTimeout(r, s * 1000));

/* ---- account ---- */
const configFile = () => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'polyfork', 'config.json');

function savedKey() {
  // POLYFORK_KEY is the name the site's own agent guide uses; the other is kept for 0.1.0.
  const env = process.env.POLYFORK_KEY || process.env.POLYFORK_API_KEY;
  if (env) return env;
  try { return JSON.parse(readFileSync(configFile(), 'utf8')).key || null; } catch { return null; }
}

/* ---- the site ---- */
async function call(path, { key = savedKey() } = {}) {
  for (let i = 1; ; i++) {
    let res;
    try {
      res = await fetch(SITE + path, { headers: { 'User-Agent': UA, ...(key ? { Authorization: `Bearer ${key}` } : {}) } });
    } catch (e) {
      if (i >= TRIES) throw new Stop(`Could not reach ${SITE}: ${e.cause?.code || e.message}`);
      await sleep(i);
      continue;
    }
    if ((res.status !== 429 && res.status !== 503) || i >= TRIES) return res;
    // The site says how long to back off, and a client that honours it is a licence term.
    const wait = Math.min(Number(res.headers.get('retry-after')) || 2 ** i, LONGEST_WAIT);
    say(res.status === 429 ? `Busy, waiting ${wait}s...` : `Preparing the file, waiting ${wait}s...`);
    await res.body?.cancel();
    await sleep(wait);
  }
}

async function json(path, opts) {
  const res = await call(path, opts);
  let body = null;
  try { body = await res.json(); } catch { /* an error page, handled below */ }
  if (!body) throw new Stop(`${SITE} answered ${res.status} with something unexpected.`);
  return { status: res.status, body };
}

async function find(words, { limit = 10, type } = {}) {
  const q = new URLSearchParams({ q: words, per_page: String(limit) });
  if (type) q.set('class', type);
  const { status, body } = await json(`/api/assets?${q}`);
  if (status !== 200) throw new Stop(body.error || `Search failed (${status}).`);
  return body;
}

/* ---- output ---- */
const row = (a) => ({ id: a.id, title: a.title, type: a.class, triangles: a.triangles, kit: a.kit, page: a.page, glb: a.download?.glb });

function table(rows) {
  const width = (k) => Math.max(...rows.map((r) => String(r[k]).length));
  const [wId, wTitle] = [width('id'), width('title')];
  for (const r of rows) console.log(`${r.id.padEnd(wId)}  ${r.title.padEnd(wTitle)}  ${r.note}`);
}

const note = (a) => [a.class, a.triangles != null ? `${a.triangles.toLocaleString('en-US')} tris` : null].filter(Boolean).join(', ');
const size = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

/* ---- commands ---- */
async function search(words, o) {
  if (!words) throw new Stop('What are you looking for? Try: polyfork search castle', 2);
  const r = await find(words, { limit: o.limit, type: o.type });
  if (o.json) return console.log(JSON.stringify({ total: r.total, close: close(r), models: r.assets.map(row) }, null, 2));
  if (!r.assets.length) {
    say(`Nothing matches "${words}" yet. You can ask for it: ${SITE}/requests`);
    return;
  }
  table(r.assets.map((a) => ({ id: a.id, title: a.title, note: note(a) })));
  say(close(r)
    ? `\n${r.total.toLocaleString('en-US')} found. Add one: polyfork add ${r.assets[0].id}`
    : `\nNothing close to "${words}", these are the nearest. You can ask for it: ${SITE}/requests`);
}

async function kits(words, o) {
  const { status, body } = await json('/api/kits');
  if (status !== 200) throw new Stop(body.error || `Could not list kits (${status}).`);
  const q = words.toLowerCase().split(/\s+/).filter(Boolean);
  const list = body.kits.filter((k) => k.status === 'published' && q.every((w) => k.title.toLowerCase().includes(w)));
  if (o.json) return console.log(JSON.stringify({ kits: list.map((k) => ({ id: k.id, title: k.title, parts: k.parts_published, page: k.page })) }, null, 2));
  if (!list.length) return say(`No finished kit matches "${words}".`);
  table(list.map((k) => ({ id: k.id, title: k.title, note: `${k.parts_published} parts` })));
  say(`\nAdd one: polyfork add --kit ${list[0].id}`);
}

/** The site's own verdict: did anything match the words, or is this its nearest guess? */
const close = (r) => r.strong_matches > 0 || r.full_matches > 0;

/** Stop with the candidates, as a list for a person or inside the JSON for a script. */
function choices(r, o, message) {
  if (!o.json) table(r.assets.map((a) => ({ id: a.id, title: a.title, note: note(a) })));
  const stop = new Stop(message, 2);
  stop.matches = r.assets.map(row);
  return stop;
}

/** Turn what was typed into one model: an exact id, the only match, or a choice. */
async function pick(words, o) {
  if (/^[a-z0-9][a-z0-9-]*$/.test(words)) {
    const { status, body } = await json(`/api/assets/${words}`);
    if (status === 200) return body;
    if (status !== 404) throw new Stop(body.error || `Lookup failed (${status}).`);
  }
  const r = await find(words.replace(/-/g, ' '), { limit: 5, type: o.type });
  if (!r.assets.length) throw new Stop(`Nothing matches "${words}" yet. You can ask for it: ${SITE}/requests`);
  /* Search always offers its nearest guesses, so a weak result is a suggestion and never
   * a choice: --first must not quietly fetch a bomber for a typo. */
  if (!close(r)) throw choices(r, o, `Nothing close to "${words}". These are the nearest. Add one by id, or ask for it: ${SITE}/requests`);
  if (o.first || r.assets.length === 1) return r.assets[0];
  if (!process.stdin.isTTY || !process.stdout.isTTY || o.json) {
    throw choices(r, o, `More than one match for "${words}". Add one by id, or use --first.`);
  }
  r.assets.forEach((a, i) => say(`  ${i + 1}. ${a.title} (${note(a)})`));
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const n = Number(await rl.question(`Which one? [1-${r.assets.length}] `));
  rl.close();
  if (!r.assets[n - 1]) throw new Stop('Nothing added.', 2);
  return r.assets[n - 1];
}

function defaultDir() {
  return existsSync('public') ? join('public', 'models') : 'models';
}

/** Write to a .part file and rename it, so a dropped connection never leaves half a model. */
async function fetchTo(path, file, force) {
  if (existsSync(file) && !force) return { already: true, bytes: statSync(file).size };
  const res = await call(path);
  if (res.status === 401) {
    await res.body?.cancel();
    throw new Stop(savedKey()
      ? 'Your key was not accepted. Run: polyfork login'
      : 'This one needs a free account (just an email). Run: polyfork login', 3);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const also = body?.available?.length ? ` Available now: ${body.available.join(', ')}.` : '';
    throw new Stop(`${body?.error || `Download failed (${res.status})`}.${also}`);
  }
  mkdirSync(dirname(file), { recursive: true });
  const part = `${file}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
    if (file.endsWith('.glb')) {
      const head = Buffer.alloc(4);
      const fd = openSync(part, 'r');
      readSync(fd, head, 0, 4, 0);
      closeSync(fd);
      if (head.toString() !== 'glTF') throw new Stop('The download was not a valid GLB, so it was not saved.');
    }
    renameSync(part, file);
  } catch (e) {
    rmSync(part, { force: true });
    throw e instanceof Stop ? e : new Stop(`Download failed: ${e.message}`);
  }
  return { already: false, bytes: statSync(file).size };
}

/** How to load the saved file, with the path a web server would use for it. */
function usage(file, ext) {
  const web = file.startsWith(`public${sep}`) ? file.slice('public'.length).replaceAll(sep, '/') : `./${file.replaceAll(sep, '/')}`;
  if (ext === 'glb') return `new GLTFLoader().load('${web}', (gltf) => scene.add(gltf.scene));`;
  if (ext === 'mjs') return `import { createAsset } from '${web}';\nscene.add(createAsset());`;
  return null;
}

async function addKit(id, o) {
  if (!id) throw new Stop('Which kit? Find one with: polyfork kits', 2);
  const file = join(o.dir || defaultDir(), `${id}.zip`);
  const r = await fetchTo(`/dl/kit-${encodeURIComponent(id)}.zip`, file, o.force);
  if (o.json) return console.log(JSON.stringify({ kit: id, file, bytes: r.bytes, already: r.already }, null, 2));
  say(r.already ? `Already there: ${file}. Use --force to replace it.` : `Saved ${file} (${size(r.bytes)})`);
}

async function add(words, o) {
  const format = o.format || 'glb';
  if (!FORMATS.includes(format)) throw new Stop(`Unknown format "${format}". Use one of: ${FORMATS.join(', ')}.`, 2);
  if (!words) throw new Stop('Which model? Find one with: polyfork search castle', 2);
  const a = await pick(words, o);
  const file = join(o.dir || defaultDir(), `${a.id}.${format}`);
  const r = await fetchTo(`/dl/${a.id}.${format}`, file, o.force);
  if (o.json) return console.log(JSON.stringify({ ...row(a), file, bytes: r.bytes, already: r.already }, null, 2));
  say(r.already ? `Already there: ${file}. Use --force to replace it.` : `${a.title}: saved ${file} (${size(r.bytes)})`);
  const how = usage(file, format);
  if (how) console.log(how);
  if (a.remixable && format === 'glb') say(`\nThis one has knobs. Get its source with: polyfork add ${a.id} --format mjs`);
  else if (a.remixable) say(`\nIts knobs are listed at ${a.page}`);
}

/** A pasted key should not sit in the terminal's scrollback. */
async function askHidden(prompt) {
  process.stderr.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let text = '';
  try {
    for await (const chunk of process.stdin) {
      for (const c of chunk.toString()) {
        if (c === '\u0003') throw new Stop('Cancelled.', 1);
        if (c === '\r' || c === '\n') return text;
        text = c === '\u007f' ? text.slice(0, -1) : text + c;
      }
    }
    return text;
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    say();
  }
}

async function login(o) {
  let key = '';
  if (process.stdin.isTTY) {
    say(`A free account costs an email address. Make a key here:\n\n  ${SITE}/login?next=%2Faccount%23api\n`);
    key = await askHidden('Paste your key: ');
  } else {
    key = readFileSync(0, 'utf8');
  }
  key = key.trim();
  if (!key) throw new Stop('No key given.', 2);
  const { body } = await json('/api/me', { key });
  // Only an anonymous answer has this field: a signed-in one just describes the account.
  if (body.authenticated === false || !body.plan) throw new Stop(`That key was not accepted. Make one at ${SITE}/account`, 3);
  const file = configFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, JSON.stringify({ key }) + '\n', { mode: 0o600 });
  if (o.json) return console.log(JSON.stringify({ authenticated: true, plan: body.plan }, null, 2));
  say(`Connected. Key saved to ${relative(process.cwd(), file).startsWith('..') ? file : relative(process.cwd(), file)}`);
}

function logout() {
  rmSync(configFile(), { force: true });
  say('Key removed.');
}

/* ---- the door ---- */
async function main() {
  let args;
  try {
    args = parseArgs({
      allowPositionals: true,
      options: {
        format: { type: 'string' }, dir: { type: 'string' }, type: { type: 'string' }, limit: { type: 'string' },
        kit: { type: 'string' }, first: { type: 'boolean' }, force: { type: 'boolean' }, json: { type: 'boolean' },
        help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
      },
    });
  } catch (e) {
    throw new Stop(`${e.message}\nSee: polyfork --help`, 2);
  }
  const { values: o, positionals: [cmd, ...rest] } = args;
  if (o.version) return console.log(VERSION);
  if (o.help || !cmd) return console.log(HELP);
  const limit = o.limit === undefined ? 10 : Number(o.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Stop('--limit is a number from 1 to 50.', 2);
  const opts = { ...o, limit };
  const words = rest.join(' ').trim();
  switch (cmd) {
    case 'search': return search(words, opts);
    case 'kits': return kits(words, opts);
    case 'add': return o.kit !== undefined ? addKit(o.kit, opts) : add(words, opts);
    case 'login': return login(opts);
    case 'logout': return logout();
    default: throw new Stop(`Unknown command "${cmd}".\nSee: polyfork --help`, 2);
  }
}

main().catch((e) => {
  const json = process.argv.includes('--json');
  const text = e instanceof Stop ? e.message : `Something went wrong: ${e.message}`;
  if (json) console.log(JSON.stringify({ error: text, ...(e.matches ? { matches: e.matches } : {}) }));
  else say(text);
  process.exit(e instanceof Stop ? e.code : 1);
});
