// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const assert = require('assert');
const {AdaptiveHUDController, distanceMeters, settings} = require('../src/adaptive_hud.js');
const {sample, scenarios} = require('./adaptive_scenarios.js');

const expected = [
    ['STANDARD_GUIDANCE'], ['STANDARD_GUIDANCE', 'MANEUVER_TRANSITION'],
    ['STANDARD_GUIDANCE', 'STANDARD_GUIDANCE', 'LANE_GUIDANCE'], ['STANDARD_GUIDANCE', 'LANE_GUIDANCE'],
    ['STANDARD_GUIDANCE', 'STANDARD_GUIDANCE', 'JUNCTION_PREVIEW'],
    ['STANDARD_GUIDANCE', 'STANDARD_GUIDANCE', 'LANE_GUIDANCE', 'LANE_GUIDANCE', 'JUNCTION_PREVIEW'],
    ['STANDARD_GUIDANCE', 'JUNCTION_PREVIEW'],
    ['STANDARD_GUIDANCE', 'JUNCTION_PREVIEW', 'MANEUVER_TRANSITION', 'STANDARD_GUIDANCE'],
    ['STANDARD_GUIDANCE', 'JUNCTION_PREVIEW', 'FALLBACK', 'STANDARD_GUIDANCE'],
    ['STANDARD_GUIDANCE', 'JUNCTION_PREVIEW', 'LANE_GUIDANCE'], ['STANDARD_GUIDANCE'],
    ['STANDARD_GUIDANCE', 'JUNCTION_PREVIEW', 'LANE_GUIDANCE'],
    ['STANDARD_GUIDANCE', 'JUNCTION_PREVIEW', 'IDLE'], ['STANDARD_GUIDANCE', 'JUNCTION_PREVIEW', 'IDLE'],
    ['STANDARD_GUIDANCE', 'JUNCTION_PREVIEW', 'FALLBACK'], ['FALLBACK'],
    ['STANDARD_GUIDANCE', 'JUNCTION_PREVIEW', 'FALLBACK'],
    ['STANDARD_GUIDANCE', 'STANDARD_GUIDANCE', 'LANE_GUIDANCE']
];

assert.strictEqual(Object.keys(scenarios).length, expected.length);
Object.keys(scenarios).forEach((name, index) => {
    const controller = new AdaptiveHUDController();
    const states = scenarios[name].map((options, frame) => {
        const now = 6000 + frame * 650;
        const result = controller.update(now, sample(now, options));
        assert.strictEqual(result.showMap, result.state === 'JUNCTION_PREVIEW');
        if (result.state === 'IDLE' || result.state === 'FALLBACK') assert.strictEqual(result.card, null);
        return result.state;
    });
    assert.deepStrictEqual(states, expected[index], name);
    console.log('ok ' + name);
});

const controller = new AdaptiveHUDController({debounceMs: 0});
const exit = {map: true, turn: {kind: 'branch', arrow: 'offramp_right', dist: '80 m', lanes: 's,r*'}};
const apply = (now, options) => controller.update(now, sample(now, options));
assert.strictEqual(apply(6000, exit).state, 'JUNCTION_PREVIEW');
assert.strictEqual(apply(6500, Object.assign({}, exit, {turn: Object.assign({}, exit.turn, {dist: '174 m'})})).showMap, true);
assert.strictEqual(apply(6600, Object.assign({}, exit, {turn: Object.assign({}, exit.turn, {dist: '250 m'})})).showMap, true);
assert.strictEqual(apply(7000, Object.assign({}, exit, {turn: Object.assign({}, exit.turn, {dist: '250 m'})})).showMap, false);
assert.strictEqual(apply(7100, Object.assign({}, exit, {sample: {priorityVerified: null}})).showMap, false);
assert.strictEqual(apply(7200, Object.assign({}, exit, {sample: {warning: null}})).card, null);
const invalidMap = sample(7300, exit);
invalidMap.map.maneuver = 'old';
assert.strictEqual(controller.update(7300, invalidMap).showMap, false);
invalidMap.map.maneuver = '1';
invalidMap.map.kind = 'secondary-display';
assert.strictEqual(controller.update(7300, invalidMap).showMap, false);
invalidMap.map.kind = 'localized';
invalidMap.map.route = [[0, 5], [25, NaN]];
assert.strictEqual(controller.update(7300, invalidMap).showMap, false);
assert.strictEqual(apply(7400, Object.assign({}, exit, {sample: {ended: true}})).state, 'IDLE');
assert.strictEqual(distanceMeters('1,2 km'), 1200);
assert.strictEqual(distanceMeters('2,000 m'), 2000);
assert.strictEqual(distanceMeters('2 010 m'), 2010);
assert.strictEqual(distanceMeters("2'050 m"), 2050);
assert.strictEqual(distanceMeters('2..1 km'), null);
assert.strictEqual(distanceMeters('½ mi'), null);
assert.strictEqual(settings({mapZoom: 30}).mapZoom, 1.5);
assert.strictEqual(new AdaptiveHUDController({enabled: false}).update(9000, sample(9000, exit)).state, 'IDLE');

const plain = new AdaptiveHUDController({debounceMs: 0, arrowDuringPreview: false, street: false});
const result = plain.update(9100, sample(9100, exit));
assert.strictEqual(result.card.arrow, '');
assert.strictEqual(result.card.road, '');
assert.strictEqual(result.card.lanes, 's,r*');
console.log('ok hysteresis, minimum duration, unverified inputs, configuration and final destination');

const live = new AdaptiveHUDController();
const projected = (now, turn, update) => live.update(now, sample(now, {
    turn, sample: Object.assign({videoPreview: true, videoAt: now}, update)
}));
assert.strictEqual(projected(9200, {dist: '2.1 km'}).showMap, false);
assert.strictEqual(projected(9250, {dist: '2,0 km'}).showMap, true);
assert.strictEqual(projected(9260, {dist: '2.1 km'}).showMap, true, 'a distance wobble does not blank the open map');
assert.strictEqual(projected(9270, {dist: '2.1 km', key: 'new'}).showMap, false, 'a new maneuver still enters at 2 km');
const laneChange = {key: '2', kind: 'laneChange', arrow: 'lane_change_left', dist: '1.2 mi'};
assert.strictEqual(projected(9280, {dist: '1.9 km'}).showMap, true);
assert.strictEqual(projected(9300, laneChange).showMap, true, 'consecutive maneuvers do not blank the map');
assert.strictEqual(projected(9350, Object.assign({}, laneChange, {dist: '1.25 mi'})).showMap, true);
assert.strictEqual(projected(9360, Object.assign({}, laneChange, {dist: '1.35 mi'})).showMap, false);
assert.strictEqual(projected(9400, {key: null, arrow: 'follow', dist: '2 000 m'}).showMap, true);
assert.strictEqual(projected(9410, {key: null, arrow: 'follow', dist: '2 080 m'}).showMap, true);
assert.strictEqual(projected(9420, {key: null, arrow: 'left', dist: '2 080 m'}).showMap, false);
assert.strictEqual(projected(9450, {key: null, dist: ''}).showMap, false);
assert.strictEqual(projected(9500, exit.turn).showMap, true);
assert.strictEqual(projected(9550, exit.turn, {videoPreview: false}).showMap, false);
assert.strictEqual(projected(9600, exit.turn, {videoAt: 0}).showMap, false);
assert.strictEqual(projected(9650, exit.turn, {priorityVerified: false}).showMap, false);
assert.strictEqual(projected(9700, exit.turn, {warning: true}).showMap, false);
assert.strictEqual(projected(9750, exit.turn, {connected: false}).showMap, false);
console.log('ok 2 km video threshold, distance hysteresis, consecutive turns and immediate fallback');
