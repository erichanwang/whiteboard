import { chromium } from "playwright";

// Correctness gate for the offscreen layer cache used by the main canvas's
// per-frame draw (paintLayerCache in src/board.ts, wired up in App.tsx's
// drawFrame). Caching is exactly the kind of optimization that can leave
// stale pixels behind if a change is missed by the invalidation signature,
// so this renders the same sequence of board states two ways - once as a
// plain full repaint every frame, once through paintLayerCache (which only
// repaints when its signature changes and blits otherwise) - and asserts the
// two canvases are pixel-identical after every step, including steps that
// must force a repaint (committing a stroke, erasing a stroke) and steps
// that must NOT (only the in-progress stroke changing).

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 900, height: 700 } });

try {
  await page.goto("http://127.0.0.1:1420", { waitUntil: "networkidle" });

  const result = await page.evaluate(async () => {
    const { drawBoard, createLayerCache, paintLayerCache, addStroke, eraseStrokesAt } =
      await import("/src/board.ts");

    let seed = 11;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    const WIDTH = 800;
    const HEIGHT = 600;
    const makeStroke = (id, cx, cy) => ({
      id,
      color: "#161616",
      width: 1 + random() * 6,
      pointerType: "pen",
      points: Array.from({ length: 3 + Math.floor(random() * 5) }, () => ({
        x: cx + (random() - 0.5) * 60,
        y: cy + (random() - 0.5) * 60,
        pressure: 0.3 + random() * 0.6,
      })),
    });

    const strokeCount = 300;
    let committed = Array.from({ length: strokeCount }, (_, index) =>
      makeStroke(`stroke-${index}`, random() * WIDTH, random() * HEIGHT));

    const theme = "white";
    const view = { x: 0, y: 0, scale: 1 };
    const dpr = 1;
    const visibleBounds = { x: 0, y: 0, width: WIDTH, height: HEIGHT };

    const fullCanvas = document.createElement("canvas");
    fullCanvas.width = WIDTH;
    fullCanvas.height = HEIGHT;
    const fullContext = fullCanvas.getContext("2d");

    const cachedCanvas = document.createElement("canvas");
    cachedCanvas.width = WIDTH;
    cachedCanvas.height = HEIGHT;
    const cachedContext = cachedCanvas.getContext("2d");
    const layerCache = createLayerCache();

    // Draws the full scene (committed strokes + optional live stroke)
    // directly onto `context`, no caching - this is the reference behavior.
    // (The grid is deliberately left out here: its hairline lines land
    // exactly on pixel boundaries at scale 1, and re-rasterizing the same
    // Path2D on two separate canvases produces a few sub-pixel antialiasing
    // differences in Chromium regardless of caching - noise unrelated to
    // what this test is checking, which is whether the cache ever drops or
    // retains stroke pixels it shouldn't.)
    const drawFull = (context, strokes, liveStroke) => {
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, WIDTH, HEIGHT);
      context.setTransform(dpr * view.scale, 0, 0, dpr * view.scale, dpr * view.x, dpr * view.y);
      drawBoard(context, strokes, [], [], theme, new Set(), false, true, visibleBounds);
      if (liveStroke) drawBoard(context, [liveStroke], [], [], theme);
    };

    // Draws the same scene through the layer cache, mirroring drawFrame:
    // committed strokes go through paintLayerCache (repainted only when the
    // signature changes), the live stroke is always drawn fresh on top.
    const drawCached = (strokes, liveStroke) => {
      const signature = [strokes, theme, view.x, view.y, view.scale];
      paintLayerCache(layerCache, cachedContext, WIDTH, HEIGHT, dpr, view, signature, (offscreenContext) => {
        drawBoard(offscreenContext, strokes, [], [], theme, new Set(), false, true, visibleBounds);
      });
      if (liveStroke) drawBoard(cachedContext, [liveStroke], [], [], theme);
    };

    const pixelsMatch = () => {
      const a = fullContext.getImageData(0, 0, WIDTH, HEIGHT).data;
      const b = cachedContext.getImageData(0, 0, WIDTH, HEIGHT).data;
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i += 1) {
        if (a[i] !== b[i]) return false;
      }
      return true;
    };

    const steps = [];

    // Baseline: committed strokes only, no live stroke.
    drawFull(fullContext, committed, null);
    drawCached(committed, null);
    steps.push({ label: "baseline", ok: pixelsMatch() });

    // Draw a new stroke over many frames: committed strokes never change, so
    // the cached path should reuse its offscreen layer every frame while the
    // live stroke grows - this is the hot path the cache exists for.
    const live = makeStroke("live", WIDTH / 2, HEIGHT / 2);
    live.points = [live.points[0]];
    for (let frame = 0; frame < 30; frame += 1) {
      live.points = [...live.points, {
        x: live.points[live.points.length - 1].x + (random() - 0.5) * 10,
        y: live.points[live.points.length - 1].y + (random() - 0.5) * 10,
        pressure: 0.4 + random() * 0.4,
      }];
      drawFull(fullContext, committed, live);
      drawCached(committed, live);
    }
    steps.push({ label: "live-stroke-frames", ok: pixelsMatch() });

    // Commit the stroke: the strokes array identity changes, which must
    // force the cache to repaint (this is the invalidation a broken
    // signature would skip, leaving the just-finished stroke's pixels
    // missing from the cached canvas).
    committed = addStroke(committed, live);
    drawFull(fullContext, committed, null);
    drawCached(committed, null);
    steps.push({ label: "commit-stroke", ok: pixelsMatch() });

    // Erase a stroke: same requirement, in the other direction (pixels must
    // disappear, not linger from the stale cached layer).
    const erased = committed[0];
    const erasePoint = erased.points[0];
    committed = eraseStrokesAt(committed, erasePoint.x, erasePoint.y, erased.width + 4);
    drawFull(fullContext, committed, null);
    drawCached(committed, null);
    steps.push({ label: "erase-stroke", ok: pixelsMatch() });

    return steps;
  });

  const failed = result.filter((step) => !step.ok);
  if (failed.length) {
    throw new Error(`Render cache produced mismatched pixels at: ${failed.map((step) => step.label).join(", ")}`);
  }
  console.log(`Render cache equivalence test passed: ${result.map((step) => step.label).join(", ")} all pixel-identical to full repaint.`);
} finally {
  await browser.close();
}
