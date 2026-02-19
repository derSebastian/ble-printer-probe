#!/usr/bin/env node
/**
 * BLE Printer Probe — CLI
 *
 * Usage:
 *   node cli.js                     scan — list all nearby BLE devices with match badges
 *   node cli.js <Name>              identify — GATT dump + profile match + config snippet
 *   node cli.js <Name> --print      identify + send test print
 *   node cli.js <Name> --discover   interactive discovery: interview + protocol probing + GitHub JSON
 *   node cli.js --list              list known profiles
 *   node cli.js --update-profiles   force-fetch latest profiles from remote
 *   node cli.js <Name> --save       identify + save new profile to profiles.json
 */
'use strict';

const noble    = require('@abandonware/noble');
const fs       = require('fs');
const https    = require('https');
const path     = require('path');
const readline = require('readline');

const PROFILES_PATH = path.join(__dirname, 'profiles.json');
const PROFILES_URL  = 'https://raw.githubusercontent.com/your-org/ble-printer-probe/main/profiles.json';
const PROFILES_TTL  = 7 * 24 * 60 * 60 * 1000; // 7 days
const SCAN_TIMEOUT  = 20000;

// ── Args ──────────────────────────────────────────────────────────────────────

const args          = process.argv.slice(2);
const listMode      = args.includes('--list');
const saveMode      = args.includes('--save');
const printMode     = args.includes('--print');
const discoverMode  = args.includes('--discover');
const updateMode    = args.includes('--update-profiles');
const targetName    = args.find(a => !a.startsWith('--')) || null;

// ── Profiles ──────────────────────────────────────────────────────────────────

function loadProfiles() {
    try { return JSON.parse(fs.readFileSync(PROFILES_PATH, 'utf8')); }
    catch { return { version: 1, profiles: {} }; }
}

function saveProfiles(db) {
    fs.writeFileSync(PROFILES_PATH, JSON.stringify(db, null, 2));
}

function fetchRemoteProfiles() {
    return new Promise((resolve, reject) => {
        const req = https.get(PROFILES_URL, { timeout: 5000 }, res => {
            if (res.statusCode !== 200) {
                reject(new Error(`HTTP ${res.statusCode}`));
                res.resume();
                return;
            }
            let raw = '';
            res.on('data', chunk => raw += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(raw);
                    if (!parsed.version || !parsed.profiles) throw new Error('Invalid format');
                    resolve(parsed);
                } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

async function loadProfilesMaybeUpdate() {
    const local = loadProfiles();

    // Check if an update is warranted
    const stat  = fs.statSync(PROFILES_PATH, { throwIfNoEntry: false });
    const ageMs = stat ? Date.now() - stat.mtimeMs : Infinity;
    if (!updateMode && ageMs < PROFILES_TTL) return local;

    try {
        const remote = await fetchRemoteProfiles();
        const localCount  = Object.keys(local.profiles).length;
        const remoteCount = Object.keys(remote.profiles).length;

        if (remote.version > local.version || remoteCount > localCount) {
            saveProfiles(remote);
            const tag = updateMode ? 'Updated' : 'Auto-updated';
            console.log(`✓ Profiles ${tag}: v${remote.version}, ${remoteCount} profile(s)\n`);
            return remote;
        } else if (updateMode) {
            console.log(`Profiles already current (v${local.version}, ${localCount} profile(s))\n`);
        }
    } catch (e) {
        if (updateMode) console.warn(`Could not fetch remote profiles: ${e.message}\n`);
        // silently fall back to local otherwise
    }

    return local;
}

function normUuid(uuid) {
    let hex = uuid.replace(/-/g, '').toLowerCase();
    // Expand Bluetooth SIG short UUIDs (16-bit or 32-bit) to full 128-bit form
    if (hex.length === 4)  hex = `0000${hex}00001000800000805f9b34fb`;
    if (hex.length === 8)  hex = `${hex}00001000800000805f9b34fb`;
    if (hex.length !== 32) return uuid.toLowerCase();
    return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

/** Returns ALL profiles whose serviceUuid appears in the given list. */
function matchAllProfiles(serviceUuids, db) {
    const normed = serviceUuids.map(normUuid);
    return Object.values(db.profiles).filter(p => normed.includes(normUuid(p.ble.serviceUuid)));
}

function ghUrl(deviceName, snippet) {
    const title = `New printer: ${deviceName}`;

    // Short service prefixes — enough to identify the family
    const services = (snippet.services || []).slice(0, 4).map(u => u.slice(0, 8)).join(' ');

    // Confirmed chars: protocol@uuidprefix
    const confirmed = (snippet.confirmedChars || [])
        .map(c => `${c.protocol}@${c.uuid.slice(0, 8)}`).join(' ') || 'none';

    // Capabilities that tested true, space-separated
    const caps = snippet.capabilities
        ? Object.entries(snippet.capabilities).filter(([, v]) => v === true).map(([k]) => k).join(' ')
        : null;

    const body = [
        `Device: ${deviceName}`,
        services  ? `Services: ${services}`   : null,
        `Confirmed: ${confirmed}`,
        caps      ? `Capabilities: ${caps}`   : null,
        ``,
        `Brand: `,
        `Model: `,
        `App: `,
        `Paper retraction before first print (y/n): `,
    ].filter(l => l !== null).join('\n');

    return `https://github.com/your-org/ble-printer-probe/issues/new` +
           `?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
}

// ── Interactive prompt helper ─────────────────────────────────────────────────

function ask(rl, question) {
    return new Promise(resolve => rl.question(question, resolve));
}

// ── Test print builders ───────────────────────────────────────────────────────

function escPosPrintBuffer(chunkSize, chunkDelay, label = 'BLE PROBE') {
    const buf = Buffer.concat([
        Buffer.from([0x1B, 0x40]),              // ESC @ — init
        Buffer.from([0x1B, 0x21, 0x00]),        // ESC ! — normal weight
        Buffer.from(`${label}\n`, 'ascii'),
        Buffer.from([0x1B, 0x4A, 0x40]),        // ESC J 64 — feed
        Buffer.from([0x1D, 0x56, 0x41, 0x0A]), // GS V A — partial cut
    ]);
    return [{ name: 'print', buf, chunk: chunkSize, delay: chunkDelay, pauseAfter: 0 }];
}

// ESC/POS capability tests — one print per test, one unambiguous question.
// Code-page / symbol tests are omitted: whether a symbol looks "correct" is
// language/region-dependent and has no universal yes/no answer.
// Returns { tests: [{key, testN, buf, question}], finalN }.
function escPosCapabilityTests(testNStart) {
    const tests = [];
    let n = testNStart;

    const FEED = Buffer.from([0x1B, 0x4A, 0x40]);          // ESC J — feed
    const CUT  = Buffer.from([0x1D, 0x56, 0x41, 0x0A]);    // GS V A — partial cut

    // Build and push one test. Label uses the post-increment value of n.
    const add = (key, mode, modeOff, question) => {
        n++;
        const label = `TEST ${n}`;
        const buf = Buffer.concat([
            Buffer.from([0x1B, 0x40]),   // ESC @ — init / reset all settings
            Buffer.from(mode),
            Buffer.from(`${label}\n`, 'ascii'),
            Buffer.from(modeOff),
            FEED, CUT,
        ]);
        tests.push({ key, testN: n, buf, question });
    };

    // Bold — text is visibly heavier regardless of language
    add('bold',
        [0x1B, 0x21, 0x08],   // ESC ! bold on
        [0x1B, 0x21, 0x00],   // reset
        'Does the text on the paper look noticeably thicker or heavier? (y/n): ',
    );

    // Double-wide — text occupies twice the horizontal space; universal
    add('doubleWide',
        [0x1B, 0x21, 0x20],   // ESC ! double-wide
        [0x1B, 0x21, 0x00],
        'Is the text stretched sideways — taking up noticeably more width on the paper? (y/n): ',
    );

    // Double-height — text occupies twice the vertical space; universal
    add('doubleHeight',
        [0x1B, 0x21, 0x10],   // ESC ! double-height
        [0x1B, 0x21, 0x00],
        'Is the text taller — taking up noticeably more vertical space on the paper? (y/n): ',
    );

    // Underline — either a line appears beneath the text or it doesn't
    add('underline',
        [0x1B, 0x2D, 0x01],   // ESC - underline on
        [0x1B, 0x2D, 0x00],   // underline off
        'Is there a visible line drawn directly beneath the text? (y/n): ',
    );

    return { tests, finalN: n };
}

function d1TestStages() {
    // 32-row image: black border around white field
    const PB = 48; // paper bytes (384px / 8)
    const H  = 32;
    const bmp = Buffer.alloc(PB * H, 0xFF); // white
    // Top + bottom border (2 rows each)
    for (let r = 0; r < 2; r++)
        for (let b = 0; b < PB; b++) { bmp[r * PB + b] = 0x00; bmp[(H - 1 - r) * PB + b] = 0x00; }
    // Left + right border (first and last byte of each row)
    for (let r = 0; r < H; r++) { bmp[r * PB] = 0x00; bmp[r * PB + PB - 1] = 0x00; }

    const wLE = PB & 0xFF, wHi = (PB >> 8) & 0xFF;
    const hLE = H  & 0xFF, hHi = (H  >> 8) & 0xFF;
    return [
        { name: 'init',      buf: Buffer.from([0x10,0xFF,0xF1,0x03, 0x10,0xFF,0x10,0x00,0x01]),                chunk: 20,  delay: 80,  pauseAfter: 500  },
        { name: 'wake',      buf: Buffer.alloc(1024, 0x00),                                                     chunk: 200, delay: 30,  pauseAfter: 1000 },
        { name: 'image',     buf: Buffer.concat([Buffer.from([0x1D,0x76,0x30,0x00, wLE,wHi,hLE,hHi]), bmp]),   chunk: 200, delay: 30,  pauseAfter: 500  },
        { name: 'feed+stop', buf: Buffer.concat([Buffer.from([0x1B,0x4A,0x64]), Buffer.from([0x10,0xFF,0xF1,0x45])]), chunk: 20, delay: 80, pauseAfter: 0 },
    ];
}

// ── BLE send helpers ──────────────────────────────────────────────────────────

function sendChunked(char, buf, chunkSize, delayMs, cb) {
    const chunks = [];
    for (let i = 0; i < buf.length; i += chunkSize) chunks.push(buf.slice(i, i + chunkSize));
    let ci = 0;
    function next() {
        if (ci >= chunks.length) return cb(null);
        char.write(chunks[ci++], true, err => err ? cb(err) : setTimeout(next, delayMs));
    }
    next();
}

function runStages(writeChar, stages) {
    return new Promise((resolve, reject) => {
        let si = 0;
        function nextStage() {
            if (si >= stages.length) return resolve();
            const stage = stages[si++];
            process.stdout.write(`  [${stage.name}] `);
            sendChunked(writeChar, stage.buf, stage.chunk, stage.delay, err => {
                if (err) return reject(err);
                process.stdout.write(`done\n`);
                setTimeout(nextStage, stage.pauseAfter || 10);
            });
        }
        nextStage();
    });
}

// ── Output helpers ────────────────────────────────────────────────────────────

const LINE = '─'.repeat(60);

function printSnippet(deviceName, snippet) {
    console.log(`\n${LINE}`);
    console.log('Paste into config.json:');
    console.log(JSON.stringify(snippet, null, 2));
    console.log(LINE);
    console.log('\nSubmit to community:');
    console.log(ghUrl(deviceName, snippet) + '\n');
}

// ── --update-profiles mode ────────────────────────────────────────────────────

if (updateMode) {
    (async () => {
        await loadProfilesMaybeUpdate();
        process.exit(0);
    })();
}

// ── --list mode ───────────────────────────────────────────────────────────────

else if (listMode) {
    (async () => {
        const db       = await loadProfilesMaybeUpdate();
        const profiles = Object.values(db.profiles);
        console.log(`\nKnown BLE printer profiles (v${db.version}) — ${profiles.length} total\n`);
        for (const p of profiles) {
            const tag = p.notes?.includes('Unimplemented') ? '  [identification only]' : '';
            console.log(`  [${p.id}]  ${p.name}${tag}`);
            console.log(`    Protocol:  ${p.protocol}`);
            console.log(`    Service:   ${p.ble.serviceUuid}`);
            console.log(`    Write:     ${p.ble.writeCharUuid}`);
            if (p.ble.notifyCharUuid) console.log(`    Notify:    ${p.ble.notifyCharUuid}`);
            console.log(`    Chunk:     ${p.ble.chunkSize}b / ${p.ble.chunkDelay}ms  MTU: ${p.ble.mtu}`);
            if (p.variants) console.log(`    Variants:  ${p.variants.join(', ')}`);
            if (p.notes)    console.log(`    Notes:     ${p.notes}`);
            console.log();
        }
        process.exit(0);
    })();
}

// ── Scan-only mode ────────────────────────────────────────────────────────────

else if (!targetName) {
    console.log(`Scanning for BLE devices (${SCAN_TIMEOUT / 1000}s)...\n`);
    const seen = new Map();
    let db;

    loadProfilesMaybeUpdate().then(loaded => { db = loaded; });

    noble.on('stateChange', state => {
        if (state === 'poweredOn') noble.startScanning([], false);
        else { console.error(`BLE state: ${state}`); process.exit(1); }
    });

    noble.on('discover', peripheral => {
        const name = peripheral.advertisement.localName;
        if (!name || seen.has(peripheral.id)) return;
        seen.set(peripheral.id, true);

        // Match against advertised service UUIDs (may be partial / empty for many printers)
        const advUuids = (peripheral.advertisement.serviceUuids || []).map(normUuid);
        const matches  = advUuids.length ? matchAllProfiles(advUuids, db) : [];
        const badge    = matches.length ? `  [${matches.map(m => m.id).join('+')}]` : '';

        const sig = peripheral.rssi > -50 ? 'strong' :
                    peripheral.rssi > -70 ? 'good'   :
                    peripheral.rssi > -85 ? 'weak'   : 'very weak';
        console.log(`  ${name.padEnd(28)} RSSI: ${String(peripheral.rssi).padStart(4)} dBm  (${sig})${badge}`);
    });

    setTimeout(() => {
        noble.stopScanning();
        console.log(`\nDone. Found ${seen.size} named device(s).`);
        console.log(`To identify:   node cli.js <DeviceName>`);
        console.log(`To test print: node cli.js <DeviceName> --print`);
        console.log(`To discover:   node cli.js <DeviceName> --discover`);
        process.exit(0);
    }, SCAN_TIMEOUT);

    return; // halt top-level execution (Node wraps modules in a function)
}

// ── Identify / print / discover mode ─────────────────────────────────────────

else {

const modeLabel = discoverMode ? 'discover' : printMode ? 'print' : 'identify';
console.log(`\nScanning for "${targetName}" [${modeLabel}]...\n`);

noble.on('stateChange', state => {
    if (state === 'poweredOn') noble.startScanning([], false);
    else { console.error(`BLE state: ${state}`); process.exit(1); }
});

noble.on('discover', peripheral => {
    const name = peripheral.advertisement.localName || '';
    if (!name.includes(targetName)) return;

    clearTimeout(scanTimer);
    noble.stopScanning();
    console.log(`Found: ${name}  (${peripheral.id})\n`);

    peripheral.connect(err => {
        if (err) { console.error('Connect error:', err); process.exit(1); }
        peripheral.discoverAllServicesAndCharacteristics((_e, services, characteristics) => {
            handleDevice(peripheral, name, services, characteristics).catch(e => {
                console.error('Error:', e.message);
                peripheral.disconnect(() => process.exit(1));
            });
        });
    });

    peripheral.on('disconnect', () => { console.log('Disconnected.'); });
});

async function handleDevice(peripheral, deviceName, services, characteristics) {
    const db           = await loadProfilesMaybeUpdate();
    const serviceUuids = services.map(s => normUuid(s.uuid));
    const chars        = characteristics.map(c => ({
        uuid:       normUuid(c.uuid),
        properties: c.properties,
        _char:      c,
    }));

    // ── GATT dump ─────────────────────────────────────────────────────────────

    console.log('Services:');
    serviceUuids.forEach(u => console.log(`  ${u}`));
    console.log('\nCharacteristics:');
    chars.forEach(c => console.log(`  ${c.uuid}  [${c.properties.join(', ')}]`));
    console.log();

    // ── Device Information Service (180a) — always read if present ────────────

    const DIS_CHARS = { '2a29': 'manufacturer', '2a24': 'model', '2a26': 'firmware', '2a25': 'serial' };
    const deviceInfo = {};
    const disChars   = chars.filter(c => DIS_CHARS[c.uuid]);

    if (disChars.length) {
        for (const c of disChars) {
            const val = await new Promise(resolve => {
                c._char.read((err, data) => resolve(err ? null : data?.toString('utf8').replace(/\0/g, '').trim()));
            });
            if (val) deviceInfo[DIS_CHARS[c.uuid]] = val;
        }
        if (Object.keys(deviceInfo).length) {
            console.log('Device info (180a):');
            for (const [k, v] of Object.entries(deviceInfo)) console.log(`  ${k.padEnd(12)} ${v}`);
            console.log();
        }
    }

    // ── Profile matching — all matches ────────────────────────────────────────

    const matches   = matchAllProfiles(serviceUuids, db);
    const writable  = chars.filter(c => c.properties.includes('write') || c.properties.includes('writeWithoutResponse'));
    const notifyable = chars.filter(c => c.properties.includes('notify'));

    if (matches.length) {
        console.log(`✓ ${matches.length === 1 ? 'Matches profile' : `Matches ${matches.length} profiles`}:`);
        for (const m of matches) {
            console.log(`  [${m.id}]  ${m.name}`);
            console.log(`    Protocol: ${m.protocol}  |  ${m.paper.widthMm}mm / ${m.paper.widthPx}px  |  chunk ${m.ble.chunkSize}b/${m.ble.chunkDelay}ms  MTU: ${m.ble.mtu}`);
            if (m.notes) console.log(`    Notes:    ${m.notes}`);
        }
    } else {
        console.log('? No matching profile found.');
    }

    // ── Build config snippet ──────────────────────────────────────────────────

    const primary = matches[0] || null;
    let snippet;

    if (primary) {
        snippet = { printer: { transport: 'ble', ble: { deviceName, activeProfile: primary.id } } };
        if (matches.length > 1) {
            snippet._allProfiles = matches.map(m => m.id);
            snippet._note        = `Device supports ${matches.length} profiles. Change activeProfile to switch.`;
        }
    } else {
        snippet = {
            deviceName,
            bleId:           peripheral.id,
            services:        serviceUuids,
            characteristics: chars.map(c => ({ uuid: c.uuid, properties: c.properties })),
            candidateWrite:  writable[0]?.uuid   || null,
            candidateNotify: notifyable[0]?.uuid  || null,
        };
    }

    // ── --print mode ──────────────────────────────────────────────────────────

    if (printMode) {
        if (!primary) {
            console.log('\n--print requires an identified profile. Run without --print first to confirm the profile.');
        } else {
            console.log(`\nSending test print via [${primary.id}] (${primary.protocol})...`);
            const writeCharObj  = chars.find(c => normUuid(c.uuid) === normUuid(primary.ble.writeCharUuid));
            const notifyCharObj = primary.ble.notifyCharUuid
                ? chars.find(c => normUuid(c.uuid) === normUuid(primary.ble.notifyCharUuid))
                : null;

            if (!writeCharObj) {
                console.log(`✗ Write characteristic ${primary.ble.writeCharUuid} not found on device.`);
            } else {
                const run = async () => {
                    if (primary.protocol === 'd1') {
                        await runStages(writeCharObj._char, d1TestStages());
                    } else {
                        await runStages(writeCharObj._char, escPosPrintBuffer(primary.ble.chunkSize, primary.ble.chunkDelay));
                    }
                    console.log('✓ Test print sent — check printer.');
                };

                if (notifyCharObj) {
                    await new Promise(resolve => notifyCharObj._char.subscribe(() => resolve()));
                }
                await run();
            }
        }
    }

    // ── --discover mode ───────────────────────────────────────────────────────

    if (discoverMode) {
        await runDiscoveryFlow(peripheral, deviceName, serviceUuids, chars, writable, notifyable, matches, db, deviceInfo);
        return; // disconnect handled inside
    }

    // ── Standard output ───────────────────────────────────────────────────────

    printSnippet(deviceName, snippet);

    if (saveMode) {
        if (primary) {
            console.log(`Profile "${primary.id}" already in database — no change.`);
        } else {
            const newId = deviceName.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 24);
            db.profiles[newId] = {
                id:                newId,
                name:              `${deviceName} (community)`,
                deviceNamePattern: deviceName,
                protocol:          'unknown',
                ble: {
                    serviceUuid:    snippet.services?.[0] || '',
                    writeCharUuid:  snippet.candidateWrite  || '',
                    notifyCharUuid: snippet.candidateNotify || null,
                    chunkSize: 20, chunkDelay: 80, mtu: 23,
                },
                paper:  { widthPx: 384, widthMm: 58 },
                notes:  'Auto-discovered. Protocol unknown.',
            };
            saveProfiles(db);
            console.log(`✓ Saved profile "${newId}" to profiles.json`);
        }
    }

    peripheral.disconnect(() => process.exit(0));
}

// ── Discovery flow — unified: always probe, known or not ─────────────────────
// The user told us it's a printer. Our job: find what actually works on it.
// 1. Show what we already know (profile matches)
// 2. Try known protocol chars first (test print)
// 3. Probe any remaining writable chars (ESC/POS → D1 → GT01)
// 4. Collect context (model, app, paper width) — pre-filled from 180a where possible
// 5. Output full discovery document + GitHub URL

async function runDiscoveryFlow(peripheral, deviceName, serviceUuids, chars, writable, notifyable, matches, db, deviceInfo) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    console.log(`\n${LINE}`);
    console.log('DISCOVERY');
    console.log(`${LINE}\n`);

    // ── Context questions (pre-fill from 180a where possible) ────────────────

    const modelDefault   = deviceInfo.model        ? ` (Enter for "${deviceInfo.model}")` : ' (or Enter to skip)';
    const modelNumber    = await ask(rl, `Model number from sticker${modelDefault}: `) || deviceInfo.model || null;
    const brandName      = await ask(rl, 'Brand name on the box/packaging (e.g. Peripage, Phomemo, HPRT, or skip): ');
    const paperWidthMm   = await ask(rl, 'Paper roll width in mm — 58 or 80 (Enter for 58): ') || '58';
    const appName        = await ask(rl, 'App used to print from phone (e.g. iPrint, PrinterOn, or skip): ');

    // ── Phase 1: test known matched protocols ─────────────────────────────────

    const probingResults  = {};
    const confirmedChars  = []; // { uuid, protocol }
    let testN = 0; // global test counter so each print has a unique label

    if (matches.length) {
        console.log(`\nKnown profile(s) matched: ${matches.map(m => m.id).join(', ')}`);
        console.log('Sending one test print per protocol — watch the paper.\n');
    }

    for (const m of matches) {
        const writeCharObj  = chars.find(c => c.uuid === normUuid(m.ble.writeCharUuid));
        const notifyCharObj = m.ble.notifyCharUuid ? chars.find(c => c.uuid === normUuid(m.ble.notifyCharUuid)) : null;
        if (!writeCharObj) { console.log(`  [${m.id}] write char not found — skipping`); continue; }

        testN++;
        const label = `TEST ${testN}`;
        console.log(`  Sending ${label} via [${m.id}] (${writeCharObj.uuid})...`);

        const go = async () => {
            if (m.protocol === 'd1') {
                await runStages(writeCharObj._char, d1TestStages()).catch(() => {});
            } else {
                await runStages(writeCharObj._char, escPosPrintBuffer(m.ble.chunkSize, m.ble.chunkDelay, label)).catch(() => {});
            }
        };
        if (notifyCharObj) await new Promise(r => notifyCharObj._char.subscribe(() => r()));
        await go();
        await new Promise(r => setTimeout(r, 1500)); // let printer flush before asking

        const confirmQ = m.protocol === 'd1'
            ? `  ${label}: Did a black rectangular border print on the paper? (y/n): `
            : `  ${label}: Did the text "${label}" appear on the paper? (y/n): `;
        const r = await ask(rl, confirmQ);
        const worked = r.toLowerCase().startsWith('y');
        probingResults[writeCharObj.uuid] = { protocol: m.protocol, profile: m.id, result: worked ? 'printed' : 'no_response' };
        if (worked) confirmedChars.push({ uuid: writeCharObj.uuid, protocol: m.protocol });
    }

    // ── Phase 2: probe writable chars not covered by a known profile ──────────

    const knownWriteUuids = new Set(matches.map(m => normUuid(m.ble.writeCharUuid)));
    const unprobed        = writable.filter(c => !knownWriteUuids.has(c.uuid));

    if (unprobed.length) {
        console.log(`\n${LINE}`);
        console.log(`PROBING ${unprobed.length} unrecognised writable char(s) — watch the printer.\n`);

        // Round A — ESC/POS: numbered print per char, one at a time.
        // If the printer prints the label text, ESC/POS is confirmed.
        console.log(`Round A: ESC/POS — sending a numbered text print to each char\n`);
        for (const c of unprobed) {
            testN++;
            const label = `TEST ${testN}`;
            console.log(`  Sending ${label} to ${c.uuid}...`);
            let writeErr = false;
            await runStages(c._char, escPosPrintBuffer(20, 80, label)).catch(() => { writeErr = true; });
            if (writeErr) {
                probingResults[c.uuid] = { escPos: 'write_error' };
                console.log('  ✗ write error — skipping');
                continue;
            }
            const r = await ask(rl, `  ${label}: Did the text "${label}" appear on the paper? (y/n): `);
            const worked = r.toLowerCase().startsWith('y');
            probingResults[c.uuid] = { escPos: worked ? 'printed' : 'no_response' };
            if (worked) confirmedChars.push({ uuid: c.uuid, protocol: 'escpos' });
        }

        // Round B — D1 family: full staged test print on ff02.
        // Sends init + wake + black border bitmap + feed+stop.
        // A black rectangular border on white paper = confirmed D1 protocol.
        const ff01 = chars.find(c => c.uuid === normUuid('ff01'));
        const ff02 = unprobed.find(c => c.uuid === normUuid('ff02'));
        if (ff02 && !confirmedChars.length) {
            testN++;
            console.log(`\nRound B: D1 family — sending TEST ${testN} (black rectangular border) via ff02...`);
            let notifyFired = false;
            if (ff01) {
                ff01._char.on('data', () => { notifyFired = true; });
                await new Promise(resolve => ff01._char.subscribe(() => resolve()));
                await new Promise(resolve => setTimeout(resolve, 200));
            }
            let ljErr = false;
            await runStages(ff02._char, d1TestStages()).catch(() => { ljErr = true; });
            if (ljErr) {
                probingResults[ff02.uuid] = { d1: 'write_error' };
                console.log('  ✗ write error');
            } else {
                if (notifyFired) console.log('  Notify received during send.');
                const r = await ask(rl, `  TEST ${testN}: Did a black rectangular border appear on the paper? (y/n): `);
                const worked = r.toLowerCase().startsWith('y');
                probingResults[ff02.uuid] = { d1: worked ? 'printed' : (notifyFired ? 'notify_only' : 'no_response') };
                if (worked) confirmedChars.push({ uuid: ff02.uuid, protocol: 'd1' });
            }
        }

        // Round C — GT01: enable + feed command on ae01.
        // A device-state query packet. If paper advances ~5mm, GT01 protocol confirmed.
        const ae01 = unprobed.find(c => c.uuid === normUuid('ae01'));
        if (ae01 && !confirmedChars.length) {
            testN++;
            console.log(`\nRound C: GT01 — sending TEST ${testN} (feed command) via ae01...`);
            // GT01 packet: 51 78 [cmd] 00 [len] 00 [data] [CRC8] FF
            // BD = feedPaper, 01 = 1 line
            const gt01Feed = Buffer.from([0x51, 0x78, 0xBD, 0x00, 0x01, 0x00, 0x01, 0xBD, 0xFF]);
            let gt01Err = false;
            await new Promise(resolve => {
                sendChunked(ae01._char, gt01Feed, 20, 80, err => { gt01Err = !!err; resolve(); });
            });
            if (gt01Err) {
                probingResults[ae01.uuid] = { gt01: 'write_error' };
                console.log('  ✗ write error');
            } else {
                const r = await ask(rl, `  TEST ${testN}: Did the paper advance by a few millimetres? (y/n): `);
                const worked = r.toLowerCase().startsWith('y');
                probingResults[ae01.uuid] = { gt01: worked ? 'paper_advanced' : 'no_response' };
                if (worked) confirmedChars.push({ uuid: ae01.uuid, protocol: 'gt01' });
            }
        }
    }

    // ── Phase 3: ESC/POS capability tests on first confirmed char ────────────
    // Only runs if ESC/POS is confirmed. Tests bold, wide, tall, underline.
    // Each is one print → one unambiguous yes/no question.

    const capabilities   = {};
    const escPosConfirmed = confirmedChars.find(c => c.protocol === 'escpos');
    if (escPosConfirmed) {
        const writeChar = chars.find(c => c.uuid === escPosConfirmed.uuid);
        if (writeChar) {
            console.log(`\n${LINE}`);
            console.log('ESC/POS CAPABILITY TESTS\n');

            const { tests: capTests } = escPosCapabilityTests(testN);
            for (const t of capTests) {
                testN = t.testN;
                console.log(`  Sending TEST ${testN}: ${t.key}...`);
                let err = false;
                await runStages(writeChar._char, [{ name: t.key, buf: t.buf, chunk: 20, delay: 80, pauseAfter: 500 }])
                    .catch(() => { err = true; });
                if (err) {
                    capabilities[t.key] = 'write_error';
                    console.log('  ✗ write error');
                    continue;
                }
                const r = await ask(rl, `  TEST ${testN}: ${t.question}`);
                capabilities[t.key] = r.toLowerCase().startsWith('y');
            }
        }
    }

    // ── Build discovery document ──────────────────────────────────────────────

    const discovery = {
        deviceName,
        bleId:           peripheral.id,
        deviceInfo:      Object.keys(deviceInfo).length ? deviceInfo : null,
        model:           modelNumber || null,
        brand:           brandName   || null,
        paperWidthMm:    parseInt(paperWidthMm, 10) || 58,
        app:             appName || null,
        profileMatches:  matches.map(m => m.id),
        confirmedChars:  confirmedChars.length ? confirmedChars : null,
        capabilities:    Object.keys(capabilities).length ? capabilities : null,
        services:        serviceUuids,
        characteristics: chars.map(c => ({ uuid: c.uuid, properties: c.properties })),
        probing:         probingResults,
    };

    rl.close();
    printSnippet(deviceName, discovery);
    console.log('Submit the snippet above via the GitHub link.\n');
    peripheral.disconnect(() => process.exit(0));
}

} // end else (identify/print/discover)

const scanTimer = setTimeout(() => {
    if (targetName) {
        console.log(`\nTimeout: "${targetName}" not found within ${SCAN_TIMEOUT / 1000}s.`);
        process.exit(1);
    }
}, SCAN_TIMEOUT);
