/* =============================================================
 * AirSketch — Camera-based drawing game
 * Hand tracking: MediaPipe Hands
 * Drawing: Canvas 2D
 * ============================================================= */

(() => {
    'use strict';

    // ---------- Word banks ----------
    const WORDS = {
        easy: [
            'apple', 'house', 'tree', 'sun', 'star', 'fish', 'cat', 'dog', 'car', 'cup',
            'hat', 'ball', 'book', 'key', 'door', 'bed', 'clock', 'chair', 'eye', 'moon',
            'cloud', 'heart', 'flower', 'banana', 'cake', 'ice cream', 'pizza', 'egg', 'cheese', 'flag'
        ],
        medium: [
            'elephant', 'guitar', 'bicycle', 'umbrella', 'airplane', 'lamp', 'phone', 'rainbow',
            'snowman', 'robot', 'ghost', 'alien', 'wizard', 'mermaid', 'pirate', 'ninja', 'rocket',
            'submarine', 'lighthouse', 'castle', 'bridge', 'pyramid', 'volcano', 'butterfly',
            'octopus', 'penguin', 'dolphin', 'turtle', 'giraffe', 'kangaroo', 'donut', 'burger',
            'microscope', 'telescope', 'camera', 'skateboard', 'rollercoaster', 'treasure chest'
        ],
        hard: [
            'procrastination', 'photosynthesis', 'constellation', 'telephone booth', 'hieroglyphics',
            'kaleidoscope', 'quicksand', 'gramophone', 'mousetrap', 'tightrope walker',
            'escalator', 'labyrinth', 'origami crane', 'parachute', 'spider web', 'crystal ball',
            'tornado', 'solar system', 'DNA strand', 'treasure map', 'juggling clown',
            'haunted mansion', 'time machine', 'disco ball', 'puppet show', 'tea ceremony',
            'rube goldberg', 'medieval knight', 'coral reef', 'northern lights'
        ]
    };

    // ---------- State ----------
    const State = {
        players: [],
        scores: {},             // cumulative points
        roundWins: {},          // per-player count of rounds won (BO-N tracking)
        roundsPerPlayer: 2,
        secondsPerRound: 60,
        difficulty: 'medium',
        inputMode: 'keyboard',  // 'keyboard' | 'gesture'
        perfMode: 'fast',       // 'fast' | 'accurate'
        format: 'bo3',          // 'bo3' | 'bo5' | 'bo7' | 'classic'
        winTarget: 2,           // first-to-N wins (derived from format)
        maxAttempts: 5,
        attemptsLeft: 5,
        currentDrawerIdx: 0,
        currentRound: 0,
        totalRounds: 0,
        currentWord: '',
        usedWords: new Set(),
        startTime: 0,
        timeLeft: 0,
        timerInterval: null,
        isDrawingActive: false,
        isPractice: false
    };

    function winTargetFor(format) {
        if (format === 'bo3') return 2;
        if (format === 'bo5') return 3;
        if (format === 'bo7') return 4;
        return Infinity; // classic — no target
    }

    // ---------- Input state (keyboard-controlled pen) ----------
    const Input = {
        // Pen semantics:
        //   penDown=true + eraser=false → drawing
        //   penDown=true + eraser=true  → erasing
        //   penDown=false → hover (position tracked but no ink)
        penDown: false,
        eraser: false,
        // Short settling period after pen-down so filter catches up (no streaks)
        settleUntil: 0
    };

    // ---------- Elements ----------
    const el = (id) => document.getElementById(id);
    const screens = {
        landing: el('screen-landing'),
        handoff: el('screen-handoff'),
        prompt: el('screen-prompt'),
        game: el('screen-game'),
        roundEnd: el('screen-round-end'),
        gameover: el('screen-gameover')
    };

    function showScreen(name) {
        Object.values(screens).forEach(s => s.classList.remove('active'));
        screens[name].classList.add('active');
    }

    // ---------- Audio (Web Audio synthesized) ----------
    const audio = (() => {
        let ctx = null;
        function getCtx() {
            if (!ctx) {
                try { ctx = new (window.AudioContext || window.webkitAudioContext)(); }
                catch (e) { return null; }
            }
            if (ctx.state === 'suspended') ctx.resume();
            return ctx;
        }
        function beep(freq, dur = 0.1, type = 'sine', gain = 0.1) {
            const c = getCtx();
            if (!c) return;
            const osc = c.createOscillator();
            const g = c.createGain();
            osc.type = type;
            osc.frequency.value = freq;
            g.gain.setValueAtTime(gain, c.currentTime);
            g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
            osc.connect(g).connect(c.destination);
            osc.start();
            osc.stop(c.currentTime + dur);
        }
        return {
            tick: () => beep(880, 0.04, 'triangle', 0.04),
            tickLow: () => beep(440, 0.08, 'triangle', 0.06),
            correct: () => {
                beep(523, 0.1, 'sine', 0.12);
                setTimeout(() => beep(659, 0.1, 'sine', 0.12), 80);
                setTimeout(() => beep(784, 0.18, 'sine', 0.12), 160);
            },
            wrong: () => beep(180, 0.15, 'sawtooth', 0.08),
            start: () => {
                beep(440, 0.08, 'sine', 0.1);
                setTimeout(() => beep(660, 0.12, 'sine', 0.1), 90);
            },
            click: () => beep(600, 0.03, 'triangle', 0.05)
        };
    })();

    // =============================================================
    // ONE-EURO FILTER — low-latency, low-jitter smoothing for pointers.
    // https://gery.casiez.net/1euro/  — Casiez, Roussel, Vogel (2012)
    // Lowers jitter when still, maintains responsiveness when moving.
    // =============================================================
    class OneEuroFilter {
        constructor({ minCutoff = 1.0, beta = 0.0, dCutoff = 1.0 } = {}) {
            this.minCutoff = minCutoff;
            this.beta = beta;
            this.dCutoff = dCutoff;
            this.xPrev = null;
            this.dxPrev = 0;
            this.tPrev = null;
        }
        _alpha(cutoff, dt) {
            const tau = 1.0 / (2 * Math.PI * cutoff);
            return 1.0 / (1.0 + tau / dt);
        }
        reset() { this.xPrev = null; this.dxPrev = 0; this.tPrev = null; }
        filter(x, t) {
            if (this.tPrev === null) { this.tPrev = t; this.xPrev = x; return x; }
            const dt = Math.max(1e-3, (t - this.tPrev) / 1000);
            this.tPrev = t;
            const dx = (x - this.xPrev) / dt;
            const aD = this._alpha(this.dCutoff, dt);
            const edx = aD * dx + (1 - aD) * this.dxPrev;
            const cutoff = this.minCutoff + this.beta * Math.abs(edx);
            const a = this._alpha(cutoff, dt);
            const xFilt = a * x + (1 - a) * this.xPrev;
            this.xPrev = xFilt;
            this.dxPrev = edx;
            return xFilt;
        }
    }

    // =============================================================
    // HAND TRACKING + GESTURE DETECTION
    // =============================================================
    const Hand = (() => {
        const video = el('cam-video');
        const overlay = el('cam-overlay');
        const octx = overlay.getContext('2d');
        const camStatus = el('cam-status');
        let hands = null;
        let camera = null;

        // Position filters — tuned for drawing. Lower minCutoff = smoother at rest;
        // beta adapts: moves faster = less smoothing (feels responsive).
        const fx = new OneEuroFilter({ minCutoff: 0.9, beta: 0.012, dCutoff: 1.0 });
        const fy = new OneEuroFilter({ minCutoff: 0.9, beta: 0.012, dCutoff: 1.0 });

        // Rolling velocity estimate (used for stability check)
        let lastRawX = 0.5, lastRawY = 0.5, lastRawT = 0;
        let velocity = 0; // normalized units / sec

        // --- Frame-drop & teleport protection ---
        // Only treat things as a tracking error when they REALLY look like one.
        // Normal fast finger motion is not an error and must be allowed through.
        const FRAMEDROP_MS = 220;       // only large gaps count as drops
        // Jump threshold scales with time: fast motion is fine, big jump in short time is not.
        //   maxJump = JUMP_BASE + JUMP_PER_SEC * dt
        const JUMP_BASE = 0.22;         // allow ~22% jump at zero dt (lite model jitter)
        const JUMP_PER_SEC = 1.8;       // extra tolerance per second of gap
        // After a confirmed glitch, suppress ink for this many fresh frames.
        const RESYNC_FRAMES_REQUIRED = 2;
        let resyncFramesRemaining = 0;
        let lastFrameTime = 0;
        let framesSeen = 0;

        // Latest cursor state (normalized 0..1)
        const cursor = {
            // Smoothed position (what the drawer sees / draws with)
            smoothX: 0.5, smoothY: 0.5,
            // Raw latest position (for diagnostics)
            x: 0.5, y: 0.5,
            visible: false,
            // Final, debounced gesture that game code reacts to
            gesture: 'nohand',
            // Per-frame raw classifier output (diagnostic)
            candidate: 'nohand',
            // Hand size & distance quality
            handSize: 0,
            distance: 'none',
            // True when tracking is "fresh" (not recovering from a frame drop/teleport).
            // When false, Draw.tick refuses to commit ink.
            trustworthy: false
        };

        // Per-gesture hold frames (how many frames the pose must persist to commit).
        // Higher = more deliberate / less accidental triggers.
        // Erase is destructive -> require strong intent (~333ms at 30fps).
        const HOLD_FRAMES = {
            draw:    3,
            hover:   4,
            peace:   6,
            thumb:   6,
            erase:   10,  // ← prevents accidental erase on hand collapse
            nohand:  2,
            unknown: 3
        };

        // Cooldown (frames) after switching OUT of a gesture before any new gesture can commit.
        // Prevents instant re-engage after an erase or color change.
        const EXIT_COOLDOWN = {
            erase: 15,
            peace: 10,
            thumb: 10,
            draw:  0,
            hover: 0,
            unknown: 0,
            nohand: 0
        };
        let exitCooldown = 0;
        let lastCommittedGesture = 'nohand';
        let pendingGesture = 'nohand';
        let pendingFrames = 0;

        // ===== Finger-extension detection =====
        //
        // Reliable extension requires BOTH:
        //  (a) finger length ratio: dist(wrist->tip) / dist(wrist->mcp) is large when extended
        //  (b) joint-angle at PIP: a folded finger bends sharply at PIP (angle < ~120°)
        //
        // Using both reduces false positives when the hand is tilted.

        function distance(a, b) {
            return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
        }

        function angleAt(a, b, c) {
            // angle at b between vectors b->a and b->c, in degrees
            const v1x = a.x - b.x, v1y = a.y - b.y;
            const v2x = c.x - b.x, v2y = c.y - b.y;
            const dot = v1x * v2x + v1y * v2y;
            const m1 = Math.hypot(v1x, v1y);
            const m2 = Math.hypot(v2x, v2y);
            if (m1 < 1e-6 || m2 < 1e-6) return 180;
            const cos = Math.max(-1, Math.min(1, dot / (m1 * m2)));
            return Math.acos(cos) * 180 / Math.PI;
        }

        function fingerState(lm, mcp, pip, dip, tip) {
            // Returns { extended: bool, folded: bool, score: 0..1 }
            const wrist = lm[0];
            const dMcp = distance(wrist, lm[mcp]);
            const dTip = distance(wrist, lm[tip]);
            const lengthRatio = dMcp > 1e-6 ? dTip / dMcp : 0;
            const angle = angleAt(lm[mcp], lm[pip], lm[tip]);
            // A straight finger has angle ≈ 180° at PIP; a folded finger ≈ 60-120°.
            const extended = lengthRatio > 1.65 && angle > 155;
            const folded   = lengthRatio < 1.15 || angle < 110;
            // Confidence score (0..1): closer to perfectly straight or perfectly folded
            let score;
            if (extended) {
                score = Math.min(1, (lengthRatio - 1.65) / 0.5) * Math.min(1, (angle - 155) / 25);
            } else if (folded) {
                score = Math.min(1, (1.15 - lengthRatio) / 0.3 + (110 - angle) / 50);
            } else {
                score = 0;
            }
            return { extended, folded, score: Math.max(0, Math.min(1, score)) };
        }

        function thumbState(lm) {
            // Thumb bends at IP (3). Compare thumb-tip (4) distance from pinky MCP (17)
            // vs thumb-IP (3) distance from pinky MCP. Robust to orientation.
            const refMcp = lm[17];  // pinky base = far side of palm
            const dTip = distance(refMcp, lm[4]);
            const dIp  = distance(refMcp, lm[3]);
            const extended = dTip > dIp * 1.25;
            const folded = dTip < dIp * 1.10;
            return { extended, folded };
        }

        function classify(lm) {
            // Compute all finger states
            const idx = fingerState(lm,  5,  6,  7,  8);
            const mid = fingerState(lm,  9, 10, 11, 12);
            const rng = fingerState(lm, 13, 14, 15, 16);
            const pky = fingerState(lm, 17, 18, 19, 20);
            const thb = thumbState(lm);

            // Overall confidence = how definitive each finger looks
            const conf = (idx.score + mid.score + rng.score + pky.score) / 4;

            // Draw: ONLY index extended; middle/ring/pinky all folded. Thumb ignored.
            if (idx.extended && mid.folded && rng.folded && pky.folded) {
                return { g: 'draw', conf };
            }
            // Peace: index + middle extended; ring + pinky folded.
            if (idx.extended && mid.extended && rng.folded && pky.folded) {
                return { g: 'peace', conf };
            }
            // Fist (erase): ALL four fingers STRONGLY folded, AND thumb not extended far,
            // AND finger scores are high (not ambiguous).
            if (idx.folded && mid.folded && rng.folded && pky.folded
                && !thb.extended
                && idx.score > 0.6 && mid.score > 0.6 && rng.score > 0.6 && pky.score > 0.6) {
                return { g: 'erase', conf };
            }
            // Thumbs up: only thumb extended, others folded.
            if (thb.extended && idx.folded && mid.folded && rng.folded && pky.folded) {
                return { g: 'thumb', conf };
            }
            // Open palm (hover): all four fingers extended.
            if (idx.extended && mid.extended && rng.extended && pky.extended) {
                return { g: 'hover', conf };
            }
            return { g: 'unknown', conf };
        }

        function handSizeOf(lm) {
            // Measure palm size as max(wrist->mid-MCP, wrist->pinky-MCP).
            // This is more robust to finger pose than tip-based measures.
            const wrist = lm[0];
            const d1 = distance(wrist, lm[9]);
            const d2 = distance(wrist, lm[17]);
            return Math.max(d1, d2);  // normalized frame units (y in [0,1])
        }

        function classifyDistance(handSize) {
            // Empirically tuned bands. Palm "size" ≈ 0.10 is a comfortable arm's length.
            if (handSize < 0.08) return 'far';
            if (handSize > 0.22) return 'close';
            return 'good';
        }

        function onResults(results) {
            const now = performance.now();
            const dtMs = lastFrameTime === 0 ? 0 : (now - lastFrameTime);
            lastFrameTime = now;
            framesSeen++;

            // Detect frame drop: if gap too large, enter resync mode
            if (dtMs > 0 && dtMs > FRAMEDROP_MS) {
                resyncFramesRemaining = RESYNC_FRAMES_REQUIRED;
            }

            octx.clearRect(0, 0, overlay.width, overlay.height);

            if (!results.multiHandLandmarks || results.multiHandLandmarks.length === 0) {
                cursor.visible = false;
                cursor.trustworthy = false;
                cursor.candidate = 'nohand';
                cursor.distance = 'none';
                cursor.handSize = 0;
                resyncFramesRemaining = RESYNC_FRAMES_REQUIRED; // require resync when hand returns
                debounceGesture('nohand');
                return;
            }

            camStatus.classList.add('hidden');
            const lm = results.multiHandLandmarks[0];

            // Draw hand skeleton on preview overlay (selfieMode already mirrors coords)
            if (window.drawConnectors && window.HAND_CONNECTIONS) {
                window.drawConnectors(octx, lm, window.HAND_CONNECTIONS, {
                    color: 'rgba(124, 92, 255, 0.9)', lineWidth: 2
                });
            }
            if (window.drawLandmarks) {
                window.drawLandmarks(octx, lm, {
                    color: 'rgba(34, 227, 255, 0.95)', lineWidth: 1, radius: 2
                });
            }
            // Highlight index fingertip
            const tipLm = lm[8];
            octx.fillStyle = '#ffdd57';
            octx.beginPath();
            octx.arc(tipLm.x * overlay.width, tipLm.y * overlay.height, 5, 0, Math.PI * 2);
            octx.fill();

            // --- Hand size / distance quality ---
            cursor.handSize = handSizeOf(lm);
            cursor.distance = classifyDistance(cursor.handSize);

            // --- Gesture classification ---
            const { g } = classify(lm);
            cursor.candidate = g;
            debounceGesture(g);

            // --- Position smoothing with teleport rejection ---
            // Anchor: use index fingertip for draw; palm center otherwise.
            // In keyboard mode we always use the index fingertip for a stable cursor.
            const useTip = (State.inputMode === 'keyboard') ||
                           cursor.gesture === 'draw' ||
                           cursor.gesture === 'peace' ||
                           cursor.gesture === 'thumb';
            const anchor = useTip ? lm[8] : lm[9];
            const rawX = anchor.x;
            const rawY = anchor.y;

            // Teleport detection — time-aware. Fast finger motion is allowed;
            // only a *big jump combined with a long inter-frame gap* counts
            // as a tracking glitch worth suppressing.
            if (framesSeen > 1 && lastRawT > 0) {
                const dtSec = Math.max(1e-3, (now - lastRawT) / 1000);
                const jump = Math.hypot(rawX - lastRawX, rawY - lastRawY);
                const maxJump = JUMP_BASE + JUMP_PER_SEC * dtSec;
                // Only treat as a glitch when BOTH: motion is implausibly fast
                // for the time elapsed, AND the frame was slow (actual lag).
                if (jump > maxJump && dtSec > 0.08) {
                    resyncFramesRemaining = RESYNC_FRAMES_REQUIRED;
                    fx.reset(); fy.reset();
                }
            }

            // Velocity estimate (for gesture stability only)
            if (lastRawT > 0) {
                const dt = Math.max(1e-3, (now - lastRawT) / 1000);
                const dx = rawX - lastRawX;
                const dy = rawY - lastRawY;
                const inst = Math.hypot(dx, dy) / dt;
                velocity = velocity * 0.7 + inst * 0.3;
            }
            lastRawX = rawX; lastRawY = rawY; lastRawT = now;

            // Count down resync — need N clean consecutive frames before trusting
            if (resyncFramesRemaining > 0) resyncFramesRemaining--;

            cursor.x = rawX;
            cursor.y = rawY;
            cursor.smoothX = fx.filter(rawX, now);
            cursor.smoothY = fy.filter(rawY, now);
            cursor.visible = true;
            // Trustworthy as soon as resync is done AND we have at least one prior frame.
            cursor.trustworthy = (resyncFramesRemaining === 0 && framesSeen >= 2);
        }

        function debounceGesture(candidate) {
            // Tick down the exit cooldown each frame
            if (exitCooldown > 0) exitCooldown--;

            // Track how many consecutive frames this candidate has held
            if (candidate === pendingGesture) {
                pendingFrames++;
            } else {
                pendingGesture = candidate;
                pendingFrames = 1;
            }

            const hold = HOLD_FRAMES[candidate] || 4;

            // Stability check for destructive/discrete actions:
            // the hand must be moving slowly to commit erase / peace / thumb.
            // This prevents mid-swipe misclassifications from triggering actions.
            const needsStability = (candidate === 'erase' || candidate === 'peace' || candidate === 'thumb');
            const stable = !needsStability || velocity < 1.5;

            // Only commit when: enough frames held, no exit cooldown, and stable (if needed)
            if (pendingFrames >= hold && exitCooldown === 0 && stable) {
                if (candidate !== lastCommittedGesture) {
                    // Transitioning → set cooldown based on OUTGOING gesture
                    exitCooldown = EXIT_COOLDOWN[lastCommittedGesture] || 0;
                    // Reset position filters so the new mode starts cleanly
                    fx.reset(); fy.reset();
                    lastCommittedGesture = candidate;
                }
                cursor.gesture = candidate;
            }
        }

        function resetFilters() {
            fx.reset(); fy.reset();
            pendingGesture = 'nohand';
            pendingFrames = 0;
            exitCooldown = 0;
            lastCommittedGesture = 'nohand';
            cursor.gesture = 'nohand';
            cursor.trustworthy = false;
            velocity = 0;
            lastRawT = 0;
            lastFrameTime = 0;
            framesSeen = 0;
            resyncFramesRemaining = RESYNC_FRAMES_REQUIRED;
        }

        /** Snap the position filter to the current position only.
         *  Use when the user just pressed "pen down" — we want the first inked
         *  point to be exactly at the fingertip without sweeping a line from
         *  the previous smoothed location. Does NOT touch trust/resync state. */
        function syncPositionFilter() {
            fx.reset();
            fy.reset();
        }

        async function init() {
            if (hands) return; // already initialized

            if (typeof Hands === 'undefined') {
                camStatus.textContent = 'MediaPipe failed to load. Check connection.';
                throw new Error('MediaPipe Hands not loaded');
            }

            camStatus.textContent = 'Loading hand model…';

            hands = new Hands({
                locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/hands@0.4/${file}`
            });

            const useFast = State.perfMode !== 'accurate';
            hands.setOptions({
                maxNumHands: 1,
                modelComplexity: useFast ? 0 : 1,          // 0 = Lite (much faster, less CPU)
                minDetectionConfidence: 0.7,
                minTrackingConfidence: 0.65,
                selfieMode: true
            });

            hands.onResults(onResults);

            // Make sure the overlay canvas has internal size matching video.
            // Set it once video has dimensions.
            video.addEventListener('loadedmetadata', () => {
                overlay.width = video.videoWidth;
                overlay.height = video.videoHeight;
            });

            try {
                // Lower resolution dramatically reduces per-frame CPU → fewer frame drops.
                const camWidth  = useFast ? 480 : 640;
                const camHeight = useFast ? 360 : 480;
                camera = new Camera(video, {
                    onFrame: async () => {
                        if (hands) await hands.send({ image: video });
                    },
                    width: camWidth,
                    height: camHeight
                });
                await camera.start();
                camStatus.classList.add('hidden');
            } catch (err) {
                console.error('Camera error:', err);
                camStatus.textContent = 'Camera blocked. Enable it in your browser.';
                throw err;
            }
        }

        function stop() {
            if (camera) { try { camera.stop(); } catch (e) {} }
            if (hands) { try { hands.close(); } catch (e) {} }
            hands = null;
            camera = null;
        }

        return {
            init,
            stop,
            resetFilters,
            syncPositionFilter,
            getCursor: () => cursor
        };
    })();

    // =============================================================
    // DRAWING CANVAS
    // =============================================================
    const Draw = (() => {
        const canvas = el('draw-canvas');
        const ctx = canvas.getContext('2d');
        const cursorCanvas = el('cursor-canvas');
        const cctx = cursorCanvas.getContext('2d');

        const COLORS = ['#ff3860', '#ffdd57', '#48c774', '#3298dc', '#b86bff', '#ffffff'];
        const COLOR_NAMES = ['Red', 'Yellow', 'Green', 'Blue', 'Purple', 'White'];
        let colorIdx = 0;

        let brushSize = 10;
        const ERASER_SIZE = 60;

        // Stroke buffer — a short history of points for smooth bezier rendering
        let stroke = [];           // [{x, y}]
        let isDrawing = false;
        let lastDrawnPointIdx = -1; // we draw segments up to this index

        // ---------- Undo history ----------
        // Snapshot the canvas before each stroke; undo restores previous.
        // Capped to keep memory bounded.
        const UNDO_MAX = 10;
        const undoStack = [];
        let snapshotTakenForCurrentStroke = false;

        function takeSnapshot() {
            try {
                const snap = ctx.getImageData(0, 0, canvas.width, canvas.height);
                undoStack.push(snap);
                if (undoStack.length > UNDO_MAX) undoStack.shift();
            } catch (e) {
                console.warn('Snapshot failed', e);
            }
        }
        function undo() {
            const snap = undoStack.pop();
            if (!snap) return false;
            // Safety: if canvas has been resized since snapshot, skip.
            if (snap.width !== canvas.width || snap.height !== canvas.height) {
                return false;
            }
            resetStroke();
            ctx.putImageData(snap, 0, 0);
            return true;
        }

        // Convert normalized cursor (0..1) to canvas-pixel coords
        function cursorToCanvas(cx, cy) {
            // Active-area margin so finger doesn't have to reach the exact camera edge.
            const MARGIN = 0.08;
            const nx = (cx - MARGIN) / (1 - 2 * MARGIN);
            const ny = (cy - MARGIN) / (1 - 2 * MARGIN);
            return {
                x: Math.max(0, Math.min(1, nx)) * canvas.width,
                y: Math.max(0, Math.min(1, ny)) * canvas.height
            };
        }

        function clearCanvas(snapshotBefore = false) {
            if (snapshotBefore) takeSnapshot();
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            drawBackground();
            resetStroke();
            eraseActive = false;
        }

        function resetUndoHistory() {
            undoStack.length = 0;
        }

        function drawBackground() {
            // Faint dot grid so blank canvas doesn't look empty
            ctx.save();
            ctx.fillStyle = '#0d0d1f';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            ctx.fillStyle = 'rgba(124, 92, 255, 0.08)';
            const spacing = 40;
            for (let x = spacing; x < canvas.width; x += spacing) {
                for (let y = spacing; y < canvas.height; y += spacing) {
                    ctx.fillRect(x - 1, y - 1, 2, 2);
                }
            }
            ctx.restore();
        }

        function setColor(idx) {
            colorIdx = (idx + COLORS.length) % COLORS.length;
            const color = COLORS[colorIdx];
            const dot = el('pill-color').querySelector('.color-dot');
            if (dot) dot.style.background = color;
            el('pill-color').lastChild.textContent = ' ' + COLOR_NAMES[colorIdx];
            document.querySelectorAll('.palette-swatch').forEach((sw, i) => {
                sw.classList.toggle('active', i === colorIdx);
            });
        }

        function nextColor() { setColor(colorIdx + 1); }

        function updateModeIndicator(state) {
            const pill = el('pill-mode');
            const map = {
                draw:    '👆 DRAW',
                hover:   '🖐️ HOVER',
                erase:   '✊ ERASE',
                peace:   '✌️ COLOR',
                thumb:   '👍 LIFT',
                nohand:  '— NO HAND',
                unknown: '… MOVE HAND'
            };
            pill.textContent = map[state] || map.nohand;
        }

        function updateDistanceIndicator(distance) {
            const pill = el('pill-distance');
            if (!pill) return;
            const map = {
                good:  { text: '✓ Good distance', cls: 'good' },
                close: { text: '← Move back',      cls: 'warn' },
                far:   { text: '→ Move closer',    cls: 'warn' },
                none:  { text: '',                 cls: 'hidden' }
            };
            const d = map[distance] || map.none;
            pill.textContent = d.text;
            pill.className = 'pill pill-distance ' + d.cls;
        }

        let lastGestureProcessed = 'nohand';
        let gestureCooldown = 0;

        function updatePenPill() {
            const pill = el('pill-pen');
            if (!pill) return;
            if (!Input.penDown) {
                pill.className = 'pill pill-pen pen-up';
                pill.textContent = State.inputMode === 'keyboard'
                    ? '✋ Pen UP · press Space'
                    : '✋ Pen UP · raise index ☝️';
            } else if (Input.eraser) {
                pill.className = 'pill pill-pen pen-erase';
                pill.textContent = '✊ Erasing';
            } else {
                pill.className = 'pill pill-pen pen-down';
                pill.textContent = '✍️ Drawing';
            }
        }

        /** Called every animation frame. */
        function tick() {
            if (!State.isDrawingActive) {
                cctx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);
                return;
            }

            const c = Hand.getCursor();
            updateModeIndicator(c.visible ? c.gesture : 'nohand');
            updateDistanceIndicator(c.visible ? c.distance : 'none');
            updatePenPill();

            // Clear cursor overlay each frame
            cctx.clearRect(0, 0, cursorCanvas.width, cursorCanvas.height);

            if (!c.visible) {
                endStroke();
                return;
            }

            const { x, y } = cursorToCanvas(c.smoothX, c.smoothY);

            // Decide the actual action based on input mode
            let action = 'hover';  // 'draw' | 'erase' | 'hover'

            if (State.inputMode === 'keyboard') {
                // Pure keyboard pen control — hand is JUST a cursor.
                // Gestures are totally ignored for mode changes → no false erases.
                if (Input.penDown) action = Input.eraser ? 'erase' : 'draw';
            } else {
                // Gesture mode (improved with cooldowns + stability)
                if (gestureCooldown > 0) gestureCooldown--;

                if (c.gesture === 'peace' && lastGestureProcessed !== 'peace' && gestureCooldown === 0) {
                    nextColor();
                    audio.click();
                    gestureCooldown = 25;
                }
                if (c.gesture === 'thumb' && lastGestureProcessed !== 'thumb' && gestureCooldown === 0) {
                    endStroke();
                    gestureCooldown = 20;
                }
                lastGestureProcessed = c.gesture;

                if (c.gesture === 'draw')       action = 'draw';
                else if (c.gesture === 'erase') action = 'erase';
                else                            action = 'hover';
            }

            // --- Trust guards: refuse to commit ink only when tracking is clearly broken ---
            // Distance is informational (shown in pill) but doesn't block drawing.
            const inSettlePeriod = performance.now() < Input.settleUntil;
            const canInk = c.trustworthy && !inSettlePeriod;

            // --- Render ---
            if (action === 'draw' && canInk) {
                appendStrokePoint(x, y);
                drawCursor(x, y, COLORS[colorIdx], brushSize, false);
            } else if (action === 'erase' && canInk) {
                endStroke();
                eraseAt(x, y);
                drawCursor(x, y, '#ffffff', ERASER_SIZE, true);
            } else if (action === 'draw' || action === 'erase') {
                // Pen is DOWN but tracking is momentarily untrustworthy.
                // Don't commit ink, but ALSO don't dump the stroke buffer —
                // when canInk returns, we want the next point to start a NEW
                // segment (not interpolate from a stale pos), so pause the
                // position filter cleanly.
                suspendStroke();
                drawCursor(x, y, COLORS[colorIdx], brushSize, false, true, true);
            } else {
                // Hover (pen up) — cursor only, no ink
                endStroke();
                endEraseBurst();
                drawCursor(x, y, COLORS[colorIdx], brushSize, false, true, false);
            }
        }

        // Pause the current stroke without clearing undo snapshot.
        // Any future appendStrokePoint call will treat this as a new stroke start.
        function suspendStroke() {
            if (isDrawing) {
                isDrawing = false;
                stroke = [];
                lastDrawnPointIdx = -1;
                // keep snapshotTakenForCurrentStroke so we don't double-snap
            }
        }

        // ---------- Smooth stroke rendering ----------
        //
        // Strategy: maintain a point buffer. For each new point, render a
        // quadratic Bezier through the midpoint of the previous two points
        // using the previous point as the control point. This yields
        // naturally smooth strokes without visible kinks.
        //
        // Also: reject points too close (sub-pixel noise) and too far
        // (likely tracking error → start a new stroke).
        //
        //      --- segment --->   --- segment --->
        //  P[n-2]      P[n-1]      P[n]        future
        //       \      /  \        /
        //        \    /    \      /
        //         mid       mid   (control point = P[n-1])
        //           ↑ draw quadratic curve from mid[n-2,n-1] through P[n-1] to mid[n-1,n]

        const MIN_SEGMENT = 1.0;    // ignore moves smaller than this (pixels)
        const MAX_SEGMENT = 140;    // reject jumps larger than this (likely tracking error)
        const WARMUP_POINTS = 2;    // need this many points to start inking (snappy)

        function appendStrokePoint(x, y) {
            if (!isDrawing) {
                // Start a new stroke — snapshot canvas FIRST for undo
                if (!snapshotTakenForCurrentStroke) {
                    takeSnapshot();
                    snapshotTakenForCurrentStroke = true;
                }
                stroke = [{ x, y }];
                isDrawing = true;
                lastDrawnPointIdx = -1;
                return;
            }
            const last = stroke[stroke.length - 1];
            const d = Math.hypot(x - last.x, y - last.y);
            if (d < MIN_SEGMENT) return;      // too small, ignore
            if (d > MAX_SEGMENT) {
                // Big jump — treat as tracking glitch, start a new stroke
                endStroke();
                stroke = [{ x, y }];
                isDrawing = true;
                lastDrawnPointIdx = -1;
                return;
            }

            stroke.push({ x, y });

            // Warmup — don't commit ink until we have confirmed a stable stroke
            if (stroke.length < WARMUP_POINTS) return;

            // On the first commit, start the stroke visually with a dot at p0
            // AND a line segment from p0 to p1 (so the stroke is visible immediately
            // once we have 2 points, not after 3).
            if (lastDrawnPointIdx === -1) {
                const p0 = stroke[0];
                const p1 = stroke[1];
                ctx.save();
                applyBrushStyle();
                // Starting dot
                ctx.beginPath();
                ctx.arc(p0.x, p0.y, brushSize / 2, 0, Math.PI * 2);
                ctx.fill();
                // Direct line to the second point for snappy stroke start
                ctx.beginPath();
                ctx.moveTo(p0.x, p0.y);
                ctx.lineTo(p1.x, p1.y);
                ctx.stroke();
                ctx.restore();
                lastDrawnPointIdx = 1;
            }

            drawCommittedSegments();
        }

        function drawCommittedSegments() {
            // Draw bezier segments for every new point since lastDrawnPointIdx
            while (stroke.length - 1 - lastDrawnPointIdx >= 2) {
                const i = lastDrawnPointIdx + 1;
                const p_prev = stroke[i - 1];
                const p_curr = stroke[i];
                const p_next = stroke[i + 1];

                const midPrevX = (p_prev.x + p_curr.x) / 2;
                const midPrevY = (p_prev.y + p_curr.y) / 2;
                const midNextX = (p_curr.x + p_next.x) / 2;
                const midNextY = (p_curr.y + p_next.y) / 2;

                ctx.save();
                applyBrushStyle();
                ctx.beginPath();
                ctx.moveTo(midPrevX, midPrevY);
                ctx.quadraticCurveTo(p_curr.x, p_curr.y, midNextX, midNextY);
                ctx.stroke();
                ctx.restore();

                lastDrawnPointIdx = i;
            }

            // Keep buffer small to save memory (we only need last few points)
            if (stroke.length > 32) {
                const trim = stroke.length - 8;
                stroke.splice(0, trim);
                lastDrawnPointIdx = Math.max(-1, lastDrawnPointIdx - trim);
            }
        }

        function applyBrushStyle() {
            ctx.strokeStyle = COLORS[colorIdx];
            ctx.fillStyle = COLORS[colorIdx];
            ctx.lineWidth = brushSize;
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';
            ctx.shadowColor = COLORS[colorIdx];
            ctx.shadowBlur = 8;
        }

        function endStroke() {
            // Flush any remaining un-rendered segment with a short line to the last point
            if (isDrawing && stroke.length > 1 && lastDrawnPointIdx >= 0 && lastDrawnPointIdx < stroke.length - 1) {
                const p_from = stroke[lastDrawnPointIdx];
                const p_to   = stroke[stroke.length - 1];
                ctx.save();
                applyBrushStyle();
                ctx.beginPath();
                ctx.moveTo(p_from.x, p_from.y);
                ctx.lineTo(p_to.x, p_to.y);
                ctx.stroke();
                ctx.restore();
            }
            resetStroke();
        }

        function resetStroke() {
            isDrawing = false;
            stroke = [];
            lastDrawnPointIdx = -1;
            snapshotTakenForCurrentStroke = false;
        }

        let eraseActive = false;
        function eraseAt(x, y) {
            // Snapshot at the start of an erase burst so a whole wipe is one undo
            if (!eraseActive) {
                takeSnapshot();
                eraseActive = true;
            }
            ctx.save();
            ctx.globalCompositeOperation = 'destination-out';
            ctx.beginPath();
            ctx.arc(x, y, ERASER_SIZE / 2, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
            // Redraw background dots in the erased area so it looks consistent
            ctx.save();
            ctx.beginPath();
            ctx.arc(x, y, ERASER_SIZE / 2, 0, Math.PI * 2);
            ctx.clip();
            drawBackground();
            ctx.restore();
        }
        function endEraseBurst() { eraseActive = false; }

        function drawCursor(x, y, color, size, isEraser, isHover, isSuppressed) {
            cctx.save();
            if (isEraser) {
                cctx.strokeStyle = 'rgba(255, 255, 255, 0.95)';
                cctx.setLineDash([6, 6]);
                cctx.lineWidth = 2;
                cctx.beginPath();
                cctx.arc(x, y, size / 2, 0, Math.PI * 2);
                cctx.stroke();
            } else {
                // Outer glow ring
                cctx.strokeStyle = isSuppressed ? '#ffdd57' : color;
                cctx.lineWidth = isSuppressed ? 3 : 2;
                if (isSuppressed) cctx.setLineDash([4, 4]);
                cctx.beginPath();
                cctx.arc(x, y, size + (isHover ? 6 : 2), 0, Math.PI * 2);
                cctx.stroke();
                cctx.setLineDash([]);
                // Center dot
                cctx.fillStyle = color;
                cctx.globalAlpha = (isHover || isSuppressed) ? 0.5 : 1;
                cctx.beginPath();
                cctx.arc(x, y, size / 3, 0, Math.PI * 2);
                cctx.fill();
            }
            cctx.restore();
        }

        // Hook up palette click
        document.querySelectorAll('.palette-swatch').forEach((sw, i) => {
            sw.addEventListener('click', () => {
                setColor(i);
                audio.click();
            });
        });

        return {
            clear: clearCanvas,
            tick,
            setColor,
            nextColor,
            endStroke,
            undo,
            resetUndoHistory,
            getCanvas: () => canvas,
            getColorCount: () => COLORS.length
        };
    })();

    // =============================================================
    // CONFETTI
    // =============================================================
    const Confetti = (() => {
        const canvas = el('confetti-canvas');
        const ctx = canvas.getContext('2d');
        let particles = [];
        let running = false;

        function resize() {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
        }
        resize();
        window.addEventListener('resize', resize);

        function fire(x, y) {
            const colors = ['#ff3860', '#ffdd57', '#48c774', '#3298dc', '#b86bff', '#22e3ff'];
            for (let i = 0; i < 120; i++) {
                particles.push({
                    x, y,
                    vx: (Math.random() - 0.5) * 14,
                    vy: Math.random() * -16 - 4,
                    g: 0.35,
                    size: Math.random() * 6 + 3,
                    color: colors[Math.floor(Math.random() * colors.length)],
                    rot: Math.random() * Math.PI * 2,
                    vr: (Math.random() - 0.5) * 0.3,
                    life: 1
                });
            }
            if (!running) loop();
        }

        function loop() {
            running = true;
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            particles.forEach(p => {
                p.vy += p.g;
                p.x += p.vx;
                p.y += p.vy;
                p.rot += p.vr;
                p.life -= 0.008;
                ctx.save();
                ctx.translate(p.x, p.y);
                ctx.rotate(p.rot);
                ctx.globalAlpha = Math.max(0, p.life);
                ctx.fillStyle = p.color;
                ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.6);
                ctx.restore();
            });
            particles = particles.filter(p => p.life > 0 && p.y < canvas.height + 50);
            if (particles.length > 0) {
                requestAnimationFrame(loop);
            } else {
                running = false;
                ctx.clearRect(0, 0, canvas.width, canvas.height);
            }
        }

        return { fire };
    })();

    // =============================================================
    // GAME LOGIC
    // =============================================================
    function pickWord() {
        const bank = WORDS[State.difficulty];
        const available = bank.filter(w => !State.usedWords.has(w));
        const pool = available.length > 0 ? available : bank;
        const word = pool[Math.floor(Math.random() * pool.length)];
        State.usedWords.add(word);
        return word;
    }

    function startGame() {
        const names = el('player-input').value
            .split('\n')
            .map(n => n.trim())
            .filter(Boolean);

        if (names.length < 2) {
            el('player-input').style.borderColor = 'var(--danger)';
            el('player-input').placeholder = 'Need at least 2 players!';
            el('player-input').value = '';
            setTimeout(() => { el('player-input').style.borderColor = ''; }, 1500);
            return;
        }
        if (names.length > 6) {
            alert('Max 6 players.');
            return;
        }
        // Dedup
        const seen = new Set();
        State.players = [];
        for (const n of names) {
            if (!seen.has(n.toLowerCase())) {
                seen.add(n.toLowerCase());
                State.players.push(n);
            }
        }

        State.scores = {};
        State.roundWins = {};
        State.players.forEach(p => { State.scores[p] = 0; State.roundWins[p] = 0; });
        State.roundsPerPlayer = parseInt(el('rounds-select').value, 10);
        State.secondsPerRound = parseInt(el('time-select').value, 10);
        State.difficulty = el('difficulty-select').value;
        State.inputMode = el('input-mode-select').value;
        State.perfMode = el('perf-select').value;
        State.format = el('format-select').value;
        State.winTarget = winTargetFor(State.format);
        State.maxAttempts = parseInt(el('attempts-select').value, 10);
        State.totalRounds = (State.format === 'classic')
            ? State.roundsPerPlayer * State.players.length
            : Infinity; // BO ends when someone hits winTarget
        State.currentRound = 0;
        State.currentDrawerIdx = 0;
        State.usedWords = new Set();
        State.isPractice = false;

        audio.click();
        beginRound();
    }

    function startPractice() {
        State.players = ['You'];
        State.scores = { You: 0 };
        State.roundWins = { You: 0 };
        State.roundsPerPlayer = 999;
        State.secondsPerRound = parseInt(el('time-select').value, 10);
        State.difficulty = el('difficulty-select').value;
        State.inputMode = el('input-mode-select').value;
        State.perfMode = el('perf-select').value;
        State.format = 'classic';
        State.winTarget = Infinity;
        State.maxAttempts = 99;  // no attempts limit in solo
        State.totalRounds = 999;
        State.currentRound = 0;
        State.currentDrawerIdx = 0;
        State.usedWords = new Set();
        State.isPractice = true;
        audio.click();
        beginRound();
    }

    function beginRound() {
        State.currentWord = pickWord();
        State.pendingCorrect = false;
        if (State.isPractice) {
            showPromptReveal();
        } else {
            // Handoff screen
            const drawer = State.players[State.currentDrawerIdx];
            el('handoff-name').textContent = drawer;
            el('handoff-round-info').textContent =
                `Round ${State.currentRound + 1} of ${State.totalRounds} · ${State.secondsPerRound}s · ${capitalize(State.difficulty)}`;
            showScreen('handoff');
        }
    }

    function showPromptReveal() {
        el('prompt-word').textContent = State.currentWord;
        showScreen('prompt');
        // Kick off camera + calibration helper
        startCalibration();
    }

    // ---------- Calibration helper ----------
    let calibrationRAF = 0;
    let goodDistanceFrames = 0;

    async function startCalibration() {
        const statusEl = el('calibration-status');
        const indicator = el('meter-indicator');
        const startBtn = el('btn-prompt-start');
        startBtn.disabled = true;
        statusEl.textContent = 'Starting camera…';
        statusEl.className = 'calibration-status';
        indicator.style.left = '0%';
        goodDistanceFrames = 0;

        try {
            await Hand.init();
        } catch (e) {
            statusEl.textContent = 'Camera unavailable';
            statusEl.className = 'calibration-status danger';
            startBtn.disabled = false; // let them try anyway
            return;
        }

        // Run a UI-update loop that reads cursor + updates the meter
        cancelAnimationFrame(calibrationRAF);
        function updateCalibration() {
            if (!screens.prompt.classList.contains('active')) return; // stop when leaving
            const c = Hand.getCursor();
            if (!c.visible) {
                statusEl.textContent = 'Show your hand to the camera';
                statusEl.className = 'calibration-status warn';
                goodDistanceFrames = 0;
                startBtn.disabled = true;
            } else {
                // Map hand size (0.05..0.28) to meter position (0..100%)
                const pct = Math.max(0, Math.min(1, (c.handSize - 0.05) / (0.28 - 0.05))) * 100;
                indicator.style.left = pct + '%';
                if (c.distance === 'good') {
                    statusEl.textContent = '✓ Great distance — hold still';
                    statusEl.className = 'calibration-status good';
                    goodDistanceFrames++;
                    if (goodDistanceFrames > 20) startBtn.disabled = false;
                } else if (c.distance === 'close') {
                    statusEl.textContent = '← Move a bit farther away';
                    statusEl.className = 'calibration-status warn';
                    goodDistanceFrames = 0;
                    startBtn.disabled = true;
                } else {
                    statusEl.textContent = '→ Move a bit closer';
                    statusEl.className = 'calibration-status warn';
                    goodDistanceFrames = 0;
                    startBtn.disabled = true;
                }
            }
            calibrationRAF = requestAnimationFrame(updateCalibration);
        }
        calibrationRAF = requestAnimationFrame(updateCalibration);
    }

    function stopCalibration() {
        cancelAnimationFrame(calibrationRAF);
        calibrationRAF = 0;
    }

    async function startDrawingPhase() {
        // Stop calibration loop (camera stays on; same Hand instance)
        stopCalibration();

        // Setup UI
        el('current-drawer').textContent = State.isPractice ? 'Practice' : State.players[State.currentDrawerIdx];
        populateGuessSelect();
        el('guess-input').value = '';
        el('guess-feedback').textContent = '';
        el('guess-feedback').className = 'guess-feedback';
        el('guess-input').disabled = false;
        el('btn-guess').disabled = false;

        // Attempts + bleeding
        State.attemptsLeft = State.maxAttempts;
        renderHearts();
        updateBleed();
        renderScoreboard();

        Draw.clear();
        Draw.resetUndoHistory();
        Draw.setColor(0);
        if (Hand.resetFilters) Hand.resetFilters();

        // Reset input state — pen always starts UP
        Input.penDown = false;
        Input.eraser = false;
        Input.settleUntil = 0;

        // Toggle keyboard hint bar based on input mode
        const hints = el('hotkey-hints');
        if (hints) hints.classList.toggle('hidden', State.inputMode !== 'keyboard');

        showScreen('game');

        // Ensure canvas size matches the displayed element to avoid distortion
        requestAnimationFrame(() => {
            syncCanvasToDisplaySize();
        });

        State.timeLeft = State.secondsPerRound;
        updateTimer(State.timeLeft, State.secondsPerRound);
        State.isDrawingActive = true;

        // Camera should already be running from calibration. Init is idempotent.
        try {
            await Hand.init();
            audio.start();
        } catch (e) {
            alert('Could not start camera. Please grant permission and reload.');
            State.isDrawingActive = false;
            showScreen('landing');
            return;
        }

        // Start timer
        clearInterval(State.timerInterval);
        State.startTime = Date.now();
        State.timerInterval = setInterval(() => {
            State.timeLeft -= 1;
            updateTimer(State.timeLeft, State.secondsPerRound);
            if (State.timeLeft <= 10 && State.timeLeft > 0) audio.tickLow();
            if (State.timeLeft <= 0) {
                clearInterval(State.timerInterval);
                endRound(false, null);
            }
        }, 1000);

        el('guess-input').focus();
    }

    function updateTimer(left, total) {
        const ratio = Math.max(0, left / total);
        const dashOffset = 283 * (1 - ratio);
        const fg = el('timer-fg');
        fg.style.strokeDashoffset = dashOffset;
        el('timer-text').textContent = Math.max(0, left);
        fg.classList.remove('warn', 'danger');
        if (left <= 10) fg.classList.add('danger');
        else if (left <= 20) fg.classList.add('warn');
    }

    function populateGuessSelect() {
        const sel = el('guess-player');
        sel.innerHTML = '';
        if (State.isPractice) {
            const o = document.createElement('option');
            o.value = 'You';
            o.textContent = 'You';
            sel.appendChild(o);
            sel.style.display = 'none';
            return;
        }
        sel.style.display = '';
        State.players.forEach((p, i) => {
            if (i === State.currentDrawerIdx) return; // drawer can't guess
            const o = document.createElement('option');
            o.value = p;
            o.textContent = p;
            sel.appendChild(o);
        });
    }

    function submitGuess() {
        const guess = el('guess-input').value.trim().toLowerCase();
        if (!guess) return;
        if (!State.isDrawingActive) return;
        if (State.attemptsLeft <= 0) return;

        const target = State.currentWord.toLowerCase();
        const guesser = el('guess-player').value || 'You';

        if (fuzzyMatch(guess, target)) {
            endRound(true, guesser);
            return;
        }

        // Wrong guess — spend an attempt
        State.attemptsLeft -= 1;
        renderHearts(true);
        updateBleed();
        audio.wrong();

        const fb = el('guess-feedback');
        const remaining = Math.max(0, State.attemptsLeft);
        if (State.maxAttempts >= 99) {
            fb.textContent = guess + ' — not it';
        } else if (remaining > 0) {
            fb.textContent = `"${guess}" — not it · ${remaining} attempt${remaining === 1 ? '' : 's'} left`;
        } else {
            fb.textContent = `"${guess}" — not it · out of attempts!`;
        }
        fb.className = 'guess-feedback wrong';
        el('guess-input').value = '';

        if (State.attemptsLeft <= 0 && State.maxAttempts < 99) {
            // Out of attempts — death flash + end the round
            triggerDeathFlash();
            setTimeout(() => endRound(false, null), 900);
            el('guess-input').disabled = true;
            el('btn-guess').disabled = true;
        } else {
            setTimeout(() => {
                if (!State.isDrawingActive) return;
                fb.textContent = '';
                fb.className = 'guess-feedback';
            }, 1800);
        }
    }

    // =============================================================
    // Hearts (attempts remaining) + Bleeding overlay
    // =============================================================
    function renderHearts(animateLast = false) {
        const container = el('hearts');
        if (!container) return;
        if (State.isPractice || State.maxAttempts >= 99) {
            container.classList.add('hidden');
            container.innerHTML = '';
            return;
        }
        container.classList.remove('hidden');
        const total = State.maxAttempts;
        const left = State.attemptsLeft;
        // Build hearts if count changed
        if (container.childElementCount !== total) {
            container.innerHTML = '';
            for (let i = 0; i < total; i++) {
                const h = document.createElement('span');
                h.className = 'heart';
                h.textContent = '❤️';
                container.appendChild(h);
            }
        }
        // Update state of each heart
        [...container.children].forEach((h, i) => {
            const lost = i >= left;
            const wasLost = h.classList.contains('lost');
            h.classList.toggle('lost', lost);
            // Last remaining heart gets a pounding animation
            h.classList.toggle('critical', !lost && left === 1);
            // Animate the newly-broken heart
            if (lost && !wasLost && animateLast && i === left) {
                // Re-trigger break animation
                h.style.animation = 'none';
                // force reflow
                // eslint-disable-next-line no-unused-expressions
                h.offsetHeight;
                h.style.animation = '';
            }
        });
    }

    function updateBleed() {
        const overlay = el('bleed-overlay');
        if (!overlay) return;
        overlay.classList.remove('level-1', 'level-2', 'level-3', 'level-4', 'active');
        if (State.isPractice || State.maxAttempts >= 99) {
            document.body.classList.remove('screen-shake');
            return;
        }
        const total = State.maxAttempts;
        const left = State.attemptsLeft;
        const ratio = left / total; // 1.0 → 0.0

        // Map remaining ratio to severity levels.
        //   > 0.6         → no bleed
        //   0.4 – 0.6     → level 1
        //   0.25 – 0.4    → level 2
        //   0.11 – 0.25   → level 3
        //   ≤ 0.1 (last)  → level 4 + screen shake
        let level = 0;
        if (left <= 0)         level = 4;
        else if (ratio <= 0.1 || left === 1) level = 4;
        else if (ratio <= 0.25) level = 3;
        else if (ratio <= 0.4)  level = 2;
        else if (ratio <= 0.6)  level = 1;

        if (level > 0) {
            overlay.classList.add('active', 'level-' + level);
        }
        document.body.classList.toggle('screen-shake', level === 4 && left > 0);
    }

    function triggerDeathFlash() {
        const overlay = el('bleed-overlay');
        if (!overlay) return;
        overlay.classList.add('active', 'level-4', 'flash');
        setTimeout(() => overlay.classList.remove('flash'), 1200);
    }

    function clearBleed() {
        const overlay = el('bleed-overlay');
        if (!overlay) return;
        overlay.classList.remove('active', 'level-1', 'level-2', 'level-3', 'level-4', 'flash');
        document.body.classList.remove('screen-shake');
    }

    // =============================================================
    // Scoreboard strip (per-round wins, Best-of-N tracker)
    // =============================================================
    function renderScoreboard() {
        const strip = el('scoreboard-strip');
        const label = el('scoreboard-label');
        const list = el('scoreboard-players');
        if (!strip || !list) return;

        if (State.isPractice) {
            strip.style.display = 'none';
            return;
        }
        strip.style.display = '';

        const formatText = {
            bo3: 'Best of 3 · First to 2',
            bo5: 'Best of 5 · First to 3',
            bo7: 'Best of 7 · First to 4',
            classic: `Classic · ${State.totalRounds} rounds`
        };
        label.textContent = formatText[State.format] || '';

        const target = State.winTarget === Infinity ? 0 : State.winTarget;
        const drawer = State.players[State.currentDrawerIdx];
        const leaderWins = Math.max(0, ...State.players.map(p => State.roundWins[p] || 0));

        list.innerHTML = State.players.map(p => {
            const wins = State.roundWins[p] || 0;
            const isDrawer = p === drawer;
            const isLeader = wins > 0 && wins === leaderWins;
            // Build "pip" dots for BO formats, numeric for classic
            let winsHtml;
            if (target > 0 && target <= 5) {
                let pips = '';
                for (let i = 0; i < target; i++) {
                    pips += `<span class="pip ${i < wins ? 'on' : ''}"></span>`;
                }
                winsHtml = `<span class="score-chip-wins">${pips}</span>`;
            } else {
                winsHtml = `<span class="score-chip-wins">${wins}W</span>`;
            }
            const cls = ['score-chip'];
            if (isDrawer) cls.push('drawer');
            if (isLeader && !isDrawer) cls.push('winner');
            return `<div class="${cls.join(' ')}">
                <span class="score-chip-name">${escapeHtml(p)}${isDrawer ? ' ✍️' : ''}</span>
                ${winsHtml}
            </div>`;
        }).join('');
    }

    function fuzzyMatch(a, b) {
        a = a.replace(/\s+/g, '').toLowerCase();
        b = b.replace(/\s+/g, '').toLowerCase();
        if (a === b) return true;
        // Allow close matches (edit distance <= 1 for short words, <= 2 for longer)
        const tolerance = b.length <= 5 ? 1 : 2;
        return levenshtein(a, b) <= tolerance;
    }

    function levenshtein(a, b) {
        const m = a.length, n = b.length;
        if (!m) return n; if (!n) return m;
        const prev = new Array(n + 1), curr = new Array(n + 1);
        for (let j = 0; j <= n; j++) prev[j] = j;
        for (let i = 1; i <= m; i++) {
            curr[0] = i;
            for (let j = 1; j <= n; j++) {
                const cost = a[i - 1] === b[j - 1] ? 0 : 1;
                curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
            }
            for (let j = 0; j <= n; j++) prev[j] = curr[j];
        }
        return prev[n];
    }

    function endRound(correct, guesser) {
        State.isDrawingActive = false;
        clearInterval(State.timerInterval);
        clearBleed();

        const timeTaken = State.secondsPerRound - State.timeLeft;
        const outOfAttempts = (State.attemptsLeft <= 0 && State.maxAttempts < 99);
        let drawerPts = 0, guesserPts = 0;

        if (correct && !State.isPractice) {
            // Reward: faster = more points
            const timeRatio = Math.max(0, State.timeLeft / State.secondsPerRound);
            guesserPts = Math.round(50 + timeRatio * 50);
            drawerPts = Math.round(30 + timeRatio * 40);
            State.scores[guesser] = (State.scores[guesser] || 0) + guesserPts;
            const drawer = State.players[State.currentDrawerIdx];
            State.scores[drawer] = (State.scores[drawer] || 0) + drawerPts;
            // Round-win credit for BO tracking: both the guesser and the drawer get +1
            State.roundWins[guesser]  = (State.roundWins[guesser]  || 0) + 1;
            State.roundWins[drawer]   = (State.roundWins[drawer]   || 0) + 1;
            audio.correct();
            Confetti.fire(window.innerWidth / 2, window.innerHeight / 3);
        } else if (correct && State.isPractice) {
            audio.correct();
            Confetti.fire(window.innerWidth / 2, window.innerHeight / 3);
        } else {
            audio.wrong();
        }

        // Fill round-end screen
        let resultText;
        if (correct)             resultText = '✓ Correct!';
        else if (outOfAttempts)  resultText = '💀 Out of attempts!';
        else                     resultText = '⏱ Time\'s up!';
        el('round-end-result').textContent = resultText;
        el('round-end-word').textContent = State.currentWord;

        let pointsHtml = '';
        if (correct && !State.isPractice) {
            pointsHtml = `
                <div><strong>${escapeHtml(guesser)}</strong> guessed in <strong>${timeTaken}s</strong> · <strong>+${guesserPts}</strong> pts · <strong>+1 round win</strong></div>
                <div>Drawer <strong>${escapeHtml(State.players[State.currentDrawerIdx])}</strong> · <strong>+${drawerPts}</strong> pts · <strong>+1 round win</strong></div>
            `;
        } else if (!State.isPractice) {
            pointsHtml = `<div>No one guessed it. No round win awarded.</div>`;
        }
        el('round-end-points').innerHTML = pointsHtml;

        renderMiniScoreboard();
        showScreen('roundEnd');
    }

    function renderMiniScoreboard() {
        if (State.isPractice) {
            el('scoreboard-mini').innerHTML = '';
            return;
        }
        const sorted = [...State.players].sort((a, b) => {
            // Primary: round wins; Secondary: points
            if ((State.roundWins[b] || 0) !== (State.roundWins[a] || 0))
                return (State.roundWins[b] || 0) - (State.roundWins[a] || 0);
            return (State.scores[b] || 0) - (State.scores[a] || 0);
        });
        const topWins = sorted.length ? (State.roundWins[sorted[0]] || 0) : 0;
        el('scoreboard-mini').innerHTML = sorted.map(p => {
            const wins = State.roundWins[p] || 0;
            const pts = State.scores[p] || 0;
            const isLeader = wins > 0 && wins === topWins;
            return `
                <div class="score-row ${isLeader ? 'leader' : ''}">
                    <span class="score-row-name">${escapeHtml(p)}</span>
                    <span class="score-row-score">${wins}W · ${pts} pts</span>
                </div>
            `;
        }).join('');
    }

    function nextRound() {
        State.currentRound++;
        if (State.isPractice) {
            beginRound();
            return;
        }
        // BO win-target check — did anyone just clinch it?
        if (State.winTarget !== Infinity) {
            const champion = State.players.find(p => (State.roundWins[p] || 0) >= State.winTarget);
            if (champion) {
                showGameOver();
                return;
            }
        }
        State.currentDrawerIdx = (State.currentDrawerIdx + 1) % State.players.length;
        if (State.currentRound >= State.totalRounds) {
            showGameOver();
        } else {
            beginRound();
        }
    }

    function showGameOver() {
        clearBleed();
        const sorted = [...State.players].sort((a, b) => {
            if ((State.roundWins[b] || 0) !== (State.roundWins[a] || 0))
                return (State.roundWins[b] || 0) - (State.roundWins[a] || 0);
            return (State.scores[b] || 0) - (State.scores[a] || 0);
        });
        const ol = el('final-scores');
        ol.innerHTML = sorted.map((p, i) => `
            <li class="${i === 0 ? 'winner' : ''}">
                <span><span class="rank-num">#${i + 1}</span>${escapeHtml(p)}</span>
                <span>${State.roundWins[p] || 0} wins · ${State.scores[p] || 0} pts</span>
            </li>
        `).join('');
        showScreen('gameover');
        Confetti.fire(window.innerWidth * 0.3, window.innerHeight * 0.4);
        setTimeout(() => Confetti.fire(window.innerWidth * 0.7, window.innerHeight * 0.4), 300);
    }

    // ---------- Helpers ----------
    function capitalize(s) { return s[0].toUpperCase() + s.slice(1); }
    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
    }

    function showLoading(text) {
        el('loading-text').textContent = text || 'Loading…';
        el('loading-overlay').classList.remove('hidden');
    }
    function hideLoading() { el('loading-overlay').classList.add('hidden'); }

    // Make the canvas internal resolution match its displayed size for crisp lines.
    function syncCanvasToDisplaySize() {
        const canvas = Draw.getCanvas();
        const cursorCanvas = el('cursor-canvas');
        const rect = canvas.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return;
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const targetW = Math.max(320, Math.round(rect.width * dpr));
        const targetH = Math.max(180, Math.round(rect.height * dpr));
        if (canvas.width !== targetW || canvas.height !== targetH) {
            // Save existing content to restore
            const tmp = document.createElement('canvas');
            tmp.width = canvas.width; tmp.height = canvas.height;
            tmp.getContext('2d').drawImage(canvas, 0, 0);
            canvas.width = targetW; canvas.height = targetH;
            Draw.clear();
            canvas.getContext('2d').drawImage(tmp, 0, 0, targetW, targetH);
        }
        if (cursorCanvas.width !== targetW || cursorCanvas.height !== targetH) {
            cursorCanvas.width = targetW;
            cursorCanvas.height = targetH;
        }
    }

    // =============================================================
    // ANIMATION LOOP
    // =============================================================
    function loop() {
        Draw.tick();
        requestAnimationFrame(loop);
    }
    requestAnimationFrame(loop);

    // =============================================================
    // EVENT BINDINGS
    // =============================================================
    el('btn-start').addEventListener('click', startGame);
    el('btn-practice').addEventListener('click', startPractice);

    el('btn-handoff-ready').addEventListener('click', () => {
        audio.click();
        showPromptReveal();
    });

    el('btn-prompt-start').addEventListener('click', () => {
        audio.click();
        startDrawingPhase();
    });

    el('btn-prompt-skip').addEventListener('click', () => {
        audio.click();
        State.currentWord = pickWord();
        el('prompt-word').textContent = State.currentWord;
    });

    el('btn-clear').addEventListener('click', () => { audio.click(); Draw.clear(true); });
    el('btn-skip-round').addEventListener('click', () => {
        audio.click();
        State.isDrawingActive = false;
        clearInterval(State.timerInterval);
        clearBleed();
        endRound(false, null);
    });

    el('btn-guess').addEventListener('click', submitGuess);
    el('guess-input').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') submitGuess();
    });

    // ========== Keyboard controls (active during drawing phase) ==========
    function isTypingInInput() {
        const a = document.activeElement;
        if (!a) return false;
        const tag = a.tagName;
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
    }

    function setPenDown(down) {
        if (down && !Input.penDown) {
            // Only snap the position filter so the first inked point is exactly at
            // the fingertip (no sweep from a stale smoothed location).
            // Do NOT reset the trust/resync state — tracking was fine; we were just hovering.
            if (Hand.syncPositionFilter) Hand.syncPositionFilter();
            // Very short grace so filter has 1-2 fresh samples. Longer than this makes
            // the start of a stroke feel unresponsive.
            Input.settleUntil = performance.now() + 60;
        }
        if (!down) Draw.endStroke();
        Input.penDown = down;
    }

    document.addEventListener('keydown', (e) => {
        if (!State.isDrawingActive) return;
        if (isTypingInInput()) return;

        const key = e.key.toLowerCase();

        // Space — toggle pen down/up
        if (e.code === 'Space' || key === ' ') {
            e.preventDefault();
            setPenDown(!Input.penDown);
            audio.click();
            return;
        }
        // E — toggle eraser mode (independent of pen down)
        if (key === 'e') {
            e.preventDefault();
            Input.eraser = !Input.eraser;
            audio.click();
            return;
        }
        // C — next color
        if (key === 'c') {
            e.preventDefault();
            Draw.nextColor();
            audio.click();
            return;
        }
        // Z — undo
        if (key === 'z') {
            e.preventDefault();
            if (Draw.undo()) audio.click();
            else audio.wrong();
            return;
        }
        // 1-6 — pick color directly
        if (/^[1-6]$/.test(key)) {
            e.preventDefault();
            const idx = parseInt(key, 10) - 1;
            if (idx < Draw.getColorCount()) { Draw.setColor(idx); audio.click(); }
            return;
        }
    });

    el('btn-undo').addEventListener('click', () => {
        if (Draw.undo()) audio.click();
        else audio.wrong();
    });

    el('btn-next-round').addEventListener('click', () => { audio.click(); nextRound(); });
    el('btn-play-again').addEventListener('click', () => {
        audio.click();
        State.players.forEach(p => { State.scores[p] = 0; State.roundWins[p] = 0; });
        State.currentRound = 0;
        State.currentDrawerIdx = 0;
        State.usedWords = new Set();
        clearBleed();
        beginRound();
    });
    el('btn-home').addEventListener('click', () => {
        audio.click();
        State.isDrawingActive = false;
        clearInterval(State.timerInterval);
        stopCalibration();
        clearBleed();
        Hand.stop();
        showScreen('landing');
    });

    // Resize handling
    window.addEventListener('resize', () => {
        if (screens.game.classList.contains('active')) {
            syncCanvasToDisplaySize();
        }
    });

    // Expose for debugging
    window._AirSketch = { State, Hand, Draw };

    console.log('%cAirSketch%c ready. Draw in the air! ✍️', 'font-weight:900;color:#7c5cff', 'color:#9ea4c7');
})();
