// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 minakoto
/**
 * Tests of src/turn_decode.js: BMW's guidance reply (GuidanceEventList's
 * queryContent) and its lanes (currentLaneGuiding) as the turn card the
 * render draws. The replies are the shape a G21 sent with CarPlay guiding
 * (idrive7-apps, kit/tools/fixtures/redline-nav-carplay-2026-11-09.txt),
 * with made-up street names. Run: node tools/test_turn_decode.js
 */
'use strict';

const assert = require('assert');
const { cardOf, lanesOf, ROAD_MAX } = require('../src/turn_decode.js');

/* One event as the car sends it: the union's kind, then what differs. */
function event(kind, more, dist, unit, road) {
    const body = Object.assign({
        uid: '2', distanceToDestination: 8986, unreliable: false, sourceId: { simpleId: { id: '0' } },
        formattedDistance: { distance: dist === undefined ? '200' : dist, unit: unit || 'METER', rawDistance: 1 },
        description: { elements: [{ text: road === undefined ? 'Example Street' : road }] },
        travelTime: 0, travelTimeDelay: 0, trafficSegmentsInfo: { overview: [], segments: [] }, guidingStep: 'GS2',
        speedLimitAssistInfo: { nil: 'NO_VALUE' }, combinedManeuverType: 'SINGLE', maneuverRestriction: 'NONE',
        roadlinks: { nil: 'NO_VALUE' }
    }, more);
    return { [kind]: body };
}
function reply(events) {
    return {
        GuidanceEventListError: 'NO_ERROR',
        viewContent: [{ configSequenceId: 4294967295, indexedPosition: { valid: false, ccpOffset: 0, totalElementCount: events.length },
            eventsInView: events }],
        currentDistances: { carDistanceToFinalDestination: 0, carDistanceToNextDestination: -1 }
    };
}
const turn = (direction, dist, unit, road) => event('intersection', { direction, detailedGeometry: 'UNDEFINED' }, dist, unit, road);
const lane = (follow, others, hi, follows) => ({ directionToFollow: follow, otherDirections: others || [], isHighlighted: !!hi,
    additionalLaneInfo: 'NONE', directionsToFollow: follows || (follow === 'NONE' ? [] : [follow]) });
const lanes = (list) => ({ rows: [{ uid: '0', distanceToDestination: 9983, unreliable: false, length: 998, lanes: list,
    laneMarkers: list.map(() => 'DASHED').concat(['DASHED']), recommendedCarPositionLaneIndex: 1, bargraphProgress: 0 }],
carPositionLaneIndex: 255 });

let passed = 0;
function check(name, fn) {
    fn();
    passed++;
    console.log(`ok   ${name}`);
}

check('a right turn in 200 m, as CarPlay hands it to the car: the arrow, the distance as the car words it, the street', () => {
    assert.deepStrictEqual(cardOf(reply([turn('RIGHT')])), { arrow: 'right', exit: '', angle: '', side: '', dist: '200 m', road: 'Example Street', lanes: '' });
});

check('each turn direction has its arrow, by name or by the catalog\'s number', () => {
    const arrows = { STRAIGHT_ON: 'straight', LEFT: 'left', SLIGHT_LEFT: 'slight_left', HARD_LEFT: 'sharp_left', RIGHT: 'right',
        SLIGHT_RIGHT: 'slight_right', HARD_RIGHT: 'sharp_right', UTURN_RIGHT: 'uturn_right', UTURN_LEFT: 'uturn_left' };
    Object.keys(arrows).forEach((d) => assert.strictEqual(cardOf(reply([turn(d)])).arrow, arrows[d], d));
    assert.strictEqual(cardOf(reply([turn(2)])).arrow, 'left');
    assert.strictEqual(cardOf(reply([turn(8)])).arrow, 'uturn_right');
});

check('a direction the catalog does not have is "follow the route", never a guessed arrow', () => {
    ['NONE', 'DIAGONAL', 42, undefined].forEach((d) => assert.strictEqual(cardOf(reply([turn(d)])).arrow, 'follow', String(d)));
});

check('a roundabout carries its exit\'s number, its angle and the side traffic drives on; unknown ones none', () => {
    const r = (n, a, side) => reply([event('roundabout', { exitAngle: a, exitNumber: n, driveDirection: side }, '400'),
        event('destinationManeuver', { uid: '5', position: 'LEFT', isCheckeredFlag: true, stopOverNumber: 0 }, ' ', 'NONE')]);
    assert.deepStrictEqual(cardOf(r(1, 307, 'LEFT')),
        { arrow: 'roundabout', exit: '1', angle: '307', side: 'left', dist: '400 m', road: 'Example Street', lanes: '' });
    assert.strictEqual(cardOf(r(255, 90, 'RIGHT')).exit, '');
    assert.strictEqual(cardOf(r(2, 90, 'RIGHT')).side, 'right');
    assert.strictEqual(cardOf(r(2, 90, 2)).side, 'right');
    assert.strictEqual(cardOf(r(2, 90, undefined)).side, '');
    /* degrees clockwise from straight on, 0-359; the catalog's UInt16 "none" and what is no angle: none */
    assert.strictEqual(cardOf(r(2, 450, 'LEFT')).angle, '90');
    assert.strictEqual(cardOf(r(2, -90, 'LEFT')).angle, '270');
    assert.strictEqual(cardOf(r(2, 89.6, 'LEFT')).angle, '90');
    [65535, 'x', undefined, null, NaN].forEach((a) => assert.strictEqual(cardOf(r(2, a, 'LEFT')).angle, '', String(a)));
});

check('a branch as the review picked: the Y for a road leaving or a fork, the off ramp for a motorway exit', () => {
    const b = (branchType) => cardOf(reply([event('branch', { branchType, detailedGeometry: 'UNDEFINED' }, '1.1', 'KM')]));
    assert.deepStrictEqual(b('BRANCH_LEFT'),
        { arrow: 'keep_left', exit: '', angle: '', side: '', dist: '1.1 km', road: 'Example Street', lanes: '' });
    const arrows = { BRANCH_RIGHT: 'keep_right', FORK_LEFT: 'keep_left', FORK_RIGHT: 'keep_right',
        HIGHWAY_OUT_LEFT: 'offramp_left', HIGHWAY_OUT_RIGHT: 'offramp_right', HIGHWAY_OUT_STRAIGHT: 'straight',
        HIGHWAY_IN_LEFT: 'merge_left', HIGHWAY_IN_RIGHT: 'merge_right', HIGHWAY_IN_STRAIGHT: 'straight',
        TRIPLE_FORK_LEFT: 'fork3_left', TRIPLE_FORK_STRAIGHT: 'fork3_straight', TRIPLE_FORK_RIGHT: 'fork3_right',
        OVERPASS: 'overpass', UNDERPASS: 'underpass' };
    Object.keys(arrows).forEach((t) => assert.strictEqual(b(t).arrow, arrows[t], t));
    assert.strictEqual(b(7).arrow, 'offramp_right');
    assert.strictEqual(b('SOMETHING_NEW').arrow, 'follow');
});

check('the junction\'s exact shape, when the car gives one, draws in the place of the branch or the turn', () => {
    const g = (kind, more, geometry) => cardOf(reply([event(kind, Object.assign({ detailedGeometry: geometry }, more))])).arrow;
    const shapes = { TWO_WAY_FORK_TAKE_LEFT: 'keep_left', TWO_WAY_FORK_TAKE_RIGHT: 'keep_right',
        THREE_WAY_FORK_TAKE_LEFT: 'fork3_left', THREE_WAY_FORK_TAKE_CENTER: 'fork3_straight', THREE_WAY_FORK_TAKE_RIGHT: 'fork3_right',
        EXIT_LEFT_TAKE_LEFT: 'offramp_left', EXIT_LEFT_TAKE_RIGHT: 'straight', EXIT_RIGHT_TAKE_LEFT: 'straight',
        EXIT_RIGHT_TAKE_RIGHT: 'offramp_right',
        EXIT_LEFT_TWO_WAY_FORK_TAKE_LEFT_LEFT: 'keep_left', EXIT_LEFT_TWO_WAY_FORK_TAKE_LEFT_RIGHT: 'keep_right',
        EXIT_RIGHT_TWO_WAY_FORK_TAKE_RIGHT_LEFT: 'keep_left', EXIT_RIGHT_TWO_WAY_FORK_TAKE_RIGHT_RIGHT: 'keep_right',
        TWO_WAY_FORK_OVERPASS_LEFT_TAKE_RIGHT: 'keep_right', TWO_WAY_FORK_UNDERPASS_RIGHT_TAKE_LEFT: 'keep_left',
        TWO_WAY_FORK_UNDERPASS_LEFT_OVERPASS_RIGHT_TAKE_LEFT: 'keep_left',
        THREE_WAY_FORK_OVERPASS_CENTER_TAKE_CENTER: 'fork3_straight', THREE_WAY_FORK_UNDERPASS_CENTER_TAKE_RIGHT: 'fork3_right' };
    Object.keys(shapes).forEach((geometry) => {
        assert.strictEqual(g('branch', { branchType: 'BRANCH_RIGHT' }, geometry), shapes[geometry], geometry);
        assert.strictEqual(g('intersection', { direction: 'RIGHT' }, geometry), shapes[geometry], geometry);
    });
    assert.strictEqual(g('branch', { branchType: 'BRANCH_RIGHT' }, 4), 'fork3_straight');
    ['UNDEFINED', 0, 'SOMETHING_NEW', undefined].forEach((geometry) => {
        assert.strictEqual(g('branch', { branchType: 'HIGHWAY_OUT_RIGHT' }, geometry), 'offramp_right', String(geometry));
        assert.strictEqual(g('intersection', { direction: 'RIGHT' }, geometry), 'right', String(geometry));
    });
});

check('along the main road a slight turn, a lane change OsmAnd\'s jog; a destination by its side, a stopover the pin', () => {
    const one = (kind, more) => cardOf(reply([event(kind, more, '60')])).arrow;
    assert.strictEqual(one('alongMainRoad', { mainRoadDirection: 'LEFT' }), 'slight_left');
    assert.strictEqual(one('alongMainRoad', { mainRoadDirection: 1 }), 'slight_right');
    assert.strictEqual(one('alongMainRoad', {}), 'follow');
    assert.strictEqual(one('laneChange', { changeSide: 'RIGHT' }), 'lane_change_right');
    assert.strictEqual(one('laneChange', { changeSide: 1 }), 'lane_change_left');
    assert.strictEqual(one('laneChange', { changeSide: 'NONE' }), 'follow');
    assert.deepStrictEqual(cardOf(reply([event('destinationManeuver', { position: 'CENTER', isCheckeredFlag: true, stopOverNumber: 0 }, '60')])),
        { arrow: 'arrive', exit: '', angle: '', side: '', dist: '60 m', road: 'Example Street', lanes: '' });
    const d = (position, flag) => one('destinationManeuver', { position, isCheckeredFlag: flag, stopOverNumber: flag ? 0 : 1 });
    assert.strictEqual(d('LEFT', true), 'arrive_left');
    assert.strictEqual(d('RIGHT', true), 'arrive_right');
    assert.strictEqual(d(3, true), 'arrive_right');
    assert.strictEqual(d('NOT_DIGITIZED', true), 'arrive');
    assert.strictEqual(d(undefined, undefined), 'arrive');
    assert.strictEqual(d('LEFT', false), 'destination');
});

check('onto a ferry or a car train: their own icons; a kind of transport the catalog lacks follows the route', () => {
    const t = (type) => cardOf(reply([event('vehicleTransportation', { type }, '2', 'KM')])).arrow;
    assert.strictEqual(t('FERRY'), 'ferry');
    assert.strictEqual(t(1), 'car_train');
    assert.strictEqual(t('HOVERCRAFT'), 'follow');
});

check('a reply whose view is not in a list (as pull request #94\'s app allows for) reads the same', () => {
    const r = reply([turn('LEFT', '350')]);
    r.viewContent = r.viewContent[0];
    assert.deepStrictEqual(cardOf(r), { arrow: 'left', exit: '', angle: '', side: '', dist: '350 m', road: 'Example Street', lanes: '' });
});

check('what is not a manoeuvre never stands in for the next turn', () => {
    const r = reply([event('laneGuiding', {}), event('pointOfInterest', {}), event('tunnel', {}), turn('LEFT', '350')]);
    assert.deepStrictEqual(cardOf(r), { arrow: 'left', exit: '', angle: '', side: '', dist: '350 m', road: 'Example Street', lanes: '' });
});

check('a kind newer than the catalog shows as "follow the route" when it has a distance', () => {
    assert.strictEqual(cardOf(reply([event('hoverLane', {}, '300')])).arrow, 'follow');
});

check('no card: an error reply, no view, no events, nothing that reads', () => {
    assert.strictEqual(cardOf(Object.assign(reply([turn('LEFT')]), { GuidanceEventListError: 'NOT_AVAILABLE' })), null);
    assert.strictEqual(cardOf({ GuidanceEventListError: 'NO_ERROR', viewContent: [] }), null);
    assert.strictEqual(cardOf(reply([])), null);
    [undefined, null, 'text', 7, [], {}].forEach((v) => assert.strictEqual(cardOf(v), null, JSON.stringify(v)));
    assert.strictEqual(cardOf(reply([null, 5, {}, { intersection: null }])), null);
});

check('distances in the car\'s own units; none when the car gives no unit or no number', () => {
    const d = (dist, unit) => cardOf(reply([turn('LEFT', dist, unit)])).dist;
    assert.strictEqual(d('4.2', 'KM'), '4.2 km');
    assert.strictEqual(d('0,5', 'MILE_US'), '0,5 mi');
    assert.strictEqual(d('0.3', 'MILE_UK'), '0.3 mi');
    assert.strictEqual(d('500', 'FEET'), '500 ft');
    assert.strictEqual(d('200', 'YARD'), '200 yd');
    assert.strictEqual(d('450', 4), '450 m');
    assert.strictEqual(d(450, 'METER'), '450 m');
    assert.strictEqual(d('450 m', 'METER'), '450 m');
    assert.strictEqual(d('½', 'MILE_US'), '0.5 mi');
    assert.strictEqual(d(' ', 'NONE'), '');
    assert.strictEqual(d('soon', 'METER'), '');
    assert.strictEqual(d('200', 'PARSEC'), '');
});

check('the street name is one plain line: pieces joined, control characters out, cut to ROAD_MAX characters', () => {
    const r = reply([turn('LEFT')]);
    r.viewContent[0].eventsInView[0].intersection.description.elements = [{ text: 'A 9' }, { text: ' München\n\tNord  West ' }, {}, null];
    assert.strictEqual(cardOf(r).road, 'A 9 München Nord West');
    const long = 'Example Street '.repeat(20);
    const cut = cardOf(reply([turn('LEFT', '200', 'METER', long)])).road;
    assert.strictEqual(ROAD_MAX, 80);
    assert.strictEqual(cut.length, 80);
    assert.strictEqual(cut, long.slice(0, 80));
    assert.strictEqual(cardOf(reply([turn('LEFT', '200', 'METER', '')])).road, '');
    const none = reply([turn('LEFT')]);
    delete none.viewContent[0].eventsInView[0].intersection.description;
    assert.strictEqual(cardOf(none).road, '');
});

check('the card goes to the render as plain JSON: no \\u escape, which the render\'s reader does not take', () => {
    /* half of a surrogate pair, a whole one, quotes and a backslash */
    const road = 'Ex\ud83dample \ud83d\ude97 "Street" \\ \udc00End';
    const c = cardOf(reply([turn('LEFT', '200', 'METER', road)]));
    assert.strictEqual(c.road, 'Example \ud83d\ude97 "Street" \\ End');
    assert.ok(!/\\u/.test(JSON.stringify(c)), JSON.stringify(c));
});

check('lanes as the car sent them on the drive: two straight on to take, a right one not to', () => {
    const v = lanes([lane('STRAIGHT_ON', [], true), lane('STRAIGHT_ON', [], true), lane('NONE', ['RIGHT'], false)]);
    assert.strictEqual(lanesOf(v), 's*,s*,r');
    assert.deepStrictEqual(cardOf(reply([turn('STRAIGHT_ON', '900')]), v),
        { arrow: 'straight', exit: '', angle: '', side: '', dist: '900 m', road: 'Example Street', lanes: 's*,s*,r' });
});

check('a lane shows all its arrows, each once, * on the one to take; every direction has its letters', () => {
    const v = lanes([lane('LEFT', ['STRAIGHT_ON'], false), lane('SLIGHT_LEFT'), lane('HARD_LEFT'), lane('UTURN_LEFT'),
        lane('NONE', [], false), lane('NONE', ['SLIGHT_RIGHT'])]);
    assert.strictEqual(lanesOf(v), 'l*+s,sl*,hl*,ul*,-,sr');
    assert.strictEqual(lanesOf(lanes([lane('RIGHT'), lane('HARD_RIGHT'), lane('UTURN_RIGHT'), lane(1)])), 'r*,hr*,ur*,s*');
    /* straight or right, take right: both arrows, the right one marked */
    assert.strictEqual(lanesOf(lanes([lane('RIGHT', ['STRAIGHT_ON'])])), 'r*+s');
    assert.strictEqual(lanesOf(lanes([lane('NONE', ['STRAIGHT_ON', 'RIGHT'])])), 's+r');
    /* directionToFollow NONE, the arrows to take listed: the first of them is the one to take */
    assert.strictEqual(lanesOf(lanes([lane('NONE', [], true, ['STRAIGHT_ON', 'RIGHT'])])), 's*+r');
    /* highlighted with no arrow to follow: its first arrow */
    assert.strictEqual(lanesOf(lanes([lane('NONE', ['UTURN_LEFT', 'LEFT'], true)])), 'ul*+l');
    /* an arrow twice is once; one the catalog lacks is left out */
    assert.strictEqual(lanesOf(lanes([lane('RIGHT', ['RIGHT', 'DIAGONAL', 'STRAIGHT_ON'])])), 'r*+s');
    assert.strictEqual(lanesOf(lanes([lane('NONE', ['DIAGONAL'])])), '-');
});

check('more than six lanes: the six around the ones to take', () => {
    const many = [lane('NONE', ['LEFT']), lane('NONE', ['LEFT']), lane('NONE', ['STRAIGHT_ON']), lane('NONE', ['STRAIGHT_ON']),
        lane('NONE', ['STRAIGHT_ON']), lane('NONE', ['STRAIGHT_ON']), lane('RIGHT'), lane('RIGHT')];
    assert.strictEqual(lanesOf(lanes(many)), 's,s,s,s,r*,r*');
    const left = [lane('LEFT')].concat(many.slice(1, 6), [lane('NONE', ['RIGHT']), lane('NONE', ['RIGHT'])]);
    assert.strictEqual(lanesOf(lanes(left)), 'l*,l,s,s,s,s');
});

check('no lanes: none sent, no rows, an empty row, a value that is not lanes', () => {
    [undefined, null, {}, { rows: [] }, { rows: [{ lanes: [] }] }, { rows: 'x' }, 'lanes', 3].forEach((v) => {
        assert.strictEqual(lanesOf(v), '', JSON.stringify(v));
    });
    assert.strictEqual(cardOf(reply([turn('LEFT')]), { rows: [] }).lanes, '');
});

check('lanes with no turn make no card', () => {
    assert.strictEqual(cardOf(reply([]), lanes([lane('STRAIGHT_ON', [], true)])), null);
});

console.log(`${passed}/${passed} passed`);
