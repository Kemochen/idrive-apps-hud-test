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
    NOTE_VALUE_MAX } = require('../src/turn_guide.js');

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
        return Promise.resolve(lanesProxy(() => b.laneReads++, () => (o.lanes ? o.lanes() : { rows: [] }), () => !!o.lanesFail));
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
    await check('the reader: the lanes read as the other fields are: once Guidance is available, given twice readMs', async () => {
        const b = builders({ reply: () => reply('STRAIGHT_ON'), lanes: () => LANES, lanesDelayMs: 300 });
        assert.deepStrictEqual(await turnReader(b, quiet(), { readMs: 200 }).read(), { card: card('straight', '200 m', 's*,r') });
        assert.ok(b.laneWaits >= 1, 'waited for Guidance to be available');
    });
    await check('the reader: a lane read that fails keeps the turn\'s last lanes for up to lanesHoldMs; a new turn never takes them', async () => {
        const o = { reply: () => reply('STRAIGHT_ON'), lanes: () => LANES };
        const r = turnReader(builders(o), quiet(), { readMs: 200, lanesHoldMs: 150 });
        assert.deepStrictEqual(await r.read(), { card: card('straight', '200 m', 's*,r') });
        o.lanesFail = true;
        assert.deepStrictEqual(await r.read(), { card: card('straight', '200 m', 's*,r') }, 'held');
        o.reply = () => reply('LEFT');
        assert.deepStrictEqual(await r.read(), { card: card('left') }, 'another turn: not held');
        o.reply = () => reply('STRAIGHT_ON');
        o.lanesFail = false;
        await r.read();
        o.lanesFail = true;
        await sleep(200);
        assert.deepStrictEqual(await r.read(), { card: card('straight') }, 'no longer held after lanesHoldMs');
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
    await check('the reader: notes for the drive log: each new lanes value of Guidance and of ProjectedModeGuiding, failed reads, ' +
            'each change of the card\'s arrow or lanes; never the street', async () => {
        const o = { reply: () => reply('STRAIGHT_ON'), lanes: () => LANES, phoneLanes: () => ({ rows: [] }) };
        const b = builders(o);
        const r = turnReader(b, quiet(), { readMs: 200 });
        await r.read();
        await sleep(20);   /* ProjectedModeGuiding's read is not waited for */
        assert.ok(b.built.includes(`${PHONE_LANES_IFACE} ${INSTANCE}`));
        assert.strictEqual(b.phoneReads, 1);
        assert.deepStrictEqual(r.takeNotes().sort(), [
            'card: straight 200 m, lanes s*,r',
            `lanes guidance: ${JSON.stringify(LANES)}`,
            'lanes phone: {"rows":[]}'].sort());
        assert.deepStrictEqual(r.takeNotes(), [], 'taken once');
        await r.read();
        assert.deepStrictEqual(r.takeNotes(), [], 'nothing changed: no notes');
        o.lanesFail = true;
        await r.read();
        assert.deepStrictEqual(r.takeNotes().sort(), ['card: straight 200 m, lanes s*,r (held)', 'lanes guidance: read failed (timeout)'].sort());
        await r.read();
        await r.read();
        assert.deepStrictEqual(r.takeNotes(), ['lanes guidance: failed 3 times in a row; not read for 10 s']);
        o.lanesFail = false;
        o.reply = () => NO_TURN;
        o.lanes = () => ({ rows: [{ lanes: new Array(80).fill(LANES.rows[0].lanes[0]) }] });
        const r2 = turnReader(builders(o), quiet(), { readMs: 200 });
        await r2.read();
        const notes = r2.takeNotes();
        const long = notes.find((n) => n.startsWith('lanes guidance: '));
        assert.ok(long.length <= 'lanes guidance: '.length + NOTE_VALUE_MAX + 1 && long.endsWith('…'), long);
        assert.ok(notes.includes('card: none'), notes.join('\n'));
        assert.ok(notes.every((n) => !/Example Street/.test(n)));
    });
    await check('the reader: ProjectedModeGuiding\'s lanes, for the notes only, are not waited for, and read one at a time', async () => {
        const b = builders({ reply: () => reply('STRAIGHT_ON'), lanes: () => LANES, phoneHangs: true });
        const r = turnReader(b, quiet(), { readMs: 500 });
        const start = Date.now();
        assert.deepStrictEqual(await r.read(), { card: card('straight', '200 m', 's*,r') });
        assert.deepStrictEqual(await r.read(), { card: card('straight', '200 m', 's*,r') });
        const took = Date.now() - start;
        assert.ok(took < 500, `two reads took ${took} ms, waiting for a phone read that never answers`);
        assert.strictEqual(b.phoneReads, 1, 'no second phone read while the first one lasts');
    });
    await check('the reader: no ProjectedModeGuiding: said once in the notes, the turn and Guidance\'s lanes as before', async () => {
        const b = builders({ reply: () => reply('STRAIGHT_ON'), lanes: () => LANES, noPhoneLanes: true });
        const r = turnReader(b, quiet(), { readMs: 200 });
        assert.deepStrictEqual(await r.read(), { card: card('straight', '200 m', 's*,r') });
        await r.read();
        const notes = r.takeNotes().filter((n) => n.startsWith('lanes phone: '));
        assert.strictEqual(notes.length, 1, notes.join('\n'));
        assert.ok(/^lanes phone: none \(.*no interface configuration/.test(notes[0]), notes[0]);
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
    await check('the reader\'s notes go to the render as {"cmd":"note"}, through the turn\'s connection, and to the app\'s log', async () => {
        showing();
        render.received.length = 0;
        const state = { card: card('right'), notes: ['lanes guidance: {"rows":[]}', 'card: right 200 m, no lanes'] };
        const t = make(state);
        t.sync.start();
        await until('the notes told', () => render.count('note') === 2);
        state.notes = ['lanes guidance: read failed (timeout)'];
        await until('a later note told', () => render.count('note') === 3);
        await sleep(100);
        t.stop();
        assert.deepStrictEqual(render.received.filter((m) => m.cmd === 'note').map((m) => m.text),
            ['lanes guidance: {"rows":[]}', 'card: right 200 m, no lanes', 'lanes guidance: read failed (timeout)']);
        assert.ok(t.log.lines.includes('info: turn card: lanes guidance: read failed (timeout)'), t.log.lines.join('\n'));
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
    await check('reads that fail: nothing told (the render drops the turn itself); after two in a row they are spaced out', async () => {
        showing();
        render.turns.length = 0;
        const state = { card: card('right'), fails: true };
        const t = make(state, { failWaitMs: 150 });
        t.sync.start();
        await until('two reads', () => t.reader.reads >= 2);
        await sleep(100);
        assert.strictEqual(t.reader.reads, 2, 'no read while spaced out');
        assert.strictEqual(turns().length, 0);
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
