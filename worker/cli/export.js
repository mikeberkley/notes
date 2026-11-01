// notes export — dump every memory (SMO) and raw source to Markdown files.
//
// Uses only the existing read-only /agent/* endpoints, so it needs nothing
// beyond an API key and requires no Worker changes or deploy.
//
// Output layout (under --out, default ./notes-export):
//   index.md                          table of contents, newest first
//   memories/monthly/<start>_<slug>.md
//   memories/weekly/<start>_<slug>.md
//   memories/daily/<date>_<slug>.md
//   sources/<source_type>/<date>_<slug>_<id8>.md
//
// Every file starts with YAML frontmatter (id, type, dates, keywords, ...)
// so it can be imported by tools that read frontmatter; memories link to
// their children and sources with relative Markdown links.

import { mkdirSync, writeFileSync } from 'fs';
import { join, dirname, relative } from 'path';

const LAYER_DIR = { 1: 'daily', 2: 'weekly', 3: 'monthly' };
const LAYER_NAME = { 1: 'Daily', 2: 'Weekly', 3: 'Monthly' };

// ── helpers ─────────────────────────────────────────────────────────────────

export function slugify(text, max = 60) {
  const s = String(text ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  return s || 'untitled';
}

function parseMaybeJson(v) {
  if (v == null) return v;
  if (typeof v !== 'string') return v;
  try { return JSON.parse(v); } catch { return v; }
}

function toList(v) {
  const p = parseMaybeJson(v);
  if (p == null || p === '') return [];
  if (Array.isArray(p)) return p.map(String).filter(Boolean);
  // open_questions is stored newline-separated
  return String(p).split('\n').map(s => s.trim()).filter(Boolean);
}

// YAML scalar: always double-quote strings so colons, #, etc. are safe.
function yamlScalar(v) {
  if (v == null) return 'null';
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(String(v));
}

export function frontmatter(obj) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (Array.isArray(v)) {
      if (!v.length) { lines.push(`${k}: []`); continue; }
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${yamlScalar(item)}`);
    } else if (v && typeof v === 'object') {
      lines.push(`${k}:`);
      for (const [k2, v2] of Object.entries(v)) {
        if (v2 === undefined || (v2 && typeof v2 === 'object')) {
          if (v2 && typeof v2 === 'object') lines.push(`  ${k2}: ${yamlScalar(JSON.stringify(v2))}`);
          continue;
        }
        lines.push(`  ${k2}: ${yamlScalar(v2)}`);
      }
    } else {
      lines.push(`${k}: ${yamlScalar(v)}`);
    }
  }
  lines.push('---', '');
  return lines.join('\n');
}

function bulletSection(title, items) {
  if (!items.length) return '';
  return `## ${title}\n\n${items.map(i => `- ${i}`).join('\n')}\n\n`;
}

function link(fromFile, toFile, text) {
  const rel = relative(dirname(fromFile), toFile).split('\\').join('/');
  return `[${text.replace(/[[\]]/g, '')}](${encodeURI(rel)})`;
}

export function sourceTitle(rs) {
  const m = rs.metadata ?? {};
  const wf = [m.root_name, m.section_name].filter(Boolean).join(' / ');
  return m.subject || m.title || m.filename
    || (m.channel_name && `Slack ${m.channel_name}`)
    || (m.with_user && `Slack DM with ${m.with_user}`)
    || wf
    || `${rs.source_type} ${rs.source_date}`;
}

function dateRange(smo) {
  return smo.date_range_start === smo.date_range_end
    ? smo.date_range_start
    : `${smo.date_range_start} – ${smo.date_range_end}`;
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ── rendering ───────────────────────────────────────────────────────────────

export function renderSmo(smo, ctx) {
  const file = ctx.smoPath.get(smo.id);
  const keywords = toList(smo.keywords);
  const entities = toList(smo.key_entities);
  const decisions = toList(smo.key_decisions);
  const questions = toList(smo.open_questions);

  let md = frontmatter({
    id: smo.id,
    type: 'memory',
    layer: smo.layer,
    period: LAYER_NAME[smo.layer]?.toLowerCase() ?? `layer-${smo.layer}`,
    title: smo.headline,
    date_start: smo.date_range_start,
    date_end: smo.date_range_end,
    location: smo.location ?? undefined,
    created_at: smo.created_at ?? undefined,
    keywords,
    entities,
  });

  md += `# ${smo.headline}\n\n`;
  md += `*${LAYER_NAME[smo.layer] ?? `Layer ${smo.layer}`} memory · ${dateRange(smo)}`;
  if (smo.location) md += ` · ${smo.location}`;
  md += '*\n\n';

  const parents = ctx.parentsOf.get(smo.id) ?? [];
  if (parents.length) {
    md += `Part of: ${parents.map(p => link(file, ctx.smoPath.get(p.id), p.headline)).join(', ')}\n\n`;
  }

  if (smo.summary) md += `## Summary\n\n${smo.summary}\n\n`;

  if (smo.themes?.length) {
    md += '## Themes\n\n';
    for (const t of smo.themes) md += `### ${t.headline}\n\n${t.summary}\n\n`;
  }

  md += bulletSection('Key decisions', decisions);
  md += bulletSection('Open questions', questions);
  md += bulletSection('Key entities', entities);
  md += bulletSection('Keywords', keywords);

  const children = (smo.children ?? []).filter(c => ctx.smoPath.has(c.id));
  if (children.length) {
    md += bulletSection(
      smo.layer === 3 ? 'Weeks' : 'Days',
      children.map(c => `${link(file, ctx.smoPath.get(c.id), c.headline)} (${dateRange(c)})`),
    );
  }

  const sources = (smo.sources ?? []).filter(s => ctx.sourcePath.has(s.raw_source_id));
  if (sources.length) {
    md += bulletSection(
      'Sources',
      sources.map(s => `${link(file, ctx.sourcePath.get(s.raw_source_id), ctx.sourceTitle.get(s.raw_source_id))} (${s.source_type})`),
    );
  }

  return md.trimEnd() + '\n';
}

export function renderSource(rs, ctx) {
  const file = ctx.sourcePath.get(rs.id);
  const title = sourceTitle(rs);
  const decisions = toList(rs.key_decisions);
  const questions = toList(rs.open_questions);
  const entities = toList(rs.key_entities);
  const keywords = toList(rs.keywords);

  let md = frontmatter({
    id: rs.id,
    type: 'source',
    source_type: rs.source_type,
    title,
    date: rs.source_date,
    external_id: rs.external_id,
    ingested_at: rs.ingested_at ?? undefined,
    keywords,
    entities,
    // node_index (Workflowy) is a large internal lookup table; leave it out.
    metadata: rs.metadata && typeof rs.metadata === 'object'
      ? Object.fromEntries(Object.entries(rs.metadata).filter(([k]) => k !== 'node_index'))
      : undefined,
  });

  md += `# ${title}\n\n*${rs.source_type} · ${rs.source_date}*\n\n`;

  const usedBy = ctx.smosOfSource.get(rs.id) ?? [];
  if (usedBy.length) {
    md += `Referenced by: ${usedBy.map(s => link(file, ctx.smoPath.get(s.id), s.headline)).join(', ')}\n\n`;
  }

  if (rs.summary) md += `## AI summary\n\n${rs.summary}\n\n`;
  md += bulletSection('Key decisions', decisions);
  md += bulletSection('Open questions', questions);

  md += '## Content\n\n';
  md += `${String(rs.content ?? '').trim() || '_(empty)_'}\n`;
  return md;
}

function renderIndex(smos, sources, ctx, outDir) {
  const file = join(outDir, 'index.md');
  let md = frontmatter({
    type: 'index',
    exported_at: new Date().toISOString(),
    memory_count: smos.length,
    source_count: sources.length,
  });
  md += '# Notes export\n\n';
  md += `${smos.length} memories and ${sources.length} sources.\n\n`;

  for (const layer of [3, 2, 1]) {
    const list = smos.filter(s => s.layer === layer)
      .sort((a, b) => b.date_range_start.localeCompare(a.date_range_start));
    if (!list.length) continue;
    md += `## ${LAYER_NAME[layer]} memories\n\n`;
    md += list.map(s => `- ${dateRange(s)} · ${link(file, ctx.smoPath.get(s.id), s.headline)}`).join('\n');
    md += '\n\n';
  }

  const orphans = sources.filter(s => !(ctx.smosOfSource.get(s.id)?.length))
    .sort((a, b) => b.source_date.localeCompare(a.source_date));
  if (orphans.length) {
    md += '## Sources not linked to any memory\n\n';
    md += orphans.map(s => `- ${s.source_date} · ${link(file, ctx.sourcePath.get(s.id), sourceTitle(s))} (${s.source_type})`).join('\n');
    md += '\n';
  }

  return md;
}

// ── data loading ────────────────────────────────────────────────────────────
// Both loaders return the same shapes:
//   smo:    full row + themes[{headline,summary}] + children[{id,layer,headline,date_range_*}]
//           + sources[{raw_source_id, source_type}]
//   source: full raw_sources row with metadata parsed

async function loadFromApi(args, config, apiFetch, log) {
  const concurrency = parseInt(args.concurrency ?? '6', 10) || 6;
  const withSources = args['no-sources'] !== true;

  // 1. List every SMO in every layer (no date filter = all of them).
  const listed = [];
  for (const layer of [1, 2, 3]) {
    const rows = await apiFetch(`/layer/${layer}`, config);
    log(`Layer ${layer}: ${rows.length} memories`);
    listed.push(...rows);
  }

  // 2. Full detail (themes, decisions, child ids) and source lists.
  let done = 0;
  const smos = await mapLimit(listed, concurrency, async row => {
    const smo = await apiFetch(`/smo/${row.id}?depth=1`, config);
    smo.sources = withSources ? await apiFetch(`/smo/${row.id}/sources`, config) : [];
    if (++done % 25 === 0 || done === listed.length) log(`  memories ${done}/${listed.length}`);
    return smo;
  });

  // 3. Every referenced raw source, once.
  const sourceIds = [...new Set(smos.flatMap(s => s.sources.map(x => x.raw_source_id)))];
  done = 0;
  const sources = (await mapLimit(sourceIds, concurrency, async id => {
    const rs = await apiFetch(`/raw-source/${id}`, config, { allow404: true });
    if (++done % 50 === 0 || done === sourceIds.length) log(`  sources ${done}/${sourceIds.length}`);
    return rs;
  })).filter(Boolean);

  return { smos, sources };
}

// Reads a D1 export (.sql, e.g. from `wrangler d1 export` or the weekly R2
// backup) or a SQLite file directly. Only users / smos / themes /
// source_pointers / raw_sources are read — never oauth_tokens or api_keys.
// Unlike the API path, this includes raw sources not linked to any SMO.
async function loadFromDb(args, log) {
  // node:sqlite (Node 22.5+) prints an ExperimentalWarning on load; silence just that one.
  const emit = process.emitWarning;
  process.emitWarning = (w, ...rest) => (String(w).includes('SQLite') ? undefined : emit.call(process, w, ...rest));
  const { DatabaseSync } = await import('node:sqlite');
  process.emitWarning = emit;
  const { readFileSync } = await import('fs');
  const file = args.db;
  let db;
  if (/\.sql$/i.test(file)) {
    db = new DatabaseSync(':memory:');
    db.exec(readFileSync(file, 'utf8'));
  } else {
    db = new DatabaseSync(file, { readOnly: true });
  }

  const users = db.prepare('SELECT id, email FROM users ORDER BY email').all();
  let user;
  if (typeof args.email === 'string') {
    user = users.find(u => u.email.toLowerCase() === args.email.toLowerCase());
    if (!user) throw new Error(`No user with email ${args.email}. Users in this database: ${users.map(u => u.email).join(', ')}`);
  } else if (users.length === 1) {
    user = users[0];
  } else {
    throw new Error(`This database has ${users.length} users; pick one with --email <address>: ${users.map(u => u.email).join(', ')}`);
  }
  log(`Exporting data for ${user.email}`);

  const withSources = args['no-sources'] !== true;
  const rows = db.prepare('SELECT * FROM smos WHERE user_id = ? ORDER BY layer, date_range_start').all(user.id);
  const byId = new Map(rows.map(r => [r.id, r]));
  const themes = db.prepare('SELECT smo_id, headline, summary FROM themes WHERE user_id = ? ORDER BY smo_id, sort_order').all(user.id);
  const pointers = db.prepare(`SELECT sp.smo_id, sp.target_type, sp.target_id FROM source_pointers sp
    JOIN smos s ON s.id = sp.smo_id WHERE s.user_id = ?`).all(user.id);
  const rawRows = withSources
    ? db.prepare('SELECT * FROM raw_sources WHERE user_id = ? ORDER BY source_date').all(user.id)
    : [];
  const rawById = new Map(rawRows.map(r => [r.id, r]));

  const smos = rows.map(r => ({ ...r, themes: [], children: [], sources: [] }));
  const smoById = new Map(smos.map(s => [s.id, s]));
  for (const t of themes) smoById.get(t.smo_id)?.themes.push({ headline: t.headline, summary: t.summary });
  for (const p of pointers) {
    const s = smoById.get(p.smo_id);
    if (!s) continue;
    if (p.target_type === 'smo' && byId.has(p.target_id)) {
      const c = byId.get(p.target_id);
      s.children.push({ id: c.id, layer: c.layer, headline: c.headline, date_range_start: c.date_range_start, date_range_end: c.date_range_end });
    } else if (p.target_type === 'raw_source' && rawById.has(p.target_id)) {
      s.sources.push({ raw_source_id: p.target_id, source_type: rawById.get(p.target_id).source_type });
    }
  }
  for (const s of smos) s.children.sort((a, b) => a.date_range_start.localeCompare(b.date_range_start));

  const sources = rawRows.map(r => ({ ...r, metadata: parseMaybeJson(r.metadata) ?? {} }));
  log(`${smos.length} memories, ${sources.length} sources`);
  return { smos, sources };
}

// ── main ────────────────────────────────────────────────────────────────────

export async function cmdExport(args, config, apiFetch) {
  const outDir = typeof args.out === 'string' ? args.out : 'notes-export';
  const log = (...a) => console.error(...a);

  let smos, sources;
  try {
    ({ smos, sources } = typeof args.db === 'string'
      ? await loadFromDb(args, log)
      : await loadFromApi(args, config, apiFetch, log));
  } catch (err) {
    log(`Error: ${err.message}`);
    process.exit(1);
  }

  writeExport(smos, sources, outDir);
  log(`\nExported ${smos.length} memories and ${sources.length} sources to ${outDir}/`);
}

export function writeExport(smos, sources, outDir) {
  // Assign file paths (deduplicating names) and build cross-reference maps.
  const used = new Set();
  const unique = p => {
    let candidate = p, n = 2;
    while (used.has(candidate)) candidate = p.replace(/\.md$/, `-${n++}.md`);
    used.add(candidate);
    return candidate;
  };

  const ctx = {
    smoPath: new Map(), sourcePath: new Map(), sourceTitle: new Map(),
    parentsOf: new Map(), smosOfSource: new Map(),
  };
  for (const s of smos) {
    const dir = LAYER_DIR[s.layer] ?? `layer-${s.layer}`;
    ctx.smoPath.set(s.id, unique(join(outDir, 'memories', dir, `${s.date_range_start}_${slugify(s.headline)}.md`)));
  }
  for (const rs of sources) {
    const title = sourceTitle(rs);
    ctx.sourceTitle.set(rs.id, title);
    ctx.sourcePath.set(rs.id, unique(join(outDir, 'sources', slugify(rs.source_type, 30),
      `${rs.source_date}_${slugify(title, 50)}_${String(rs.id).slice(0, 8)}.md`)));
  }
  const push = (map, k, v) => { if (!map.has(k)) map.set(k, []); map.get(k).push(v); };
  for (const s of smos) {
    for (const c of s.children ?? []) push(ctx.parentsOf, c.id, s);
    for (const x of s.sources) push(ctx.smosOfSource, x.raw_source_id, s);
  }

  // 5. Write files.
  const write = (path, content) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); };
  for (const s of smos) write(ctx.smoPath.get(s.id), renderSmo(s, ctx));
  for (const rs of sources) write(ctx.sourcePath.get(rs.id), renderSource(rs, ctx));
  write(join(outDir, 'index.md'), renderIndex(smos, sources, ctx, outDir));

}
