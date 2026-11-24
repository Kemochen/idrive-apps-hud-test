// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const junction = (maneuver, at, kind) => {
    const split = kind === 'branch';
    const circle = kind === 'roundabout';
    const through = [[0, -100], [0, 120]];
    const side = split ? [[0, 15], [40, 44], [80, 58]] : [[-110, 15], [110, 15]];
    const loop = [[0, 5], [-18, 17], [-18, 35], [0, 46], [18, 35], [18, 17], [0, 5]];
    return {kind: 'localized', maneuver, at, routeVerified: true, vehicle: [0, -45],
        roads: circle ? [loop, [[0, -100], [0, 5]], [[18, 17], [95, 17]]] : [through, side],
        route: circle ? [[0, -45], [0, 5], [-18, 17], [-18, 35], [0, 46], [18, 35], [18, 17], [95, 17]] :
            split ? [[0, -45], [0, 15], [40, 44], [80, 58]] : [[0, -45], [0, 15], [110, 15]]};
};

function sample(at, options) {
    const o = options || {};
    const data = Object.assign({connected: true, active: true, at, speedKmh: 45, priorityVerified: true,
        warning: false, lanesVerified: true, positionValid: true, route: 'synthetic-route'}, o.sample);
    data.turn = Object.assign({key: '1', arrow: 'right', kind: 'intersection', dist: '750 m', road: 'Oak Street', lanes: ''}, o.turn);
    if (o.map) data.map = junction(data.turn.key, at, data.turn.kind);
    return data;
}

const laneTurn = {dist: '230 m', lanes: 's,s+r*,r*'};
const exitTurn = {arrow: 'offramp_right', kind: 'branch', dist: '105 m', road: 'Exit 36 · Burnaby', lanes: 's,s,r*'};
const complex = {sample: {complex: true}, map: true, turn: laneTurn};
const exit = {map: true, turn: exitTurn};
const near = {map: true, sample: {complex: true}, turn: Object.assign({}, laneTurn, {dist: '100 m'})};
const scenarios = {
    'Straight road': [{turn: {arrow: 'straight'}}],
    'Left and right turns': [{turn: {arrow: 'left'}}, {turn: {arrow: 'right', key: '2'}}],
    'Multi-lane intersection': [{}, {turn: laneTurn}, {turn: laneTurn}],
    'Two recommended lanes': [{turn: {dist: '220 m', lanes: 's,s*,s*,r'}}, {turn: {dist: '200 m', lanes: 's,s*,s*,r'}}],
    'Highway exit': [{turn: {arrow: 'offramp_right', dist: '870 m'}}, exit, exit],
    'Complex interchange': [{}, complex, complex, near, near],
    'Roundabout': [{map: true, turn: {kind: 'roundabout', arrow: 'roundabout', dist: '92 m', road: 'Second exit'}},
        {map: true, turn: {kind: 'roundabout', arrow: 'roundabout', dist: '86 m', road: 'Second exit'}}],
    'Consecutive turns': [near, near, {turn: {key: '2', arrow: 'left', dist: '72 m'}}, {turn: {key: '2', arrow: 'left', dist: '55 m'}}],
    'Route recalculation': [near, near, {sample: {recalculating: true}}, {sample: {route: 'reroute'}}],
    'GPS interruption': [near, near, {sample: {positionValid: false}, turn: laneTurn, map: true}],
    'Missing lane metadata': [{sample: {lanesVerified: false}, turn: laneTurn}],
    'Missing map stream': [near, near, {turn: laneTurn}],
    'CarPlay disconnection': [near, near, {sample: {connected: false}}],
    'Navigation cancellation': [near, near, {sample: {active: false}}],
    'Application crash': [near, near, {sample: {at: 0}, turn: laneTurn}],
    'Stale navigation': [{sample: {at: 0}, turn: laneTurn}],
    'OEM warning priority': [near, near, {sample: {warning: true}}],
    'Different vehicle speeds': [{sample: {speedKmh: 35}, turn: {dist: '480 m', lanes: 's,r*'}},
        {sample: {speedKmh: 110}, turn: {dist: '470 m', lanes: 's,r*'}},
        {sample: {speedKmh: 110}, turn: {dist: '430 m', lanes: 's,r*'}}]
};

module.exports = {sample, scenarios};
