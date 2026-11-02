// Runs the real CLI as a subprocess against a stub of the site, so nothing here touches
// polyfork.dev. Run: npm test

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BIN = new URL('../bin/polyfork.mjs', import.meta.url).pathname;
const KEY = 'pf_test';
const GLB = Buffer.concat([Buffer.from('glTF'), Buffer.alloc(2000)]);
const van = { id: 'camper-van-111', title: 'Camper Van', class: 'vehicle', triangles: 2626, kit: 'road-1',
  remixable: true, page: 'https://x/asset/camper-van-111', download: { glb: 'https://x/cdn/camper-van-111.glb' } };
const bus = { ...van, id: 'city-bus-222', title: 'City Bus', remixable: false };

let server, site, cwd, config, seen, script;

const send = (res, code, body, headers = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  const key = req.headers.authorization === `Bearer ${KEY}`;
  seen.push({ path: url.pathname + url.search, ua: req.headers['user-agent'], auth: req.headers.authorization });
  if (script[url.pathname]?.length) return script[url.pathname].shift()(res);
  if (url.pathname === '/api/assets') {
    const q = url.searchParams.get('q');
    // The same fields the live API sends: a weak result is real rows with no matches.
    const list = /zzz/.test(q) ? [] : /only/.test(q) ? [van] : [van, bus];
    const n = /zzz|weak/.test(q) ? 0 : list.length;
    return send(res, 200, { total: list.length, coverage: n ? 'ok' : 'poor', strong_matches: n, full_matches: n, assets: list });
  }
  if (url.pathname === '/api/assets/camper-van-111') return send(res, 200, van);
  if (url.pathname.startsWith('/api/assets/')) return send(res, 404, { error: 'no such asset' });
  if (url.pathname === '/api/kits') return send(res, 200, { kits: [
    { id: 'road-1', title: 'Road Kit', status: 'published', parts_published: 60, page: 'https://x/kit/road-1' },
    { id: 'wip-2', title: 'Road Works', status: 'parts', parts_published: 3, page: 'https://x/kit/wip-2' }] });
  // As live: only the anonymous answer carries `authenticated`.
  if (url.pathname === '/api/me') return send(res, 200, key ? { plan: 'free', email: 'a@b.c' } : { authenticated: false, plan: 'anonymous' });
  if (url.pathname === '/dl/camper-van-111.glb') return send(res, 200, GLB, { 'Content-Type': 'model/gltf-binary' });
  if (url.pathname === '/dl/camper-van-111.mjs' || url.pathname === '/dl/kit-road-1.zip') {
    return key ? send(res, 200, 'export function createAsset() {}') : send(res, 401, { error: 'sign in' });
  }
  send(res, 404, { error: 'this file does not exist for this asset' });
}

function run(args, { env = {}, stdin = '' } = {}) {
  return new Promise((done) => {
    const p = spawn(process.execPath, [BIN, ...args], { cwd,
      env: { PATH: process.env.PATH, POLYFORK_URL: site, XDG_CONFIG_HOME: config, ...env } });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.stdin.end(stdin);
    p.on('close', (code) => done({ code, out, err }));
  });
}

before(async () => {
  server = createServer(handle);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  site = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'polyfork-'));
  config = join(cwd, '.config-test');
  seen = [];
  script = {};
});

test('search prints ids and names the next step', async () => {
  const r = await run(['search', 'camper', 'van']);
  assert.equal(r.code, 0);
  assert.match(r.out, /camper-van-111\s+Camper Van\s+vehicle, 2,626 tris/);
  assert.match(r.err, /polyfork add camper-van-111/);
  assert.equal(new URLSearchParams(seen[0].path.split('?')[1]).get('q'), 'camper van');
  assert.match(seen[0].ua, /^polyfork-cli\/\d/);
});

test('search --json is parseable and an empty result is not an error', async () => {
  const r = await run(['search', 'camper', '--json']);
  assert.equal(JSON.parse(r.out).models[0].glb, van.download.glb);
  const none = await run(['search', 'zzz']);
  assert.equal(none.code, 0);
  assert.match(none.err, /requests/);
});

test('kits lists finished kits only', async () => {
  const r = await run(['kits', 'road']);
  assert.match(r.out, /road-1/);
  assert.doesNotMatch(r.out, /wip-2/);
});

test('add by id saves a GLB with no account and shows how to load it', async () => {
  const r = await run(['add', 'camper-van-111']);
  assert.equal(r.code, 0);
  assert.equal(statSync(join(cwd, 'models/camper-van-111.glb')).size, GLB.length);
  assert.match(r.out, /GLTFLoader/);
  assert.equal(seen.find((s) => s.path.startsWith('/dl/')).auth, undefined);
  assert.deepEqual(readdirSync(join(cwd, 'models')), ['camper-van-111.glb']);
});

test('add uses public/models when a public folder exists', async () => {
  mkdirSync(join(cwd, 'public'));
  const r = await run(['add', 'camper-van-111']);
  assert.ok(existsSync(join(cwd, 'public/models/camper-van-111.glb')));
  assert.match(r.out, /'\/models\/camper-van-111\.glb'/);
});

test('more than one match stops and lists ids when nobody can answer', async () => {
  const r = await run(['add', 'van']);
  assert.equal(r.code, 2);
  assert.match(r.out, /camper-van-111/);
  assert.match(r.err, /--first/);
  assert.ok(!existsSync(join(cwd, 'models')));
});

test('--first takes the best match, and a single match needs no flag', async () => {
  assert.equal((await run(['add', 'van', '--first'])).code, 0);
  assert.ok(existsSync(join(cwd, 'models/camper-van-111.glb')));
  rmSync(join(cwd, 'models'), { recursive: true });
  assert.equal((await run(['add', 'only', 'van'])).code, 0);
  assert.ok(existsSync(join(cwd, 'models/camper-van-111.glb')));
});

test('a weak match is never taken, even with --first', async () => {
  const r = await run(['add', 'weak', 'typo', '--first']);
  assert.equal(r.code, 2);
  assert.match(r.err, /Nothing close/);
  assert.ok(!existsSync(join(cwd, 'models')));
  const s = await run(['search', 'weak', 'typo']);
  assert.equal(s.code, 0);
  assert.match(s.err, /nearest/);
});

test('a file already there is kept, unless --force', async () => {
  await run(['add', 'camper-van-111']);
  writeFileSync(join(cwd, 'models/camper-van-111.glb'), 'mine');
  const again = await run(['add', 'camper-van-111']);
  assert.equal(again.code, 0);
  assert.equal(readFileSync(join(cwd, 'models/camper-van-111.glb'), 'utf8'), 'mine');
  await run(['add', 'camper-van-111', '--force']);
  assert.equal(statSync(join(cwd, 'models/camper-van-111.glb')).size, GLB.length);
});

test('the source module asks for an account, then works with one', async () => {
  const anon = await run(['add', 'camper-van-111', '--format', 'mjs']);
  assert.equal(anon.code, 3);
  assert.match(anon.err, /polyfork login/);
  const keyed = await run(['add', 'camper-van-111', '--format', 'mjs'], { env: { POLYFORK_API_KEY: KEY } });
  assert.equal(keyed.code, 0);
  assert.match(keyed.out, /createAsset/);
});

test('a kit needs an account and lands as one zip', async () => {
  assert.equal((await run(['add', '--kit', 'road-1'])).code, 3);
  assert.equal((await run(['add', '--kit', 'road-1'], { env: { POLYFORK_API_KEY: KEY } })).code, 0);
  assert.ok(existsSync(join(cwd, 'models/road-1.zip')));
});

test('429 is honoured: it waits as long as Retry-After says, then goes on', async () => {
  script['/dl/camper-van-111.glb'] = [(res) => send(res, 429, { error: 'slow down' }, { 'Retry-After': '1' })];
  const started = Date.now();
  const r = await run(['add', 'camper-van-111']);
  assert.equal(r.code, 0);
  assert.ok(Date.now() - started >= 1000);
  assert.match(r.err, /waiting 1s/);
});

test('a format still building is waited for', async () => {
  script['/dl/camper-van-111.glb'] = [(res) => send(res, 503, { error: 'that format is being prepared' }, { 'Retry-After': '1' })];
  const r = await run(['add', 'camper-van-111']);
  assert.equal(r.code, 0);
  assert.match(r.err, /Preparing/);
});

test('a bad download leaves nothing behind', async () => {
  script['/dl/camper-van-111.glb'] = [(res) => send(res, 200, '<html>not a model</html>')];
  const r = await run(['add', 'camper-van-111']);
  assert.equal(r.code, 1);
  assert.match(r.err, /not a valid GLB/);
  assert.deepEqual(readdirSync(join(cwd, 'models')), []);
});

test('a dropped connection leaves no half a file', async () => {
  script['/dl/camper-van-111.glb'] = [(res) => {
    res.writeHead(200, { 'Content-Type': 'model/gltf-binary', 'Content-Length': '5000' });
    res.write(GLB.subarray(0, 100));
    setTimeout(() => res.destroy(), 50);
  }];
  const r = await run(['add', 'camper-van-111']);
  assert.equal(r.code, 1);
  assert.deepEqual(readdirSync(join(cwd, 'models')), []);
});

test('login checks the key first and keeps it private', async () => {
  const bad = await run(['login'], { stdin: 'pf_wrong\n' });
  assert.equal(bad.code, 3);
  assert.ok(!existsSync(join(config, 'polyfork/config.json')));
  assert.equal((await run(['login'], { stdin: `${KEY}\n` })).code, 0);
  const file = join(config, 'polyfork/config.json');
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).key, KEY);
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.equal((await run(['add', 'camper-van-111', '--format', 'mjs'])).code, 0);
  assert.equal(seen.at(-1).auth, `Bearer ${KEY}`);
  await run(['logout']);
  assert.ok(!existsSync(file));
});

test('a key is never sent where none is saved, and never printed', async () => {
  const r = await run(['add', 'camper-van-111', '--format', 'mjs'], { env: { POLYFORK_API_KEY: KEY } });
  assert.ok(!r.out.includes(KEY) && !r.err.includes(KEY));
});

test('usage errors are exit 2 and name the fix', async () => {
  assert.equal((await run(['add'])).code, 2);
  assert.equal((await run(['search'])).code, 2);
  assert.equal((await run(['nope'])).code, 2);
  assert.equal((await run(['--bogus'])).code, 2);
  assert.equal((await run(['add', 'x', '--format', 'stl'])).code, 2);
  assert.equal((await run(['search', 'x', '--limit', '999'])).code, 2);
});

test('--json errors stay parseable', async () => {
  const r = await run(['add', 'van', '--json']);
  assert.equal(r.code, 2);
  const body = JSON.parse(r.out);
  assert.match(body.error, /More than one/);
  assert.equal(body.matches[0].id, 'camper-van-111');
});

test('--version and --help', async () => {
  assert.match((await run(['--version'])).out, /^\d+\.\d+\.\d+/);
  assert.match((await run(['--help'])).out, /polyfork add/);
  assert.match((await run([])).out, /polyfork search/);
});
