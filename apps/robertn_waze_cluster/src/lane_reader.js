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
 * Returns the sample to the caller, which decides what to display or log.
 */
'use strict';

const { within } = require('./profile_sync.js');

const LANES_FAILS = 3;
const LANES_WAIT_MS = 10000;
/* proxy() -> Promise<proxy | null>. read() resolves to a fresh value,
 * an unavailable sample, or a field missing on this firmware. */
function laneSource(field, proxy, options) {
    const o = options || {};
    const readMs = o.readMs;
    const waitMs = o.lanesWaitMs || LANES_WAIT_MS;
    let fails = 0;
    let pausedUntil = 0;

    const failed = () => {
        fails++;
        if (fails >= LANES_FAILS) {
            fails = 0;
            pausedUntil = Date.now() + waitMs;
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
                if (!p || !p[field] || typeof p[field].getValue !== 'function') {
                    return { ok: false, none: true };
                }
                return within(Promise.resolve()
                    .then(() => p.waitUntilAvailable(readMs))
                    .then(() => p[field].getValue()), readMs * 2, `reading ${field}`)
                    .then((value) => {
                        fails = 0;
                        return { ok: true, value };
                    });
            })
            .catch(failed);
    };
    return { read };
}

module.exports = { laneSource, LANES_FAILS, LANES_WAIT_MS };
