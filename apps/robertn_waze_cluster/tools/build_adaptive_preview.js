// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

const fs = require('fs');
const path = require('path');
const [, , output, configFile] = process.argv;
if (!output) throw new Error('Usage: node build_adaptive_preview.js OUTPUT.html [CONFIG.json]');
const read = (file) => fs.readFileSync(path.join(__dirname, file), 'utf8');
const config = configFile ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {};
const bundle = (file) => `(() => { const module = {exports: {}};\n${read(file)}\nreturn module.exports; })()`;
const code = `const adaptive = ${bundle('../src/adaptive_hud.js')};\n` +
    `const simulator = ${bundle('adaptive_scenarios.js')};\n` +
    `const config = ${JSON.stringify(config).replace(/</g, '\\u003c')};\n` + read('adaptive_preview.js');
if (/<\/script\b/i.test(code)) throw new Error('Invalid script in simulator bundle');
fs.writeFileSync(output, read('adaptive_preview.html').replace('<!-- PREVIEW_CODE -->', () => `<script>${code}</script>`));
