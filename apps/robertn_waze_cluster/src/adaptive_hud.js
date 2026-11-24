// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const DEFAULTS = Object.freeze({
    enabled: true, lanes: true, junction: true, highwayJunction: true, street: true,
    arrowDuringPreview: true, speedDependent: true,
    laneMeters: 350, junctionMeters: 150, laneSeconds: 18, junctionSeconds: 8,
    expiryMs: 3500, debounceMs: 350, transitionMs: 450, minimumPreviewMs: 800,
    hysteresisMeters: 35, mapBrightness: 0.9, mapOpacity: 0.85, mapSize: 1,
    mapX: 0, mapY: 0, mapZoom: 1
});

const LIMITS = {
    laneMeters: [100, 800], junctionMeters: [40, 300], laneSeconds: [1, 35], junctionSeconds: [1, 20],
    expiryMs: [1000, 5000], debounceMs: [0, 1000], transitionMs: [0, 1000], minimumPreviewMs: [0, 1500],
    hysteresisMeters: [0, 80], mapBrightness: [0.15, 1], mapOpacity: [0.15, 1], mapSize: [0.6, 1.2],
    mapX: [-40, 40], mapY: [-25, 25], mapZoom: [1, 1.5]
};

function settings(input) {
    const out = Object.assign({}, DEFAULTS);
    for (const key of Object.keys(DEFAULTS)) {
        const value = input && input[key];
        if (typeof DEFAULTS[key] === 'boolean' && typeof value === 'boolean') out[key] = value;
        if (LIMITS[key] && Number.isFinite(value)) out[key] = Math.max(LIMITS[key][0], Math.min(LIMITS[key][1], value));
    }
    out.junctionMeters = Math.min(out.junctionMeters, out.laneMeters);
    out.junctionSeconds = Math.min(out.junctionSeconds, out.laneSeconds);
    return out;
}

function distanceMeters(text) {
    const match = /^([0-9]+(?:[.,][0-9]+)?)\s*(km|m|mi|ft|yd)$/.exec(text || '');
    if (!match) return null;
    return Number(match[1].replace(',', '.')) * {km: 1000, m: 1, mi: 1609.344, ft: 0.3048, yd: 0.9144}[match[2]];
}

function fresh(now, time, max) {
    return Number.isFinite(time) && now >= time && now - time < max;
}

class AdaptiveHUDController {
    constructor(config) {
        this.config = settings(config);
        this.reset('IDLE');
    }

    reset(state) {
        this.state = state;
        this.key = null;
        this.since = 0;
        this.pending = null;
        this.route = null;
    }

    update(now, sample) {
        const cfg = this.config;
        const s = sample || {};
        const turn = s.turn;
        if (!cfg.enabled || !s.connected || !s.active || s.ended) {
            this.reset('IDLE');
            return this.view('no-active-route');
        }
        if (s.warning !== false || s.priorityVerified !== true || s.recalculating ||
            !fresh(now, s.at, cfg.expiryMs) || !turn || !turn.arrow) {
            this.reset('FALLBACK');
            return this.view('unavailable-or-oem-priority');
        }
        const key = String(turn.key || '');
        if (this.route !== null && s.route !== this.route) this.reset('FALLBACK');
        this.route = s.route === undefined ? null : s.route;
        if (key && this.key !== null && key !== this.key) {
            this.state = 'MANEUVER_TRANSITION';
            this.since = now;
            this.pending = null;
        }
        this.key = key || null;
        if (this.state === 'MANEUVER_TRANSITION' && now - this.since < cfg.transitionMs) {
            return this.view('new-maneuver', turn);
        }

        const distance = distanceMeters(turn.dist);
        const speed = cfg.speedDependent && Number.isFinite(s.speedKmh) && s.speedKmh >= 0 && s.speedKmh <= 250 ? s.speedKmh / 3.6 : 0;
        const laneRange = Math.min(800, Math.max(cfg.laneMeters, speed * cfg.laneSeconds));
        const mapRange = Math.min(300, Math.max(cfg.junctionMeters, speed * cfg.junctionSeconds));
        const highway = s.highway === true || /^offramp_/.test(turn.arrow);
        const complex = s.complex === true || highway || turn.kind === 'roundabout' || turn.kind === 'branch';
        const eligibleLanes = Boolean(cfg.lanes && key && turn.lanes && s.lanesVerified === true);
        const map = s.map;
        const eligibleMap = Boolean(cfg.junction && (!highway || cfg.highwayJunction) && key && complex &&
            s.positionValid === true && map && map.kind === 'localized' && map.maneuver === key &&
            map.routeVerified === true && fresh(now, map.at, cfg.expiryMs));
        const previewOpen = this.state === 'JUNCTION_PREVIEW';
        const lanesOpen = previewOpen || this.state === 'LANE_GUIDANCE';
        const showMap = eligibleMap && distance !== null && (distance <= mapRange + (previewOpen ? cfg.hysteresisMeters : 0) ||
            (previewOpen && now - this.since < cfg.minimumPreviewMs));
        const showLanes = eligibleLanes && distance !== null && distance <= laneRange + (lanesOpen ? cfg.hysteresisMeters : 0);
        const next = showMap ? 'JUNCTION_PREVIEW' : showLanes ? 'LANE_GUIDANCE' : 'STANDARD_GUIDANCE';

        // A lost preview or lane source clears on this update. Only entering an enhanced view is debounced.
        if (this.state === 'JUNCTION_PREVIEW' && !showMap) {
            this.switchTo(showLanes ? 'LANE_GUIDANCE' : 'STANDARD_GUIDANCE', now);
        } else if (this.state !== 'STANDARD_GUIDANCE' && (this.state !== 'LANE_GUIDANCE' || !showLanes) && !previewOpen) {
            this.switchTo('STANDARD_GUIDANCE', now);
        }
        if (next !== this.state) {
            if (!this.pending || this.pending.state !== next) this.pending = {state: next, at: now};
            if (now - this.pending.at >= cfg.debounceMs) this.switchTo(next, now);
        } else {
            this.pending = null;
        }
        return this.view(null, turn, showLanes);
    }

    switchTo(state, now) {
        this.state = state;
        this.since = now;
        this.pending = null;
    }

    view(reason, turn, showLanes) {
        const map = this.state === 'JUNCTION_PREVIEW';
        const lanes = showLanes && (map || this.state === 'LANE_GUIDANCE') ? turn.lanes : '';
        const card = turn ? Object.assign({}, turn, {
            road: this.config.street ? turn.road : '',
            arrow: this.config.arrowDuringPreview || !map ? turn.arrow : '', lanes
        }) : null;
        return {state: this.state, card, showMap: map, reason};
    }
}

module.exports = {AdaptiveHUDController, distanceMeters, settings};
