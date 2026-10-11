# ✍️ AirSketch

A camera-based **draw-in-the-air** party game inspired by Skribbl.io / Pictionary.
Instead of drawing with your mouse, you **draw with your finger** — tracked
through your webcam in real time by **MediaPipe Hands**, right in the browser.

> No installs for players. No servers. No backend. Pure, local, hackathon-ready.

## 🎮 How it plays

1. One player enters names of everyone playing (pass-and-play, one device).
2. Each turn, one player gets a secret word.
3. They **draw it in the air** using their index finger — the camera tracks their hand and the drawing appears on the canvas.
4. The other players watch and shout guesses. Any player types the guess into the input.
5. First correct guess ends the round. Faster = more points for both the guesser and the drawer.
6. Highest score across all rounds wins.

There's also a **Solo Practice** mode if you just want to try the hand-drawing.

## 🎛️ Two input modes

Pick on the start screen:

### Keyboard mode (recommended)
Your finger moves the cursor, but **nothing commits to the canvas until you press a key**. Zero accidental marks, zero mis-erases.

| Key | What it does |
| --- | --- |
| **Space** | Toggle pen down / up |
| **E** | Toggle eraser mode |
| **C** | Next color |
| **Z** | Undo last stroke |
| **1 – 6** | Pick color directly |

### Gesture mode
Pure hands-free; pose decides the action. More magical, less reliable.

| Gesture | What it does |
| --- | --- |
| ☝️ Index up | Draw |
| 🖐️ Open palm | Hover / stop drawing |
| ✊ Fist | Eraser (hold firmly) |
| ✌️ Peace sign | Next color |

The current pen state is displayed as a big pill at the top-left of the canvas,
and the camera preview in the bottom-right shows your tracked hand skeleton.

## 🛡️ Anti-lag protections

Camera lag used to send the cursor flying across the canvas. Fixed:

- **Frame-drop detection** — if two tracking frames are > 180 ms apart, drawing is suppressed for the next 4 frames until positions are confirmed.
- **Teleport rejection** — any raw position jump > 18 % of the frame is treated as a tracking error and drops the stroke immediately (no "line across the canvas" artifact).
- **Pen-down settle period** — 150 ms grace after pressing Space, so the first point of a stroke is at the fingertip, not a stale smoothed location.
- **Lite model + lower camera resolution** (Fast perf mode) — model runs 2–3× faster, far fewer frame drops.
- **Trust gate** — if the cursor isn't trustworthy, you see a dashed yellow cursor instead of ink, so you *see* when tracking is bad.
- **Undo (Z)** — if something sneaks past the guards, one key brings it back.

## 🧠 How it works

- **Hand tracking** — [MediaPipe Hands](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker)
  (loaded from CDN). 21 landmarks per hand, ~30 FPS, runs entirely client-side on WebGL.
- **Gesture classification** — simple geometric rules on landmark distances (how
  extended each finger is from the wrist). No ML inference needed beyond the hand
  landmarker itself.
- **Smoothing** — exponential moving average on the fingertip position to reduce
  jitter, plus a tiny gesture-hold debouncer so transient misclassifications
  don't flicker the mode.
- **Drawing** — Canvas 2D, with a glow shadow for a neon look. Fuzzy guess
  matching (Levenshtein distance ≤ 2) so near-misses still count.

## 🚀 Running it

Camera access requires an `http://localhost` or `https://` origin — opening
`index.html` directly from the filesystem **will not work** (browsers block
`getUserMedia` on `file://`).

### Option 1 — Python (easiest, works everywhere)

```powershell
cd C:\Users\tranq\air-sketch
python -m http.server 8000
```

Then open **http://localhost:8000** in Chrome / Edge / Safari.

### Option 2 — Node.js

```powershell
cd C:\Users\tranq\air-sketch
npx serve . -l 8000
```

### Option 3 — one-click launchers in this folder

- `start.ps1` — PowerShell launcher (uses whichever is installed)
- `start.bat` — Windows batch launcher

Just double-click one and it will start a local server and open your browser.

## 🧑‍🤝‍🧑 Browser compatibility

- ✅ **Chrome / Edge** (desktop) — recommended
- ✅ **Safari** (macOS 13+) — works
- ✅ **Firefox** — works
- ⚠️ On mobile, the camera works but hand tracking is heavier; use a laptop for best results.

## 📁 Files

```
air-sketch/
├── index.html    # Markup + screen flow
├── styles.css    # Dark neon UI, glassmorphism, animations
├── game.js       # Hand tracking, drawing, game loop
├── start.ps1     # PowerShell launcher
├── start.bat     # Windows launcher
└── README.md
```

## 💡 Tips for a smooth demo

- Good lighting on your hand → better tracking.
- Keep your hand ~30–60cm from the camera, inside the preview box.
- The game uses the **index fingertip** when drawing — exaggerate the "pointing" pose for cleaner strokes.
- If the stroke feels laggy, lower the smoothing by changing the `SMOOTH` constant in `game.js`.

Have fun! 🎨
