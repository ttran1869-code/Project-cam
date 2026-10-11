# 📸 Project Cam

A tiny suite of **camera-driven, in-browser party modes** with a vintage,
Nintendo-DS–inspired **Main Menu** launcher. One hub, pick a cartridge:

| Mode | What it is |
| --- | --- |
| **✍️ ScribblCam** | Draw-in-the-air Pictionary. Teams of drawer + guesser race for leftover-time points. |
| **📸 Photo Booth** | *Hand Frame Darkroom* — frame yourself with your hands, pick a filter, auto-fire on a group smile, print a 4-shot strip. |

> No installs for players. No servers. No backend. Pure, local, hackathon-ready.

Open **`index.html`** (via `start.ps1` / `start.bat` — see below) and the
Main Menu lets you pick a mode.

## 🎨 Theming

Two self-contained themes:

- **Main Menu (`index.html`)** — vintage Nintendo-DS palette, inline inside
  its own `<style>` block. Edit the `:root { --menu-* }` variables at the top
  of the file (bezel color, screen gradient, tile tints) to re-skin the
  launcher.
- **ScribblCam (`scribblcam.html`)** — modern dark/neon. All variables live in
  `theme.css`. A few preset palettes (warm sunrise, forest green, light/pastel)
  are commented at the bottom — uncomment one or write your own `:root { ... }`.

The photobooth brings its own vintage-darkroom palette.

## 📁 Files

```
scribblcam/
├── index.html          # 🏠 Main Menu (vintage DS-style hub)
├── scribblcam.html     # ✍️ ScribblCam markup + screen flow
├── styles.css          # ScribblCam styles
├── game.js             # ScribblCam logic (hand tracking, game loop)
├── theme.css           # 🎨 ScribblCam theme variables
├── photobooth/
│   └── index.html      # 📸 Hand Frame Darkroom (self-contained)
├── start.ps1           # PowerShell launcher
├── start.bat           # Windows launcher
└── README.md
```

---

## ✍️ ScribblCam

A camera-based **draw-in-the-air** party game inspired by Skribbl.io / Pictionary.
Instead of drawing with your mouse, you **draw with your finger** — tracked
through your webcam in real time by **MediaPipe Hands**, right in the browser.

### 🎮 How it plays

1. One player enters names of everyone playing (pass-and-play, one device).
2. Each turn, one player gets a secret word.
3. They **draw it in the air** using their index finger — the camera tracks their hand and the drawing appears on the canvas.
4. The other players watch and shout guesses. Any player types the guess into the input.
5. First correct guess ends the round. Faster = more points for both the guesser and the drawer.
6. Highest score across all rounds wins.

There's also a **Solo Practice** mode if you just want to try the hand-drawing.

### 🎛️ Two input modes

Pick on the start screen:

#### Keyboard mode (recommended)
Your finger moves the cursor, but **nothing commits to the canvas until you press a key**. Zero accidental marks, zero mis-erases.

| Key | What it does |
| --- | --- |
| **Space** | Toggle pen down / up |
| **E** | Toggle eraser mode |
| **C** | Next color |
| **Z** | Undo last stroke |
| **1 – 6** | Pick color directly |

#### Gesture mode
Pure hands-free; pose decides the action. More magical, less reliable.

| Gesture | What it does |
| --- | --- |
| ☝️ Index up | Draw |
| 🖐️ Open palm | Hover / stop drawing |
| ✊ Fist | Eraser (hold firmly) |
| ✌️ Peace sign | Next color |

### 🛡️ Anti-lag protections

Camera lag used to send the cursor flying across the canvas. Fixed:

- **Frame-drop detection** — if two tracking frames are > 180 ms apart, drawing is suppressed for the next 4 frames.
- **Teleport rejection** — any raw position jump > 18 % of the frame drops the stroke.
- **Pen-down settle period** — 150 ms grace after pressing Space.
- **Lite model + lower camera resolution** (Fast perf mode).
- **Trust gate** — dashed yellow cursor when tracking is bad.
- **Undo (Z)** — if something sneaks past the guards.

### 🧠 How it works

- **Hand tracking** — [MediaPipe Hands](https://ai.google.dev/edge/mediapipe/solutions/vision/hand_landmarker)
  loaded from CDN. 21 landmarks per hand, ~30 FPS, all client-side on WebGL.
- **Gesture classification** — simple geometric rules on landmark distances.
- **Smoothing** — exponential moving average + hold debouncer.
- **Drawing** — Canvas 2D with a glow shadow. Fuzzy guess matching (Levenshtein ≤ 2).

---

## 📸 Photo Booth

Cloned from [ssiravantha/PhotoBooth](https://github.com/ssiravantha/PhotoBooth)
and dropped into `photobooth/` as a self-contained HTML file. Hold both hands
up like you're gripping the sides of a frame, tilt your hands to tilt the
frame, flip one hand to twist it into a bow-tie. Pick a filter from the left
rail (Classic, Art, Animated), press **Space** or let the auto-shutter fire
when everyone smiles. Every 4 shots makes a printable strip.

Keyboard shortcuts inside the booth:

| Key | What it does |
| --- | --- |
| **Space** | Take photo (or start a new turn if the strip is full) |
| **L** | Lock the current frame in place |
| **Z** | Undo the last locked frame |

---

## 🚀 Running it

Camera access requires an `http://localhost` or `https://` origin — opening
`index.html` directly from the filesystem **will not work** (browsers block
`getUserMedia` on `file://`).

### Option 1 — one-click launchers

- Double-click **`start.ps1`** (PowerShell) or **`start.bat`** (CMD) in this folder.
- Both will start a local server on port 8000 and open the Main Menu in your browser.

### Option 2 — Python

```powershell
cd C:\Users\tranq\scribblcam
python -m http.server 8000
```

Then open **http://localhost:8000** in Chrome / Edge / Safari.

### Option 3 — Node.js

```powershell
cd C:\Users\tranq\scribblcam
npx serve . -l 8000
```

## 🧑‍🤝‍🧑 Browser compatibility

- ✅ **Chrome / Edge** (desktop) — recommended
- ✅ **Safari** (macOS 13+)
- ✅ **Firefox**
- ⚠️ Mobile cameras work but hand tracking is heavier — laptop is best.

## 💡 Tips for a smooth demo

- Good lighting on your hand → better tracking.
- Keep your hand ~30–60 cm from the camera, inside the preview box.
- ScribblCam uses the **index fingertip** when drawing — exaggerate the "pointing" pose.
- If strokes feel laggy, lower the `SMOOTH` constant in `game.js`.

Have fun! 🎨
