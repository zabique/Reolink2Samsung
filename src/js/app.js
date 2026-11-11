/**
 * Reolink2Samsung - Multi-Camera TV Application
 * Based on Apps2Samsung/ReolinkViewer with All Cameras Grid, PTZ Control, and Patrol Mode.
 */
(function () {
    'use strict';

    var STORAGE_KEY = 'reolink-viewer-settings';
    var RELAY_BASE = 'http://127.0.0.1:8129';

    // Samsung TV remote key codes
    var KEY = {
        LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, ENTER: 13,
        RETURN: 10009, EXIT: 10182,
        PLAY: 415, PAUSE: 19, PLAY_PAUSE: 10252, STOP: 413,
        CH_UP: 427, CH_DOWN: 428,
        RED: 403, GREEN: 404, YELLOW: 405, BLUE: 406
    };

    var DEFAULTS = {
        host: '',
        port: '80',
        scheme: 'http',
        user: 'admin',
        password: '',
        channelsCount: 8,
        stream: 'sub',
        channel: 0,             // 0-based channel (0 = CH 01)
        audio: 'off',
        mode: 'flv',            // 'flv' | 'rtsp'
        rtspPort: '554',
        rtspPath: '',           // '' = Reolink's standard paths
        rtspPlayer: 'auto',     // 'auto' | 'mse' | 'avplay'
        defaultView: 'grid',    // 'grid' | 'player'
        unplayable: {},         // '<channel>:<quality>' the TV could not decode
        order: [],              // the cameras in the user's order (channel numbers); [] = by channel
        layout: '1+5',          // live view tiles: '1+5' | '2x2' | '3x3' | '4x2'
        sidebar: 'on',          // the camera list beside the tiles
        lang: 'en',             // 'en' | 'pl' | 'es' | 'fr' | 'it'
        ptzSpeed: 'medium',     // 'slow' | 'medium' | 'fast'
        autoconnect: 'on',
        ptzChannel: 0,          // which channel is the PTZ camera (1-based); 0 = none
        channelNames: {}        // { "0": "Front door", ... } by 0-based channel; empty = "Camera 01"...
    };

    // Battle-tested MPEGTS config from Apps2Samsung/ReolinkViewer
    var MPEGTS_CONFIG = {
        enableWorker: false,
        enableStashBuffer: false,
        stashInitialSize: 128,
        isLive: true,
        lazyLoad: false,
        liveBufferLatencyChasing: true,
        liveBufferLatencyMaxLatency: 3.0,
        liveBufferLatencyMinRemain: 0.5,
        autoCleanupSourceBuffer: true,
        autoCleanupMaxBackwardDuration: 30,
        autoCleanupMinBackwardDuration: 10,
        fixAudioTimestampGap: true,
        reuseRedirectedURL: true
    };

    var RECONNECT_BASE_MS = 3000;
    var RECONNECT_MAX_MS = 30000;
    var OVERLAY_HIDE_MS = 4000;

    var RELAY_LAUNCH_TRIES = 25;
    var RELAY_START_TIMEOUT_MS = 25000;
    var RELAY_POLL_MS = 1000;
    var HLS_MIN_SEGMENTS = 3;

    var settings = loadSettings();

    var el = {
        grid: document.getElementById('view-grid'),
        setup: document.getElementById('view-setup'),
        player: document.getElementById('view-player'),
        gridContainer: document.getElementById('grid-container'),
        gridBar: document.getElementById('grid-bar'),
        gridPage: document.getElementById('grid-page'),
        sidebar: document.getElementById('sidebar'),
        sideHost: document.getElementById('side-host'),
        sideState: document.getElementById('side-state'),
        sideCount: document.getElementById('side-count'),
        sideList: document.getElementById('side-list'),
        sideHint: document.getElementById('side-hint'),
        playerBar: document.getElementById('player-bar'),
        playerHint: document.getElementById('player-hint'),
        gridPatrolBadge: document.getElementById('grid-patrol-badge'),
        gridClock: document.getElementById('grid-clock'),
        form: document.getElementById('form'),
        setupMessage: document.getElementById('setup-message'),
        video: document.getElementById('video'),
        avObject: document.getElementById('av-player'),
        overlay: document.getElementById('overlay'),
        channelTitle: document.getElementById('channel-title'),
        status: document.getElementById('status'),
        stats: document.getElementById('stats'),
        ptzOverlay: document.getElementById('ptz-overlay'),
        ptzCamTitle: document.getElementById('ptz-cam-title'),
        ptzPad: document.getElementById('ptz-pad'),
        ptzPresets: document.getElementById('ptz-presets'),
        ptzPresetsTitle: document.getElementById('ptz-presets-title'),
        ptzHints: document.getElementById('ptz-hints')
    };

    var rows = Array.prototype.slice.call(el.form.querySelectorAll('.row'));
    var focusedRow = 0;

    // ---- texts (js/i18n.js): T('key', values for {0}, {1}...)
    function T(key) {
        var all = window.RV_STR || {}, text = (all[settings.lang] || {})[key];
        if (text === undefined) text = (all.en || {})[key];
        if (text === undefined) text = key;
        var args = arguments;
        return text.replace(/\{(\d)\}/g, function (m, i) { return args[+i + 1] === undefined ? '' : args[+i + 1]; });
    }

    function applyI18n() {
        if ((window.RV_LANGS || ['en']).indexOf(settings.lang) < 0) settings.lang = 'en';
        document.documentElement.lang = settings.lang;
        Array.prototype.forEach.call(document.querySelectorAll('[data-i18n]'), function (node) {
            node.textContent = T(node.getAttribute('data-i18n'));
        });
        el.gridPatrolBadge.textContent = T('patrolBadge', Math.round(PATROL_INTERVAL_MS / 1000));
    }

    function qualityLabel(q) { return q === 'sub' ? T('qSub') : q === 'ext' ? T('qExt') : q === 'main' ? T('qMain') : q; }

    // What a settings row shows for a value.
    function optionLabel(field, val) {
        if (field === 'lang') return (window.RV_LANG_NAMES || {})[val] || val;
        if (field === 'stream') return qualityLabel(val);
        if (field === 'audio') return T(val === 'on' ? 'on' : 'off');
        if (field === 'ptzChannel') return parseInt(val, 10) ? String(val) : T('none');
        var keys = { flv: 'oFlv', rtsp: 'oRtsp', auto: 'oAuto', mse: 'oMse', avplay: 'oAvplay', grid: 'oGrid', player: 'oPlayer' };
        return keys[val] ? T(keys[val]) : val;
    }

    // ---- what happened lately, shown under "Info" in the player
    var eventLog = [];
    var statsText = '';
    function renderStats() { el.stats['textContent'] = statsText + (eventLog.length ? '\n' + eventLog.join('\n') : ''); }
    function setStats(text) { statsText = text || ''; renderStats(); }
    function logEvent(text) {
        var now = new Date();
        eventLog.push(('0' + now.getHours()).slice(-2) + ':' + ('0' + now.getMinutes()).slice(-2) + ':' + ('0' + now.getSeconds()).slice(-2) + '  ' + text);
        if (eventLog.length > 7) eventLog.shift();
        renderStats();
    }
    var currentView = 'grid'; // 'grid' | 'player' | 'setup'

    // Grid state
    var snapshotTimer = null;
    var snapshotInFlight = false;

    // Player state
    var player = null;
    var avplayActive = false;
    var avplayPaused = false;
    var activeBackend = null;
    var mseFailedForRelay = false;
    var startToken = 0;
    var reconnectTimer = null;
    var reconnectAttempt = 0;
    var relayPollTimer = null;
    var overlayTimer = null;
    var lastMediaInfo = null;
    var lastRelayStatus = null;

    // Patrol state
    var patrolActive = false;
    var patrolTimer = null;
    var PATROL_INTERVAL_MS = 10000;

    // PTZ state
    var ptzActive = false;
    var ptzStopTimer = null;

    // ------------------------------------------------------------------ Settings

    function loadSettings() {
        var saved = {};
        try {
            saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
        } catch (e) {
            saved = {};
        }

        // Versions before the "PTZ camera channel" setting treated channel 5 as the PTZ camera.
        if (saved.host && saved.ptzChannel === undefined) saved.ptzChannel = 5;

        // Preload default_config.json if first launch
        if (!saved.host) {
            try {
                var xhr = new XMLHttpRequest();
                xhr.open('GET', 'default_config.json', false);
                xhr.send(null);
                if (xhr.status === 200 || xhr.status === 0) {
                    var def = JSON.parse(xhr.responseText);
                    if (def.nvrIp) saved.host = def.nvrIp;
                    if (def.httpPort) saved.port = String(def.httpPort);
                    if (def.username) saved.user = def.username;
                    if (def.password) saved.password = def.password;
                    if (def.channelsCount) saved.channelsCount = def.channelsCount;
                    if (def.streamQuality) saved.stream = def.streamQuality;
                    if (def.ptzChannel) saved.ptzChannel = def.ptzChannel;
                    if (def.channelNames) {
                        saved.channelNames = {};
                        Object.keys(def.channelNames).forEach(function(k) {
                            var chIdx = parseInt(k, 10) - 1;
                            saved.channelNames[chIdx] = def.channelNames[k];
                        });
                    }
                }
            } catch (err) {
                console.warn('[Settings] Could not load default_config.json:', err);
            }
        }

        var merged = {};
        Object.keys(DEFAULTS).forEach(function (key) {
            merged[key] = saved.hasOwnProperty(key) ? saved[key] : DEFAULTS[key];
        });
        return merged;
    }

    function saveSettings() {
        try {
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
        } catch (e) {}
    }

    function getChannelDisplayName(ch) {
        if (settings.channelNames && settings.channelNames[ch]) {
            return settings.channelNames[ch];
        }
        return T('camera', ('0' + (ch + 1)).slice(-2));
    }

    function isPtzChannel(ch) {
        return (parseInt(settings.ptzChannel, 10) || 0) === ch + 1;
    }

    // The quality a camera is really opened in. The one chosen in the toolbar, except:
    //  - a PTZ camera's lowest stream is skipped (it stalls), so Fluent means Balanced there;
    //  - a quality this TV could not decode for this camera (settings.unplayable, filled in when it fails)
    //    steps down: Clear -> Balanced -> Fluent. Choosing a quality again forgets those marks.
    var QUALITY_DOWN = { main: 'ext', ext: 'sub' };
    function effectiveQuality(channel, wanted) {
        var q = wanted || 'sub', bad = settings.unplayable || {};
        var floor = isPtzChannel(channel) ? 'ext' : 'sub';
        if (q === 'sub') q = floor;
        while (bad[channel + ':' + q] && q !== floor && QUALITY_DOWN[q]) q = QUALITY_DOWN[q];
        return q;
    }

    function getStreamName(channel, streamQuality) {
        return 'channel' + channel + '_' + effectiveQuality(channel, streamQuality) + '.bcs';
    }

    // The picture could not be decoded: remember that for this camera and quality, and open the next lower
    // one at once. False when there is nothing lower to try.
    function stepQualityDown() {
        if (activeBackend !== 'flv') return false;
        var ch = settings.channel, q = effectiveQuality(ch, settings.stream);
        var floor = isPtzChannel(ch) ? 'ext' : 'sub';
        if (q === floor || !QUALITY_DOWN[q]) return false;
        if (!settings.unplayable || typeof settings.unplayable !== 'object') settings.unplayable = {};
        settings.unplayable[ch + ':' + q] = 1;
        saveSettings();
        logEvent(T('qFallback', qualityLabel(q), qualityLabel(effectiveQuality(ch, settings.stream))));
        reconnectAttempt = 0;
        startPlayer();
        return true;
    }

    function buildStreamUrl(opts) {
        var defaultPort = opts.scheme === 'https' ? '443' : '80';
        var hostPort = opts.host + (opts.port && opts.port !== defaultPort ? ':' + opts.port : '');
        var stream = getStreamName(opts.channel, opts.stream);
        return opts.scheme + '://' + hostPort +
            '/flv?port=1935&app=bcs' +
            '&stream=' + stream +
            '&user=' + encodeURIComponent(opts.user) +
            '&password=' + encodeURIComponent(opts.password);
    }

    function buildSnapshotUrl(channelIndex) {
        var defaultPort = settings.scheme === 'https' ? '443' : '80';
        var hostPort = settings.host + (settings.port && settings.port !== defaultPort ? ':' + settings.port : '');
        return (settings.scheme || 'http') + '://' + hostPort +
            '/cgi-bin/api.cgi?cmd=Snap&channel=' + channelIndex +
            '&user=' + encodeURIComponent(settings.user) +
            '&password=' + encodeURIComponent(settings.password) +
            '&rs=' + Date.now();
    }

    function maskPassword(url) {
        return url.replace(/password=[^&]*/, 'password=••••');
    }

    // ------------------------------------------------------------------ Views Navigation

    function showView(name) {
        currentView = name;
        el.grid.classList.toggle('hidden', name !== 'grid');
        el.player.classList.toggle('hidden', name !== 'player');
        el.setup.classList.toggle('hidden', name !== 'setup');

        clearTimeout(barTimer);
        barActive = false;
        el.playerBar.classList.add('hidden');
        el.playerHint.classList.remove('hidden');

        if (name === 'grid') {
            destroyPlayer();
            closePtzOverlay();
            if (/^cam:/.test(gridFocusKey)) showPageOf(focusedChannel());
            renderGrid();
            startSnapshotLoop();
        } else if (name === 'player') {
            stopSnapshotLoop();
        } else if (name === 'setup') {
            destroyPlayer();
            stopSnapshotLoop();
            closePtzOverlay();
            renderForm();
            setFocus(focusedRow);
        }
    }

    function exitApp() {
        destroyPlayer();
        stopRelaySession();
        try {
            window.tizen.application.getCurrentApplication().exit();
        } catch (e) {}
    }

    // ------------------------------------------------------------------ Toolbars (arrows + OK)

    function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
    function pad2(n) { return ('0' + n).slice(-2); }

    // A row of buttons. defs: [{id, icon(), label(), action(), visible()?, on()?, right?}]. `focused` tells whether
    // the bar draws its own cursor (the player's bar); in the live view the cursor is shared with tiles and list.
    function makeBar(container, defs, focused) {
        var bar = { index: 0, items: [], after: null };
        bar.render = function () {
            bar.items = defs.filter(function (d) { return !d.visible || d.visible(); });
            bar.index = Math.max(0, Math.min(bar.index, bar.items.length - 1));
            container.innerHTML = '';
            var pushed = false;
            bar.items.forEach(function (d, i) {
                var b = document.createElement('div');
                b.className = 'tb-btn nav' + (d.on && d.on() ? ' on' : '') + (d.right && !pushed ? ' push-right' : '') +
                    (focused && focused() && i === bar.index ? ' focused' : '');
                if (d.right) pushed = true;
                b.setAttribute('data-key', 'bar:' + d.id);
                var label = d.label ? d.label() : '';
                b.innerHTML = '<span class="tb-icon">' + esc(d.icon()) + '</span>' + (label ? '<span class="tb-label">' + esc(label) + '</span>' : '');
                b.addEventListener('click', function () { bar.index = i; bar.run(d.id); });
                container.appendChild(b);
            });
        };
        bar.move = function (step) {
            if (!bar.items.length) return;
            bar.index = (bar.index + step + bar.items.length) % bar.items.length;
            bar.render();
        };
        bar.focusId = function (id) {
            bar.items = defs.filter(function (d) { return !d.visible || d.visible(); });
            for (var i = 0; i < bar.items.length; i++) if (bar.items[i].id === id) bar.index = i;
        };
        bar.run = function (id) {
            var d = null;
            defs.forEach(function (x) { if (x.id === id) d = x; });
            if (!d || (d.visible && !d.visible())) return;
            d.action();
            if (bar.after) bar.after(d);
        };
        bar.activate = function () { if (bar.items[bar.index]) bar.run(bar.items[bar.index].id); };
        return bar;
    }

    var QUALITY_ORDER = ['sub', 'ext', 'main'];

    function cycleQuality() {
        var i = QUALITY_ORDER.indexOf(settings.stream);
        settings.stream = QUALITY_ORDER[(i + 1) % QUALITY_ORDER.length];
        settings.unplayable = {};          // chosen again: every camera gets another try at it
        saveSettings();
        if (currentView === 'player') { reconnectAttempt = 0; startPlayer(); }
    }

    function toggleAudio() {
        settings.audio = settings.audio === 'on' ? 'off' : 'on';
        saveSettings();
        if (currentView === 'player') { reconnectAttempt = 0; startPlayer(); }
    }

    // ------------------------------------------------------------------ Live view (device list, tiles, toolbar)

    var LAYOUTS = ['1+5', '2x2', '3x3', '4x2'];
    var LAYOUT_LABELS = { '1+5': '1 + 5', '2x2': '2 × 2', '3x3': '3 × 3', '4x2': '4 × 2' };

    var gridFocusKey = 'cam:0';          // what the cursor is on: cam:<ch>, side:<ch> or bar:<id>
    var gridPage = 0;
    var gridPages = 1;
    var visibleChannels = [];
    var channelState = {};               // ch -> 'ok' | 'fail' (did its last snapshot load)
    var lastThumb = {};                  // ch -> the last snapshot that loaded
    var snapQueue = [];
    var snapOther = 0;
    var snapGuard = null;

    function channelCount() { return Math.max(1, parseInt(settings.channelsCount, 10) || 8); }
    function shortName(ch) { return getChannelDisplayName(ch).replace(/^CH\s*\d+\s*[-–:]\s*/i, ''); }
    function mainChannel() { var c = parseInt(settings.channel, 10) || 0; return c >= 0 && c < channelCount() ? c : 0; }
    function currentLayout() { return LAYOUTS.indexOf(settings.layout) >= 0 ? settings.layout : '1+5'; }
    function perPage(layout) { return layout === '2x2' ? 4 : layout === '3x3' ? 9 : 8; }

    // The cameras in the user's order (CH+ / CH- on the list or on a tile): the saved order, minus channels that no longer
    // exist, plus any new ones at the end.
    function orderedChannels() {
        var count = channelCount(), out = [], seen = {};
        (Array.isArray(settings.order) ? settings.order : []).forEach(function (c) {
            c = parseInt(c, 10);
            if (c >= 0 && c < count && !seen[c]) { seen[c] = true; out.push(c); }
        });
        for (var i = 0; i < count; i++) if (!seen[i]) out.push(i);
        return out;
    }

    // Moves camera `ch` one place up (-1) or down (+1) in the list; the tiles follow. The cursor stays on the
    // camera: on its row when moved from the list, on its tile (and its page) when moved from a tile.
    function moveCameraInOrder(ch, step) {
        var order = orderedChannels(), i = order.indexOf(ch), j = i + step;
        if (i < 0) return;
        if (/^cam:/.test(gridFocusKey) && currentLayout() === '1+5') {
            // On the tiles of "1 + 5" the large tile is the first place: the tile next to it swaps with it.
            var main = mainChannel();
            var rest = order.filter(function (c) { return c !== main; });
            var at = rest.indexOf(ch);
            if (ch === main ? step > 0 && rest.length : step < 0 && at === 0) {
                var big = ch === main ? rest[0] : ch, small = ch === main ? main : rest[0] === ch ? main : rest[0];
                settings.order = [big, small].concat(rest.slice(1));
                settings.channel = big;
                saveSettings();
                gridPage = 0;
                gridFocusKey = 'cam:' + ch;
                renderGrid();
                return;
            }
            if (ch === main || at + step < 0 || at + step >= rest.length) return;
            j = order.indexOf(rest[at + step]);
        }
        if (j < 0 || j >= order.length) return;
        order[i] = order[j];
        order[j] = ch;
        settings.order = order;
        saveSettings();
        if (/^cam:/.test(gridFocusKey)) { gridFocusKey = 'cam:' + ch; showPageOf(ch); }
        else gridFocusKey = 'side:' + ch;
        renderGrid();
    }

    // The channels of the current page in tile order. In "1 + 5" the first is the large tile: the camera that
    // was opened last, with the others five to a page around it.
    function pageInfo() {
        var count = channelCount(), layout = currentLayout(), all = orderedChannels(), list;
        if (layout === '1+5') {
            var main = mainChannel();
            var rest = all.filter(function (c) { return c !== main; });
            gridPages = Math.max(1, Math.ceil(rest.length / 5));
            gridPage = ((gridPage % gridPages) + gridPages) % gridPages;
            list = [main].concat(rest.slice(gridPage * 5, gridPage * 5 + 5));
        } else {
            var per = perPage(layout);
            gridPages = Math.max(1, Math.ceil(count / per));
            gridPage = ((gridPage % gridPages) + gridPages) % gridPages;
            list = all.slice(gridPage * per, gridPage * per + per);
        }
        return { layout: layout, list: list };
    }

    // The page that shows channel `ch`.
    function showPageOf(ch) {
        var layout = currentLayout();
        if (layout === '1+5') {
            if (ch === mainChannel()) return;
            var rest = orderedChannels().filter(function (c) { return c !== mainChannel(); });
            gridPage = Math.max(0, Math.floor(rest.indexOf(ch) / 5));
        } else {
            gridPage = Math.max(0, Math.floor(orderedChannels().indexOf(ch) / perPage(layout)));
        }
    }

    function renderGrid() {
        var info = pageInfo();
        visibleChannels = info.list;
        snapQueue = [];
        el.gridContainer.className = 'grid-container layout-' + info.layout.replace('+', 'p');
        el.gridContainer.innerHTML = '';

        info.list.forEach(function (ch, i) {
            var card = document.createElement('div');
            var off = channelState[ch] === 'fail';
            card.className = 'camera-card nav' + (info.layout === '1+5' && i === 0 ? ' big' : '') + (off ? ' offline' : '');
            card.id = 'cam-card-' + ch;
            card.setAttribute('data-key', 'cam:' + ch);
            card.innerHTML =
                '<img class="card-thumb" id="thumb-' + ch + '" alt="">' +
                '<div class="card-placeholder" id="placeholder-' + ch + '"><span class="ph-icon"></span>' +
                '<span class="ph-text">' + esc(T(off ? 'noSignal' : 'loadingPreview')) + '</span></div>' +
                '<div class="card-label"><span class="card-ch">' + pad2(ch + 1) + '</span>' + esc(shortName(ch)) +
                (isPtzChannel(ch) ? '<span class="badge-ptz">PTZ</span>' : '') +
                '<span class="card-hint">' + esc(T(info.layout === '1+5' && i > 0 ? 'hintEnlarge' : 'hintFull')) + '</span></div>';
            card.addEventListener('click', function () { gridFocusKey = 'cam:' + ch; activateGridFocus(); });
            el.gridContainer.appendChild(card);
            if (lastThumb[ch]) {
                card.querySelector('.card-thumb').src = lastThumb[ch];
                card.querySelector('.card-placeholder').style.display = 'none';
            }
        });

        renderSidebar();
        gridBar.render();
        setGridFocusKey(gridFocusKey);
    }

    function renderSidebar() {
        var hidden = settings.sidebar === 'off';
        el.sidebar.classList.toggle('hidden', hidden);
        el.grid.classList.toggle('no-sidebar', hidden);
        el.sideHost.textContent = settings.host || '';
        var html = '', main = mainChannel();
        orderedChannels().forEach(function (ch) {
            html += '<div class="side-row nav' + (channelState[ch] === 'fail' ? ' offline' : '') + (ch === main ? ' current' : '') +
                '" id="side-row-' + ch + '" data-key="side:' + ch + '" data-channel="' + ch + '"><span class="side-dot"></span>' +
                '<span class="side-name">' + esc(shortName(ch)) + '</span>' + (isPtzChannel(ch) ? '<span class="badge-ptz">PTZ</span>' : '') + '</div>';
        });
        el.sideList.innerHTML = html;
        updateSideSummary();
    }

    function updateSideSummary() {
        var count = channelCount(), ok = 0, known = 0;
        for (var ch = 0; ch < count; ch++) {
            if (channelState[ch]) known++;
            if (channelState[ch] === 'ok') ok++;
        }
        el.sideCount.textContent = T('channels', ok, count);
        var bad = known === count && ok === 0;
        el.sideState.textContent = T(ok ? 'connected' : bad ? 'noConnection' : 'connecting');
        el.sideState.classList.toggle('bad', bad);
    }

    function gridNavs() {
        return Array.prototype.slice.call(el.grid.querySelectorAll('.nav')).filter(function (n) { return n.offsetParent !== null; });
    }

    function setGridFocusKey(key) {
        var navs = gridNavs(), target = null;
        navs.forEach(function (n) { if (n.getAttribute('data-key') === key) target = n; });
        if (!target) target = el.gridContainer.querySelector('.nav') || navs[0];
        if (!target) return;
        gridFocusKey = target.getAttribute('data-key');
        Array.prototype.forEach.call(el.grid.querySelectorAll('.focused, .hint'), function (n) { n.classList.remove('focused'); n.classList.remove('hint'); });
        target.classList.add('focused');
        var side = /^side:(\d+)$/.exec(gridFocusKey);
        el.sideHint.classList.toggle('shown', !!side || /^cam:/.test(gridFocusKey));
        if (side) {
            // Keep the row in sight and mark the camera's tile.
            var list = el.sideList;
            if (target.offsetTop < list.scrollTop) list.scrollTop = target.offsetTop;
            else if (target.offsetTop + target.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = target.offsetTop + target.offsetHeight - list.clientHeight;
            var card = document.getElementById('cam-card-' + side[1]);
            if (card) card.classList.add('hint');
        }
    }

    // The cursor moves to the nearest thing in the direction pressed: tiles, list rows and toolbar buttons alike.
    function moveGridFocus(dx, dy) {
        var cur = el.grid.querySelector('.nav.focused');
        if (!cur) return setGridFocusKey(gridFocusKey);

        // Between a camera's tile and its row in the list.
        var cam = /^cam:(\d+)$/.exec(gridFocusKey), side = /^side:(\d+)$/.exec(gridFocusKey);
        if (dx < 0 && cam && document.getElementById('side-row-' + cam[1]) && settings.sidebar !== 'off') {
            var a0 = cur.getBoundingClientRect(), leftmost = true;
            Array.prototype.forEach.call(el.gridContainer.querySelectorAll('.camera-card'), function (c) {
                if (c !== cur && c.getBoundingClientRect().right <= a0.left + 2) leftmost = false;
            });
            if (leftmost) return setGridFocusKey('side:' + cam[1]);
        }
        if (dx > 0 && side && document.getElementById('cam-card-' + side[1])) return setGridFocusKey('cam:' + side[1]);

        var best = nearestNav(gridNavs(), cur, dx, dy);
        if (best) setGridFocusKey(best.getAttribute('data-key'));
    }

    function activateGridFocus() {
        var m = /^(cam|side|bar):(.+)$/.exec(gridFocusKey);
        if (!m) return;
        if (m[1] === 'bar') return gridBar.run(m[2]);
        var ch = parseInt(m[2], 10);
        if (currentLayout() === '1+5' && ch !== mainChannel()) return enlargeCamera(ch);
        openCamera(ch);
    }

    // Rearranges "1 + 5": camera `ch` takes the large tile, the others follow in order.
    function enlargeCamera(ch) {
        settings.channel = ch;
        saveSettings();
        gridPage = 0;
        renderGrid();
    }

    function focusedChannel() {
        var m = /^(?:cam|side):(\d+)$/.exec(gridFocusKey);
        return m ? parseInt(m[1], 10) : mainChannel();
    }

    function changeGridPage(step) {
        if (gridPages < 2) return;
        gridPage += step;
        renderGrid();
    }

    function openCamera(ch) {
        settings.channel = ch;
        saveSettings();
        gridFocusKey = 'cam:' + ch;
        showView('player');
        startPlayer();
    }

    var gridBar = makeBar(el.gridBar, [
        { id: 'list', icon: function () { return '≡'; }, label: function () { return T('tbList'); },
          on: function () { return settings.sidebar !== 'off'; },
          action: function () { settings.sidebar = settings.sidebar === 'off' ? 'on' : 'off'; saveSettings(); } },
        { id: 'prev', icon: function () { return '‹'; }, label: function () { return ''; },
          visible: function () { return gridPages > 1; }, action: function () { gridPage -= 1; } },
        { id: 'next', icon: function () { return '›'; }, label: function () { return T('tbPage', gridPage + 1, gridPages); },
          visible: function () { return gridPages > 1; }, action: function () { gridPage += 1; } },
        { id: 'patrol', icon: function () { return '↻'; }, label: function () { return T('tbPatrol'); },
          on: function () { return patrolActive; }, action: function () { togglePatrol(); } },
        { id: 'audio', right: true, icon: function () { return '♪'; }, label: function () { return T('tbSound', T(settings.audio === 'on' ? 'on' : 'off')); },
          on: function () { return settings.audio === 'on'; }, action: toggleAudio },
        { id: 'quality', right: true, icon: function () { return 'HD'; }, label: function () { return qualityLabel(settings.stream); },
          action: cycleQuality },
        { id: 'layout', right: true, icon: function () { return '▦'; }, label: function () { return T('tbLayout', LAYOUT_LABELS[currentLayout()]); },
          action: function () {
              settings.layout = LAYOUTS[(LAYOUTS.indexOf(currentLayout()) + 1) % LAYOUTS.length];
              gridPage = 0;
              saveSettings();
          } },
        { id: 'setup', right: true, icon: function () { return '⚙'; }, label: function () { return T('tbSettings'); },
          action: function () { showView('setup'); } },
        { id: 'exit', right: true, icon: function () { return '×'; }, label: function () { return T('tbExit'); },
          action: function () { exitApp(); } }
    ]);
    gridBar.after = function (d) {
        if (currentView !== 'grid') return;
        gridFocusKey = 'bar:' + d.id;
        renderGrid();
    };

    // ---- snapshots: the tiles on screen in turn (the large one every other time), plus one camera that is not
    // on screen per round, so the list knows which cameras answer.
    function snapshotRound() {
        var q = [], big = currentLayout() === '1+5' ? visibleChannels[0] : null;
        visibleChannels.forEach(function (ch, i) {
            if (big !== null && i > 0) q.push(big);
            if (big === null || i > 0) q.push(ch);
        });
        if (big !== null && visibleChannels.length === 1) q.push(big);
        var others = [];
        for (var ch = 0; ch < channelCount(); ch++) if (visibleChannels.indexOf(ch) < 0) others.push(ch);
        if (others.length) q.push(others[snapOther++ % others.length]);
        return q;
    }

    function startSnapshotLoop() {
        stopSnapshotLoop();
        snapQueue = [];
        loadNextSnapshot();
    }

    function stopSnapshotLoop() {
        clearTimeout(snapshotTimer);
        clearTimeout(snapGuard);
        snapshotTimer = null;
        snapshotInFlight = false;
    }

    function markChannel(ch, ok) {
        var was = channelState[ch];
        channelState[ch] = ok ? 'ok' : 'fail';
        if (was === channelState[ch]) return;
        var row = document.getElementById('side-row-' + ch), card = document.getElementById('cam-card-' + ch);
        if (row) row.classList.toggle('offline', !ok);
        if (card) {
            card.classList.toggle('offline', !ok);
            var text = card.querySelector('.ph-text');
            if (text) text.textContent = T(ok ? 'loadingPreview' : 'noSignal');
        }
        updateSideSummary();
    }

    function loadNextSnapshot() {
        if (currentView !== 'grid') return;
        if (!snapQueue.length) snapQueue = snapshotRound();
        var ch = snapQueue.shift();
        if (ch === undefined) { snapshotTimer = setTimeout(loadNextSnapshot, 500); return; }

        var tempImg = new Image();
        var mine = {};
        snapshotInFlight = mine;
        var done = function (ok) {
            if (snapshotInFlight !== mine) return;
            snapshotInFlight = false;
            clearTimeout(snapGuard);
            tempImg.onload = tempImg.onerror = null;
            markChannel(ch, ok);
            if (ok) {
                lastThumb[ch] = tempImg.src;
                var img = document.getElementById('thumb-' + ch), ph = document.getElementById('placeholder-' + ch);
                if (img) img.src = tempImg.src;
                if (ph) ph.style.display = 'none';
            }
            if (currentView === 'grid') snapshotTimer = setTimeout(loadNextSnapshot, ok ? 150 : 400);
        };
        tempImg.onload = function () { done(true); };
        tempImg.onerror = function () { done(false); };
        snapGuard = setTimeout(function () { done(false); }, 7000);     // a camera that never answers
        tempImg.src = buildSnapshotUrl(ch);
    }

    // ------------------------------------------------------------------ Patrol Mode

    function togglePatrol() {
        patrolActive = !patrolActive;
        if (el.gridPatrolBadge) {
            el.gridPatrolBadge.classList.toggle('hidden', !patrolActive);
        }
        if (patrolActive) {
            setStatus(T('patrolOn', Math.round(PATROL_INTERVAL_MS / 1000)));
            if (currentView !== 'player') {
                openCamera(focusedChannel());
            }
            startPatrolTimer();
        } else {
            setStatus(T('patrolOff'));
            stopPatrolTimer();
        }
    }

    function startPatrolTimer() {
        stopPatrolTimer();
        patrolTimer = setInterval(function() {
            if (!patrolActive) return;
            changeChannel(1);
        }, PATROL_INTERVAL_MS);
    }

    function stopPatrolTimer() {
        if (patrolTimer) {
            clearInterval(patrolTimer);
            patrolTimer = null;
        }
    }

    // ------------------------------------------------------------------ PTZ popup
    // A panel over the picture. The arrows choose a button; OK presses it, and for the movement buttons the
    // camera moves for as long as OK is held. "Arrow mode" (the middle button) makes the arrows themselves
    // move the camera until OK is pressed again.

    var PTZ_SPEEDS = { slow: 8, medium: 20, fast: 45 };
    var PTZ_SPEED_ORDER = ['slow', 'medium', 'fast'];
    var PTZ_MOVES = { Up: 1, Down: 1, Left: 1, Right: 1, ZoomInc: 1, ZoomDec: 1, FocusInc: 1, FocusDec: 1 };
    var PTZ_MIN_MOVE_MS = 300;           // a tap moves at least this long
    var PTZ_HOLD_MS = 900;               // no repeat of the key in this time: it was released

    var ptzFocusKey = 'ptz:Up';
    var ptzArrowMode = false;
    var ptzMoving = null;
    var ptzMoveStart = 0;
    var ptzPresets = [];
    var ptzPresetsFor = null;

    function ptzSpeedName() { return PTZ_SPEEDS[settings.ptzSpeed] ? settings.ptzSpeed : 'medium'; }

    function ptzRequest(cmd, action, param, cb) {
        var defaultPort = settings.scheme === 'https' ? '443' : '80';
        var url = (settings.scheme || 'http') + '://' + settings.host + (settings.port && settings.port !== defaultPort ? ':' + settings.port : '') +
            '/cgi-bin/api.cgi?cmd=' + cmd + '&user=' + encodeURIComponent(settings.user) +
            '&password=' + encodeURIComponent(settings.password);
        var xhr = new XMLHttpRequest();
        xhr.open('POST', url, true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        xhr.timeout = 3000;
        xhr.onload = function () {
            var data = null;
            try { data = JSON.parse(xhr.responseText); } catch (e) {}
            if (cb) cb(data && data[0] ? data[0] : null);
        };
        xhr.onerror = xhr.ontimeout = function () { if (cb) cb(null); };
        xhr.send(JSON.stringify([{ cmd: cmd, action: action, param: param }]));
    }

    function sendPtz(op, id) {
        var param = { channel: settings.channel, op: op, speed: PTZ_SPEEDS[ptzSpeedName()] };
        if (id !== undefined) param.id = id;
        ptzRequest('PtzCtrl', 0, param, function (res) {
            if (!res || res.code !== 0) logEvent('PTZ ' + op + ': ' + (res && res.error ? JSON.stringify(res.error) : 'no answer'));
        });
    }

    // Starts a movement, or keeps it going while the key repeats.
    function startPtz(op) {
        if (ptzMoving !== op) {
            if (ptzMoving) sendPtz('Stop');
            sendPtz(op);
            ptzMoving = op;
            ptzMoveStart = Date.now();
        }
        clearTimeout(ptzStopTimer);
        ptzStopTimer = setTimeout(stopPtz, PTZ_HOLD_MS);
        var b = el.ptzPad.querySelector('[data-key="ptz:' + op + '"]');
        if (b) b.classList.add('active');
    }

    function stopPtz() {
        clearTimeout(ptzStopTimer);
        if (!ptzMoving) return;
        ptzMoving = null;
        sendPtz('Stop');
        Array.prototype.forEach.call(el.ptzPad.querySelectorAll('.active'), function (b) { b.classList.remove('active'); });
    }

    // The key was released: stop, but not before a tap has moved the camera a little.
    function releasePtz() {
        if (!ptzMoving) return;
        var left = PTZ_MIN_MOVE_MS - (Date.now() - ptzMoveStart);
        clearTimeout(ptzStopTimer);
        if (left > 0) ptzStopTimer = setTimeout(stopPtz, left); else stopPtz();
    }

    function renderPtz() {
        var btn = function (id, glyph, text, cls) {
            return '<div class="ptz-btn nav' + (cls ? ' ' + cls : '') + '" data-key="ptz:' + id + '">' +
                (glyph ? '<span class="ptz-glyph">' + glyph + '</span>' : '') + (text ? '<span class="ptz-text">' + esc(text) + '</span>' : '') + '</div>';
        };
        el.ptzPad.innerHTML =
            '<div class="ptz-row">' + btn('ZoomDec', '', T('zoomOut')) + btn('Up', '▲', '') + btn('ZoomInc', '', T('zoomIn')) + '</div>' +
            '<div class="ptz-row">' + btn('Left', '◀', '') + btn('arrows', '✥', T('arrowMode'), ptzArrowMode ? 'on' : '') + btn('Right', '▶', '') + '</div>' +
            '<div class="ptz-row">' + btn('FocusDec', '', T('focusNear')) + btn('Down', '▼', '') + btn('FocusInc', '', T('focusFar')) + '</div>' +
            '<div class="ptz-row">' + btn('speed', '', T('ptzSpeed', T(ptzSpeedName())), 'wide') + btn('close', '', T('close')) + '</div>';
        el.ptzPresetsTitle.classList.toggle('hidden', !ptzPresets.length);
        el.ptzPresets.innerHTML = ptzPresets.map(function (p) { return btn('pre:' + p.id, '', p.name, 'preset'); }).join('');
        el.ptzHints.textContent = T(ptzArrowMode ? 'arrowHint' : 'ptzHint');
        el.ptzOverlay.classList.toggle('arrow-mode', ptzArrowMode);
        setPtzFocus(ptzFocusKey);
    }

    function ptzNavs() { return Array.prototype.slice.call(el.ptzOverlay.querySelectorAll('.nav')); }

    function setPtzFocus(key) {
        var navs = ptzNavs(), target = null;
        navs.forEach(function (n) { n.classList.remove('focused'); if (n.getAttribute('data-key') === key) target = n; });
        if (!target) target = navs[1] || navs[0];
        if (!target) return;
        ptzFocusKey = target.getAttribute('data-key');
        target.classList.add('focused');
    }

    function loadPtzPresets() {
        var ch = settings.channel;
        if (ptzPresetsFor === ch) return;
        ptzPresets = [];
        ptzRequest('GetPtzPreset', 1, { channel: ch }, function (res) {
            if (!ptzActive || settings.channel !== ch) return;
            var list = res && res.value && res.value.PtzPreset ? res.value.PtzPreset : res && res.initial && res.initial.PtzPreset ? res.initial.PtzPreset : [];
            ptzPresets = list.filter(function (p) { return p && p.enable === 1 && p.name; }).slice(0, 8)
                .map(function (p) { return { id: p.id, name: String(p.name).slice(0, 18) }; });
            ptzPresetsFor = ch;
            renderPtz();
        });
    }

    function openPtzOverlay() {
        if (ptzActive || !isPtzChannel(settings.channel)) return;
        hideBar();
        ptzActive = true;
        ptzArrowMode = false;
        el.ptzCamTitle.textContent = getChannelDisplayName(settings.channel);
        if (ptzPresetsFor !== settings.channel) ptzPresets = [];
        renderPtz();
        el.ptzOverlay.classList.remove('hidden');
        loadPtzPresets();
    }

    function closePtzOverlay() {
        stopPtz();
        ptzActive = false;
        ptzArrowMode = false;
        if (el.ptzOverlay) el.ptzOverlay.classList.add('hidden');
    }

    function togglePtzOverlay() {
        if (ptzActive) closePtzOverlay(); else openPtzOverlay();
    }

    function pressPtz(id, repeat) {
        if (PTZ_MOVES[id]) return startPtz(id);
        if (repeat) return;
        if (id === 'arrows') { ptzArrowMode = !ptzArrowMode; stopPtz(); renderPtz(); return; }
        if (id === 'speed') {
            settings.ptzSpeed = PTZ_SPEED_ORDER[(PTZ_SPEED_ORDER.indexOf(ptzSpeedName()) + 1) % PTZ_SPEED_ORDER.length];
            saveSettings();
            renderPtz();
            return;
        }
        if (id === 'close') { closePtzOverlay(); showBar('ptz'); return; }
        var pre = /^pre:(\d+)$/.exec(id);
        if (pre) { stopPtz(); sendPtz('ToPos', parseInt(pre[1], 10)); }
    }

    function handlePtzKey(event) {
        var k = event.keyCode;
        var dir = k === KEY.UP ? 'Up' : k === KEY.DOWN ? 'Down' : k === KEY.LEFT ? 'Left' : k === KEY.RIGHT ? 'Right' : null;
        if (ptzArrowMode) {
            if (dir) startPtz(dir);
            else if (k === KEY.ENTER || k === KEY.RETURN) { if (!event.repeat) pressPtz('arrows'); }
            else return;
        } else if (dir) {
            var cur = el.ptzOverlay.querySelector('.nav.focused');
            var next = cur ? nearestNav(ptzNavs(), cur, dir === 'Left' ? -1 : dir === 'Right' ? 1 : 0, dir === 'Up' ? -1 : dir === 'Down' ? 1 : 0) : null;
            if (next) setPtzFocus(next.getAttribute('data-key'));
        } else if (k === KEY.ENTER) {
            pressPtz(ptzFocusKey.replace(/^ptz:/, ''), event.repeat);
        } else if (k === KEY.RETURN || k === KEY.BLUE || k === KEY.PLAY_PAUSE) {
            closePtzOverlay();
            showBar('ptz');
        } else {
            return;
        }
        event.preventDefault();
    }

    // The nearest of `navs` from `cur` in the direction (dx, dy): what lines up with it first, then the closest.
    function nearestNav(navs, cur, dx, dy) {
        var a = cur.getBoundingClientRect(), best = null, bestScore = Infinity;
        var gap = function (lo1, hi1, lo2, hi2) { return lo2 >= hi1 ? lo2 - hi1 : lo1 >= hi2 ? lo1 - hi2 : 0; };
        navs.forEach(function (n) {
            if (n === cur) return;
            var b = n.getBoundingClientRect(), along, across, centre;
            if (dx) {
                if (dx > 0 ? b.left < a.right - 2 : b.right > a.left + 2) return;
                along = dx > 0 ? b.left - a.right : a.left - b.right;
                across = gap(a.top, a.bottom, b.top, b.bottom);
                centre = Math.abs((b.top + b.bottom) - (a.top + a.bottom));
            } else {
                if (dy > 0 ? b.top < a.bottom - 2 : b.bottom > a.top + 2) return;
                along = dy > 0 ? b.top - a.bottom : a.top - b.bottom;
                across = gap(a.left, a.right, b.left, b.right);
                centre = Math.abs((b.left + b.right) - (a.left + a.right));
            }
            var score = Math.max(0, along) + across * 4 + centre * 0.001;
            if (score < bestScore) { bestScore = score; best = n; }
        });
        return best;
    }

    // ------------------------------------------------------------------ Form Rendering (Setup)

    function visibleRows() {
        return rows.filter(function (row) { return !row.classList.contains('hidden'); });
    }

    function applyModeVisibility() {
        rows.forEach(function (row) {
            var mode = row.getAttribute('data-mode');
            if (mode) {
                row.classList.toggle('hidden', mode !== settings.mode);
            }
        });
    }

    function renderRow(row) {
        var field = row.getAttribute('data-field');
        if (!field) return;

        var type = row.getAttribute('data-type');
        var val = settings[field];

        if (type === 'text') {
            var input = row.querySelector('input');
            if (input && document.activeElement !== input) {
                input.value = val !== undefined ? val : '';
            }
        } else if (type === 'toggle' || type === 'stepper') {
            var valueEl = row.querySelector('.value');
            if (valueEl) {
                valueEl.textContent = optionLabel(field, val);
            }
        }
    }

    function renderForm() {
        applyModeVisibility();
        rows.forEach(renderRow);
    }

    function setFocus(target) {
        var list = visibleRows();
        if (!list.length) return;
        focusedRow = Math.max(0, Math.min(target, list.length - 1));
        list.forEach(function (row, idx) {
            row.classList.toggle('focused', idx === focusedRow);
        });
        // The form is taller than the screen: keep the row under the cursor in sight.
        var row = list[focusedRow], form = el.form;
        if (row.offsetTop < form.scrollTop) form.scrollTop = focusedRow === 0 ? 0 : row.offsetTop;
        else if (row.offsetTop + row.offsetHeight > form.scrollTop + form.clientHeight) form.scrollTop = row.offsetTop + row.offsetHeight - form.clientHeight + 6;
    }

    function moveFocus(direction) {
        setFocus(focusedRow + direction);
    }

    function cycleOption(row, direction) {
        var field = row.getAttribute('data-field');
        var options = (row.getAttribute('data-options') || '').split(',');
        if (!options.length || !field) return;

        var current = String(settings[field]);
        var idx = options.indexOf(current);
        if (idx === -1) idx = 0;
        var next = options[(idx + direction + options.length) % options.length];
        settings[field] = next;

        if (field === 'mode') {
            applyModeVisibility();
            setFocus(focusedRow);
        }
        if (field === 'lang') {
            applyI18n();
            renderForm();
        }
        renderRow(row);
        saveSettings();
    }

    function stepValue(row, direction) {
        var field = row.getAttribute('data-field');
        var min = parseInt(row.getAttribute('data-min'), 10);
        var max = parseInt(row.getAttribute('data-max'), 10);
        var current = parseInt(settings[field], 10) || 0;
        var next = current + direction;
        if (!isNaN(min) && next < min) next = max;
        if (!isNaN(max) && next > max) next = min;
        settings[field] = next;
        renderRow(row);
        saveSettings();
    }

    function adjustRow(row, direction) {
        var type = row.getAttribute('data-type');
        if (type === 'toggle') cycleOption(row, direction);
        else if (type === 'stepper') stepValue(row, direction);
    }

    function activateRow(row) {
        var action = row.getAttribute('data-action');
        if (action === 'open-grid') {
            saveSettings();
            showView('grid');
            return;
        }
        if (action === 'open-player') {
            saveSettings();
            openCamera(settings.channel || 0);
            return;
        }
        var input = row.querySelector('input');
        if (input) {
            input.focus();
            input.select();
        } else {
            adjustRow(row, 1);
        }
    }

    function commitInput(input) {
        var row = input.closest('.row');
        var field = row && row.getAttribute('data-field');
        if (!field) return;
        settings[field] = input.value.trim();
        saveSettings();
    }

    // ------------------------------------------------------------------ Status & OSD Overlay

    function setStatus(text, isError) {
        el.status.textContent = text;
        el.status.classList.toggle('error', !!isError);
        logEvent((isError ? '! ' : '') + text);
        showOverlay(true);
    }

    function showOverlay(autoHide) {
        el.overlay.classList.remove('faded');
        clearTimeout(overlayTimer);
        if (autoHide && !barActive && !infoOn) {
            overlayTimer = setTimeout(function () {
                el.overlay.classList.add('faded');
            }, OVERLAY_HIDE_MS);
        }
    }

    function toggleOverlay() {
        if (el.overlay.classList.contains('faded')) {
            showOverlay(true);
        } else {
            el.overlay.classList.add('faded');
        }
    }

    function describeMediaInfo(info) {
        if (!info) return '';
        var parts = [];
        if (info.videoCodec) parts.push(info.videoCodec.toUpperCase());
        if (info.width && info.height) parts.push(info.width + 'x' + info.height);
        if (info.fps) parts.push(Math.round(info.fps) + ' fps');
        return parts.join(' • ');
    }

    function bufferLag() {
        if (!el.video.buffered.length) return '';
        var lag = el.video.buffered.end(el.video.buffered.length - 1) - el.video.currentTime;
        return ' • buffer ' + lag.toFixed(1) + ' s';
    }

    // ------------------------------------------------------------------ Codec Support

    function mseCanPlay(codec) {
        if (!window.MediaSource || !window.mpegts || !window.mpegts.isSupported()) {
            return false;
        }
        var types = codec === 'H265'
            ? ['video/mp4; codecs="hvc1.1.6.L153.B0"', 'video/mp4; codecs="hev1.1.6.L153.B0"']
            : ['video/mp4; codecs="avc1.640028"'];
        for (var i = 0; i < types.length; i++) {
            try {
                if (window.MediaSource.isTypeSupported(types[i])) return true;
            } catch (e) {}
        }
        return false;
    }

    // ------------------------------------------------------------------ mpegts.js (FLV and relay TS)

    function onMediaInfo(info) {
        lastMediaInfo = info;
        if (activeBackend === 'flv' && /hevc|hvc1|hev1|h265/i.test(info.videoCodec || '') && !mseCanPlay('H265')) {
            if (!stepQualityDown()) setStatus(T('eH265'), true);
        }
    }

    function onStatistics(stats) {
        if (activeBackend !== 'flv') return;
        var speed = stats.speed ? (stats.speed / 1024).toFixed(2) + ' MB/s' : '';
        var dropped = stats.droppedFrames ? ' • dropped ' + stats.droppedFrames : '';
        setStats(describeMediaInfo(lastMediaInfo) +
            (speed ? '\n' + speed : '') + dropped + bufferLag() +
            '\n' + maskPassword(buildStreamUrl(settings)));
    }

    function explainError(type, detail, info) {
        var message = (info && info.msg) ? info.msg : '';
        if (type === 'NetworkError') {
            if (activeBackend === 'mse') return T('eRelayLost');
            if (/40[13]/.test(message) || (info && (info.code === 401 || info.code === 403))) {
                return T('eLogin');
            }
            if (info && info.code === 404) {
                return T('eNoStream');
            }
            return T('eNoNvr', settings.host);
        }
        if (type === 'MediaError') {
            return T('eMedia', detail || message);
        }
        return T('eOther', type + ' ' + (detail || '') + ' ' + message);
    }

    function onPlayerError(type, detail, info) {
        if (activeBackend === 'mse' && type === 'MediaError' && settings.rtspPlayer === 'auto' && !mseFailedForRelay) {
            switchToAvPlay();
            return;
        }
        if (type === 'MediaError' && stepQualityDown()) return;
        scheduleReconnect(explainError(type, detail, info));
    }

    function startMsePlayer(url, type, hasAudio) {
        if (!window.mpegts || !window.mpegts.isSupported()) {
            setStatus(T('eNoMse'), true);
            return;
        }
        player = window.mpegts.createPlayer({
            type: type,
            isLive: true,
            url: url,
            hasVideo: true,
            hasAudio: hasAudio
        }, MPEGTS_CONFIG);

        player.attachMediaElement(el.video);
        player.on(window.mpegts.Events.ERROR, onPlayerError);
        player.on(window.mpegts.Events.MEDIA_INFO, onMediaInfo);
        player.on(window.mpegts.Events.STATISTICS_INFO, onStatistics);
        player.on(window.mpegts.Events.LOADING_COMPLETE, function () {
            scheduleReconnect(T(activeBackend === 'mse' ? 'eRelayClosed' : 'eNvrClosed'));
        });

        player.load();
        var playPromise = player.play();
        if (playPromise && typeof playPromise.catch === 'function') {
            playPromise.catch(function (err) {
                if (err && err.name === 'AbortError') return;      // the camera was changed before this one started
                setStatus(T('eStart', err && err.message ? err.message : err), true);
            });
        }
    }

    function startFlvPlayback() {
        activeBackend = 'flv';
        var url = buildStreamUrl(settings);
        var name = getChannelDisplayName(settings.channel);
        if (el.channelTitle) el.channelTitle.textContent = name;
        setStatus(T('stConnecting', settings.host, name));
        setStats(maskPassword(url));
        startMsePlayer(url, 'flv', settings.audio === 'on');
    }

    function destroyMsePlayer() {
        if (!player) return;
        try {
            player.pause();
            player.unload();
            player.detachMediaElement();
            player.destroy();
        } catch (e) {}
        player = null;
    }

    // ------------------------------------------------------------------ Relay Service (RTSP Mode)

    function relayRequest(method, path, body, cb) {
        var xhr = new XMLHttpRequest();
        xhr.open(method, RELAY_BASE + path, true);
        xhr.timeout = 4000;
        xhr.onreadystatechange = function () {
            if (xhr.readyState !== 4) return;
            if (xhr.status === 0) {
                cb(new Error('relay unreachable'));
                return;
            }
            var data = null;
            try { data = JSON.parse(xhr.responseText); } catch (e) {}
            cb(null, data || {}, xhr.status);
        };
        xhr.ontimeout = function () { cb(new Error('relay timeout')); };
        if (body) {
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.send(JSON.stringify(body));
        } else {
            xhr.send();
        }
    }

    function relayServiceId() {
        try {
            var current = window.tizen.application.getCurrentApplication().appInfo.id;
            var pkg = current.split('.')[0];
            return pkg + '.relay';
        } catch (e) {
            return 'Rl2Samsung.relay';
        }
    }

    function launchRelayService(cb) {
        try {
            window.tizen.application.launch(relayServiceId(), function () { cb(null); }, function (err) { cb(err); });
        } catch (e) {
            cb(e);
        }
    }

    function ensureRelay(cb) {
        var tries = 0;
        function ping() {
            relayRequest('GET', '/ping', null, function (err, res) {
                if (!err && res && res.ok) return cb(null);
                tries += 1;
                if (tries === 1) launchRelayService(function () {});
                if (tries >= RELAY_LAUNCH_TRIES) return cb(new Error('Relay service did not start'));
                setTimeout(ping, 300);
            });
        }
        ping();
    }

    function stopRelaySession() {
        clearInterval(relayPollTimer);
        relayRequest('POST', '/stop', null, function () {});
    }

    function startRelayPlayback(token) {
        setStatus(T('stRelayStart'));
        ensureRelay(function (err) {
            if (token !== startToken) return;
            if (err) return scheduleReconnect(T('eRelayNoStart', err.message));

            var reqBody = {
                host: settings.host,
                port: parseInt(settings.rtspPort, 10) || 554,
                user: settings.user,
                pass: settings.password,
                channel: settings.channel,
                stream: settings.stream,
                path: settings.rtspPath,
                audio: settings.audio === 'on'
            };
            relayRequest('POST', '/start', reqBody, function (err, res) {
                if (token !== startToken) return;
                if (err) return scheduleReconnect(T('eRelayReq', err.message));
                if (!res.ok) return scheduleReconnect(res.error || T('eRelayRefused'));
                waitForRelay(token, Date.now());
            });
        });
    }

    function waitForRelay(token, since) {
        relayRequest('GET', '/status', null, function (err, st) {
            if (token !== startToken) return;
            if (err) return scheduleReconnect(T('eRelayLost'));
            if (st.state === 'error') return scheduleReconnect(st.error || T('eRelayErr'));
            if (st.state === 'playing') {
                chooseRelayPlayer(token, st);
                return;
            }
            if (Date.now() - since > RELAY_START_TIMEOUT_MS) {
                return scheduleReconnect(T('eNoPicture'));
            }
            if (st.state === 'waiting') setStatus(T('stWaitKey'));
            setTimeout(function () { waitForRelay(token, since); }, 500);
        });
    }

    function chooseRelayPlayer(token, st) {
        var codec = st.video ? st.video.codec : '';
        var choice = settings.rtspPlayer;
        if (choice === 'auto') {
            choice = (!mseFailedForRelay && mseCanPlay(codec)) ? 'mse' : 'avplay';
        }
        lastRelayStatus = st;
        if (choice === 'mse') {
            activeBackend = 'mse';
            setStatus(T('stOpenMse', codec === 'H265' ? 'H.265' : 'H.264'));
            startMsePlayer(RELAY_BASE + '/live.ts?t=' + Date.now(), 'mpegts', !!st.audio);
            startRelayPolling(token);
        } else {
            activeBackend = 'avplay';
            waitForSegments(token, Date.now());
        }
    }

    function switchToAvPlay() {
        mseFailedForRelay = true;
        startToken += 1;
        var token = startToken;
        clearInterval(relayPollTimer);
        destroyMsePlayer();
        setStatus(T('stSwitchAv'));
        activeBackend = 'avplay';
        waitForSegments(token, Date.now());
    }

    function waitForSegments(token, since) {
        relayRequest('GET', '/status', null, function (err, st) {
            if (token !== startToken) return;
            if (err) return scheduleReconnect(T('eRelayLost'));
            if (st.state === 'error') return scheduleReconnect(st.error || T('eRelayErr'));
            if (st.segments >= HLS_MIN_SEGMENTS) {
                startAvPlayer(token, RELAY_BASE + '/live.m3u8');
                return;
            }
            setStatus(T('stBufferAv', st.segments, HLS_MIN_SEGMENTS));
            if (Date.now() - since > 30000) {
                return scheduleReconnect(T('eNoSegments'));
            }
            setTimeout(function () { waitForSegments(token, since); }, 500);
        });
    }

    // ------------------------------------------------------------------ AVPlay (HLS Hardware)

    function startAvPlayer(token, url) {
        var av = window.webapis && window.webapis.avplay;
        if (!av) return scheduleReconnect(T('eNoAvplay'));
        try {
            av.open(url);
            av.setDisplayRect(0, 0, window.innerWidth || 1920, window.innerHeight || 1080);
            try { av.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX'); } catch (e) {}
            av.setListener({
                onbufferingstart: function () { setStatus(T('stBuffering')); },
                onbufferingprogress: function () {},
                onbufferingcomplete: function () { reconnectAttempt = 0; setStatus(T('stLive')); },
                oncurrentplaytime: function () {},
                onstreamcompleted: function () { scheduleReconnect(T('eStreamEnd')); },
                onevent: function () {},
                onerror: function (e) { scheduleReconnect(T('eAvplay', e)); },
                ondrmevent: function () {},
                onsubtitlechange: function () {}
            });
            avplayActive = true;
            avplayPaused = false;
            document.body.classList.add('avplay');
            el.video.classList.add('hidden');
            el.avObject.classList.remove('hidden');
            setStatus(T('stOpenAv'));
            av.prepareAsync(function () {
                if (token !== startToken) return;
                try { av.play(); } catch (e) { return scheduleReconnect(T('eAvStart')); }
                reconnectAttempt = 0;
                setStatus(T('stLive'));
            }, function (e) {
                scheduleReconnect(T('eAvplay', e));
            });
            startRelayPolling(token);
        } catch (e) {
            scheduleReconnect(T('eAvplay', e.message));
        }
    }

    function stopAvPlayer() {
        if (avplayActive) {
            try { window.webapis.avplay.stop(); } catch (e) {}
            try { window.webapis.avplay.close(); } catch (e2) {}
            avplayActive = false;
            avplayPaused = false;
            document.body.classList.remove('avplay');
        }
        el.avObject.classList.add('hidden');
        el.video.classList.remove('hidden');
    }

    function startRelayPolling(token) {
        clearInterval(relayPollTimer);
        relayPollTimer = setInterval(function () {
            if (token !== startToken) return;
            relayRequest('GET', '/status', null, function (err, st) {
                if (token !== startToken || err) return;
                lastRelayStatus = st;
                renderRelayStats(st);
            });
        }, RELAY_POLL_MS);
    }

    function renderRelayStats(st) {
        var name = getChannelDisplayName(settings.channel);
        if (el.channelTitle) el.channelTitle.textContent = name;
        var parts = [];
        parts.push(st.video ? st.video.codec + ' ' + st.video.width + 'x' + st.video.height : 'video');
        if (st.bitrateKbps) parts.push(st.bitrateKbps + ' kbps');
        parts.push(activeBackend === 'avplay' ? 'AVPlay (HLS)' : 'MSE (live.ts)');
        setStats(parts.join(' • ') + bufferLag() + '\n' + (st.url ? maskPassword(st.url) : ''));
    }

    // ------------------------------------------------------------------ Player Lifecycle

    function startPlayer() {
        clearTimeout(reconnectTimer);
        startToken += 1;
        clearInterval(relayPollTimer);
        destroyMsePlayer();
        stopAvPlayer();
        lastMediaInfo = null;

        var name = getChannelDisplayName(settings.channel);
        if (el.channelTitle) el.channelTitle.textContent = name;
        if (el.ptzCamTitle) el.ptzCamTitle.textContent = name;
        if (ptzActive && !isPtzChannel(settings.channel)) closePtzOverlay();
        if (barActive) playerBar.render();

        if (settings.mode === 'rtsp') {
            startRelayPlayback(startToken);
        } else {
            startFlvPlayback();
        }
    }

    function destroyPlayer() {
        startToken += 1;
        destroyMsePlayer();
        stopAvPlayer();
        stopRelaySession();
        activeBackend = null;
    }

    function scheduleReconnect(reason) {
        destroyPlayer();
        reconnectAttempt += 1;
        var delay = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * Math.pow(2, reconnectAttempt - 1));
        var remaining = Math.round(delay / 1000);
        setStatus(T('retry', reason, remaining), true);

        clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(function () {
            if (currentView === 'player') startPlayer();
        }, delay);
    }

    function changeChannel(direction) {
        var order = orderedChannels(), at = order.indexOf(parseInt(settings.channel, 10) || 0);
        var next = order[((at < 0 ? 0 : at) + direction + order.length) % order.length];
        settings.channel = next;
        reconnectAttempt = 0;
        gridFocusKey = 'cam:' + next;
        saveSettings();
        startPlayer();
    }

    function togglePlayPause() {
        if (activeBackend === 'avplay') {
            if (avplayPaused) {
                reconnectAttempt = 0;
                startPlayer();
            } else {
                try { window.webapis.avplay.pause(); } catch (e) {}
                avplayPaused = true;
                setStatus(T('stPaused'));
            }
            return;
        }
        if (!player) return;
        if (el.video.paused) {
            reconnectAttempt = 0;
            startPlayer();
        } else {
            player.pause();
            setStatus(T('stPaused'));
        }
    }

    // Video Element Events
    el.video.addEventListener('playing', function () {
        reconnectAttempt = 0;
        setStatus(T('stLive'));
    });
    el.video.addEventListener('waiting', function () {
        if (activeBackend !== 'avplay') setStatus(T('stBuffering'));
    });
    el.video.addEventListener('error', function () {
        if (activeBackend === 'mse' && el.video.error && el.video.error.code === 3 && settings.rtspPlayer === 'auto' && !mseFailedForRelay) {
            switchToAvPlay();
            return;
        }
        var err = el.video.error;
        if (err && err.message) logEvent('video: ' + err.message);
        if (err && (err.code === 3 || err.code === 4) && stepQualityDown()) return;
        scheduleReconnect(T('eVideo', err ? err.code : ''));
    });

    // ------------------------------------------------------------------ Player control bar

    var barActive = false;
    var barTimer = null;
    var infoOn = false;
    var BAR_HIDE_MS = 9000;

    function isPaused() {
        if (activeBackend === 'avplay') return avplayPaused;
        return !!player && el.video.paused;
    }

    var playerBar = makeBar(el.playerBar, [
        { id: 'pause', icon: function () { return isPaused() ? '▶' : '❚❚'; }, label: function () { return T(isPaused() ? 'resume' : 'pause'); },
          action: function () { togglePlayPause(); } },
        { id: 'quality', icon: function () { return 'HD'; }, label: function () { return qualityLabel(settings.stream); },
          action: cycleQuality },
        { id: 'audio', icon: function () { return '♪'; }, label: function () { return T('tbSound', T(settings.audio === 'on' ? 'on' : 'off')); },
          on: function () { return settings.audio === 'on'; }, action: toggleAudio },
        { id: 'ptz', icon: function () { return '✥'; }, label: function () { return T('ptzControls'); },
          visible: function () { return isPtzChannel(settings.channel); }, action: function () { openPtzOverlay(); } },
        { id: 'patrol', icon: function () { return '↻'; }, label: function () { return T('tbPatrol'); },
          on: function () { return patrolActive; }, action: function () { togglePatrol(); } },
        { id: 'info', icon: function () { return 'i'; }, label: function () { return T('info'); },
          on: function () { return infoOn; }, action: function () { infoOn = !infoOn; el.stats.classList.toggle('hidden', !infoOn); } },
        { id: 'grid', right: true, icon: function () { return '▦'; }, label: function () { return T('allCameras'); },
          action: function () { showView('grid'); } },
        { id: 'setup', right: true, icon: function () { return '⚙'; }, label: function () { return T('tbSettings'); },
          action: function () { showView('setup'); } }
    ], function () { return barActive; });
    playerBar.after = function () {
        if (!barActive) return;
        playerBar.render();
        armBar();
    };

    function armBar() {
        clearTimeout(barTimer);
        barTimer = setTimeout(hideBar, BAR_HIDE_MS);
    }

    function showBar(id) {
        barActive = true;
        playerBar.index = 0;
        if (id) playerBar.focusId(id);
        el.playerBar.classList.remove('hidden');
        el.playerHint.classList.add('hidden');
        playerBar.render();
        showOverlay(false);
        armBar();
    }

    function hideBar() {
        clearTimeout(barTimer);
        if (!barActive) return;
        barActive = false;
        el.playerBar.classList.add('hidden');
        el.playerHint.classList.remove('hidden');
        if (!infoOn) el.overlay.classList.add('faded');
    }

    // ------------------------------------------------------------------ Input Handlers (Remote Keys)
    // Everything is reachable with the arrows and OK; the colour, channel and media keys are shortcuts.

    function handleGridKey(event) {
        switch (event.keyCode) {
            case KEY.LEFT: moveGridFocus(-1, 0); break;
            case KEY.RIGHT: moveGridFocus(1, 0); break;
            case KEY.UP: moveGridFocus(0, -1); break;
            case KEY.DOWN: moveGridFocus(0, 1); break;
            case KEY.ENTER: activateGridFocus(); break;
            case KEY.PLAY: openCamera(focusedChannel()); break;
            case KEY.CH_UP:
            case KEY.CH_DOWN:
                var up = event.keyCode === KEY.CH_UP, row = /^(?:side|cam):(\d+)$/.exec(gridFocusKey);
                if (row) moveCameraInOrder(parseInt(row[1], 10), up ? -1 : 1);
                else changeGridPage(up ? 1 : -1);
                break;
            case KEY.RED: showView('setup'); break;
            case KEY.GREEN: gridBar.run('patrol'); break;
            case KEY.RETURN:
            case KEY.EXIT: exitApp(); break;
            default: return;
        }
        event.preventDefault();
    }

    function handlePlayerKey(event) {
        var k = event.keyCode;

        if (ptzActive) { handlePtzKey(event); return; }

        if (barActive) {
            var used = true;
            if (k === KEY.LEFT) playerBar.move(-1);
            else if (k === KEY.RIGHT) playerBar.move(1);
            else if (k === KEY.ENTER) playerBar.activate();
            else if (k === KEY.UP || k === KEY.DOWN || k === KEY.RETURN) hideBar();
            else used = false;
            if (used) {
                if (barActive) armBar();
                event.preventDefault();
                return;
            }
        }

        switch (k) {
            case KEY.LEFT:
            case KEY.CH_DOWN: changeChannel(-1); break;
            case KEY.RIGHT:
            case KEY.CH_UP: changeChannel(1); break;
            case KEY.ENTER:
            case KEY.UP:
            case KEY.DOWN: showBar(); break;
            case KEY.PLAY:
            case KEY.PAUSE:
            case KEY.PLAY_PAUSE:
                if (isPtzChannel(settings.channel)) togglePtzOverlay(); else togglePlayPause();
                break;
            case KEY.BLUE: if (isPtzChannel(settings.channel)) togglePtzOverlay(); break;
            case KEY.GREEN: togglePatrol(); if (barActive) playerBar.render(); break;
            case KEY.RED: showView('setup'); break;
            case KEY.RETURN: showView('grid'); break;
            case KEY.EXIT: exitApp(); break;
            default: return;
        }
        event.preventDefault();
    }

    // The TV keyboard's own Done (65376) and Cancel (65385) keys end a text field as OK and RETURN do.
    var IME_DONE = 65376, IME_CANCEL = 65385;

    function handleSetupKey(event) {
        var active = document.activeElement;
        var inText = active && active.tagName === 'INPUT';
        var k = event.keyCode;

        if (inText) {
            if (k === KEY.ENTER || k === KEY.RETURN || k === IME_DONE || k === IME_CANCEL) {
                commitInput(active);
                active.blur();
                event.preventDefault();
            }
            return;
        }

        var row = visibleRows()[focusedRow];
        switch (k) {
            case KEY.UP: moveFocus(-1); break;
            case KEY.DOWN: moveFocus(1); break;
            case KEY.LEFT: if (row) adjustRow(row, -1); break;
            case KEY.RIGHT: if (row) adjustRow(row, 1); break;
            case KEY.ENTER: if (row) activateRow(row); break;
            case KEY.RETURN: saveSettings(); showView('grid'); break;
            default: return;
        }
        event.preventDefault();
    }

    document.addEventListener('keydown', function (event) {
        if (currentView === 'grid') handleGridKey(event);
        else if (currentView === 'player') handlePlayerKey(event);
        else if (currentView === 'setup') handleSetupKey(event);
    });

    // Pointer (air mouse): the same things can be clicked.
    el.video.addEventListener('click', function () { if (barActive) hideBar(); else showBar(); });
    el.sideList.addEventListener('click', function (event) {
        var row = event.target.closest ? event.target.closest('.side-row') : null;
        if (row) openCamera(parseInt(row.getAttribute('data-channel'), 10));
    });
    el.ptzOverlay.addEventListener('click', function (event) {
        var b = event.target.closest ? event.target.closest('.ptz-btn') : null;
        if (!b) return;
        setPtzFocus(b.getAttribute('data-key'));
        pressPtz(ptzFocusKey.replace(/^ptz:/, ''), false);
        releasePtz();
    });
    // Letting go of OK (or of an arrow in arrow mode) stops the camera.
    document.addEventListener('keyup', function (event) {
        var k = event.keyCode;
        if (ptzActive && (k === KEY.ENTER || k === KEY.UP || k === KEY.DOWN || k === KEY.LEFT || k === KEY.RIGHT)) releasePtz();
    });
    rows.forEach(function (row) {
        row.addEventListener('click', function () {
            var list = visibleRows(), i = list.indexOf(row);
            if (i < 0) return;
            setFocus(i);
            activateRow(row);
        });
    });

    function registerTvKeys() {
        try {
            ['MediaPlay', 'MediaPause', 'MediaPlayPause', 'MediaStop', 'ChannelUp', 'ChannelDown', 'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue']
                .forEach(function (name) {
                    window.tizen.tvinputdevice.registerKey(name);
                });
        } catch (e) {}
    }

    // Visibility Change
    document.addEventListener('visibilitychange', function () {
        if (document.hidden) {
            clearTimeout(reconnectTimer);
            destroyPlayer();
            stopSnapshotLoop();
        } else {
            if (currentView === 'player') {
                reconnectAttempt = 0;
                startPlayer();
            } else if (currentView === 'grid') {
                startSnapshotLoop();
            }
        }
    });

    // Clock
    setInterval(function() {
        if (el.gridClock) {
            var now = new Date();
            el.gridClock.textContent = ('0' + now.getHours()).slice(-2) + ':' +
                                      ('0' + now.getMinutes()).slice(-2) + ':' +
                                      ('0' + now.getSeconds()).slice(-2);
        }
    }, 1000);

    // ------------------------------------------------------------------ Boot

    registerTvKeys();
    applyI18n();
    renderForm();

    if (!settings.host) {
        showView('setup');
    } else if (settings.defaultView === 'player' && settings.autoconnect === 'on') {
        showView('player');
        startPlayer();
    } else {
        showView('grid');
    }
}());

