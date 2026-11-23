// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 minakoto
/**
 * turn_decode - BMW's guidance data as the turn card the render draws on
 * the HUD. Pure: no I/O, never throws on a value the car sends.
 *
 * In: a reply of GuidanceEventList.queryContent (viewContent[0].eventsInView,
 * each event a union keyed by its kind; the first manoeuvre is the next
 * turn) and the value of currentLaneGuiding (rows[0].lanes). Both are what
 * CarPlay and Android Auto hand the car for the phone's route, and what
 * BMW's own navigation lists for its own.
 *
 * Out: cardOf(reply, lanes) -> { arrow, exit, angle, side, dist, road,
 * lanes }, all strings, the render's {"cmd":"turn"} fields, or null (no turn
 * to show).
 *   arrow  the icon the render draws (its card_pick.h), as the HUD card's
 *          review picked them:
 *          a turn: straight, slight_, sharp_ and plain left / right,
 *            uturn_left / _right;
 *          a branch: keep_left / _right (a road leaving, a two-way fork),
 *            offramp_left / _right (a motorway exit), merge_left / _right
 *            (a motorway entry), fork3_left / _straight / _right (a
 *            three-way fork), overpass, underpass; the junction's exact
 *            shape (ManeuverGeometry), when the car gives one, in their place;
 *          roundabout; slight_left / _right along the main road;
 *            lane_change_left / _right;
 *          arrive, arrive_left / _right (the destination on that side),
 *            destination (a stopover); ferry, car_train;
 *          follow ("follow the route": a manoeuvre with no arrow of its own;
 *            never a guessed arrow)
 *   exit   a roundabout's exit number, else ''
 *   angle  a roundabout's exit, degrees clockwise from straight on (0-359), else ''
 *   side   at a roundabout, the side traffic drives on: left, right, or '' (not given)
 *   dist   "450 m", "1.2 km": the number as the car words it; '' when none
 *   road   the street or exit name, one plain line, at most ROAD_MAX characters
 *   lanes  "s*,s+r*,r": one item a lane, left to right: its arrows (s, l, r,
 *          sl, sr, hl, hr, ul, ur) joined by +, each once, * on the one to
 *          take; - for none; at most LANES_MAX, the ones around the lanes to
 *          take; '' when none
 *
 * The enums, the union's kinds and the reading of distances and lanes are
 * ported from Redline's decoder (idrive7-apps, apps/redline/nav.js), which
 * was written from the replies a G21 sent on a drive:
 *
 *   MIT License
 *   Copyright (c) 2026 cauliflowermossgrape
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a
 *   copy of this software and associated documentation files (the
 *   "Software"), to deal in the Software without restriction, including
 *   without limitation the rights to use, copy, modify, merge, publish,
 *   distribute, sublicense, and/or sell copies of the Software, and to
 *   permit persons to whom the Software is furnished to do so, subject to
 *   the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included
 *   in all copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
 *   OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
 *   MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
 *   IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
 *   CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
 *   TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
 *   SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
 */
'use strict';

const ROAD_MAX = 80;
const LANES_MAX = 6;

/* The enums that decide an arrow, from the car's catalog
 * (navigation.GuidingTypes, CommonTypes.DistanceUnit): the index is the
 * number a firmware may send in the name's place. */
const ENUMS = {
    TurnDirection: ['NONE', 'STRAIGHT_ON', 'LEFT', 'SLIGHT_LEFT', 'HARD_LEFT', 'RIGHT', 'SLIGHT_RIGHT', 'HARD_RIGHT', 'UTURN_RIGHT', 'UTURN_LEFT'],
    BranchType: [null, 'BRANCH_LEFT', 'BRANCH_RIGHT', 'HIGHWAY_IN_LEFT', 'HIGHWAY_IN_RIGHT', 'HIGHWAY_IN_STRAIGHT', 'HIGHWAY_OUT_LEFT',
        'HIGHWAY_OUT_RIGHT', 'HIGHWAY_OUT_STRAIGHT', 'FORK_LEFT', 'FORK_RIGHT', 'TRIPLE_FORK_LEFT', 'TRIPLE_FORK_RIGHT',
        'TRIPLE_FORK_STRAIGHT', 'OVERPASS', 'UNDERPASS'],
    Side: [null, 'LEFT', 'RIGHT'],
    DestinationPosition: [null, 'LEFT', 'CENTER', 'RIGHT', 'NOT_DIGITIZED'],
    MainRoadDirection: ['LEFT', 'RIGHT'],
    VehicleTransportationType: ['FERRY', 'CAR_TRAIN'],
    ManeuverGeometry: [null, 'TWO_WAY_FORK_TAKE_LEFT', 'TWO_WAY_FORK_TAKE_RIGHT', 'THREE_WAY_FORK_TAKE_LEFT', 'THREE_WAY_FORK_TAKE_CENTER',
        'THREE_WAY_FORK_TAKE_RIGHT', 'EXIT_LEFT_TAKE_LEFT', 'EXIT_LEFT_TAKE_RIGHT', 'EXIT_RIGHT_TAKE_LEFT', 'EXIT_RIGHT_TAKE_RIGHT',
        'EXIT_LEFT_TWO_WAY_FORK_TAKE_LEFT_LEFT', 'EXIT_LEFT_TWO_WAY_FORK_TAKE_LEFT_RIGHT', 'EXIT_RIGHT_TWO_WAY_FORK_TAKE_RIGHT_LEFT',
        'EXIT_RIGHT_TWO_WAY_FORK_TAKE_RIGHT_RIGHT', 'TWO_WAY_FORK_OVERPASS_LEFT_TAKE_LEFT', 'TWO_WAY_FORK_OVERPASS_LEFT_TAKE_RIGHT',
        'TWO_WAY_FORK_OVERPASS_RIGHT_TAKE_LEFT', 'TWO_WAY_FORK_OVERPASS_RIGHT_TAKE_RIGHT', 'TWO_WAY_FORK_UNDERPASS_LEFT_TAKE_LEFT',
        'TWO_WAY_FORK_UNDERPASS_LEFT_TAKE_RIGHT', 'TWO_WAY_FORK_UNDERPASS_RIGHT_TAKE_LEFT', 'TWO_WAY_FORK_UNDERPASS_RIGHT_TAKE_RIGHT',
        'TWO_WAY_FORK_OVERPASS_LEFT_UNDERPASS_RIGHT_TAKE_LEFT', 'TWO_WAY_FORK_OVERPASS_LEFT_UNDERPASS_RIGHT_TAKE_RIGHT',
        'TWO_WAY_FORK_UNDERPASS_LEFT_OVERPASS_RIGHT_TAKE_LEFT', 'TWO_WAY_FORK_UNDERPASS_LEFT_OVERPASS_RIGHT_TAKE_RIGHT',
        'THREE_WAY_FORK_OVERPASS_CENTER_TAKE_LEFT', 'THREE_WAY_FORK_OVERPASS_CENTER_TAKE_CENTER', 'THREE_WAY_FORK_OVERPASS_CENTER_TAKE_RIGHT',
        'THREE_WAY_FORK_UNDERPASS_CENTER_TAKE_LEFT', 'THREE_WAY_FORK_UNDERPASS_CENTER_TAKE_CENTER', 'THREE_WAY_FORK_UNDERPASS_CENTER_TAKE_RIGHT'],
    DistanceUnit: ['NONE', 'KM', 'MILE_UK', 'MILE_US', 'METER', 'YARD', 'FEET']
};
const UNITS = { KM: 'km', METER: 'm', MILE_UK: 'mi', MILE_US: 'mi', YARD: 'yd', FEET: 'ft' };
const TURN_ARROWS = { STRAIGHT_ON: 'straight', LEFT: 'left', SLIGHT_LEFT: 'slight_left', HARD_LEFT: 'sharp_left', UTURN_LEFT: 'uturn_left',
    RIGHT: 'right', SLIGHT_RIGHT: 'slight_right', HARD_RIGHT: 'sharp_right', UTURN_RIGHT: 'uturn_right' };
const LANE_LETTERS = { STRAIGHT_ON: 's', LEFT: 'l', SLIGHT_LEFT: 'sl', HARD_LEFT: 'hl', UTURN_LEFT: 'ul',
    RIGHT: 'r', SLIGHT_RIGHT: 'sr', HARD_RIGHT: 'hr', UTURN_RIGHT: 'ur' };
const FRACTIONS = { '½': '.5', '¼': '.25', '¾': '.75' };
/* Union members that are not a manoeuvre: they never stand in for the next turn. */
const SKIP = ['pointOfInterest', 'laneGuiding', 'trafficEvent', 'trafficFlowItem', 'routeSegmentItem', 'placeholderElement', 'tunnel',
    'border', 'tollgate', 'passiveManeuver', 'speedLimitAssist', 'speedLimit', 'speedCamera', 'speedSectionCamera', 'dangerousCurve',
    'schoolZone'];

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/* An enum value as its catalog name, or null (neither a name nor a number of that enum). */
function enumOf(type, v) {
    const names = ENUMS[type];
    if (typeof v === 'string') {
        return names.indexOf(v) >= 0 ? v : null;
    }
    if (typeof v === 'number' && v >= 0 && v < names.length && v === Math.floor(v)) {
        return names[v];
    }
    return null;
}

/* Text as one plain line: no control characters, any run of spaces one plain space. */
function plain(text) {
    return String(text).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/[\s  -​  　]+/g, ' ').trim();
}

/* The union's kind and body, { kind, body }, or null (not one member). */
function unionOf(e) {
    const item = isObj(e) && isObj(e.maneuver) ? e.maneuver : e;
    if (!isObj(item)) {
        return null;
    }
    const keys = Object.keys(item).filter((k) => isObj(item[k]));
    return keys.length === 1 ? { kind: keys[0], body: item[keys[0]] } : null;
}

/* The street or exit name: the description's text pieces as one line. */
function roadOf(body) {
    const els = isObj(body.description) && Array.isArray(body.description.elements) ? body.description.elements : [];
    const text = plain(els.map((x) => (isObj(x) && typeof x.text === 'string' ? x.text : '')).join(' '));
    /* by characters, never half of one: a lone surrogate would go to the
     * render as a \u escape, which its reader does not take */
    const whole = (ch) => ch.length > 1 || ch < '\ud800' || ch > '\udfff';
    return Array.from(text).filter(whole).slice(0, ROAD_MAX).join('');
}

/* formattedDistance as "450 m"; '' with no unit or no number. A fraction
 * (a half mile) reads as a decimal; a unit the car put in the text is
 * taken out of it. */
function distOf(body) {
    const f = isObj(body.formattedDistance) ? body.formattedDistance : null;
    const unit = f ? UNITS[enumOf('DistanceUnit', f.unit)] : undefined;
    const raw = f && (typeof f.distance === 'string' || (typeof f.distance === 'number' && isFinite(f.distance))) ? String(f.distance) : null;
    if (!unit || raw === null) {
        return '';
    }
    const number = plain(raw)
        .replace(/^(\d*)([½¼¾])/, (x, n, fr) => (n || '0') + FRACTIONS[fr])
        .replace(new RegExp(`\\s*${unit}$`, 'i'), '')
        .trim();
    return /^\d[\d.,' ]*$/.test(number) ? `${number} ${unit}` : '';
}

/* name_left or name_right by the side, else follow. */
const sided = (name, side) => (side === 'LEFT' ? `${name}_left` : side === 'RIGHT' ? `${name}_right` : 'follow');

/* A branch by its type: the Y for a road leaving and a two-way fork, the
 * off ramp for a motorway exit, the merge for an entry, OsmAnd's three-way
 * fork; what goes straight on is the straight arrow. */
const BRANCH_ARROWS = { BRANCH_LEFT: 'keep_left', BRANCH_RIGHT: 'keep_right', FORK_LEFT: 'keep_left', FORK_RIGHT: 'keep_right',
    HIGHWAY_OUT_LEFT: 'offramp_left', HIGHWAY_OUT_RIGHT: 'offramp_right', HIGHWAY_OUT_STRAIGHT: 'straight',
    HIGHWAY_IN_LEFT: 'merge_left', HIGHWAY_IN_RIGHT: 'merge_right', HIGHWAY_IN_STRAIGHT: 'straight',
    TRIPLE_FORK_LEFT: 'fork3_left', TRIPLE_FORK_STRAIGHT: 'fork3_straight', TRIPLE_FORK_RIGHT: 'fork3_right',
    OVERPASS: 'overpass', UNDERPASS: 'underpass' };

/* The junction's exact shape, when the car gives one: a two-way fork (over
 * or under a road or not) the Y, a three-way fork OsmAnd's, an exit the off
 * ramp when it is taken and straight on when not; the leg taken last. */
function geometryArrow(name) {
    if (!name) {
        return null;
    }
    const take = /_TAKE_(?:\w+_)?(LEFT|CENTER|RIGHT)$/.exec(name)[1];
    if (/^THREE_WAY_FORK/.test(name)) {
        return take === 'CENTER' ? 'fork3_straight' : `fork3_${take.toLowerCase()}`;
    }
    if (/_TWO_WAY_FORK_|^TWO_WAY_FORK/.test(name)) {
        return `keep_${take.toLowerCase()}`;
    }
    const exit = /^EXIT_(LEFT|RIGHT)_/.exec(name)[1];
    return exit === take ? `offramp_${take.toLowerCase()}` : 'straight';
}

/* A roundabout's exit number; '' when unknown (the catalog's UInt8 "none" is 255). */
function exitOf(body) {
    const n = Number(body.exitNumber);
    return isFinite(n) && n > 0 && n < 100 ? String(Math.round(n)) : '';
}

/* A roundabout's exit angle, 0-359; '' when unknown (the catalog's UInt16 "none") or not a number. */
function angleOf(body) {
    const a = typeof body.exitAngle === 'number' ? body.exitAngle : NaN;
    return isFinite(a) && a >= -360 && a <= 720 ? String(((Math.round(a) % 360) + 360) % 360) : '';
}

/* A destination by the side of the road it is on; a stopover on the way (not the checkered flag) the pin. */
function destinationArrow(body) {
    if (body.isCheckeredFlag === false) {
        return 'destination';
    }
    const at = enumOf('DestinationPosition', body.position);
    return at === 'LEFT' ? 'arrive_left' : at === 'RIGHT' ? 'arrive_right' : 'arrive';
}

const TRANSPORT_ARROWS = { FERRY: 'ferry', CAR_TRAIN: 'car_train' };
const plainArrow = (arrow) => ({ arrow, exit: '', angle: '', side: '' });

/* One event's arrow and a roundabout's exit, angle and side, or null: not a manoeuvre. */
function arrowOf(kind, body) {
    const shape = () => geometryArrow(enumOf('ManeuverGeometry', body.detailedGeometry));
    switch (kind) {
    case 'intersection':
        return plainArrow(shape() || TURN_ARROWS[enumOf('TurnDirection', body.direction)] || 'follow');
    case 'branch':
        return plainArrow(shape() || BRANCH_ARROWS[enumOf('BranchType', body.branchType)] || 'follow');
    case 'roundabout': {
        const side = enumOf('Side', body.driveDirection);
        return { arrow: 'roundabout', exit: exitOf(body), angle: angleOf(body), side: side ? side.toLowerCase() : '' };
    }
    case 'alongMainRoad':
        return plainArrow(sided('slight', enumOf('MainRoadDirection', body.mainRoadDirection)));
    case 'laneChange':
        return plainArrow(sided('lane_change', enumOf('Side', body.changeSide)));
    case 'destinationManeuver':
        return plainArrow(destinationArrow(body));
    case 'vehicleTransportation':
        return plainArrow(TRANSPORT_ARROWS[enumOf('VehicleTransportationType', body.type)] || 'follow');
    default:
        /* a kind newer than the catalog: "follow the route" when it has a distance */
        return SKIP.indexOf(kind) < 0 && isObj(body.formattedDistance) ? plainArrow('follow') : null;
    }
}

/* The events of a reply, or null: an error reply or no view. */
function eventsOf(reply) {
    if (!isObj(reply)) {
        return null;
    }
    const err = reply.GuidanceEventListError;
    if (err !== undefined && err !== 'NO_ERROR' && err !== 0) {
        return null;
    }
    /* the views in a list; one view alone is taken too */
    const view = Array.isArray(reply.viewContent) ? reply.viewContent[0] : reply.viewContent;
    return isObj(view) && Array.isArray(view.eventsInView) ? view.eventsInView : null;
}

/* One lane's authoritative arrows, each once and joined by +. A single
 * indicated direction is marked with *. ! highlights the lane itself
 * when BMW marks the lane or sends more than one direction to follow. */
function laneItem(l) {
    const lane = isObj(l) ? l : {};
    const names = (a) => (Array.isArray(a) ? a : []).map((x) => enumOf('TurnDirection', x)).filter((s) => s && s !== 'NONE');
    const one = enumOf('TurnDirection', lane.directionToFollow);
    const follows = Array.from(new Set((one && one !== 'NONE' ? [one] : []).concat(names(lane.directionsToFollow))));
    const all = Array.from(new Set(follows.concat(names(lane.otherDirections))));
    const take = follows.length > 0 || lane.isHighlighted === true;
    if (!all.length) {
        return { text: '-', take: false, follows };
    }
    const arrows = all.map((d, i) => LANE_LETTERS[d] + (follows.length === 1 && i === 0 ? '*' : ''));
    if (take && follows.length !== 1) {
        arrows.push('!');
    }
    return { text: arrows.join('+'), take, follows };
}

/* currentLaneGuiding's first row as the card's lanes; '' when there are none. */
function lanesOf(value) {
    const row = isObj(value) && Array.isArray(value.rows) ? value.rows[0] : null;
    if (!isObj(row) || row.unreliable === true || !Array.isArray(row.lanes) || !row.lanes.length) {
        return '';
    }
    const items = row.lanes.map(laneItem);
    if (items.every((item) => item.text === '-')) {
        return '';
    }
    const taken = items.map((it, i) => (it.take ? i : -1)).filter((i) => i >= 0);
    /* more than the card holds: the window centred on the lanes to take */
    const centre = taken.length ? (taken[0] + taken[taken.length - 1]) / 2 : 0;
    const start = Math.max(0, Math.min(items.length - LANES_MAX, Math.round(centre - (LANES_MAX - 1) / 2)));
    return items.slice(start, start + LANES_MAX).map((it) => it.text).join(',');
}

/* The next turn and its identity as supplied by the guidance list. Distance
 * changes without changing the turn. Some firmware omits the UID. */
function nextManeuver(reply) {
    const events = eventsOf(reply) || [];
    for (let i = 0; i < events.length; i++) {
        const u = unionOf(events[i]);
        const a = u ? arrowOf(u.kind, u.body) : null;
        if (a) {
            const { uid } = u.body;
            const id = typeof uid === 'number' && Number.isSafeInteger(uid) && uid >= 0 ||
                typeof uid === 'string' && /^\d{1,20}$/.test(uid) ? String(uid) : null;
            return {
                id, kind: u.kind,
                card: { arrow: a.arrow, exit: a.exit, angle: a.angle, side: a.side, dist: distOf(u.body), road: roadOf(u.body) }
            };
        }
    }
    return null;
}

function cardOf(reply, lanes) {
    const turn = nextManeuver(reply);
    return turn ? Object.assign(turn.card, { lanes: lanesOf(lanes) }) : null;
}

module.exports = { cardOf, nextManeuver, eventsOf, lanesOf, laneItem, ROAD_MAX, LANES_MAX };
