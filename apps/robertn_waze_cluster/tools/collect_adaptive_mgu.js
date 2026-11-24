// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';

// Prints an allowlisted diagnostic snapshot on stdout. No live SOME/IP calls.
const fs = require('fs');
const child = require('child_process');

const fields = {
    GuidanceEventList: ['queryContent', 'getViewConfig'],
    Guidance: ['currentLaneGuiding', 'guidanceState', 'guidingProvider', 'conclusiveDart', 'nextIntersection'],
    ProjectedModeGuiding: ['currentLaneGuiding', 'setGuidanceState', 'updateEventsOnRoute', 'waypoints', 'currentRoad', 'streamCommandChanged'],
    CarPlayManager: ['projectedGuidanceActive', 'projectedGuidanceMetadataAvailable', 'onScreenChange'],
    Positioning: ['rawPositionData', 'currentLocation'],
    Vehicle2: ['statusCarSpeed2']
};

function run(command, args) {
    try { return child.execFileSync(command, args, {encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore']}).trim(); }
    catch (e) { return null; }
}

function inventory(file) {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Object.keys(data.interfaces || {}).filter((name) => fields[name.split('.').pop()]).map((name) => {
        const iface = data.interfaces[name];
        const names = fields[name.split('.').pop()];
        const methods = iface.methods || {}, values = iface.fields || {}, events = iface.events || {};
        const types = (list) => (list || []).map((entry) => ({name: entry.name, type: entry.dataRef, dimension: entry.dimension}));
        const entries = names.filter((key) => methods[key] || values[key] || events[key]).map((key) => {
            const item = methods[key] || values[key] || events[key];
            return {name: key, methodId: item.methodId, eventId: item.eventId, eventGroups: item.eventgroups,
                getter: item.getter && item.getter.id, setter: item.setter && item.setter.id,
                notifier: item.notifier && {id: item.notifier.id, eventGroups: item.notifier.eventgroups},
                input: types(item.inputs), output: types(item.outputs), dataRef: item.dataRef};
        });
        return {name, serviceId: iface.serviceId, version: iface.version,
            instances: (data.instanceIDs || {})[name], entries};
    });
}

function main(args) {
    const paths = ['/usr/bin/carplay', '/usr/bin/carplay.woc-orig', '/usr/bin/aapd', '/usr/bin/aapd.woc-orig'];
    const services = ['waze-on-cluster.service', 'cluster-render.service', 'carplay.service'];
    let schema = null, schemaError = null;
    try { schema = inventory('/etc/oap/someip/someip-interfaces.json'); }
    catch (e) { schemaError = e.code || 'unreadable-schema'; }
    const result = {time: new Date().toISOString(), schema, schemaError,
        binaries: paths.filter((file) => fs.existsSync(file)).map((file) => ({file,
            sha256: (run('sha256sum', [file]) || '').split(/\s+/)[0] || null,
            buildId: ((run('readelf', ['-n', file]) || '').match(/Build ID:\s*([a-f0-9]+)/i) || [])[1] || null})),
        services: services.map((service) => ({service, status: run('systemctl', ['show', service, '-p', 'ActiveState',
            '-p', 'SubState', '-p', 'NRestarts', '-p', 'CPUUsageNSec', '-p', 'MemoryCurrent'])}))};
    const allow = /app: (nav \S+ (route|Guidance|ProjectedModeGuiding) |adaptive HUD shadow )/;
    const saved = run('tail', ['-n', '500', '/var/opt/waze-on-cluster/log/waze-on-cluster.log']);
    const logs = saved || run('journalctl', ['-u', 'waze-on-cluster.service', '-n', '500', '--no-pager', '-o', 'cat']);
    result.navigation = logs === null ? null : logs.split('\n').filter((line) => allow.test(line) ||
        (args.includes('--with-turn-text') && /app: nav \S+ turn /.test(line)));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (require.main === module) main(process.argv.slice(2));
module.exports = {inventory};
