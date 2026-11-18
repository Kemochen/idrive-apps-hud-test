// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 minakoto
/**
 * lane_reader - one source of the lanes for the HUD's turn card: a
 * currentLaneGuiding field of BMW's navigation, read-only. turn_guide.js
 * reads Guidance's for the card and ProjectedModeGuiding's (where CarPlay
 * and Android Auto hand the car their lanes, per idrive7-apps' Redline)
 * for the notes only.
 *
 * A read waits for the service to be available, as the app's other field
 * reads do, and is given twice readMs. Three failures in a row leave the
 * field alone for LANES_WAIT_MS. Nothing is registered, set or written.
 *
 * Notes, for the drive log (turn_guide.js hands them to the render, which
 * keeps them in its log): each new value, cut to NOTE_VALUE_MAX characters;
 * the first failure of a run and each pause; a source missing for good,
 * once. A lanes value holds lane arrows only, never a place or a street.
 */
'use strict';

const { within } = require('./profile_sync.js');

const LANES_FAILS = 3;
const LANES_WAIT_MS = 10000;
const NOTE_VALUE_MAX = 300;

/* A value as one note's text: JSON, cut to NOTE_VALUE_MAX characters. */
function valueText(v) {
    let s;
    try {
        s = JSON.stringify(v);
    } catch (e) {
        s = `(not JSON: ${e && e.message})`;
    }
    s = s === undefined ? 'undefined' : s;
    return s.length > NOTE_VALUE_MAX ? `${s.slice(0, NOTE_VALUE_MAX)}…` : s;
}

/* A source named name ("guidance", "phone"): proxy() -> Promise<proxy |
 * null> (null: none, for good), field the lanes' field, note(text) the
 * notes. options: readMs, lanesWaitMs. read() -> Promise<{ ok, value }>,
 * never rejected; missing(why) is for proxy()'s set-up to call once. */
function laneSource(name, field, proxy, note, options) {
    const o = options || {};
    const readMs = o.readMs;
    const waitMs = o.lanesWaitMs || LANES_WAIT_MS;
    let fails = 0;
    let pausedUntil = 0;
    let lastText = null;

    const failed = (e) => {
        fails++;
        if (fails === 1 && fails < LANES_FAILS) {
            note(`lanes ${name}: read failed (${e && e.message})`);
        }
        if (fails >= LANES_FAILS) {
            fails = 0;
            pausedUntil = Date.now() + waitMs;
            note(`lanes ${name}: failed ${LANES_FAILS} times in a row; not read for ${Number((waitMs / 1000).toFixed(1))} s`);
        }
        return { ok: false };
    };
    const read = () => {
        if (Date.now() < pausedUntil) {
            return Promise.resolve({ ok: false });
        }
        return Promise.resolve()
            .then(() => proxy())
            .then((p) => {
                if (!p) {
                    return { ok: false, none: true };
                }
                return within(Promise.resolve()
                    .then(() => p.waitUntilAvailable(readMs))
                    .then(() => p[field].getValue()), readMs * 2, `reading ${field}`)
                    .then((value) => {
                        fails = 0;
                        const text = valueText(value);
                        if (text !== lastText) {
                            lastText = text;
                            note(`lanes ${name}: ${text}`);
                        }
                        return { ok: true, value };
                    });
            })
            .catch(failed);
    };
    const missing = (why) => note(`lanes ${name}: none (${why})`);
    return { read, missing };
}

module.exports = { laneSource, valueText, LANES_FAILS, LANES_WAIT_MS, NOTE_VALUE_MAX };
