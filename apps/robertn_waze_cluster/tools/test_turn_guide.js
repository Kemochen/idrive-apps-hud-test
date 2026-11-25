// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 minakoto
/**
 * Tests of src/turn_guide.js and src/render_link.js against the fake render
 * (tools/fakes.js): the reader asks BMW's guidance list for the next turn,
 * read-only, the way the SDK's proxy takes a call on a car, with the lanes
 * beside it, and counts a head unit without the list out for good; the
 * sync tells the render the turn while the turn card is in use and the HUD
 * map shows - through the page's connection while the page is open, else
 * through the app's one background connection, which the driving mode
 * shares - again while it lasts, a new one at once, none once; nothing is
 * read or told while the card is off or the map does not show; failing
 * reads are spaced out; the background connection gives the socket to the
 * page and leaves a render owned by another alone.
 * Run: node tools/test_turn_guide.js
 */
'use strict';

const assert = require('assert');
const { FakeRender, FakePatch } = require('./fakes.js');
const { WazeClusterControl } = require('../src/waze_cluster_control.js');
const { RenderLink } = require('../src/render_link.js');
const { DriveModeSync } = require('../src/drive_mode.js');
const { TurnGuideSync, turnReader, eventQuery, EVENTS_IFACE, LANES_IFACE, PHONE_LANES_IFACE, INSTANCE, LANES_WAIT_MS,
    CARPLAY, ANDROID_AUTO } = require('../src/turn_guide.js');

const RENDER = `/tmp/woc-tg-${process.pid}.sock`;
const PATCH = `/tmp/woc-tg-patch-${process.pid}.sock`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, check, ms) {
    const end = Date.now() + (ms || 3000);
    while (!check()) {
        if (Date.now() > end) throw new Error(`timed out: ${what}`);
        await sleep(5);
    }
}
const quiet = () => {
    const l = { lines: [] };
    l.info = (m) => l.lines.push(`info: ${m}`);
    l.warn = (m) => l.lines.push(`warn: ${m}`);
    return l;
};

/* A reply with one turn, as the car sends it. */
function reply(direction, dist) {
    return { GuidanceEventListError: 'NO_ERROR', viewContent: [{ eventsInView: [{ intersection: {
        uid: '2', formattedDistance: { distance: dist || '200', unit: 'METER', rawDistance: 1 },
        description: { elements: [{ text: 'Example Street' }] }, direction, detailedGeometry: 'UNDEFINED' } }] }] };
}
const NO_TURN = { GuidanceEventListError: 'NO_ERROR', viewContent: [{ eventsInView: [] }] };
const LANES = { rows: [{ lanes: [{ directionToFollow: 'STRAIGHT_ON', otherDirections: [], isHighlighted: true, directionsToFollow: ['STRAIGHT_ON'] },
    { directionToFollow: 'NONE', otherDirections: ['RIGHT'], isHighlighted: false, directionsToFollow: [] }] }] };
const card = (arrow, dist, lanes) => ({ arrow, exit: '', angle: '', side: '', dist: dist || '200 m', road: 'Example Street',
    lanes: lanes || '' });
const told = (c) => Object.assign({ cmd: 'turn' }, c);

/* A fake of the SDK's typed proxies, shaped by o: the reply of the
 * guidance list's queryContent, the lanes' values (Guidance's o.lanes,
 * ProjectedModeGuiding's o.phoneLanes), how long a lane read takes
 * (o.lanesDelayMs; o.phoneHangs: ProjectedModeGuiding's never answers),
 * and what is missing. */
function builders(o) {
    const b = { built: [], calls: [], laneReads: 0, laneWaits: 0, phoneReads: 0 };
    const lanesProxy = (count, value, fails, hangs) => ({ init: () => Promise.resolve(),
        waitUntilAvailable: () => {
            b.laneWaits++;
            return o.lanesAway ? Promise.reject(new Error('not available')) : Promise.resolve();
        },
        currentLaneGuiding: { getValue: () => {
            count();
            if (fails()) return Promise.reject(new Error('timeout'));
            if (hangs && hangs()) return new Promise(() => {});
            return sleep(o.lanesDelayMs || 0).then(value);
        } } });
    const answer = (via, name, params, ms) => {
        b.calls.push({ via, name, params, ms });
        return o.callFails ? Promise.reject(new Error('timeout')) : Promise.resolve(o.reply());
    };
    b.buildTypedProxy = (iface, instance) => {
        b.built.push(`${iface} ${instance}`);
        if (iface === CARPLAY[0] || iface === ANDROID_AUTO[0]) {
            if (o.disconnected && iface === CARPLAY[0]) {
                return Promise.resolve({ init: () => Promise.resolve(), waitUntilAvailable: () => Promise.reject(new Error('disconnected')),
                    projectedGuidanceActive: { getValue: () => Promise.resolve(true) } });
            }
            return Promise.resolve({
                init: () => Promise.resolve(), waitUntilAvailable: () => Promise.resolve(),
                projectedGuidanceActive: { getValue: () => Promise.resolve(iface === CARPLAY[0] ? o.carplay !== false : o.android === true) }
            });
        }
        if (iface === EVENTS_IFACE) {
            if (o.noEvents) return Promise.reject(new Error('no interface configuration'));
            const proxy = { init: () => Promise.resolve(), waitUntilAvailable: () => (o.away ? Promise.reject(new Error('not available')) : Promise.resolve()) };
            if (!o.typedOnly && !o.noCall) proxy._someIpProxy = { callMethod: (name, params, ms) => answer('raw', name, params, ms) };
            if (o.typedOnly) proxy.queryContent = (params) => answer('typed', 'queryContent', params);
            return Promise.resolve(proxy);
        }
        if (iface === PHONE_LANES_IFACE) {
            if (o.noPhoneLanes) return Promise.reject(new Error('no interface configuration'));
            return Promise.resolve(lanesProxy(() => b.phoneReads++, () => (o.phoneLanes ? o.phoneLanes() : { rows: [] }), () => !!o.phoneLanesFail,
                () => !!o.phoneHangs));
        }
        if (o.noLanes) return Promise.reject(new Error('no interface configuration'));
        const guidance = lanesProxy(() => b.laneReads++, () => (o.lanes ? o.lanes() : { rows: [] }), () => !!o.lanesFail);
        guidance.guidingProvider = { getValue: () => Promise.resolve(o.provider) };
        guidance.guidanceState = { getValue: () => Promise.resolve(o.nativeState) };
        return Promise.resolve(guidance);
    };
    return b;
}

/* A reader whose turn is state.card (null: none): fails while state.fails,
 * none for good with state.none; its notes are state.notes, taken once. */
function fakeReader(state) {
    const r = { reads: 0 };
    r.takeNotes = () => {
        const n = state.notes || [];
        state.notes = [];
        return n;
    };
    r.read = () => {
        r.reads++;
        if (state.none) return Promise.resolve({ none: true });
        return state.fails ? Promise.reject(new Error('timeout')) : Promise.resolve({ card: state.card });
    };
    return r;
}

let passed = 0;
async function check(name, fn) {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
}

async function main() {
    /* ---- the reader ---- */
    await check('the reader: the next turn from GuidanceEventList\'s queryContent, called on the proxy\'s raw SOME/IP proxy, built once', async () => {
        const o = { reply: () => reply('RIGHT') };
        const b = builders(o);
        const r = turnReader(b, quiet(), { readMs: 200 });
        assert.deepStrictEqual(await r.read(), { card: card('right') });
        o.reply = () => reply('LEFT', '150');
        assert.deepStrictEqual(await r.read(), { card: card('left', '150 m') });
        assert.deepStrictEqual(b.built.filter((x) => x === `${EVENTS_IFACE} ${INSTANCE}`).length, 1);
        assert.strictEqual(b.calls.length, 2);
        assert.strictEqual(b.calls[0].via, 'raw');
        assert.strictEqual(b.calls[0].name, 'queryContent');
        assert.strictEqual(b.calls[0].ms, 200);
        assert.deepStrictEqual(b.calls[0].params, eventQuery());
    });
    await check('the request: one view from the car\'s position, the manoeuvres, lanes, keep-left/right and destinations', async () => {
        assert.deepStrictEqual(eventQuery(), { viewConfigs: [{
            viewport: { startPoint: { anchorPoint: { standardReferencePoint: 'CCP' }, offsets: [] }, maxElementCount: 6, endPoints: [],
                includedTypes: ['INCLUDE_ACTIVE_MANEUVERS', 'INCLUDE_LANE_GUIDINGS', 'INCLUDE_ALONG_MAIN_ROAD', 'INCLUDE_DESTINATIONS'] },
            options: [], minimumUpdateIntervalMs: 1000, segmentItemRasterLength: 100 }] });
    });
    await check('the reader: a proxy with the typed method only is called through it', async () => {
        const b = builders({ reply: () => reply('RIGHT'), typedOnly: true });
        assert.deepStrictEqual(await turnReader(b, quiet(), { readMs: 200 }).read(), { card: card('right') });
        assert.strictEqual(b.calls[0].via, 'typed');
    });
    await check('the reader: the lanes beside the turn, from Guidance\'s currentLaneGuiding, read with each turn', async () => {
        const b = builders({ reply: () => reply('STRAIGHT_ON'), lanes: () => LANES });
        const r = turnReader(b, quiet(), { readMs: 200 });
        assert.deepStrictEqual(await r.read(), { card: card('straight', '200 m', 's*,r') });
        await r.read();
        assert.strictEqual(b.laneReads, 2);
        assert.ok(b.built.includes(`${LANES_IFACE} ${INSTANCE}`));
    });
    await check('the reader: no lanes to read (no proxy, or its read fails): the turn without lanes', async () => {
        const none = builders({ reply: () => reply('RIGHT'), noLanes: true });
        assert.deepStrictEqual(await turnReader(none, quiet(), { readMs: 200 }).read(), { card: card('right') });
        const fails = builders({ reply: () => reply('RIGHT'), lanesFail: true });
        const r = turnReader(fails, quiet(), { readMs: 200 });
        assert.deepStrictEqual(await r.read(), { card: card('right') });
        assert.deepStrictEqual(await r.read(), { card: card('right') });
        assert.deepStrictEqual(await r.read(), { card: card('right') });
        assert.deepStrictEqual(await r.read(), { card: card('right') });
        assert.strictEqual(fails.laneReads, 3, 'lanes failing three times in a row are left alone for a while');
    });
    await check('adaptive observer accepts complete lane rows and preserves the maneuver UID', async () => {
        const value = reply('STRAIGHT_ON');
        value.viewContent[0].eventsInView[0].intersection.uid = '29';
        let lanes = LANES;
        const reader = turnReader(builders({ reply: () => value, lanes: () => lanes }), quiet(), { readMs: 200 });
        const accepted = (await reader.read(true, true)).sample;
        assert.strictEqual(accepted.turn.key, '29');
        assert.strictEqual(accepted.turn.lanes, 's*,r');
        assert.strictEqual(accepted.lanesVerified, true);
        lanes = { rows: [{ lanes: Array(7).fill(LANES.rows[0].lanes[0]) }] };
        assert.strictEqual((await reader.read(true, true)).sample.lanesVerified, false);
    });
    await check('the reader: the lanes read as the other fields are: once Guidance is available, given twice readMs', async () => {
        const b = builders({ reply: () => reply('STRAIGHT_ON'), lanes: () => LANES, lanesDelayMs: 300 });
        assert.deepStrictEqual(await turnReader(b, quiet(), { readMs: 200 }).read(), { card: card('straight', '200 m', 's*,r') });
        assert.ok(b.laneWaits >= 1, 'waited for Guidance to be available');
    });
    await check('a failed lane read clears lanes; a new UID rejects the previous lane row until it changes', async () => {
        const o = { reply: () => reply('STRAIGHT_ON'), lanes: () => LANES };
        const r = turnReader(builders(o), quiet(), { readMs: 200 });
        assert.deepStrictEqual(await r.read(), { card: card('straight', '200 m', 's*,r') });
        o.lanesFail = true;
        assert.deepStrictEqual(await r.read(), { card: card('straight') });
        o.lanesFail = false;
        const next = reply('STRAIGHT_ON', '850');
        next.viewContent[0].eventsInView[0].intersection.uid = '3';
        o.reply = () => next;
        assert.deepStrictEqual(await r.read(), { card: card('straight', '850 m') });
        assert.deepStrictEqual(await r.read(), { card: card('straight', '850 m') });
        o.lanes = () => ({ rows: [] });
        await r.read();
        o.lanes = () => LANES;
        assert.deepStrictEqual(await r.read(), { card: card('straight', '850 m', 's*,r') });
    });
    await check('the reader: lanes failing three times in a row are not read for lanesWaitMs (10 s by default), then read again', async () => {
        assert.strictEqual(LANES_WAIT_MS, 10000);
        const o = { reply: () => reply('RIGHT'), lanesFail: true };
        const b = builders(o);
        const r = turnReader(b, quiet(), { readMs: 200, lanesWaitMs: 100 });
        for (let i = 0; i < 4; i++) await r.read();
        assert.strictEqual(b.laneReads, 3);
        await sleep(120);
        await r.read();
        assert.strictEqual(b.laneReads, 4, 'read again after lanesWaitMs');
    });
    await check('opt-in diagnostics report source, turn fields and separate lane availability; coordinates are excluded', async () => {
        let projected = { rows: [] };
        const b = builders({ reply: () => reply('STRAIGHT_ON'), provider: 'CAR_PLAY',
            lanes: () => Object.assign({ latitude: 49.1 }, LANES), phoneLanes: () => projected });
        const r = turnReader(b, quiet(), { readMs: 200 });
        await r.read();
        assert.deepStrictEqual(r.takeNotes(), []);
        assert.strictEqual(b.phoneReads, 0);
        await r.read(true);
        assert.ok(b.built.includes(`${PHONE_LANES_IFACE} ${INSTANCE}`));
        assert.strictEqual(b.phoneReads, 1);
        const notes = r.takeNotes();
        assert.strictEqual(notes.length, 4);
        assert.match(notes[0], /^nav \S+ route .*"source":"CAR_PLAY","app":null/);
        assert.match(notes[1], /"distance":"200 m","street":"Example Street"/);
        assert.match(notes[2], /Guidance .*"count":2.*"recommended":\[true,false\]/);
        assert.match(notes[3], /ProjectedModeGuiding .*"count":0/);
        assert.doesNotMatch(notes.join('\n'), /latitude|49\.1/);
        assert.deepStrictEqual(r.takeNotes(), [], 'taken once');
        await r.read(true);
        assert.deepStrictEqual(r.takeNotes(), [], 'identical samples are coalesced');
        projected = LANES;
        await r.read(true);
        const change = r.takeNotes();
        assert.strictEqual(change.length, 1);
        assert.match(change[0], /ProjectedModeGuiding .*"count":2/);
    });
    await check('normal rendering does not read the diagnostics-only ProjectedModeGuiding source', async () => {
        const b = builders({ reply: () => reply('STRAIGHT_ON'), lanes: () => LANES, phoneHangs: true });
        const r = turnReader(b, quiet(), { readMs: 500 });
        const start = Date.now();
        assert.deepStrictEqual(await r.read(), { card: card('straight', '200 m', 's*,r') });
        assert.deepStrictEqual(await r.read(), { card: card('straight', '200 m', 's*,r') });
        const took = Date.now() - start;
        assert.ok(took < 500, `two reads took ${took} ms, waiting for a phone read that never answers`);
        assert.strictEqual(b.phoneReads, 0);
    });
    await check('the diagnostic distinguishes an unsupported service from a valid empty lane row', async () => {
        const b = builders({ reply: () => reply('STRAIGHT_ON'), lanes: () => LANES, noPhoneLanes: true });
        const r = turnReader(b, quiet(), { readMs: 200 });
        assert.deepStrictEqual(await r.read(true), { card: card('straight', '200 m', 's*,r') });
        assert.match(r.takeNotes()[3], /ProjectedModeGuiding .*"status":"unsupported","count":null/);
    });
    await check('diagnostics can still sample route and lane interfaces after a missing event list is detected', async () => {
        const r = turnReader(builders({ noEvents: true, reply: () => NO_TURN, lanes: () => LANES }), quiet(), { readMs: 200 });
        assert.deepStrictEqual(await r.read(), { none: true });
        assert.deepStrictEqual(await r.read(true), { card: null });
        const notes = r.takeNotes();
        assert.match(notes[0], /"query":false/);
        assert.match(notes[2], /Guidance .*"count":2/);
    });
    await check('cancel, disconnected CarPlay, and unrelated routes suppress otherwise readable turns', async () => {
        for (const state of [{ carplay: false, provider: 'CAR_PLAY' }, { disconnected: true }, { android: true },
            { provider: 'ANDROID_AUTO' }, { carplay: false, nativeState: 'ACTIVE' }]) {
            const o = Object.assign({ reply: () => reply('RIGHT'), lanes: () => LANES }, state);
            const r = turnReader(builders(o), quiet(), { readMs: 200 });
            assert.deepStrictEqual(await r.read(), { card: null });
        }
    });
    await check('the reader: no route: no turn', async () => {
        assert.deepStrictEqual(await turnReader(builders({ reply: () => NO_TURN }), quiet(), { readMs: 200 }).read(), { card: null });
    });
    await check('the reader: a head unit without the guidance list, or with no way to call it: none, for good, said once', async () => {
        for (const o of [{ noEvents: true }, { noCall: true }]) {
            const b = builders(Object.assign({ reply: () => reply('RIGHT') }, o));
            const log = quiet();
            const r = turnReader(b, log, { readMs: 200 });
            assert.deepStrictEqual(await r.read(), { none: true });
            assert.deepStrictEqual(await r.read(), { none: true });
            assert.strictEqual(b.built.filter((x) => x === `${EVENTS_IFACE} ${INSTANCE}`).length, 1);
            assert.strictEqual(b.calls.length, 0);
            assert.strictEqual(log.lines.filter((l) => /^warn: turn card: /.test(l)).length, 1, log.lines.join('\n'));
        }
    });
    await check('the reader: a call that fails, or navigation not available, is a failed read, tried again at the next', async () => {
        const o = { reply: () => reply('RIGHT'), callFails: true };
        const b = builders(o);
        const r = turnReader(b, quiet(), { readMs: 200 });
        await assert.rejects(r.read());
        o.callFails = false;
        assert.deepStrictEqual(await r.read(), { card: card('right') });
        o.away = true;
        await assert.rejects(r.read());
    });

    /* ---- the sync ---- */
    const render = new FakeRender(RENDER);
    const patch = new FakePatch(PATCH);
    await render.listen();
    await patch.listen();
    render.single = true;
    const showing = () => { render.hud = 1; render.hudCard = 1; render.state = 'showing'; render.hudState = 'showing'; };
    const turns = () => render.turns.slice();
    /* every connection of the test before is gone, none refused yet */
    const alone = async () => {
        await until('the connections of the test before closed', () => render._clients.size === 0);
        render.refused = 0;
    };
    const make = (state, more) => {
        const link = new RenderLink({ path: RENDER, retryMs: 50, busyMs: 150 });
        const control = new WazeClusterControl({ renderPath: RENDER, patchPath: PATCH, retryMs: 50, log: quiet() });
        const reader = fakeReader(state);
        const log = quiet();
        const sync = new TurnGuideSync(Object.assign({ control, link, log, reader, pollMs: 20, idleMs: 60, resendMs: 100, handoverMs: 40 }, more));
        return { link, control, reader, log, sync, stop: () => { sync.stop(); control.close(); } };
    };

    await check('the card in use, the page closed: the turn told through the app\'s own connection, one connection for every turn', async () => {
        showing();
        const state = { card: card('right') };
        const t = make(state);
        const before = render.connections;
        t.sync.start();
        await until('the turn told', () => render.turn);
        assert.deepStrictEqual(render.turn, told(card('right')));
        state.card = card('right', '150 m');
        await until('the nearer turn told', () => render.turn && render.turn.dist === '150 m');
        state.card = card('left', '80 m');
        await until('another turn told', () => render.turn && render.turn.arrow === 'left');
        assert.strictEqual(render.connections - before, 1);
        assert.ok(t.link.connected());
        t.stop();
        await until('the connection closed at stop', () => !t.link.isOpen() && render._clients.size === 0);
    });
    await check('a turn that lasts is told again at least every resendMs, not at every read', async () => {
        showing();
        render.turns.length = 0;
        const t = make({ card: card('right') });
        t.sync.start();
        await until('told three times', () => turns().length >= 3, 2000);
        const reads = t.reader.reads;
        t.stop();
        assert.ok(turns().every((m) => JSON.stringify(m) === JSON.stringify(told(card('right')))));
        assert.ok(reads >= turns().length * 2, `${reads} reads, ${turns().length} told`);
    });
    await check('no turn: told once, then read less often', async () => {
        showing();
        render.turns.length = 0;
        const state = { card: card('right') };
        const t = make(state);
        t.sync.start();
        await until('the turn told', () => render.turn);
        state.card = null;
        await until('none told', () => render.turn === null);
        const n = turns().length, reads = t.reader.reads;
        await sleep(200);
        t.stop();
        assert.deepStrictEqual(turns()[n - 1], { cmd: 'turn', arrow: '' });
        assert.strictEqual(turns().length, n, 'none is told once');
        assert.ok(t.reader.reads - reads <= 5, `${t.reader.reads - reads} reads in 200 ms with no turn`);
    });
    await check('opt-in diagnostics log through the render even when the HUD card is off', async () => {
        showing();
        render.navDiagnostics = 1;
        render.hudCard = 0;
        render.received.length = 0;
        const state = { card: card('right'), notes: ['lanes guidance: {"rows":[]}', 'card: right 200 m, no lanes'] };
        const t = make(state);
        t.sync.start();
        await until('the notes told', () => render.count('note') === 2);
        state.notes = ['lanes guidance: read failed (timeout)'];
        await until('a later note told', () => render.count('note') === 3);
        await sleep(100);
        t.stop();
        render.navDiagnostics = 0;
        assert.deepStrictEqual(render.received.filter((m) => m.cmd === 'note').map((m) => m.text),
            ['lanes guidance: {"rows":[]}', 'card: right 200 m, no lanes', 'lanes guidance: read failed (timeout)']);
        assert.ok(!render.received.some((m) => m.cmd === 'turn'));
        assert.ok(!t.log.lines.some((line) => line.includes('lanes guidance')));
    });
    await check('the adaptive switch requests a HUD preview at 2 km without a verification flag or maneuver UID, then clears it when guidance ends', async () => {
        await alone();
        showing();
        render.adaptiveHud = 1;
        render.adaptivePreviewReady = 1;
        render.hudCard = 0;
        let active = true;
        const turn = Object.assign(card('right', '2 km'), { key: null, kind: 'intersection' });
        const t = make({}, {reader: {
            read: () => Promise.resolve({ card: active ? turn : null,
                sample: { connected: true, active, at: Date.now(), turn: active ? turn : null } })
        }});
        render.received.length = 0;
        try {
            t.sync.start();
            await until('a preview requested', () => render.received.some((m) => m.cmd === 'adaptive-preview' && m.on === '1'));
            active = false;
            await until('preview cleared', () => render.received.some((m) => m.cmd === 'adaptive-preview' && m.on === '0'));
            assert.ok(!render.received.some((m) => m.cmd === 'turn'), 'the card stays off');
        } finally {
            t.stop();
            render.adaptiveHud = 0;
            render.adaptivePreviewReady = 0;
        }
    });
    await check('the card off: nothing read or told, no connection kept; looked at again at recheck()', async () => {
        showing();
        render.hudCard = 0;
        render.turns.length = 0;
        const t = make({ card: card('right') });
        t.sync.start();
        await until('its connection closed again', () => t.link.isOpen() === false && render._clients.size === 0);
        await sleep(100);
        assert.strictEqual(t.reader.reads, 0);
        assert.strictEqual(turns().length, 0);
        const before = render.connections;
        await sleep(100);
        assert.strictEqual(render.connections, before, 'not connected to again');
        render.hudCard = 1;
        t.sync.recheck();
        await until('the turn told after recheck', () => render.turn);
        t.stop();
    });
    await check('a render before the turn card (no hud_card in its status): never in use', async () => {
        showing();
        render.hudCard = null;
        render.turns.length = 0;
        const t = make({ card: card('right') });
        t.sync.start();
        await until('its connection closed again', () => t.link.isOpen() === false);
        await sleep(80);
        t.stop();
        assert.strictEqual(t.reader.reads, 0);
        assert.strictEqual(turns().length, 0);
    });
    await check('the HUD map not showing (no phone, hidden in Sport): nothing read, the connection kept; read once it shows', async () => {
        showing();
        render.hudState = 'idle';
        render.turns.length = 0;
        const t = make({ card: card('right') });
        t.sync.start();
        await until('connected', () => t.link.connected());
        await sleep(100);
        assert.strictEqual(t.reader.reads, 0);
        render.hudState = 'showing';
        render.announce('showing');
        await until('the turn told', () => render.turn);
        t.stop();
    });
    await check('the page open: the turn goes through the page\'s connection, the app\'s own closed', async () => {
        showing();
        await alone();
        render.turns.length = 0;
        render.turn = null;
        const t = make({ card: card('right') });
        assert.strictEqual(t.sync.pageOpening(), false, 'no connection of its own to close: the page opens at once');
        t.control.open();
        t.sync.start();
        await until('the page connected', () => t.control.connectedRender() && t.control.renderStatus);
        await until('the turn told', () => render.turn);
        assert.strictEqual(t.link.isOpen(), false);
        assert.strictEqual(render._clients.size, 1);
        assert.strictEqual(render.refused || 0, 0, 'the render never had two connections');
        /* the page closes: the app's own connection takes over */
        t.control.close();
        t.sync.follow();
        render.turn = null;
        await until('told through its own connection', () => render.turn && t.link.connected());
        /* and gives the socket back before the page opens */
        assert.strictEqual(t.sync.pageOpening(), true, 'its connection was open: the page waits a moment');
        assert.strictEqual(t.link.isOpen(), false);
        await sleep(40);
        assert.strictEqual(t.link.isOpen(), false, 'not opened again while the page is due');
        t.control.open();
        await until('the page connected again', () => t.control.connectedRender() && t.control.renderStatus);
        assert.strictEqual(render.refused || 0, 0, 'the page was not refused');
        t.stop();
    });
    await check('failed reads clear the card once and are spaced out after two in a row', async () => {
        await alone();
        showing();
        render.turns.length = 0;
        render.turn = null;
        const state = { card: card('right'), fails: true };
        const t = make(state, { failWaitMs: 150 });
        t.sync.start();
        await until('two reads', () => t.reader.reads >= 2);
        await sleep(100);
        assert.strictEqual(t.reader.reads, 2, 'no read while spaced out');
        assert.deepStrictEqual(turns(), [{ cmd: 'turn', arrow: '' }]);
        state.fails = false;
        await until('the turn told once reads work', () => render.turn);
        t.stop();
    });
    await check('a head unit with no guidance list: not available, said to the page, nothing read again, no connection kept', async () => {
        showing();
        let changed = 0;
        const t = make({ none: true }, { changed: () => changed++ });
        assert.strictEqual(t.sync.available(), true);
        t.sync.start();
        await until('not available', () => !t.sync.available());
        await until('its connection closed', () => !t.link.isOpen());
        const reads = t.reader.reads;
        await sleep(100);
        t.stop();
        assert.strictEqual(changed, 1);
        assert.strictEqual(t.reader.reads, reads);
    });

    /* ---- the background connection ---- */
    await check('the driving mode goes through the background connection while it is up, not a connection of its own', async () => {
        showing();
        await alone();
        render.hudHideSport = 1;
        render.sport = 0;
        const t = make({ card: card('right') });
        t.sync.start();
        await until('connected', () => t.link.connected());
        const before = render.connections;
        const mode = { mode: 'SPORT' };
        const drive = new DriveModeSync({ control: t.control, link: t.link, log: quiet(), renderPath: RENDER, pollMs: 30, statusMs: 300, holdMs: 30,
            reader: { read: () => Promise.resolve(mode.mode), onChange() {} } });
        drive.start();
        await until('Sport told', () => render.sport === 1);
        assert.strictEqual(render.connections, before);
        assert.strictEqual(render.refused || 0, 0);
        drive.stop();
        t.stop();
        render.hudHideSport = 0;
        render.sport = 0;
    });
    await check('a render owned by another: left alone for busyMs, then tried again; never taken as "not in use"', async () => {
        showing();
        const owner = new WazeClusterControl({ renderPath: RENDER, patchPath: PATCH, retryMs: 50, log: quiet() });
        await alone();
        owner.open();
        await until('the other connected', () => owner.connectedRender() && owner.renderStatus);
        const t = make({ card: card('right') });
        t.control = null;
        const sync = new TurnGuideSync({ control: null, link: t.link, log: quiet(), reader: t.reader, pollMs: 20, idleMs: 60, resendMs: 100 });
        sync.start();
        await until('refused once', () => render.refused === 1);
        await sleep(100);
        assert.strictEqual(render.refused, 1, 'not tried again within busyMs');
        assert.strictEqual(t.reader.reads, 0);
        owner.close();
        render.turn = null;
        await until('told once the other is gone', () => render.turn, 3000);
        sync.stop();
    });

    await render.close();
    await patch.close();
    console.log(`${passed}/${passed} passed`);
}

main().catch((e) => {
    console.error(`FAIL ${e && e.stack}`);
    process.exit(1);
});
