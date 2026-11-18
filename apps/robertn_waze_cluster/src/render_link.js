// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 minakoto
/**
 * render_link - the app's own connection to the render's control socket
 * while its page is closed.
 *
 * The render's control socket has one owner. While the page shows, the
 * page's connection is the owner (waze_cluster_control.js) and this one
 * stays closed. With the page closed, what the app still tells the render
 * - the next turn for the HUD's turn card every second (turn_guide.js),
 * the driving mode (drive_mode.js), another driver's settings
 * (profile_sync.js) - goes through this one connection, kept open while
 * the turn card is in use, so the three never take the socket from each
 * other and the render is not connected to again for every turn.
 *
 * status is the render's last status line on this connection, null without
 * one. A render owned by another (its "busy" answer) is left alone for
 * BUSY_MS, then tried again while open.
 */
'use strict';

const EventEmitter = require('events');
const { LineSocket, RENDER_PATH } = require('./waze_cluster_control.js');

const BUSY_MS = 10000;

class RenderLink extends EventEmitter {
    /* options: path, log, retryMs, busyMs. Emits 'status' at each status
     * line and when the connection goes. */
    constructor(options) {
        super();
        const o = options || {};
        this._busyMs = o.busyMs || BUSY_MS;
        this._busyTimer = null;
        this._wanted = false;
        this.status = null;
        this._socket = new LineSocket({
            path: o.path || RENDER_PATH,
            retryMs: o.retryMs,
            /* its connecting and closing are not worth a log line each */
            log: { info() {}, warn() {} },
            onMessage: (msg) => this._onMessage(msg)
        });
        this._socket.on('close', () => {
            if (this.status !== null) {
                this.status = null;
                this.emit('status');
            }
        });
    }

    /* Connects, and again whenever the connection goes, until close(). */
    open() {
        this._wanted = true;
        if (!this._busyTimer) {
            this._socket.open();
        }
    }

    close() {
        this._wanted = false;
        clearTimeout(this._busyTimer);
        this._busyTimer = null;
        this._socket.close();
        this.status = null;
    }

    isOpen() {
        return this._wanted;
    }

    /* Connected, with the render's status: commands sent now reach it. */
    connected() {
        return this._socket.connected() && this.status !== null;
    }

    send(obj) {
        this._socket.send(obj);
    }

    _onMessage(msg) {
        if (msg.ev !== 'status') {
            return;
        }
        if (msg.state === 'error' && msg.reason === 'busy') {
            /* owned by another, which closes this connection: not at once again */
            this._socket.close();
            this.status = null;
            this._busyTimer = setTimeout(() => {
                this._busyTimer = null;
                if (this._wanted) {
                    this._socket.open();
                }
            }, this._busyMs);
            this.emit('status');
            return;
        }
        this.status = msg;
        this.emit('status');
    }
}

module.exports = { RenderLink, BUSY_MS };
