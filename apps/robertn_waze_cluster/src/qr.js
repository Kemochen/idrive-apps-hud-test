// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 Robert Nisipeanu
/**
 * A QR code as a PNG the HMI shows: the text at error correction level M
 * (src/qrcodegen.js), black on white with the 4-module quiet zone, each module
 * a whole number of pixels so the picture stays sharp, at most maxPx wide.
 * qrPng(null) is a blank white square of maxPx, for no code.
 */
'use strict';

const { rgbaPng } = require('./png.js');
const qrcodegen = require('./qrcodegen.js');

const QUIET = 4;
const MAX_PX = 360;

/** { png: Buffer, width, modules } for text (RGBA, deflated). */
function qrPng(text, maxPx) {
    const max = maxPx || MAX_PX;
    const code = text ? qrcodegen.QrCode.encodeText(text, qrcodegen.QrCode.Ecc.MEDIUM) : null;
    const modules = code ? code.size + 2 * QUIET : max;
    const scale = Math.max(1, Math.floor(max / modules));
    const width = modules * scale;
    const stride = width * 4 + 1;
    const raw = Buffer.alloc(stride * width, 255);
    for (let y = 0; y < width; y += 1) {
        raw[y * stride] = 0;
        const my = Math.floor(y / scale) - QUIET;
        for (let mx = 0; code && my >= 0 && my < code.size && mx < code.size; mx += 1) {
            if (code.getModule(mx, my)) {
                const x0 = (mx + QUIET) * scale;
                raw.fill(0, y * stride + 1 + x0 * 4, y * stride + 1 + (x0 + scale) * 4);
                for (let x = x0; x < x0 + scale; x += 1) {
                    raw[y * stride + 1 + x * 4 + 3] = 255;
                }
            }
        }
    }
    const png = rgbaPng(width, width, raw);
    return { png, width, modules: code ? code.size : 0 };
}

module.exports = { qrPng };
