#!/usr/bin/env node
// notes — CLI wrapper for the Notes App agent API
// Usage: notes <command> [options]
// Config stored in ~/.notes/config.json

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

const CONFIG_DIR = join(homedir(), '.notes');
const CONFIG_FILE = join(CONFIG_DIR, 'config.json');

function loadConfig() {
  if (!existsSync(CONFIG_FILE)) return {};
  try { return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}

function saveConfig(config) {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function parseArgs(argv) {
  const args = { _: [] };
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i += 2;
      } else {
        args[key] = true;
        i++;
      }
    } else {
      args._.push(arg);
      i++;
    }
  }
  return args;
}

async function apiFetch(path, config) {
  const apiUrl = config['api-url'] ?? 'https://notes-api.lost2038.com';
  const apiKey = config['api-key'];
  if (!apiKey) {
    console.error('Error: no API key configured. Run: notes config set api-key <key>');
    process.exit(1);
  }

  const url = `${apiUrl}/agent${path}`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!resp.ok) {
    console.error(`API error ${resp.status}: ${await resp.text()}`);
    process.exit(1);
  }

  return resp.json();
}

async function cmdContext(args, config) {
  const params = new URLSearchParams();
  if (args.query) params.set('q', args.query);
  if (args.budget) params.set('budget', args.budget);
  if (args.layer) params.set('layer', args.layer);
  if (args.from) params.set('from', args.from);

  if (args.to) {
    params.set('to', args.to);
  } else if (args.since) {
    const match = args.since.match(/^(\d+)(day|week|month)s?$/i);
    if (match) {
      const n = parseInt(match[1], 10);
      const unit = match[2].toLowerCase();
      const d = new Date();
      if (unit === 'day') d.setDate(d.getDate() - n);
      else if (unit === 'week') d.setDate(d.getDate() - n * 7);
      else if (unit === 'month') d.setMonth(d.getMonth() - n);
      params.set('from', d.toISOString().slice(0, 10));
    }
  }

  const data = await apiFetch(`/context?${params}`, config);
  console.log(data.context);
  console.error(`\n[tokens_used: ${data.tokens_used}]`);
}

async function cmdHierarchy(args, config) {
  const params = new URLSearchParams();
  if (args.from) params.set('from', args.from);
  if (args.to) params.set('to', args.to);

  const data = await apiFetch(`/hierarchy?${params}`, config);
  for (const layer of [3, 2, 1]) {
    const key = `layer${layer}`;
    if (data[key]?.length) {
      console.log(`\n=== Layer ${layer} ===`);
      for (const smo of data[key]) {
        console.log(`  [${smo.date_range_start}${smo.date_range_end !== smo.date_range_start ? ` – ${smo.date_range_end}` : ''}] ${smo.headline}  (${smo.id})`);
      }
    }
  }
}

async function cmdSmo(args, config) {
  const [, id] = args._;
  if (!id) { console.error('Usage: notes smo <id> [--depth 0|1|2]'); process.exit(1); }
  const depth = args.depth ?? '0';
  const data = await apiFetch(`/smo/${id}?depth=${depth}`, config);
  console.log(JSON.stringify(data, null, 2));
}

async function cmdConfig(args) {
  const [, action, key, value] = args._;
  const config = loadConfig();

  if (action === 'set') {
    if (!key || value === undefined) { console.error('Usage: notes config set <key> <value>'); process.exit(1); }
    config[key] = value;
    saveConfig(config);
    console.log(`Set ${key}`);
  } else if (action === 'get') {
    console.log(config[key] ?? '(not set)');
  } else if (action === 'list' || !action) {
    for (const [k, v] of Object.entries(config)) {
      // Mask api key
      console.log(`${k} = ${k === 'api-key' ? v.slice(0, 8) + '...' : v}`);
    }
  } else {
    console.error('Usage: notes config [set|get|list] [key] [value]');
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const config = loadConfig();

  switch (command) {
    case 'context':   return cmdContext(args, config);
    case 'hierarchy': return cmdHierarchy(args, config);
    case 'smo':       return cmdSmo(args, config);
    case 'config':    return cmdConfig(args);
    default:
      console.log(`notes — Notes App CLI

Commands:
  notes context --query <text> [--budget <n>] [--since <1week>] [--from <date>] [--to <date>] [--layer 1|2|3]
  notes hierarchy [--from <date>] [--to <date>]
  notes smo <id> [--depth 0|1|2]
  notes config set api-key <key>
  notes config set api-url <url>
  notes config list`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
