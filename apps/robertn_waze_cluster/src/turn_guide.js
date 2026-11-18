// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 minakoto
/**
 * turn_guide - the next turn of the route, for the HUD's turn card. Runs
 * from the app's start, page shown or not.
 *
 * The reader asks BMW's navigation, read-only, what it lists as the next
 * manoeuvre: GuidanceEventList's queryContent (the turns CarPlay and
 * Android Auto hand the car for the phone's route, and BMW's own
 * navigation's), and the lanes beside it from Guidance's
 * currentLaneGuiding; turn_decode.js makes the card of them. Nothing is
 * registered, set or written. The call goes through the SDK's typed proxy
 * the way PR #94's app found it taken on a car (the proxy's raw SOME/IP
 * proxy, callMethod), else through the typed method. A head unit with no
 * such list, or no way to call it, has no turn card, for good. A call that
 * fails is a failed read. Lanes are read as the app's other fields are
 * (lane_reader.js); a lane read that fails keeps the same turn's last lanes
 * for LANES_HOLD_MS, and three in a row leave them alone for a while.
 * ProjectedModeGuiding's lanes are read for the notes only, so a turn's
 * read never waits for them.
 *
 * The reader keeps notes for the drive log (takeNotes()): each new lanes
 * value of both sources, failed lane reads, and each change of the card's
 * arrow or lanes, never the street. The sync logs them and tells them to the
 * render, {"cmd":"note","text":...}, which keeps them in its own log, the
 * one Save logs collects.
 *
 * TurnGuideSync tells the render the turn, {"cmd":"turn",...}, only while
 * the setting is in use (the map on the HUD and Turn card on HUD ticked)
 * and the HUD map shows: every POLL_MS it reads, tells a new turn at once
 * and one that lasts again every RESEND_MS, since the render draws a turn
 * for 5 s only, so the card never shows a turn this no longer reads; no
 * turn is told once, then read every IDLE_MS. Failed reads tell nothing
 * and are spaced out. It goes through the page's own render connection
 * while the page is open (it owns the render's control socket), else
 * through the app's background connection (render_link.js), opened while
 * the setting may be in use and closed before the page opens
 * (pageOpening()). The socket changes hands with a pause, HANDOVER_MS: a
 * connection made in the same moment as the other's close can reach the
 * render first and be turned away as a second owner. Not in use, nothing is read or told and no connection
 * kept until the page's status says otherwise or recheck() (another driver
 * profile's settings may be in effect).
 */
'use strict';

const { within } = require('./profile_sync.js');
const { cardOf } = require('./turn_decode.js');
const { laneSource, LANES_WAIT_MS, NOTE_VALUE_MAX } = require('./lane_reader.js');

const EVENTS_IFACE = 'de.bmw.infotainment.navigation.guiding.GuidanceEventList';
const LANES_IFACE = 'de.bmw.infotainment.navigation.guiding.Guidance';
const PHONE_LANES_IFACE = 'de.bmw.infotainment.navigation.projectedmodeguiding.ProjectedModeGuiding';
const INSTANCE = 'Main_Instance';
const METHOD = 'queryContent';
const LANES_FIELD = 'currentLaneGuiding';

/* a turn is read this often while there is one, and told again this often */
const POLL_MS = 1000;
const RESEND_MS = 2000;
/* with no turn (no route) it is read this often */
const IDLE_MS = 3000;
/* a call waits this long for its answer */
const READ_MS = 900;
/* reads failing twice in a row wait this long, five times this long */
const FAIL_WAIT_MS = 2000;
const FAIL_LONG_WAIT_MS = 30000;
/* a lane read that fails keeps the same turn's last lanes this long */
const LANES_HOLD_MS = 3000;
/* notes not yet taken are kept up to this many, the oldest dropped */
const NOTES_MAX = 50;
/* the pause between one connection to the render closing and the other being made */
const HANDOVER_MS = 300;
/* after pageOpening() the background connection waits this long for the page to open */
const PAGE_WAIT_MS = 2000;
/* a proxy that failed to start: set up again after this, then less often */
const SETUP_RETRY_MS = 10000;
const SETUP_RETRY_MAX_MS = 300000;

/* The request: one view from the car's position, six events: the
 * manoeuvres, lane guidings, keep-left/right and destinations (the one
 * idrive7-apps' Redline asks on cars, its navlog.js). */
function eventQuery() {
    return { viewConfigs: [{
        viewport: { startPoint: { anchorPoint: { standardReferencePoint: 'CCP' }, offsets: [] }, maxElementCount: 6, endPoints: [],
            includedTypes: ['INCLUDE_ACTIVE_MANEUVERS', 'INCLUDE_LANE_GUIDINGS', 'INCLUDE_ALONG_MAIN_ROAD', 'INCLUDE_DESTINATIONS'] },
        options: [], minimumUpdateIntervalMs: 1000, segmentItemRasterLength: 100
    }] };
}

/* How the proxy takes a call of METHOD: (params, ms) -> Promise, or null. */
function callOf(proxy) {
    const raw = proxy && proxy._someIpProxy;
    if (raw && typeof raw.callMethod === 'function') {
        return (params, ms) => raw.callMethod(METHOD, params, ms);
    }
    if (proxy && typeof proxy[METHOD] === 'function') {
        return (params) => proxy[METHOD](params);
    }
    return null;
}

/* A typed proxy set up when first asked for: get() -> Promise<proxy | null>,
 * null for good when the head unit has no such proxy or usable(proxy) says
 * no (missing(why) is then called once); rejected while it cannot be set
 * up, which is tried again after retryMs, then less often. */
function lazyProxy(someipBuilders, iface, usable, missing, o) {
    let retryMs = o.retryMs || SETUP_RETRY_MS;
    const retryMax = o.retryMaxMs || SETUP_RETRY_MAX_MS;
    let proxy = null;
    let none = false;
    let starting = null;
    let retryAt = 0;
    const noProxy = (why) => {
        none = true;
        missing(why);
        return null;
    };
    return () => {
        if (proxy || none) {
            return Promise.resolve(proxy);
        }
        if (starting) {
            return starting;
        }
        if (Date.now() < retryAt) {
            return Promise.reject(new Error(`${iface} proxy: set up again later`));
        }
        starting = within(Promise.resolve()
            .then(() => someipBuilders.buildTypedProxy(iface, INSTANCE))
            .then((p) => (usable(p) ? p.init().then(() => p) : noProxy('nothing to read it with')),
                (e) => noProxy(`no ${iface} proxy (${e && e.message})`)), o.setupMs, `${iface} proxy`)
            .then((p) => {
                starting = null;
                proxy = p;
                return p;
            }, (e) => {
                starting = null;
                retryAt = Date.now() + retryMs;
                retryMs = Math.min(retryMs * 2, retryMax);
                throw e;
            });
        return starting;
    };
}

/* The card as one note: its arrow, a roundabout's exit and angle, the
 * distance and the lanes, never the street. */
function cardNote(card, held) {
    if (!card) {
        return 'card: none';
    }
    const angle = card.angle ? `at ${card.angle}${card.side ? ` ${card.side}` : ''}` : '';
    const head = [card.arrow, card.exit ? `exit ${card.exit}` : '', angle, card.dist].filter((s) => s).join(' ');
    return `card: ${head}, ${card.lanes ? `lanes ${card.lanes}` : 'no lanes'}${held ? ' (held)' : ''}`;
}

/* A reader of the next turn: read() -> Promise<{ card } | { none: true }>,
 * card the turn card's fields (turn_decode.js) or null with no turn, none
 * only without the guidance list, for good; rejected when the read gives
 * nothing to go by. takeNotes() -> the notes since the last call.
 * options: readMs, retryMs, retryMaxMs, lanesWaitMs, lanesHoldMs. */
function turnReader(someipBuilders, log, options) {
    const o = options || {};
    const readMs = o.readMs || READ_MS;
    const holdMs = o.lanesHoldMs || LANES_HOLD_MS;
    const setup = { retryMs: o.retryMs, retryMaxMs: o.retryMaxMs, setupMs: readMs * 4 };
    let notes = [];
    const note = (text) => {
        notes = notes.concat([text]).slice(-NOTES_MAX);
    };
    const events = lazyProxy(someipBuilders, EVENTS_IFACE, (p) => !!callOf(p),
        (why) => log.warn(`turn card: ${why}; no turn card on this head unit`), setup);
    const lanesUsable = (p) => !!p && !!p[LANES_FIELD] && typeof p[LANES_FIELD].getValue === 'function';
    const laneOptions = { readMs, lanesWaitMs: o.lanesWaitMs };
    let guidanceProxy = null;
    let phoneProxy = null;
    const guidance = laneSource('guidance', LANES_FIELD, () => guidanceProxy(), note, laneOptions);
    const phone = laneSource('phone', LANES_FIELD, () => phoneProxy(), note, laneOptions);
    guidanceProxy = lazyProxy(someipBuilders, LANES_IFACE, lanesUsable, (why) => {
        log.info(`turn card: no lanes (${why}); turns are shown without them`);
        guidance.missing(why);
    }, setup);
    phoneProxy = lazyProxy(someipBuilders, PHONE_LANES_IFACE, lanesUsable, (why) => phone.missing(why), setup);

    /* the lanes last read, for the turn they came with: { key, value, at } */
    let held = null;
    let lastNote = null;
    /* the lanes for the turn: the ones read now, else the same turn's held ones */
    const lanesFor = (bare, got) => {
        const key = bare ? [bare.arrow, bare.exit, bare.angle, bare.road].join('|') : '';
        if (got.ok) {
            held = { key, value: got.value, at: Date.now() };
            return { value: got.value, held: false };
        }
        if (held && held.key === key && Date.now() - held.at <= holdMs) {
            return { value: held.value, held: true };
        }
        return { value: undefined, held: false };
    };
    /* ProjectedModeGuiding's lanes are for the notes only: read beside the
     * turn but never waited for, and one read at a time */
    let phoneReading = false;
    const readPhone = () => {
        if (phoneReading) {
            return;
        }
        phoneReading = true;
        const done = () => {
            phoneReading = false;
        };
        phone.read().then(done, done);
    };
    const read = () => events().then((p) => {
        if (!p) {
            return { none: true };
        }
        readPhone();
        const call = callOf(p);
        const turn = within(Promise.resolve()
            .then(() => p.waitUntilAvailable(readMs))
            .then(() => call(eventQuery(), readMs)), readMs * 2, METHOD);
        return Promise.all([turn, guidance.read()]).then((r) => {
            const bare = cardOf(r[0], undefined);
            const lanes = lanesFor(bare, r[1]);
            const card = bare ? cardOf(r[0], lanes.value) : null;
            const text = cardNote(card, lanes.held && !!(card && card.lanes));
            /* a new note when the arrow, the exit, the angle or the lanes change, not the distance */
            const key = text.replace(/^card: (\S+)( exit \d+)?( at \d+(?: left| right)?)?[^,]*/, '$1$2$3');
            if (key !== lastNote) {
                lastNote = key;
                note(text);
            }
            return { card };
        });
    });
    const takeNotes = () => {
        const taken = notes;
        notes = [];
        return taken;
    };
    return { read, takeNotes };
}

class TurnGuideSync {
    /* options: control (the page's WazeClusterControl), link (the app's
     * RenderLink), log, reader (a turnReader), changed (called when
     * available() changes), pollMs, idleMs, resendMs, failWaitMs,
     * failLongWaitMs, handoverMs. */
    constructor(options) {
        const o = options || {};
        this._control = o.control || null;
        this._link = o.link;
        this._log = o.log || { info() {}, warn() {} };
        this._reader = o.reader;
        this._changed = o.changed || function () {};
        this._pollMs = o.pollMs || POLL_MS;
        this._idleMs = o.idleMs || IDLE_MS;
        this._resendMs = o.resendMs || RESEND_MS;
        this._failWaitMs = o.failWaitMs || FAIL_WAIT_MS;
        this._failLongWaitMs = o.failLongWaitMs || FAIL_LONG_WAIT_MS;
        this._handoverMs = o.handoverMs || HANDOVER_MS;
        this._holdUntil = 0;       /* no background connection before this */
        this._pageWas = false;     /* the page was open at the last look */
        this._inUse = undefined;   /* the setting in use, as last seen; undefined: not known */
        this._none = false;        /* the head unit has no guidance list */
        this._sent = null;         /* what was last told, and through which connection */
        this._sentAt = 0;
        this._readAt = 0;          /* no read before this */
        this._fails = 0;
        this._reading = false;
        this._telling = false;     /* a turn is being told, for the log */
        this._timer = null;
        this._stopped = true;
        this._onStatus = () => this.follow();
    }

    start() {
        if (this._stopped && this._reader && this._link) {
            this._stopped = false;
            this._link.on('status', this._onStatus);
            this._tick();
        }
    }

    stop() {
        this._stopped = true;
        clearTimeout(this._timer);
        this._timer = null;
        if (this._link) {
            this._link.removeListener('status', this._onStatus);
            this._link.close();
        }
    }

    /* False once the head unit is known to have no guidance list to read:
     * the setting then does nothing. */
    available() {
        return !this._none;
    }

    /* The settings may have changed where the page's status does not show
     * it: whether the setting is in use is looked at again. */
    recheck() {
        this._inUse = undefined;
        this.follow();
    }

    /* The page is about to connect to the render: the socket is its own.
     * True when the background connection was open: the page then connects
     * HANDOVER_MS later, once the render has seen this one close. */
    pageOpening() {
        const was = !!this._link && this._link.isOpen();
        if (this._link) {
            this._link.close();
        }
        this._sent = null;
        this._holdUntil = Date.now() + PAGE_WAIT_MS;
        return was;
    }

    /* The connections and whether the setting is in use, looked at now (the
     * page's status or the background connection's changed); the reads keep
     * their own pace. */
    follow() {
        if (!this._stopped) {
            this._channel();
        }
    }

    _pageOpen() {
        const c = this._control;
        return !!c && typeof c.isOpen === 'function' && c.isOpen();
    }

    /* The connection to tell a turn through, { send, name }, or null: none
     * with a status yet, or the setting is not in use. Opens and closes the
     * background connection as due. */
    _channel() {
        const c = this._control;
        const page = this._pageOpen();
        let status = null;
        let send = null;
        if (this._pageWas && !page) {
            this._holdUntil = Date.now() + this._handoverMs;   /* the page just closed */
        }
        this._pageWas = page;
        if (page) {
            this._link.close();
            if (c.render.connected() && c.renderStatus) {
                status = c.renderStatus;
                send = (m) => c.render.send(m);
            }
        } else if (this._none || this._inUse === false || Date.now() < this._holdUntil) {
            this._link.close();
        } else {
            this._link.open();
            if (this._link.connected()) {
                status = this._link.status;
                send = (m) => this._link.send(m);
            }
        }
        if (!status) {
            return null;
        }
        const inUse = status.hud === 1 && status.hud_card === 1;
        if (inUse !== this._inUse) {
            this._inUse = inUse;
            this._sent = null;
            if (!inUse && !page) {
                this._link.close();
            }
        }
        if (!inUse || this._none || status.hud_state !== 'showing') {
            this._said(false);
            return null;
        }
        return { send, name: page ? 'page' : 'link' };
    }

    _said(telling) {
        if (telling !== this._telling) {
            this._telling = telling;
            this._log.info(`turn card: ${telling ? 'turns are told to the render' : 'no turns told (the card off, or the HUD map not showing)'}`);
        }
    }

    _tell(channel, card) {
        const msg = card ? Object.assign({ cmd: 'turn' }, card) : { cmd: 'turn', arrow: '' };
        const key = `${channel.name}:${JSON.stringify(msg)}`;
        const now = Date.now();
        if (key === this._sent && (!card || now - this._sentAt < this._resendMs)) {
            return;
        }
        channel.send(msg);
        this._sent = key;
        this._sentAt = now;
        this._said(true);
    }

    /* The reader's notes: to the app's log, and to the render's log through
     * channel when there is one (the render's own rate limit applies). */
    _notes(channel) {
        const notes = typeof this._reader.takeNotes === 'function' ? this._reader.takeNotes() : [];
        for (const text of notes) {
            this._log.info(`turn card: ${text}`);
            if (channel) {
                channel.send({ cmd: 'note', text });
            }
        }
    }

    _failed(err) {
        this._fails++;
        const wait = this._fails >= 5 ? this._failLongWaitMs : this._fails >= 2 ? this._failWaitMs : 0;
        this._readAt = Date.now() + wait;
        if (this._fails === 1 || this._fails === 2 || this._fails === 5) {
            this._log.info(`turn card: no turn read (${err && err.message})${wait ? `; read again in ${Math.round(wait / 1000)} s` : ''}`);
        }
    }

    _read(channel) {
        this._reading = true;
        return Promise.resolve().then(() => this._reader.read()).then((r) => {
            this._fails = 0;
            if (r && r.none) {
                this._none = true;
                this._link.close();
                this._changed();
                return;
            }
            const card = r ? r.card : null;
            this._readAt = Date.now() + (card ? 0 : this._idleMs - this._pollMs);
            /* the connection as it is now: the page may have opened meanwhile */
            const now = this._stopped ? null : this._channel();
            this._notes(now);
            if (now && now.name === channel.name) {
                this._tell(now, card);
            }
        }, (e) => {
            this._notes(this._stopped ? null : this._channel());
            this._failed(e);
        }).then(() => {
            this._reading = false;
        });
    }

    _tick() {
        if (this._stopped) {
            return;
        }
        const channel = this._channel();
        const due = channel && !this._reading && Date.now() >= this._readAt;
        Promise.resolve(due ? this._read(channel) : undefined).then(() => {
            if (!this._stopped) {
                this._timer = setTimeout(() => this._tick(), this._pollMs);
            }
        });
    }
}

module.exports = { TurnGuideSync, turnReader, eventQuery, EVENTS_IFACE, LANES_IFACE, PHONE_LANES_IFACE, INSTANCE, METHOD, LANES_FIELD,
    POLL_MS, RESEND_MS, IDLE_MS, HANDOVER_MS, LANES_WAIT_MS, LANES_HOLD_MS, NOTE_VALUE_MAX };
