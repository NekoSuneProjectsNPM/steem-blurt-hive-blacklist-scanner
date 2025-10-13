#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const fetch = require('node-fetch'); // using node-fetch@2 for wide compatibility
const minimist = require('minimist');

// Default sources (user-provided in the prompt)
const DEFAULT_SOURCES = {
    blurt: process.env.BLURT_BLACKLIST_URL || 'https://coal.blurtwallet.com/',
    hive: process.env.HIVE_BLACKLIST_URL || 'https://spaminator.me/api/bl/all.json',
    steemit: process.env.STEEMIT_BLACKLIST_URL || null // currently none
};

// Simple in-memory cache to avoid repeated fetch during one run
const CACHE = {
    blurt: null,
    hive: null,
    fetchedAt: {}
};

// Utility: normalize username (strip leading @, lowercase, trim)
function normalize(name) {
    if (!name && name !== 0) return '';
    return String(name).trim().replace(/^@+/, '').toLowerCase();
}

// Fetch JSON with timeout and graceful parse
async function fetchJson(url, opts = {}) {
    const timeout = opts.timeout || 10000;
    const controller = new fetch.Request && null; // noop for compatibility
    // node-fetch v2 doesn't have global AbortController reliably; use simple timeout via Promise.race
    const p = fetch(url, { headers: { 'User-Agent': 'sbhs-scanner/1.0 (+https://github.com/)' } });
    const timer = new Promise((_, rej) => setTimeout(() => rej(new Error('Timeout')), timeout));
    return Promise.race([p, timer]).then(r => {
        if (!r) throw new Error('Empty response');
        if (r.ok && (r.headers.get('content-type') || '').includes('application/json')) return r.json();
        // try text, then parse
        return r.text().then(t => {
            try { return JSON.parse(t); } catch (e) {
                // if non-json, return as text
                return t;
            }
        });
    });
}

// Parse Blurt response: the prompt showed an array of objects: [{"name":"anikkhan16","reason":"FARM","notes":"..."}, ...]
function parseBlurt(data) {
    const users = new Map();
    if (Array.isArray(data)) {
        for (const item of data) {
            if (!item) continue;
            const raw = item.name || item.account || item.author || item.user || item.username;
            if (!raw) continue;
            const name = normalize(raw);
            users.set(name, { source: 'blurt', raw: item });
        }
    } else if (typeof data === 'object' && data !== null) {
        // Maybe object mapping
        for (const k of Object.keys(data)) {
            const name = normalize(k);
            users.set(name, { source: 'blurt', raw: data[k] });
        }
    }
    return users;
}

// Parse Hive response: example: {"result":["a-0-0","a-0-0-0-0-0-a", ...]}
function parseHive(data) {
    const users = new Map();
    if (!data) return users;
    if (Array.isArray(data)) {
        for (const raw of data) {
            const name = normalize(raw);
            users.set(name, { source: 'hive', raw });
        }
    } else if (typeof data === 'object' && data.result && Array.isArray(data.result)) {
        for (const raw of data.result) {
            const name = normalize(raw);
            users.set(name, { source: 'hive', raw });
        }
    } else if (typeof data === 'string') {
        // try newline-separated
        for (const raw of data.split(/\r?\n/)) { if (raw.trim()) { users.set(normalize(raw), { source: 'hive', raw }); } }
    }
    return users;
}

async function fetchBlurt(url = DEFAULT_SOURCES.blurt, force = false) {
    if (!url) return new Map();
    if (CACHE.blurt && !force) return CACHE.blurt;
    try {
        const json = await fetchJson(url);
        const parsed = parseBlurt(json);
        CACHE.blurt = parsed;
        CACHE.fetchedAt.blurt = new Date();
        return parsed;
    } catch (e) {
        // try a couple common endpoints under the base url
        try {
            const alt = url.endsWith('/') ? url + 'blacklist.json' : url + '/blacklist.json';
            const json2 = await fetchJson(alt);
            const parsed2 = parseBlurt(json2);
            CACHE.blurt = parsed2;
            CACHE.fetchedAt.blurt = new Date();
            return parsed2;
        } catch (err) {
            console.warn('Failed to fetch Blurt blacklist:', e.message || e);
            return new Map();
        }
    }
}

async function fetchHive(url = DEFAULT_SOURCES.hive, force = false) {
    if (!url) return new Map();
    if (CACHE.hive && !force) return CACHE.hive;
    try {
        const json = await fetchJson(url);
        const parsed = parseHive(json);
        CACHE.hive = parsed;
        CACHE.fetchedAt.hive = new Date();
        return parsed;
    } catch (e) {
        console.warn('Failed to fetch Hive blacklist:', e.message || e);
        return new Map();
    }
}

async function init(sources = {}) {
    const merged = Object.assign({}, DEFAULT_SOURCES, sources || {});
    const [b, h] = await Promise.all([
        fetchBlurt(merged.blurt, false),
        fetchHive(merged.hive, false)
    ]);
    return { blurt: b, hive: h };
}

// Check single username
async function checkUser(username, options = {}) {
    const name = normalize(username);
    if (!name) return { username, ok: false, reason: 'empty' };
    const sources = options.sources || DEFAULT_SOURCES;
    const blurt = await fetchBlurt(sources.blurt);
    const hive = await fetchHive(sources.hive);
    const found = [];
    if (blurt.has(name)) found.push({ source: 'blurt', data: blurt.get(name) });
    if (hive.has(name)) found.push({ source: 'hive', data: hive.get(name) });
    const ok = found.length === 0;
    return { username: name, ok, matches: found };
}

async function checkUsers(usernames, options = {}) {
    if (!Array.isArray(usernames)) throw new Error('usernames must be an array');
    const sources = options.sources || DEFAULT_SOURCES;
    // ensure blacklists fetched once
    const [blurt, hive] = await Promise.all([fetchBlurt(sources.blurt), fetchHive(sources.hive)]);
    const results = [];
    for (const u of usernames) {
        const name = normalize(u);
        if (!name) continue;
        const matches = [];
        if (blurt.has(name)) matches.push({ source: 'blurt', data: blurt.get(name) });
        if (hive.has(name)) matches.push({ source: 'hive', data: hive.get(name) });
        results.push({ username: name, ok: matches.length === 0, matches });
    }
    return results;
}

// CLI helper: read newline-separated list
function readUsersFromFileSync(filePath) {
    try {
        const txt = fs.readFileSync(filePath, 'utf8');
        return txt.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    } catch (e) {
        throw new Error('Failed to read file: ' + e.message);
    }
}

// Simple pretty print
function prettyPrint(results, format = 'plain') {
    if (format === 'json') return JSON.stringify(results, null, 2);
    const lines = [];
    for (const r of results) {
        if (r.ok) lines.push(`${r.username}: OK`);
        else {
            const sources = r.matches.map(m => m.source + (m.data && m.data.raw ? ` (${JSON.stringify(m.data.raw)})` : '')).join(', ');
            lines.push(`${r.username}: BLACKLISTED -> ${sources}`);
        }
    }
    return lines.join('\n');
}

// CLI entrypoint
async function cli(argv) {
    const args = minimist(argv.slice(2), {
        alias: { u: 'user', f: 'file', F: 'format', h: 'help' },
        default: { format: 'plain' }
    });
    if (args.help) {
        console.log('Usage:\n  sbhs-scan --user <username> | --file <file> [--format json|plain]');
        return;
    }
    let inputUsers = [];
    if (args.user) inputUsers = [args.user];
    else if (args.file) inputUsers = readUsersFromFileSync(path.resolve(process.cwd(), args.file));
    else {
        // read from stdin if available
        if (!process.stdin.isTTY) {
            const stdin = fs.readFileSync(0, 'utf8');
            inputUsers = stdin.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
        } else {
            console.error('No input. Use --user or --file or pipe a newline list to stdin.');
            process.exit(2);
        }
    }

    const results = await checkUsers(inputUsers, { sources: DEFAULT_SOURCES });
    const out = prettyPrint(results, args.format === 'json' ? 'json' : 'plain');
    console.log(out);
}

// Export as module
module.exports = {
    init,
    fetchBlurt,
    fetchHive,
    checkUser,
    checkUsers,
    DEFAULT_SOURCES
};

// If run directly, invoke CLI
if (require.main === module) {
    cli(process.argv).catch(err => { console.error('Error:', err.message || err); process.exit(1); });
}