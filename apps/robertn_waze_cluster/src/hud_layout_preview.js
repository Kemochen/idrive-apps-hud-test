// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const { rgbaPng } = require('./png.js');
const HUD_W = 800, HUD_H = 480;
const WIDTH = 360, HEIGHT = 216;
const SCALE = WIDTH / HUD_W;
const REF = {x: 173, y: 160, w: 453, h: 160};
const GLYPHS = {
    '0': [14,17,19,21,25,17,14], '2': [14,17,1,2,4,8,31], '4': [2,6,10,18,31,2,2],
    A: [14,17,17,31,17,17,17], E: [31,16,16,30,16,16,31], G: [14,17,16,23,17,17,14],
    I: [14,4,4,4,4,4,14], K: [17,18,20,24,20,18,17], M: [17,27,21,21,17,17,17],
    O: [14,17,17,17,17,17,14], R: [30,17,17,30,20,18,17], S: [15,16,16,14,1,1,30],
    T: [31,4,4,4,4,4,4], W: [17,17,17,21,21,21,10]
};

const hold = (v, max) => Math.max(0, Math.min(max, v));
const place = (w, h, x, y) => ({w, h, x: hold(x, HUD_W - w), y: hold(y, HUD_H - h)});
const at = (pair, i) => pair && pair[i] || 0;

function layoutRects(s) {
    const w = s.width ? Math.floor(HUD_W * s.width / 100) : REF.w;
    const sourceHeight = 480, fittedHeight = 200;
    const crop = s.crop || 0;
    const cut = Math.floor(Math.max(0, crop) * sourceHeight / 400) * 2;
    const h = crop < 0 ? Math.floor(fittedHeight * (100 - crop) / 100)
        : Math.round(fittedHeight * (sourceHeight - 2 * cut) / sourceHeight);
    const view = place(w, h, Math.floor((HUD_W - w) / 2) + at(s.mapOffset, 0),
        Math.floor((HUD_H - h) / 2) + at(s.mapOffset, 1));
    const zoom = (s.zoom || 100) / 100;
    const picture = {w: Math.floor(REF.w * zoom), h: Math.floor(fittedHeight * zoom)};
    const viewW = Math.min(w, picture.w), viewH = Math.min(h, picture.h);
    const mapW = viewW & ~3, mapH = viewH & ~3;
    const rowScale = (s.turnSize || 100) / 100, lanesScale = (s.lanesSize || 100) / 100;
    const rowH = Math.round(44 * rowScale), lanesH = Math.round(36 * lanesScale);
    const lanesW = Math.round(218 * lanesScale);
    const turn = place(REF.w, rowH, REF.x + at(s.turnOffset, 0), REF.y - Math.round(12 * rowScale) - rowH + at(s.turnOffset, 1));
    const maneuverW = Math.round(160 * rowScale);
    const maneuver = place(maneuverW, rowH, turn.x + REF.w - maneuverW + at(s.maneuverOffset, 0), turn.y + at(s.maneuverOffset, 1));
    const roadName = place(Math.round(80 * rowScale), rowH, turn.x + at(s.roadOffset, 0), turn.y + at(s.roadOffset, 1));
    const sharesRow = Math.abs(roadName.y - maneuver.y) < rowH;
    const roadRight = sharesRow && roadName.x < maneuver.x + maneuver.w ? maneuver.x - Math.round(16 * rowScale) : HUD_W;
    roadName.w = Math.max(0, roadRight - roadName.x);
    return {
        map: place(mapW, mapH, view.x + Math.floor((w - viewW) / 2) + Math.floor((viewW - mapW) / 2),
            view.y + Math.floor((h - viewH) / 2) + Math.floor((viewH - mapH) / 2)),
        view, picture, turn, roadName, maneuver,
        lanes: place(lanesW, lanesH, REF.x + REF.w - lanesW + at(s.lanesOffset, 0),
            REF.y + REF.h + Math.round(14 * lanesScale) + at(s.lanesOffset, 1))
    };
}

function layoutPreviewPng(settings, wide) {
    const stride = WIDTH * 4 + 1, data = Buffer.alloc(stride * HEIGHT);
    const pixel = (x, y, color, opacity) => {
        const i = y * stride + x * 4 + 1;
        for (let channel = 0; channel < 3; channel++) {
            data[i + channel] = Math.round(color[channel] * opacity + data[i + channel] * (1 - opacity));
        }
        data[i + 3] = 255;
    };
    const paint = (x, y, w, h, color, clip, opacity = 1) => {
        const left = Math.max(0, Math.round(x), clip ? clip.x : 0);
        const top = Math.max(0, Math.round(y), clip ? clip.y : 0);
        const right = Math.min(WIDTH, Math.round(x + w), clip ? clip.x + clip.w : WIDTH);
        const bottom = Math.min(HEIGHT, Math.round(y + h), clip ? clip.y + clip.h : HEIGHT);
        for (let j = top; j < bottom; j++) {
            for (let i = left; i < right; i++) pixel(i, j, color, opacity);
        }
    };
    const line = (points, color, size, clip) => {
        points.slice(1).forEach(([x, y], i) => {
            const [x0, y0] = points[i];
            const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x - x0), Math.abs(y - y0))));
            for (let k = 0; k <= steps; k++) {
                paint(x0 + (x - x0) * k / steps - size / 2, y0 + (y - y0) * k / steps - size / 2, size, size, color, clip);
            }
        });
    };
    const text = (value, x, y, size, color, clip) => {
        Array.from(value).forEach((char, index) => {
            const rows = GLYPHS[char];
            if (rows) rows.forEach((bits, row) => {
                for (let col = 0; col < 5; col++) {
                    if (bits & (16 >> col)) paint(x + (index * 6 + col) * size, y + row * size, size, size, color, clip);
                }
            });
        });
    };
    const arrow = (x, y, size, direction, color, clip) => {
        const paths = direction === 0 ? [[0,0.4],[0,-0.4]] : [[-0.2 * direction,0.4],[-0.2 * direction,-0.15],[0.4 * direction,-0.15]];
        const tip = paths[paths.length - 1];
        const head = direction === 0 ? [[-0.22,-0.15],tip,[0.22,-0.15]]
            : [[0.16 * direction,-0.39],tip,[0.16 * direction,0.09]];
        [paths, head].forEach((path) => line(path.map(([dx,dy]) => [x + dx * size,y + dy * size]), color, Math.max(1, size / 8), clip));
    };
    const rect = (box) => ({x: Math.round(box.x * SCALE), y: Math.round(box.y * SCALE),
        w: Math.round(box.w * SCALE), h: Math.round(box.h * SCALE)});
    const {map, view, picture, turn, roadName, maneuver, lanes} = layoutRects(settings);
    const split = roadName.x !== turn.x || roadName.y !== turn.y ||
        maneuver.x + maneuver.w !== turn.x + turn.w || maneuver.y !== turn.y;
    const m = rect(map), r = rect(split ? roadName : turn), t = rect(split ? maneuver : turn), l = rect(lanes);
    const white = [236,245,251], muted = [111,131,151], route = [37,194,231];
    paint(0, 0, WIDTH, HEIGHT, [15,22,32]);
    paint(0, 0, WIDTH, 1, [66,86,108]);
    paint(0, HEIGHT - 1, WIDTH, 1, [66,86,108]);
    paint(0, 0, 1, HEIGHT, [66,86,108]);
    paint(WIDTH - 1, 0, 1, HEIGHT, [66,86,108]);
    const v = rect(view);
    paint(v.x, v.y, v.w, v.h, [36,52,68]);
    paint(m.x, m.y, m.w, m.h, [25,46,54]);
    const road = (points, color, size) => line(points.map(([x,y]) =>
        [m.x + m.w / 2 + x * picture.w * SCALE, m.y + m.h / 2 + y * picture.h * SCALE]), color, size, m);
    road([[-0.7,0.22],[-0.2,0.05],[0.18,-0.01],[0.68,-0.17]], muted, 2);
    road([[-0.7,-0.44],[-0.16,-0.25],[0.22,-0.23],[0.69,-0.35]], muted, 1);
    road([[0.45,0.65],[0.17,0.11],[0.15,-0.42],[0.05,-0.68]], muted, 2);
    road([[0.01,0.62],[-0.11,0.22],[-0.2,0.05],[0.18,-0.01],[0.68,-0.17]], route, 3);
    road([[-0.08,0.34],[-0.08,0.34]], white, 5);
    const panel = (x, y, w, h, clip) => {
        const color = [12,19,27], opacity = 0.82;
        paint(x + 2, y + 1, w - 4, 1, color, clip, opacity);
        paint(x, y + 2, w, h - 4, color, clip, opacity);
        paint(x + 2, y + h - 2, w - 4, 1, color, clip, opacity);
    };
    const name = wide ? 'WEST GEORGIA STREET' : 'OAK ST';
    const nameBox = split ? r : Object.assign({}, r, {w: Math.max(0, r.w - 45)});
    const baseTextSize = Math.max(1, Math.round(r.h / 20));
    const textSize = Math.max(baseTextSize * 0.8, Math.min(baseTextSize, (nameBox.w - 7) / (name.length * 6)));
    const badgeWidth = Math.min(nameBox.w, name.length * 6 * textSize + 10);
    panel(r.x, r.y, badgeWidth, r.h, nameBox);
    panel(t.x + t.w - 49, t.y, 49, t.h, t);
    text(name, r.x + 5, r.y + Math.round((r.h - 7 * textSize) / 2), textSize, white, nameBox);
    text(wide ? '240 M' : '420 M', t.x + t.w - 45, t.y + Math.round((t.h - 7) / 2), 1, white, t);
    arrow(t.x + t.w - t.h / 2, t.y + t.h / 2, t.h * 0.65, wide ? -1 : 1, white, t);
    const count = wide ? 6 : 3, icon = l.w / 6;
    for (let i = 0; i < count; i++) {
        const x = l.x + l.w - (count - i) * icon;
        const recommended = i === count - 1 || (wide && i === count - 2);
        paint(x, l.y, icon - 1, l.h, recommended ? [65,91,107] : [36,52,68], l);
        arrow(x + icon / 2, l.y + l.h / 2, l.h * 0.65, i === count - 1 ? 1 : 0, recommended ? white : muted, l);
    }
    return rgbaPng(WIDTH, HEIGHT, data, 3);
}

module.exports = { layoutPreviewPng, layoutRects };
