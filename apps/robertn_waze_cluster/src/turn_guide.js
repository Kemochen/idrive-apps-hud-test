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
 * fails is a failed read. An active projected route is required for the
 * overlay. The two lane interfaces are sampled separately in opt-in
 * diagnostics. Only Guidance contributes to the live lane row.
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
const { nextManeuver, eventsOf, lanesOf, laneItem } = require('./turn_decode.js');
const { laneSource, LANES_WAIT_MS } = require('./lane_reader.js');

const EVENTS_IFACE = 'de.bmw.infotainment.navigation.guiding.GuidanceEventList';
const LANES_IFACE = 'de.bmw.infotainment.navigation.guiding.Guidance';
const PHONE_LANES_IFACE = 'de.bmw.infotainment.navigation.projectedmodeguiding.ProjectedModeGuiding';
const INSTANCE = 'Main_Instance';
const METHOD = 'queryContent';
const LANES_FIELD = 'currentLaneGuiding';
const PROJECTION_ACTIVE = 'projectedGuidanceActive';
const CARPLAY = ['de.bmw.infotainment.a4a.carplay.CarPlayManager', 'CarPlayManagerInst1'];
const ANDROID_AUTO = [
    'de.bmw.infotainment.sdi.aap.androidautoprojectedmanager.AndroidAutoProjectedManager',
    'AndroidAutoProjectedManagerInst1'
];
const DIAGNOSTIC_HEARTBEAT_MS = 15000;

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
function lazyProxy(someipBuilders, iface, usable, missing, o, instance) {
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
            .then(() => someipBuilders.buildTypedProxy(iface, instance || INSTANCE))
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

const hasGetter = (proxy, name) => !!(proxy && proxy[name]) && typeof proxy[name].getValue === 'function';
const flag = (value) => typeof value === 'boolean' ? value : null;
const catalogValue = (value) => (
    Number.isSafeInteger(value) || typeof value === 'string' && /^[A-Z_]{1,32}$/.test(value) ? value : null
);

function readField(getProxy, name, ms) {
    return within(getProxy().then((proxy) => {
        if (!hasGetter(proxy, name)) {
            return null;
        }
        return Promise.resolve(proxy.waitUntilAvailable(ms)).then(() => proxy[name].getValue());
    }), ms * 2, name).then((value) => value === undefined ? null : value, () => null);
}

/* Providers are named in BMW's catalog. A provider may stay selected
 * after the phone cancels its route, so it cannot activate the card. */
function projectedRoute(carplay, android, provider) {
    if ((carplay === true) === (android === true)) {
        return null;
    }
    const active = carplay === true ? 'CAR_PLAY' : 'ANDROID_AUTO';
    const named = typeof provider === 'number' ? ['NONE', 'CAR_PLAY', 'ANDROID_AUTO', 'CAR_LIFE', 'OTHER'][provider] : provider;
    return provider === null || named === 'NONE' || named === active ? active : null;
}

/* Whitelist fields instead of dumping replies, which can contain route
 * positions. A source name identifies the protocol, not the phone app. */
function laneReport(sample) {
    const rows = sample.ok && sample.value && sample.value.rows;
    const row = Array.isArray(rows) ? rows[0] : null;
    const lanes = row && row.lanes;
    const details = Array.isArray(lanes) ? lanes.slice(0, 6).map(laneItem) : null;
    return {
        status: sample.ok ? Array.isArray(rows) ? 'available' : 'missing' : sample.none ? 'unsupported' : 'unreadable',
        count: Array.isArray(rows) && rows.length === 0 ? 0 : Array.isArray(lanes) ? lanes.length : null,
        unreliable: row ? flag(row.unreliable) : null,
        arrows: details && details.map((lane) => lane.text),
        recommended: details && details.map((lane) => lane.take),
        highlighted: Array.isArray(lanes) ? lanes.slice(0, 6).map((lane) =>
            lane && typeof lane.isHighlighted === 'boolean' ? lane.isHighlighted : null) : null
    };
}

/* A reader of the next turn: read() -> Promise<{ card } | { none: true }>,
 * card the turn card's fields (turn_decode.js) or null with no turn, none
 * only without the guidance list, for good; rejected when the read gives
 * nothing to go by. takeNotes() -> the notes since the last call.
 * options: readMs, retryMs, retryMaxMs, lanesWaitMs. */
function turnReader(someipBuilders, log, options) {
    const o = options || {};
    const readMs = o.readMs || READ_MS;
    const setup = { retryMs: o.retryMs, retryMaxMs: o.retryMaxMs, setupMs: readMs * 4 };
    let notes = [];
    const events = lazyProxy(someipBuilders, EVENTS_IFACE, (p) => !!callOf(p),
        (why) => log.warn(`turn card: ${why}; no turn card on this head unit`), setup);
    const ignore = () => {};
    const guidanceProxy = lazyProxy(someipBuilders, LANES_IFACE, (p) => !!p, ignore, setup);
    const phoneProxy = lazyProxy(someipBuilders, PHONE_LANES_IFACE, (p) => hasGetter(p, LANES_FIELD), ignore, setup);
    const manager = ([iface, instance]) => lazyProxy(someipBuilders, iface, (p) => hasGetter(p, PROJECTION_ACTIVE), ignore, setup, instance);
    const carplayManager = manager(CARPLAY);
    const androidManager = manager(ANDROID_AUTO);
    const laneOptions = { readMs, lanesWaitMs: o.lanesWaitMs };
    const guidance = laneSource(LANES_FIELD, guidanceProxy, laneOptions);
    const phone = laneSource(LANES_FIELD, phoneProxy, laneOptions);

    let lastTurn = null;
    let lastLanes = '';
    let blockedLanes = '';
    const reports = new Map();
    const reset = () => {
        lastTurn = null;
        blockedLanes = lastLanes || blockedLanes;
    };
    const lanesFor = (source, turn, sample) => {
        const key = JSON.stringify([source, turn.id, turn.kind, turn.card.arrow, turn.card.exit, turn.card.road]);
        if (lastTurn !== null && key !== lastTurn) {
            reset();
        }
        lastTurn = key;
        if (!sample.ok) {
            return '';
        }
        const lanes = lanesOf(sample.value);
        if (lanes && lanes === blockedLanes) {
            return '';
        }
        blockedLanes = '';
        lastLanes = lanes;
        return lanes;
    };
    const diagnostic = (source, state, flags, turn, sample, projected, carplayMeta, replyOK) => {
        const now = Date.now();
        const at = new Date(now).toISOString();
        const report = (label, fields, keyFields = fields) => {
            const key = JSON.stringify(keyFields);
            const previous = reports.get(label);
            if (!previous || previous.key !== key || now - previous.at >= DIAGNOSTIC_HEARTBEAT_MS) {
                reports.set(label, { key, at: now });
                notes.push(`nav ${at} ${label} ${JSON.stringify(fields)}`);
            }
        };
        const card = turn && turn.card;
        const isExit = card && /^offramp_/.test(card.arrow);
        const name = card && card.road ? Array.from(card.road).slice(0, 28).join('') : null;
        report('route', { source, app: null, state, carplay: flags[0], androidAuto: flags[1],
            provider: flags[2], carplayMetadata: carplayMeta, query: replyOK });
        const distance = card && card.dist || null;
        report('turn', { maneuver: card && card.arrow, uid: turn && turn.id, distance,
            street: isExit ? null : name, exitName: isExit ? name : null, roundaboutExit: card && card.exit || null, eventTime: null },
        [source, turn && turn.id, card && card.arrow, name, card && card.exit, distance !== null]);
        report('Guidance', laneReport(sample));
        report('ProjectedModeGuiding', laneReport(projected));
        notes = notes.slice(-24);
    };
    const read = (diagnostics) => events().then((p) => {
        if (!p && !diagnostics) {
            return { none: true };
        }
        const report = diagnostics === true;
        if (!report) {
            reports.clear();
        }
        const flags = Promise.all([
            readField(carplayManager, PROJECTION_ACTIVE, readMs).then(flag),
            readField(androidManager, PROJECTION_ACTIVE, readMs).then(flag),
            readField(guidanceProxy, 'guidingProvider', readMs).then(catalogValue)
        ]);
        const turn = p ? within(Promise.resolve()
            .then(() => p.waitUntilAvailable(readMs))
            .then(() => callOf(p)(eventQuery(), readMs)), readMs * 2, METHOD) : Promise.resolve(null);
        const laneSample = guidance.read();
        const extra = report ? Promise.all([
            readField(guidanceProxy, 'guidanceState', readMs).then(catalogValue),
            readField(carplayManager, 'projectedGuidanceMetadataAvailable', readMs).then(flag),
            phone.read()
        ]) : null;
        return Promise.all([turn.then((reply) => ({ reply }), (error) => ({ error })), laneSample, flags]).then(([query, lanes, route]) => {
            const source = projectedRoute(...route);
            const maneuver = nextManeuver(query.reply);
            const card = source && maneuver ? Object.assign({}, maneuver.card, { lanes: lanesFor(source, maneuver, lanes) }) : null;
            if (!card) {
                reset();
            }
            const result = () => {
                if (query.error) {
                    throw query.error;
                }
                return { card };
            };
            if (!report) {
                return result();
            }
            const nativeFallback = !maneuver && route[0] !== true && route[1] !== true ?
                readField(guidanceProxy, 'conclusiveDart', readMs) : null;
            return Promise.all([extra, nativeFallback]).then(([[state, metadata, projected], dart]) => {
                const native = route[0] !== true && route[1] !== true && (state === 'ACTIVE' || state === 2);
                const nativeTurn = native && dart && nextManeuver({ viewContent: { eventsInView: [dart] } });
                diagnostic(source || (native ? 'BMW' : null), state, route, maneuver || nativeTurn || null,
                    lanes, projected, metadata, eventsOf(query.reply) !== null);
                return result();
            });
        });
    });
    const takeNotes = () => {
        const taken = notes;
        notes = [];
        return taken;
    };
    return { read, takeNotes, reset };
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
        this._diagnostics = false;
        this._sent = null;         /* what was last told, and through which connection */
        this._sentAt = 0;
        this._readAt = 0;          /* no read before this */
        this._fails = 0;
        this._reading = false;
        this._telling = false;     /* a turn is being told, for the log */
        this._overlay = false;
        this._overlayEpoch = 0;
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
        } else if ((this._none && !this._diagnostics) || this._inUse === false || Date.now() < this._holdUntil) {
            this._link.close();
        } else {
            this._link.open();
            if (this._link.connected()) {
                status = this._link.status;
                send = (m) => this._link.send(m);
            }
        }
        if (!status) {
            this._setOverlay(false);
            return null;
        }
        const cardOn = status.hud === 1 && status.hud_card === 1;
        const diagnostics = status.nav_diagnostics === 1;
        this._diagnostics = diagnostics;
        const inUse = cardOn || diagnostics;
        if (inUse !== this._inUse) {
            this._inUse = inUse;
            this._sent = null;
            if (!inUse && !page) {
                this._link.close();
            }
        }
        const overlay = !this._none && cardOn && status.hud_state === 'showing' && status.nav_live === 1;
        this._setOverlay(overlay);
        if (!overlay) {
            this._sent = null;
            this._said(false);
        }
        if (!inUse || (!overlay && !diagnostics)) {
            return null;
        }
        return { send, name: page ? 'page' : 'link', diagnostics, overlay, epoch: this._overlayEpoch };
    }

    _setOverlay(visible) {
        if (this._overlay && !visible) {
            this._overlayEpoch++;
        }
        this._overlay = visible;
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

    /* Diagnostic samples go only to the opt-in log collected by Save logs. */
    _notes(channel) {
        const notes = typeof this._reader.takeNotes === 'function' ? this._reader.takeNotes() : [];
        for (const text of notes) {
            if (channel && channel.diagnostics) {
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
        const stillShowing = (now) => channel.overlay && now && now.overlay &&
            now.epoch === channel.epoch && now.name === channel.name;
        return Promise.resolve().then(() => this._reader.read(channel.diagnostics)).then((r) => {
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
            if (stillShowing(now)) {
                this._tell(now, card);
            } else if (channel.overlay && this._overlayEpoch !== channel.epoch && typeof this._reader.reset === 'function') {
                this._reader.reset();
            }
        }, (e) => {
            const now = this._stopped ? null : this._channel();
            this._notes(now);
            if (stillShowing(now)) {
                this._tell(now, null);
            }
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
        if ((!channel || !channel.overlay) && !this._reading && typeof this._reader.reset === 'function') {
            this._reader.reset();
        }
        const due = channel && !this._reading && Date.now() >= this._readAt;
        Promise.resolve(due ? this._read(channel) : undefined).then(() => {
            if (!this._stopped) {
                this._timer = setTimeout(() => this._tick(), this._pollMs);
            }
        });
    }
}

module.exports = { TurnGuideSync, turnReader, eventQuery, EVENTS_IFACE, LANES_IFACE, PHONE_LANES_IFACE, INSTANCE, METHOD, LANES_FIELD,
    CARPLAY, ANDROID_AUTO, POLL_MS, RESEND_MS, IDLE_MS, HANDOVER_MS, LANES_WAIT_MS };
