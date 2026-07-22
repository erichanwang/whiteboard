import { chromium } from "playwright";

// Frame-time benchmark for the offscreen layer cache (paintLayerCache in
// src/board.ts). Measures the app's actual hot path - the committed board is
// static, and each animation frame only needs to add a point to the stroke
// being drawn and repaint - at increasing stroke counts, comparing:
//   "before": every frame does a full culled repaint of every visible stroke
//             (drawBoard over the whole committed array), same as the code
//             before this change.
//   "after":  the committed layer is painted once into an offscreen canvas
//             and blitted every frame; only the in-progress stroke is drawn
//             fresh each frame (paintLayerCache).
// Both draw into a real Canvas2D context in headless Chromium so the numbers
// reflect actual browser rasterization cost, not a synthetic proxy.

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

try {
  await page.goto("http://127.0.0.1:1420", { waitUntil: "networkidle" });

  const results = await page.evaluate(async () => {
    const { drawBoard, drawGrid, createLayerCache, paintLayerCache } = await import("/src/board.ts");

    let seed = 5;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    const WIDTH = 1280;
    const HEIGHT = 800;
    const dpr = 1;
    const view = { x: 0, y: 0, scale: 1 };
    const visibleBounds = { x: 0, y: 0, width: WIDTH, height: HEIGHT };
    const theme = "white";

    // Strokes scattered across the visible viewport - the worst case for a
    // full repaint, since every one of them is on-screen and has to be
    // walked and stroked each frame.
    const makeStrokes = (count) => Array.from({ length: count }, (_, index) => ({
      id: `stroke-${index}`,
      color: "#161616",
      width: 1 + random() * 5,
      pointerType: "pen",
      points: Array.from({ length: 3 + Math.floor(random() * 5) }, () => ({
        x: random() * WIDTH,
        y: random() * HEIGHT,
        pressure: 0.3 + random() * 0.6,
      })),
    }));

    // A full repaint of 100k strokes is expensive and its cost is stable
    // frame to frame (same work every time, no I/O), so a full repaint needs
    // far fewer samples than a cheap blit to get a solid average - this is
    // what keeps the "before" case from taking minutes per size.
    const BEFORE_FRAMES = 8;
    const AFTER_FRAMES = 60;
    const sizes = [1_000, 10_000, 50_000, 100_000];
    const report = [];

    for (const size of sizes) {
      const strokes = makeStrokes(size);

      const canvas = document.createElement("canvas");
      canvas.width = WIDTH;
      canvas.height = HEIGHT;
      const context = canvas.getContext("2d");

      // "Before": full repaint every frame (grid + every visible strokes +
      // the in-progress stroke), matching the pre-change drawFrame body.
      const live = { id: "live", color: "#161616", width: 3, pointerType: "pen", points: [{ x: WIDTH / 2, y: HEIGHT / 2, pressure: 0.5 }] };
      let beforeTotal = 0;
      for (let frame = 0; frame < BEFORE_FRAMES; frame += 1) {
        live.points = [...live.points, {
          x: live.points[live.points.length - 1].x + (random() - 0.5) * 8,
          y: live.points[live.points.length - 1].y + (random() - 0.5) * 8,
          pressure: 0.4 + random() * 0.4,
        }];
        const start = performance.now();
        context.setTransform(1, 0, 0, 1, 0, 0);
        context.clearRect(0, 0, WIDTH, HEIGHT);
        context.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.x, dpr * view.y);
        drawGrid(context, visibleBounds, theme, view.scale);
        drawBoard(context, strokes, [], [], theme, new Set(), false, true, visibleBounds);
        drawBoard(context, [live], [], [], theme);
        beforeTotal += performance.now() - start;
      }
      const beforeMsPerFrame = beforeTotal / BEFORE_FRAMES;

      // "After": same scene, but the committed layer goes through
      // paintLayerCache. The stroke array and view never change across these
      // frames (exactly like drawing one stroke in the real app), so after
      // the first frame's one-time paint, every subsequent frame just blits.
      const layerCache = createLayerCache();
      const live2 = { id: "live", color: "#161616", width: 3, pointerType: "pen", points: [{ x: WIDTH / 2, y: HEIGHT / 2, pressure: 0.5 }] };
      let afterTotal = 0;
      for (let frame = 0; frame < AFTER_FRAMES; frame += 1) {
        live2.points = [...live2.points, {
          x: live2.points[live2.points.length - 1].x + (random() - 0.5) * 8,
          y: live2.points[live2.points.length - 1].y + (random() - 0.5) * 8,
          pressure: 0.4 + random() * 0.4,
        }];
        const start = performance.now();
        const signature = [strokes, theme, view.x, view.y, view.scale];
        paintLayerCache(layerCache, context, WIDTH, HEIGHT, dpr, view, signature, (offscreenContext) => {
          drawGrid(offscreenContext, visibleBounds, theme, view.scale);
          drawBoard(offscreenContext, strokes, [], [], theme, new Set(), false, true, visibleBounds);
        });
        drawBoard(context, [live2], [], [], theme);
        afterTotal += performance.now() - start;
      }
      const afterMsPerFrame = afterTotal / AFTER_FRAMES;

      report.push({ size, beforeMsPerFrame, afterMsPerFrame });
    }

    return report;
  });

  console.log("Render frame-time benchmark (headless Chromium, drawing one stroke while the board is static):");
  console.log("strokes\tbefore(ms/frame)\tafter(ms/frame)\tspeedup");
  for (const row of results) {
    console.log(
      `${row.size}\t${row.beforeMsPerFrame.toFixed(3)}\t\t\t${row.afterMsPerFrame.toFixed(3)}\t\t${(row.beforeMsPerFrame / row.afterMsPerFrame).toFixed(1)}x`,
    );
  }
} finally {
  await browser.close();
}
