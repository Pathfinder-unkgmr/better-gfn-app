// ==UserScript==
// @name         Better GFN
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Enhance GeForce NOW with visual filters, gyroscope aiming, touch joystick, and rumble.
// @author       You
// @match        *://play.geforcenow.com/*
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // ─────────────────────────────────────────────
    // 1. SETTINGS  (localStorage)
    // ─────────────────────────────────────────────
    const defaultSettings = {
        brightness: 100,
        saturation: 100,
        resolution: '1080p',
        fps: '60',
        rumble: false,
        gyro: false,
        gyroSensitivity: 10,
        touchStick: false
    };

    let settings = {};
    for (const key in defaultSettings) {
        const stored = localStorage.getItem('bgfn_' + key);
        if (stored !== null) {
            if (typeof defaultSettings[key] === 'boolean') {
                settings[key] = stored === 'true';
            } else if (typeof defaultSettings[key] === 'number') {
                settings[key] = parseFloat(stored);
            } else {
                settings[key] = stored;
            }
        } else {
            settings[key] = defaultSettings[key];
        }
    }

    function saveSetting(key, value) {
        settings[key] = value;
        localStorage.setItem('bgfn_' + key, value);
        applySettings();
    }

    // ─────────────────────────────────────────────
    // 2. SHARED AXIS STATE  (written by gyro + touch stick, read by getGamepads proxy)
    // ─────────────────────────────────────────────
    // We use a plain object in the userscript scope. The injected main-world script
    // reads updates via window.postMessage and patches getGamepads() accordingly.
    const rightStick = { x: 0, y: 0 }; // right stick axes [2],[3]

    // ─────────────────────────────────────────────
    // 3. MAIN-WORLD INJECTION
    //    Intercepts navigator.getGamepads() so axes are overridden with our values.
    //    Also exposes vibrationActuator for rumble on real BT controllers.
    // ─────────────────────────────────────────────
    const mainWorldScript = `
(function() {
    'use strict';

    // Spoof UA so GFN thinks we are a PC browser
    const FAKE_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
    try {
        Object.defineProperty(navigator, 'userAgent',  { get: () => FAKE_UA });
        Object.defineProperty(navigator, 'appVersion', { get: () => FAKE_UA.slice(8) });
    } catch(e) {}

    // Live state — updated by postMessage from userscript context
    let state = { enableGyro: false, enableRumble: false, gyroX: 0, gyroY: 0, stickX: 0, stickY: 0 };

    window.addEventListener('message', (ev) => {
        if (!ev.data || ev.data.__bgfn !== true) return;
        Object.assign(state, ev.data);
    });

    // Intercept RTCPeerConnection (hook for future SDP / bitrate work)
    const _OrigRTC = window.RTCPeerConnection;
    if (_OrigRTC) {
        window.RTCPeerConnection = function(...args) {
            const pc = new _OrigRTC(...args);
            const _orig = pc.createOffer.bind(pc);
            pc.createOffer = async (opts) => {
                const offer = await _orig(opts);
                // SDP mutation point — no-op for now
                return offer;
            };
            return pc;
        };
        window.RTCPeerConnection.prototype = _OrigRTC.prototype;
    }

    // Intercept getGamepads
    const _origGetGamepads = navigator.getGamepads.bind(navigator);
    navigator.getGamepads = function() {
        const real = _origGetGamepads();
        if (!real) return real;

        const list = Array.from(real);
        let changed = false;

        for (let i = 0; i < list.length; i++) {
            const pad = list[i];
            if (!pad) continue;

            // Build a plain-object clone we can mutate
            const clone = {
                id: pad.id,
                index: pad.index,
                connected: pad.connected,
                mapping: pad.mapping,
                timestamp: pad.timestamp,
                buttons: pad.buttons.map(b => ({ pressed: b.pressed, touched: b.touched, value: b.value })),
                axes: [...pad.axes],
                vibrationActuator: pad.vibrationActuator || null
            };

            // Gyro + touch-stick: override right-stick axes
            if (state.enableGyro || state.enableStick) {
                clone.axes[2] = state.stickX + state.gyroX;
                clone.axes[3] = state.stickY + state.gyroY;
                // clamp to [-1, 1]
                clone.axes[2] = Math.max(-1, Math.min(1, clone.axes[2]));
                clone.axes[3] = Math.max(-1, Math.min(1, clone.axes[3]));
                clone.timestamp = performance.now();
                changed = true;
            }

            // Rumble: if BT controller lacks vibrationActuator, stub one in
            if (state.enableRumble && !clone.vibrationActuator) {
                clone.vibrationActuator = {
                    type: 'dual-rumble',
                    playEffect: (type, params) => {
                        // Forward to real pad if it later gains an actuator
                        if (pad.vibrationActuator && pad.vibrationActuator.playEffect) {
                            return pad.vibrationActuator.playEffect(type, params);
                        }
                        return Promise.resolve('complete');
                    }
                };
                changed = true;
            }

            if (changed) list[i] = clone;
        }

        return changed ? list : real;
    };
})();
`;

    const scriptEl = document.createElement('script');
    scriptEl.textContent = mainWorldScript;
    (document.head || document.documentElement).appendChild(scriptEl);
    scriptEl.remove();

    // ─────────────────────────────────────────────
    // 4. GYROSCOPE  (userscript context — no permission boundary issues)
    //    Uses devicemotion.rotationRate like Gyropad does.
    // ─────────────────────────────────────────────
    const MAX_ANGLE = 45;
    let smoothedX = 0, smoothedY = 0;

    function handleDeviceMotion(event) {
        if (!settings.gyro) return;
        const sens = settings.gyroSensitivity / 10.0;  // 0.1 – 5.0
        const smoothFactor = 0.85; // low-pass, like Gyropad's alpha logic

        let rawX = (event.rotationRate && event.rotationRate.alpha) || 0;
        let rawY = (event.rotationRate && event.rotationRate.beta)  || 0;

        smoothedX = smoothFactor * smoothedX + (1 - smoothFactor) * rawX;
        smoothedY = smoothFactor * smoothedY + (1 - smoothFactor) * rawY;

        let normX = Math.max(-1, Math.min(1, smoothedX / MAX_ANGLE)) * sens;
        let normY = Math.max(-1, Math.min(1, smoothedY / MAX_ANGLE)) * sens;

        // Clamp combined result
        normX = Math.max(-1, Math.min(1, normX));
        normY = Math.max(-1, Math.min(1, normY));

        // Post gyro contribution to main world
        postState({ gyroX: normX, gyroY: normY, enableGyro: true });
    }

    function startGyro() {
        if (typeof DeviceMotionEvent !== 'undefined' &&
            typeof DeviceMotionEvent.requestPermission === 'function') {
            // iOS / some Android require explicit permission
            DeviceMotionEvent.requestPermission()
                .then(state => {
                    if (state === 'granted') {
                        window.addEventListener('devicemotion', handleDeviceMotion);
                    } else {
                        alert('Better GFN: Gyroscope permission denied.');
                        saveSetting('gyro', false);
                    }
                })
                .catch(console.error);
        } else {
            window.addEventListener('devicemotion', handleDeviceMotion);
        }
    }

    function stopGyro() {
        window.removeEventListener('devicemotion', handleDeviceMotion);
        smoothedX = 0; smoothedY = 0;
        postState({ gyroX: 0, gyroY: 0, enableGyro: false });
    }

    // ─────────────────────────────────────────────
    // 5. MESSAGE BUS — posts live axis state to main-world script
    // ─────────────────────────────────────────────
    function postState(overrides) {
        window.postMessage(Object.assign({
            __bgfn: true,
            enableGyro:  settings.gyro,
            enableRumble: settings.rumble,
            enableStick: settings.touchStick,
            gyroX: 0,
            gyroY: 0,
            stickX: touchStickAxes.x,
            stickY: touchStickAxes.y
        }, overrides), '*');
    }

    // ─────────────────────────────────────────────
    // 6. VISUAL FILTERS
    // ─────────────────────────────────────────────
    function applyFilters() {
        const video = document.querySelector('video');
        if (video) {
            video.style.filter = `brightness(${settings.brightness}%) saturate(${settings.saturation}%)`;
        }
    }

    const filterObserver = new MutationObserver(() => {
        const video = document.querySelector('video');
        if (video && !video.style.filter.includes(`brightness(${settings.brightness}%)`)) {
            applyFilters();
        }
    });
    filterObserver.observe(document.documentElement, { childList: true, subtree: true });

    function applySettings() {
        applyFilters();
        postState({});
    }
    applySettings();

    // ─────────────────────────────────────────────
    // 7. TOUCH RIGHT-STICK OVERLAY JOYSTICK
    // ─────────────────────────────────────────────
    const STICK_RADIUS = 50; // px — virtual stick travel distance
    const touchStickAxes = { x: 0, y: 0 };
    let stickContainer = null;
    let stickKnob = null;
    let activeStickTouch = null;

    function createTouchStick() {
        if (stickContainer) return;

        stickContainer = document.createElement('div');
        stickContainer.id = 'bgfn-stick-container';
        Object.assign(stickContainer.style, {
            position: 'fixed',
            right: '5vw',
            bottom: '15vh',
            width: '20vw',
            height: '20vw',
            maxWidth: '120px',
            maxHeight: '120px',
            minWidth: '80px',
            minHeight: '80px',
            background: 'rgba(255,255,255,0.15)',
            borderRadius: '50%',
            border: '2px solid rgba(255,255,255,0.4)',
            zIndex: '9998',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            touchAction: 'none',
            userSelect: 'none'
        });

        stickKnob = document.createElement('div');
        Object.assign(stickKnob.style, {
            width: '45%',
            height: '45%',
            background: 'rgba(255,255,255,0.6)',
            borderRadius: '50%',
            position: 'absolute',
            left: '27.5%',
            top: '27.5%',
            transition: 'transform 0.05s',
            pointerEvents: 'none'
        });

        // Label
        const label = document.createElement('div');
        Object.assign(label.style, {
            position: 'absolute',
            bottom: '-22px',
            width: '100%',
            textAlign: 'center',
            color: 'rgba(255,255,255,0.6)',
            fontSize: '10px',
            fontFamily: 'Arial, sans-serif',
            pointerEvents: 'none'
        });
        label.textContent = 'R-STICK';

        stickContainer.appendChild(stickKnob);
        stickContainer.appendChild(label);

        stickContainer.addEventListener('touchstart', (e) => {
            e.preventDefault();
            activeStickTouch = e.touches[0];
        }, { passive: false });

        stickContainer.addEventListener('touchmove', (e) => {
            e.preventDefault();
            if (!activeStickTouch) return;
            const touch = Array.from(e.touches).find(t => t.identifier === activeStickTouch.identifier);
            if (!touch) return;

            const rect = stickContainer.getBoundingClientRect();
            const centerX = rect.left + rect.width / 2;
            const centerY = rect.top + rect.height / 2;

            let dx = touch.clientX - centerX;
            let dy = touch.clientY - centerY;

            const magnitude = Math.hypot(dx, dy);
            if (magnitude > STICK_RADIUS) {
                dx = (dx / magnitude) * STICK_RADIUS;
                dy = (dy / magnitude) * STICK_RADIUS;
            }

            touchStickAxes.x = dx / STICK_RADIUS;
            touchStickAxes.y = dy / STICK_RADIUS;

            stickKnob.style.transform = `translate(${dx}px, ${dy}px)`;
            stickKnob.style.transition = 'none';

            postState({ stickX: touchStickAxes.x, stickY: touchStickAxes.y, enableStick: true });
        }, { passive: false });

        const releaseStick = (e) => {
            e.preventDefault();
            activeStickTouch = null;
            touchStickAxes.x = 0;
            touchStickAxes.y = 0;
            stickKnob.style.transform = 'translate(0, 0)';
            stickKnob.style.transition = 'transform 0.15s';
            postState({ stickX: 0, stickY: 0 });
        };

        stickContainer.addEventListener('touchend',    releaseStick, { passive: false });
        stickContainer.addEventListener('touchcancel', releaseStick, { passive: false });

        document.body.appendChild(stickContainer);
    }

    function removeTouchStick() {
        if (stickContainer) {
            stickContainer.remove();
            stickContainer = null;
            stickKnob = null;
            touchStickAxes.x = 0;
            touchStickAxes.y = 0;
            postState({ stickX: 0, stickY: 0, enableStick: false });
        }
    }

    // ─────────────────────────────────────────────
    // 8. UI OVERLAY  (Gyropad-style createElement architecture)
    // ─────────────────────────────────────────────
    function createUI() {
        const containerStyles = {
            position: 'fixed',
            top: '10px',
            right: '10px',
            width: '42%',
            padding: '10px',
            background: 'rgba(0,0,0,0.85)',
            color: 'white',
            borderRadius: '10px',
            fontFamily: 'Arial, sans-serif',
            fontSize: '2.5vh',
            zIndex: '2147483647',
            textAlign: 'center',
            boxShadow: '0px 0px 10px rgba(255,255,255,0.2)',
            display: 'none'
        };
        const elementsStyles = {
            position: 'relative',
            background: 'transparent',
            color: 'white',
            fontFamily: 'Arial, sans-serif',
            fontSize: '2.5vh',
            zIndex: '2147483647',
            textAlign: 'left',
            maxHeight: '75vh',
            overflowY: 'auto'
        };
        const selectStyles = {
            width: '100%',
            marginTop: '4px',
            marginBottom: '10px',
            backgroundColor: '#333',
            color: 'white',
            padding: '5px',
            borderRadius: '5px',
            border: 'none',
            fontSize: '2.5vh'
        };
        const inputStyles = {
            width: '100%',
            marginTop: '4px',
            marginBottom: '10px'
        };
        const toggleRowStyles = {
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '10px'
        };
        const sectionDivStyle = {
            borderTop: '1px solid #444',
            marginTop: '6px',
            paddingTop: '8px'
        };

        const mkBtn = (text, styles, handlers) => {
            const b = document.createElement('button');
            b.textContent = text;
            Object.assign(b.style, styles);
            for (const ev in handlers) b.addEventListener(ev, handlers[ev]);
            return b;
        };

        // Root panel
        const uiContainer = document.createElement('div');
        uiContainer.id = 'better-gfn-ui';
        Object.assign(uiContainer.style, containerStyles);

        const uiElements = document.createElement('div');
        uiElements.id = 'better-gfn-elements';
        Object.assign(uiElements.style, elementsStyles);

        // Close
        const closeBtn = mkBtn('❌', {
            fontSize: '3.5vh', textAlign: 'left', paddingLeft: '6px',
            width: '100%', background: 'transparent', color: 'white',
            border: 'none', cursor: 'pointer', marginBottom: '6px'
        }, { click: () => { uiContainer.style.display = 'none'; } });

        // Title
        const title = document.createElement('div');
        title.textContent = 'Better GFN ⚡';
        Object.assign(title.style, {
            textAlign: 'center', fontWeight: 'bold',
            marginBottom: '12px', borderBottom: '1px solid #555',
            paddingBottom: '8px', fontSize: '3vh'
        });

        // ── Video section ──
        const videoSection = document.createElement('div');
        Object.assign(videoSection.style, sectionDivStyle);

        const videoTitle = document.createElement('div');
        videoTitle.textContent = '🎨 Video';
        Object.assign(videoTitle.style, { fontWeight: 'bold', marginBottom: '6px' });
        videoSection.appendChild(videoTitle);

        const resLabel = document.createElement('label');
        resLabel.textContent = 'Target Resolution';
        const resSelect = document.createElement('select');
        Object.assign(resSelect.style, selectStyles);
        ['1080p', '1440p', '4K'].forEach(r => {
            const o = document.createElement('option');
            o.value = r; o.textContent = r;
            resSelect.appendChild(o);
        });
        resSelect.value = settings.resolution;
        resSelect.onchange = function() { saveSetting('resolution', this.value); };
        videoSection.appendChild(resLabel); videoSection.appendChild(resSelect);

        const fpsLabel = document.createElement('label');
        fpsLabel.textContent = 'Target FPS';
        const fpsSelect = document.createElement('select');
        Object.assign(fpsSelect.style, selectStyles);
        [['60', '60 FPS'], ['120', '120 FPS']].forEach(([v, t]) => {
            const o = document.createElement('option');
            o.value = v; o.textContent = t;
            fpsSelect.appendChild(o);
        });
        fpsSelect.value = settings.fps;
        fpsSelect.onchange = function() { saveSetting('fps', this.value); };
        videoSection.appendChild(fpsLabel); videoSection.appendChild(fpsSelect);

        const brightLabel = document.createElement('label');
        brightLabel.textContent = 'Brightness: ' + settings.brightness + '%';
        const brightInput = document.createElement('input');
        brightInput.type = 'range'; brightInput.min = '50'; brightInput.max = '200';
        brightInput.value = settings.brightness;
        Object.assign(brightInput.style, inputStyles);
        brightInput.oninput = function() {
            brightLabel.textContent = 'Brightness: ' + this.value + '%';
            saveSetting('brightness', parseInt(this.value));
        };
        videoSection.appendChild(brightLabel); videoSection.appendChild(brightInput);

        const satLabel = document.createElement('label');
        satLabel.textContent = 'Saturation: ' + settings.saturation + '%';
        const satInput = document.createElement('input');
        satInput.type = 'range'; satInput.min = '50'; satInput.max = '200';
        satInput.value = settings.saturation;
        Object.assign(satInput.style, inputStyles);
        satInput.oninput = function() {
            satLabel.textContent = 'Saturation: ' + this.value + '%';
            saveSetting('saturation', parseInt(this.value));
        };
        videoSection.appendChild(satLabel); videoSection.appendChild(satInput);

        // ── Controller section ──
        const ctrlSection = document.createElement('div');
        Object.assign(ctrlSection.style, sectionDivStyle);

        const ctrlTitle = document.createElement('div');
        ctrlTitle.textContent = '🎮 Controller';
        Object.assign(ctrlTitle.style, { fontWeight: 'bold', marginBottom: '6px' });
        ctrlSection.appendChild(ctrlTitle);

        // Rumble toggle
        const rumbleRow = document.createElement('div');
        Object.assign(rumbleRow.style, toggleRowStyles);
        const rumbleLbl = document.createElement('label');
        rumbleLbl.textContent = 'Enable Rumble';
        const rumbleChk = document.createElement('input');
        rumbleChk.type = 'checkbox'; rumbleChk.checked = settings.rumble;
        rumbleChk.onchange = function() { saveSetting('rumble', this.checked); };
        rumbleRow.appendChild(rumbleLbl); rumbleRow.appendChild(rumbleChk);
        ctrlSection.appendChild(rumbleRow);

        // ── Gyroscope section ──
        const gyroSection = document.createElement('div');
        Object.assign(gyroSection.style, sectionDivStyle);

        const gyroTitle = document.createElement('div');
        gyroTitle.textContent = '📱 Gyroscope Aiming';
        Object.assign(gyroTitle.style, { fontWeight: 'bold', marginBottom: '6px' });
        gyroSection.appendChild(gyroTitle);

        const gyroRow = document.createElement('div');
        Object.assign(gyroRow.style, toggleRowStyles);
        const gyroLbl = document.createElement('label');
        gyroLbl.textContent = 'Enable Gyroscope';
        const gyroChk = document.createElement('input');
        gyroChk.type = 'checkbox'; gyroChk.checked = settings.gyro;
        gyroChk.onchange = function() {
            if (this.checked) {
                startGyro();
                saveSetting('gyro', true);
            } else {
                stopGyro();
                saveSetting('gyro', false);
            }
        };
        gyroRow.appendChild(gyroLbl); gyroRow.appendChild(gyroChk);
        gyroSection.appendChild(gyroRow);

        const gyroSensLbl = document.createElement('label');
        gyroSensLbl.textContent = 'Gyro Sensitivity: ' + (settings.gyroSensitivity / 10).toFixed(1) + 'x';
        const gyroSensInput = document.createElement('input');
        gyroSensInput.type = 'range'; gyroSensInput.min = '1'; gyroSensInput.max = '50';
        gyroSensInput.value = settings.gyroSensitivity;
        Object.assign(gyroSensInput.style, inputStyles);
        gyroSensInput.oninput = function() {
            gyroSensLbl.textContent = 'Gyro Sensitivity: ' + (this.value / 10).toFixed(1) + 'x';
            saveSetting('gyroSensitivity', parseInt(this.value));
        };
        gyroSection.appendChild(gyroSensLbl); gyroSection.appendChild(gyroSensInput);

        // ── Touch Stick section ──
        const stickSection = document.createElement('div');
        Object.assign(stickSection.style, sectionDivStyle);

        const stickTitle = document.createElement('div');
        stickTitle.textContent = '🕹️ Touch Right-Stick';
        Object.assign(stickTitle.style, { fontWeight: 'bold', marginBottom: '6px' });
        stickSection.appendChild(stickTitle);

        const stickRow = document.createElement('div');
        Object.assign(stickRow.style, toggleRowStyles);
        const stickLbl = document.createElement('label');
        stickLbl.textContent = 'Enable Touch Stick';
        const stickChk = document.createElement('input');
        stickChk.type = 'checkbox'; stickChk.checked = settings.touchStick;
        stickChk.onchange = function() {
            saveSetting('touchStick', this.checked);
            if (this.checked) { createTouchStick(); } else { removeTouchStick(); }
        };
        stickRow.appendChild(stickLbl); stickRow.appendChild(stickChk);
        stickSection.appendChild(stickRow);

        // ── Floating toggle button ──
        const toggleButton = document.createElement('button');
        toggleButton.textContent = '⚙️';
        Object.assign(toggleButton.style, {
            position: 'fixed',
            top: '10%',
            right: '0vw',
            fontSize: '4vh',
            textAlign: 'center',
            background: '#1e1e1e',
            color: 'white',
            border: '2px solid #555',
            borderRadius: '50%',
            width: '7vh',
            height: '7vh',
            zIndex: '2147483647',
            cursor: 'pointer'
        });

        // Draggable + tap-to-toggle (Gyropad pattern)
        toggleButton.ontouchstart = function(event) {
            event.preventDefault();
            const touch = event.touches[0];
            const rect = toggleButton.getBoundingClientRect();
            const shiftX = touch.clientX - rect.left;
            const shiftY = touch.clientY - rect.top;
            const startX = touch.clientX;
            const startY = touch.clientY;
            let moved = false;

            function onMove(e) {
                const t = e.touches[0];
                toggleButton.style.left = (t.clientX - shiftX) + 'px';
                toggleButton.style.top  = (t.clientY - shiftY) + 'px';
                toggleButton.style.right = 'auto';
                if (Math.abs(t.clientX - startX) > 10 || Math.abs(t.clientY - startY) > 10) moved = true;
            }
            function onEnd() {
                document.removeEventListener('touchmove', onMove);
                document.removeEventListener('touchend', onEnd);
                if (!moved) {
                    uiContainer.style.display = uiContainer.style.display === 'none' ? 'block' : 'none';
                }
            }
            document.addEventListener('touchmove', onMove, { passive: false });
            document.addEventListener('touchend', onEnd);
        };
        toggleButton.onclick = function(e) {
            if (e.pointerType === 'mouse') {
                uiContainer.style.display = uiContainer.style.display === 'none' ? 'block' : 'none';
            }
        };

        // Re-attach into GFN fullscreen container instantly when fullscreen changes
        document.addEventListener('fullscreenchange', () => {
            const fs = document.fullscreenElement || document.webkitFullscreenElement || document.getElementById('StreamHud') || document.getElementById('fullscreen-container') || document.body;
            if (fs) {
                fs.appendChild(toggleButton);
                fs.appendChild(uiContainer);
                if (stickContainer) fs.appendChild(stickContainer);
            }
        });

        // Assemble
        uiContainer.appendChild(closeBtn);
        uiContainer.appendChild(title);
        uiContainer.appendChild(uiElements);
        uiElements.appendChild(videoSection);
        uiElements.appendChild(ctrlSection);
        uiElements.appendChild(gyroSection);
        uiElements.appendChild(stickSection);

        // ── Watchdog: Keep elements in the active container ──
        // If the user is in full screen, appending to document.body makes elements invisible.
        // We must append to the active fullscreen element or GFN stream container.
        setInterval(() => {
            let targetContainer = document.fullscreenElement || 
                                  document.webkitFullscreenElement ||
                                  document.getElementById('StreamHud') || 
                                  document.getElementById('fullscreen-container') || 
                                  document.body;

            if (!targetContainer) return;

            if (!targetContainer.contains(toggleButton)) {
                targetContainer.appendChild(toggleButton);
            }
            if (!targetContainer.contains(uiContainer)) {
                targetContainer.appendChild(uiContainer);
            }
            if (stickContainer && !targetContainer.contains(stickContainer)) {
                targetContainer.appendChild(stickContainer);
            }
        }, 1000);

        // If settings say gyro/stick were on, re-activate
        if (settings.gyro)       startGyro();
        if (settings.touchStick) createTouchStick();
    }

    // Guard: only call createUI once document.body is available
    function init() {
        if (document.body) {
            createUI();
        } else {
            document.addEventListener('DOMContentLoaded', createUI);
        }
    }

    init();

})();
