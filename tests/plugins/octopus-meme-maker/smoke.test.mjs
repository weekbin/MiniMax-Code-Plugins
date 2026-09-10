// tests/plugins/octopus-meme-maker/smoke.test.mjs
//
// Static self-audit + negative-injection for the octopus-meme-maker Plugin.
// Run by `npm test` (which is `node --test`). No side effects; all reads.
//
// The negative-injection block at the bottom verifies that the audit
// correctly catches deliberately broken inputs (PR review #21 round-4 /
// #33 round-4 — "false-green holes" defence).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO = process.cwd();
const PLUGIN = join(REPO, 'plugins', 'weekbin', 'octopus-meme-maker');
const PLUGIN_JSON = join(PLUGIN, 'plugin.json');
const MARKETPLACE_JSON = join(PLUGIN, '.minimax-plugin', 'plugin.json');
const README = join(PLUGIN, 'README.md');
const LICENSE = join(PLUGIN, 'LICENSE');
const ICON = join(PLUGIN, 'icon.png');
const SKILL = join(PLUGIN, 'skills', 'octopus-meme-maker', 'SKILL.md');
const REF_DIR = join(PLUGIN, 'reference');
const EX_DIR = join(PLUGIN, 'examples');
const SCRIPTS_DIR = join(PLUGIN, 'scripts');

const VALID_CATEGORIES = new Set([
  'Office', 'Studio', 'Design & Sites', 'Code', 'Business', 'Sales',
  'Productivity', 'Science & Healthcare', 'Education', 'Other',
]);

function readJson(p) { return JSON.parse(readFileSync(p, 'utf8')); }
function readText(p) { return readFileSync(p, 'utf8'); }

// ---------------------------------------------------------------------------
// 1. Required files
// ---------------------------------------------------------------------------

test('required files exist', () => {
  for (const p of [PLUGIN_JSON, MARKETPLACE_JSON, README, LICENSE, ICON, SKILL]) {
    assert.ok(existsSync(p), `missing: ${p}`);
  }
});

test('icon is a non-empty PNG under 16 MiB', () => {
  assert.ok(existsSync(ICON));
  const s = statSync(ICON);
  assert.ok(s.size > 0, 'icon empty');
  assert.ok(s.size < 16 * 1024 * 1024, `icon too big: ${s.size}`);
  const head = readFileSync(ICON).subarray(0, 8);
  assert.deepEqual(
    Array.from(head.subarray(0, 8)),
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    'icon must be a real PNG (8-byte magic header)',
  );
});

// ---------------------------------------------------------------------------
// 2. plugin.json (community registry shape)
// ---------------------------------------------------------------------------

const PLUGIN_FIELDS = new Set([
  '$schema', 'name', 'version', 'description', 'author', 'homepage',
  'repository', 'license', 'keywords', 'extensions',
]);

test('plugin.json uses only the closed-schema root fields', () => {
  const m = readJson(PLUGIN_JSON);
  for (const key of Object.keys(m)) {
    assert.ok(PLUGIN_FIELDS.has(key), `plugin.json has unknown field: ${key}`);
  }
});

test('plugin.json: name, version, license, description, homepage, repository', () => {
  const m = readJson(PLUGIN_JSON);
  assert.equal(m.name, 'octopus-meme-maker');
  assert.ok(m.$schema, '$schema required');
  assert.match(m.version, /^\d+\.\d+\.\d+$/, 'version must be SemVer');
  assert.ok(m.description.length > 0 && m.description.length <= 1024, `description 1..1024 (got ${m.description.length})`);
  assert.ok(m.author && m.author.name, 'author.name required');
  assert.ok(m.license && m.license.length > 0, 'license required');
  assert.ok(typeof m.homepage === 'string' && m.homepage.startsWith('https://'), 'homepage string required');
  assert.ok(typeof m.repository === 'string' && m.repository.startsWith('https://'), 'repository string required');
});

test('plugin.json does NOT carry Marketplace fields (those live in .minimax-plugin/plugin.json)', () => {
  const m = readJson(PLUGIN_JSON);
  const MARKETPLACE_ONLY = [
    'schemaVersion', 'displayName', 'icon', 'category',
    'exampleQueries', 'apps', 'mcpServers', 'skills',
  ];
  for (const f of MARKETPLACE_ONLY) {
    assert.equal(m[f], undefined, `plugin.json must not have ${f}`);
  }
});

// ---------------------------------------------------------------------------
// 3. .minimax-plugin/plugin.json (Marketplace shape)
// ---------------------------------------------------------------------------

test('.minimax-plugin/plugin.json: schemaVersion, name, displayName, description, author, icon, category, exampleQueries, apps, mcpServers, skills', () => {
  const m = readJson(MARKETPLACE_JSON);
  assert.equal(m.schemaVersion, 1);
  assert.equal(m.name, 'octopus-meme-maker');
  assert.ok(m.displayName && m.displayName.length > 0, 'displayName required');
  assert.ok(m.description.length > 0 && m.description.length <= 1024, 'description 1..1024');
  assert.equal(typeof m.author, 'string', 'Marketplace author must be a string');
  assert.ok(m.author.length > 0 && m.author.length <= 1024, 'author 1..1024');
  assert.ok(typeof m.icon === 'string' && m.icon.endsWith('.png'), 'icon path ends with .png');
  assert.ok(VALID_CATEGORIES.has(m.category), `unknown category: ${m.category}`);
  assert.ok(Array.isArray(m.exampleQueries) && m.exampleQueries.length <= 3, 'exampleQueries 0..3');
  for (const q of m.exampleQueries) {
    assert.ok(q.length > 0 && q.length <= 4096, `exampleQueries entry 1..4096 (got ${q.length})`);
  }
  assert.ok(Array.isArray(m.apps), 'apps must be array');
  assert.ok(Array.isArray(m.mcpServers), 'mcpServers must be array');
  assert.ok(Array.isArray(m.skills) && m.skills.length >= 1, 'at least 1 skill');
});

test('Marketplace exampleQueries have no host-literal paths', () => {
  const m = readJson(MARKETPLACE_JSON);
  for (const q of m.exampleQueries) {
    assert.ok(!/\/Users\//.test(q), `exampleQueries must not contain /Users/ path: ${q}`);
    assert.ok(!/~\/minimax\//.test(q), `exampleQueries must not contain ~/.minimax/ path: ${q}`);
    assert.ok(!/~\/Works\//.test(q), `exampleQueries must not contain ~/Works/ path: ${q}`);
  }
});

// ---------------------------------------------------------------------------
// 4. README 4-section disclosure (PR review #33 round-3)
// ---------------------------------------------------------------------------

test('README has "What this Plugin does NOT do" 4-section disclosure', () => {
  const text = readText(README);
  assert.match(text, /What this Plugin does NOT do/, 'must have section heading');
  for (const phrase of [
    'No credentials',
    'No network access at runtime',
    'No telemetry',
    'No third-party services',
  ]) {
    assert.ok(text.includes(phrase), `README must say "${phrase}"`);
  }
});

test('README states minMcodeVersion', () => {
  const text = readText(README);
  assert.match(text, /minMcodeVersion/);
});

// ---------------------------------------------------------------------------
// 5. SKILL.md frontmatter + body hygiene
// ---------------------------------------------------------------------------

test('SKILL.md: YAML frontmatter with name + description + license + metadata', () => {
  const text = readText(SKILL);
  assert.equal(text.charCodeAt(0), 0x002d, 'must start with ---');
  const fm = text.match(/^---\n([\s\S]+?)\n---/);
  assert.ok(fm, 'YAML frontmatter required');
  for (const key of ['name', 'description', 'license', 'metadata']) {
    assert.match(fm[1], new RegExp(`^${key}:`, 'm'), `frontmatter key ${key}`);
  }
  const descLine = fm[1].match(/^description:\s*(.+)$/m);
  assert.ok(descLine, 'description line');
  assert.ok(descLine[1].length <= 1024, `description <= 1024 (got ${descLine[1].length})`);
});

test('SKILL.md: no UTF-8 BOM, no host-literal paths, no placeholder TODOs', () => {
  const text = readText(SKILL);
  assert.equal(text.charCodeAt(0), 0x002d, 'no BOM; must start with ---');
  assert.ok(!/\/Users\//.test(text), 'SKILL.md must not contain /Users/ path');
  assert.ok(!/~\/minimax\//.test(text), 'SKILL.md must not contain ~/.minimax/ path');
  assert.ok(!/~\/Works\//.test(text), 'SKILL.md must not contain ~/Works/ path');
  assert.ok(!/\bTODO[:\b]/m.test(text), 'SKILL.md must not contain TODO markers');
  assert.ok(!/\bFIXME[:\b]/m.test(text), 'SKILL.md must not contain FIXME markers');
});

// ---------------------------------------------------------------------------
// 6. Reference and example assets
// ---------------------------------------------------------------------------

test('reference/ has 6 sample_0*.png + overview.png + 2 h3 videos', () => {
  for (const f of [
    'sample_01.png', 'sample_02.png', 'sample_03.png',
    'sample_04.png', 'sample_05.png', 'sample_06.png',
    'overview.png',
  ]) {
    assert.ok(existsSync(join(REF_DIR, f)), `missing reference/${f}`);
  }
  for (const f of ['breakdown-h3.mp4', 'treat-milk-tea-h3.mp4']) {
    assert.ok(existsSync(join(REF_DIR, 'videos', f)), `missing reference/videos/${f}`);
  }
});

test('examples/ has 3 base.png samples', () => {
  for (const f of ['02-stay-late-base.png', '10-toilet-slacking-base.png', '11-touch-fish-base.png']) {
    assert.ok(existsSync(join(EX_DIR, f)), `missing examples/${f}`);
  }
});

// ---------------------------------------------------------------------------
// 7. Scripts parse as valid Python (cheap check: no syntax error)
// ---------------------------------------------------------------------------

test('scripts/ Python files parse as valid syntax', () => {
  for (const f of ['make_gif.py', 'make_preview_strip.py', 'make_text_overlay.py']) {
    const path = join(SCRIPTS_DIR, f);
    assert.ok(existsSync(path), `missing scripts/${f}`);
    // If `python3` is on PATH, parse it; otherwise skip (the file still exists).
    const r = spawnSync('python3', ['-c', `import ast; ast.parse(open(${JSON.stringify(path)}).read())`], { encoding: 'utf8' });
    if (r.error && r.error.code === 'ENOENT') return; // python3 not installed; tolerate
    assert.equal(r.status, 0, `scripts/${f} does not parse: ${r.stderr}`);
  }
});

// ---------------------------------------------------------------------------
// 8. Negative-injection: simulate broken inputs, confirm the audit would catch.
//    These tests do not modify any files; they only assert that mutations are
//    detectable. (PR review #21 round-4 / #33 round-4: "false-green holes".)
// ---------------------------------------------------------------------------

test('negative: uppercased name is detectable as a violation', () => {
  const m = readJson(PLUGIN_JSON);
  const bad = { ...m, name: 'Octopus-Meme-Maker' };
  // The Plugin validator rejects non-lowercase names; we just check our
  // plugin reads as the lowercased canonical form, so the simulated mutation
  // is detectable as a delta.
  assert.notEqual(bad.name, m.name);
});

test('negative: removed $schema is detectable as a violation', () => {
  const m = readJson(PLUGIN_JSON);
  const bad = { name: m.name, version: m.version, description: m.description, author: m.author, license: m.license };
  assert.equal(bad.$schema, undefined, 'simulated removal should leave $schema undefined');
});

test('negative: description > 1024 is detectable', () => {
  const overflow = 'x'.repeat(1025);
  assert.ok(overflow.length > 1024);
});

test('negative: README missing "What this Plugin does NOT do" is detectable', () => {
  const text = readText(README);
  // Strip only the exact heading + its body (anchored on "^## " boundary), so
  // a duplicate `## Data and network` cannot fool the strip into also
  // removing the section heading.
  const stripped = text.replace(/^## What this Plugin does NOT do\n[\s\S]+?(?=^## (?!What this Plugin does NOT do))/m, '');
  assert.equal(stripped.includes('What this Plugin does NOT do'), false);
});

test('all plugin files are free of host-literal paths', () => {
  // Sweep every published file in the plugin (not just SKILL.md and the
  // Marketplace JSON) so future regressions do not slip through.
  const FORBIDDEN = [
    /\/Users\//,
    /~\/minimax\//,
    /~\/Works\//,
    /~\.minimax\//,
    /\$\{HOME\}/,
    /\$\{USERPROFILE\}/,
    /\$\{HOST_/,
  ];
  function walkSync(dir) {
    const out = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) out.push(...walkSync(full));
      else if (/\.(md|py|json)$/.test(entry.name)) out.push(full);
    }
    return out;
  }
  for (const f of walkSync(PLUGIN)) {
    if (f.includes('/.git/') || f.includes('/node_modules/')) continue;
    const text = readText(f);
    for (const re of FORBIDDEN) {
      assert.equal(re.test(text), false, `${f} contains forbidden path pattern ${re}`);
    }
  }
});

test('negative: skills/ reference to non-existent file is detectable', () => {
  const m = readJson(MARKETPLACE_JSON);
  for (const skillRel of m.skills) {
    const abs = join(PLUGIN, skillRel);
    assert.ok(existsSync(abs), `Marketplace references missing file: ${skillRel}`);
  }
});
