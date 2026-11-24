// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const ui = (id) => document.getElementById(id);
const select = ui('scenario');
const cfg = adaptive.settings(config);
const arrows = {right: '↱', left: '↰', straight: '↑', offramp_right: '↗', offramp_left: '↖', roundabout: '⟳'};
const laneArrows = {s: '↑', r: '↱', l: '↰', sl: '↖', sr: '↗', hl: '↰', hr: '↱', ul: '↶', ur: '↷'};
const ns = 'http://www.w3.org/2000/svg';
let index = 0;
let timer = null;

for (const name of Object.keys(simulator.scenarios)) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    select.appendChild(option);
}

function svg(parent, tag, attrs) {
    const element = document.createElementNS(ns, tag);
    for (const key of Object.keys(attrs)) element.setAttribute(key, attrs[key]);
    parent.appendChild(element);
    return element;
}

function drawMap(map) {
    const root = ui('map');
    root.textContent = '';
    root.style.display = map ? '' : 'none';
    if (!map) return;
    root.removeAttribute('hidden');
    root.style.opacity = String(cfg.mapOpacity);
    root.style.filter = `brightness(${cfg.mapBrightness})`;
    root.style.transform = `translate(${cfg.mapX}px, ${cfg.mapY}px) scale(${cfg.mapSize})`;
    const geometry = svg(root, 'g', {transform: `scale(${cfg.mapZoom})`});
    const points = (line) => line.map(([x, y]) => `${x},${-y}`).join(' ');
    const line = (coords, stroke, width) => svg(geometry, 'polyline', {
        points: points(coords), fill: 'none', stroke, 'stroke-width': width, 'stroke-linecap': 'round', 'stroke-linejoin': 'round'
    });
    map.roads.forEach((road) => line(road, '#617181', 7));
    line(map.route, '#8bd7ff', 5);
    svg(geometry, 'circle', {cx: map.vehicle[0], cy: -map.vehicle[1], r: 6, fill: '#eaf7ff', stroke: '#2e738e', 'stroke-width': 2});
}

function drawLanes(lanes) {
    const row = ui('lanes');
    row.textContent = '';
    row.hidden = !lanes;
    if (!lanes) return;
    for (const lane of lanes.split(',')) {
        const el = document.createElement('span');
        el.className = 'lane';
        if (lane.includes('!')) el.classList.add('take');
        for (const token of lane.split('+')) {
            if (token === '!') continue;
            const direction = document.createElement('span');
            direction.textContent = laneArrows[token.replace('*', '')] || '•';
            if (token.includes('*')) direction.className = 'take';
            el.appendChild(direction);
        }
        row.appendChild(el);
    }
}

function render() {
    const frames = simulator.scenarios[select.value];
    const controller = new adaptive.AdaptiveHUDController(config);
    let current, view;
    for (let frame = 0; frame <= index; frame++) {
        const at = 6000 + frame * 650;
        current = simulator.sample(at, frames[frame]);
        view = controller.update(at, current);
    }
    const card = view.card;
    ui('card').hidden = !card;
    ui('arrow').textContent = card && card.arrow ? arrows[card.arrow] || '•' : '';
    ui('distance').textContent = card && card.dist || '';
    ui('street').textContent = card && card.road || '';
    ui('speed').textContent = `${current.speedKmh} km/h`;
    ui('warning').hidden = !current.warning;
    drawMap(view.showMap ? current.map : null);
    drawLanes(card && card.lanes);
    ui('back').disabled = index === 0;
    ui('next').disabled = index + 1 >= frames.length;
    ui('status').textContent = `${view.state.replace(/_/g, ' ')} · ${index + 1} / ${frames.length}`;
}

function stop() {
    clearInterval(timer);
    timer = null;
    ui('play').textContent = 'Play';
}

select.addEventListener('change', () => { stop(); index = 0; render(); });
ui('back').addEventListener('click', () => { stop(); index--; render(); });
ui('next').addEventListener('click', () => { stop(); index++; render(); });
ui('play').addEventListener('click', () => {
    if (timer !== null) { stop(); return; }
    index = 0;
    render();
    ui('play').textContent = 'Pause';
    timer = setInterval(() => {
        if (ui('next').disabled) { stop(); return; }
        index++;
        render();
    }, 800);
});
select.value = 'Highway exit';
render();
