import { chromium } from "playwright";

// Headless benchmark for the live stroke-simplification path in
// appendStrokePoint/compactStrokePoints (src/board.ts): how much smaller are
// serialized strokes after simplification than the raw pointer samples that
// produced them, and how far does the simplified polyline actually deviate
// from the raw one. Runs in a real browser engine (headless Chromium),
// importing board.ts directly through the Vite dev server, same approach as
// tests/spatial-index-bench.mjs.

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

try {
  await page.goto("http://127.0.0.1:1420", { waitUntil: "networkidle" });

  const results = await page.evaluate(async () => {
    const { appendStrokePoint, serializeBoard, createBoard } = await import("/src/board.ts");

    let seed = 11;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    // Simulate a realistic handwritten stroke: a smooth cursive-like curve
    // (sum of a few low-frequency sinusoids, like real letterforms) sampled
    // at ~240 Hz (a fast stylus report rate) with small per-sample jitter,
    // plus pressure that ramps and wobbles the way real handwriting pressure
    // does (light at stroke start/end, heavier mid-stroke, small tremor).
    function makeRawStroke(seedOffset, lengthPx, width) {
      seed = 1000 + seedOffset;
      const sampleSpacingPx = 1.1; // ~240Hz sampling at a natural writing speed
      const sampleCount = Math.max(8, Math.round(lengthPx / sampleSpacingPx));
      const points = [];
      const freqA = 0.045 + random() * 0.02;
      const freqB = 0.13 + random() * 0.05;
      const ampA = 6 + random() * 6;
      const ampB = 1.5 + random() * 2;
      for (let index = 0; index < sampleCount; index += 1) {
        const t = index / (sampleCount - 1);
        const x = t * lengthPx;
        const y = ampA * Math.sin(x * freqA) + ampB * Math.sin(x * freqB + 1.7)
          + (random() - 0.5) * 0.35; // sensor jitter
        const rampIn = Math.min(1, t * 6);
        const rampOut = Math.min(1, (1 - t) * 6);
        const pressure = Math.max(0.05, Math.min(1,
          0.35 + 0.45 * Math.min(rampIn, rampOut) + (random() - 0.5) * 0.03));
        points.push({ x, y, pressure });
      }
      return { points, width };
    }

    function pointToSegmentDistance(px, py, ax, ay, bx, by) {
      const dx = bx - ax;
      const dy = by - ay;
      const lengthSquared = dx * dx + dy * dy;
      const t = lengthSquared > 0 ? Math.min(1, Math.max(0, ((px - ax) * dx + (py - ay) * dy) / lengthSquared)) : 0;
      const cx = ax + dx * t;
      const cy = ay + dy * t;
      return Math.hypot(px - cx, py - cy);
    }

    // Max/mean perpendicular distance from every raw sample point to the
    // nearest segment of the simplified polyline - the standard way to
    // quantify simplification fidelity loss (what RDP-style tolerances
    // bound directly).
    function deviation(rawPoints, simplifiedPoints) {
      let max = 0;
      let sum = 0;
      for (const point of rawPoints) {
        let best = Infinity;
        if (simplifiedPoints.length === 1) {
          best = Math.hypot(point.x - simplifiedPoints[0].x, point.y - simplifiedPoints[0].y);
        } else {
          for (let index = 1; index < simplifiedPoints.length; index += 1) {
            const a = simplifiedPoints[index - 1];
            const b = simplifiedPoints[index];
            const distance = pointToSegmentDistance(point.x, point.y, a.x, a.y, b.x, b.y);
            if (distance < best) best = distance;
          }
        }
        max = Math.max(max, best);
        sum += best;
      }
      return { max, mean: sum / rawPoints.length };
    }

    // Build a page of realistic handwriting: many strokes of varied length
    // (short letter strokes to long connected cursive runs) and width.
    const rawStrokes = [];
    for (let index = 0; index < 400; index += 1) {
      const length = 20 + random() * 220;
      const width = 1.5 + random() * 3.5;
      rawStrokes.push(makeRawStroke(index, length, width));
    }

    const simplifiedStrokes = [];
    let totalRawPoints = 0;
    let totalSimplifiedPoints = 0;
    let maxDeviation = 0;
    let sumMeanDeviation = 0;

    for (const raw of rawStrokes) {
      // Feed samples one at a time through appendStrokePoint, exactly as the
      // live pointermove handler in App.tsx does, so the benchmark exercises
      // the real capture-time simplification path, not an idealized offline
      // pass over the finished array.
      const stroke = { id: "s", color: "#111", width: raw.width, pointerType: "pen", points: [] };
      for (const point of raw.points) appendStrokePoint(stroke, point);
      simplifiedStrokes.push(stroke);
      totalRawPoints += raw.points.length;
      totalSimplifiedPoints += stroke.points.length;
      const { max, mean } = deviation(raw.points, stroke.points);
      maxDeviation = Math.max(maxDeviation, max);
      sumMeanDeviation += mean;
    }

    // Serialize both as the app's board JSON would (same per-point shape:
    // x, y, pressure), to measure actual file-size impact rather than just
    // point counts.
    const toBoardStrokes = (strokes) => strokes.map((stroke, index) => ({
      id: `stroke-${index}`,
      color: stroke.color ?? "#111111",
      width: stroke.width,
      pointerType: "pen",
      points: stroke.points,
    }));

    const rawBoardStrokes = rawStrokes.map((raw, index) => ({
      id: `stroke-${index}`,
      color: "#111111",
      width: raw.width,
      pointerType: "pen",
      points: raw.points,
    }));

    // "Raw" board: what would be saved if every pointer sample were kept
    // verbatim, at full float64 JSON precision (no simplification, no
    // rounding) - the naive baseline.
    const rawBoard = { ...createBoard(), strokes: rawBoardStrokes };
    const rawJson = JSON.stringify(rawBoard);

    // "Simplified" board: same strokes after live capture-time
    // simplification, still at full float64 precision.
    const simplifiedBoard = { ...createBoard(), strokes: toBoardStrokes(simplifiedStrokes) };
    const simplifiedJson = JSON.stringify(simplifiedBoard);

    // What actually gets written to disk/localStorage: simplified strokes
    // through serializeBoard's rounding, the real save path (src/App.tsx
    // saveBoard/autosave/encrypted export all call serializeBoard).
    const savedJson = serializeBoard(simplifiedBoard);

    return {
      strokeCount: rawStrokes.length,
      totalRawPoints,
      totalSimplifiedPoints,
      rawBytes: rawJson.length,
      simplifiedBytes: simplifiedJson.length,
      savedBytes: savedJson.length,
      maxDeviationPx: maxDeviation,
      meanDeviationPx: sumMeanDeviation / rawStrokes.length,
    };
  });

  const pointRatio = results.totalRawPoints / results.totalSimplifiedPoints;
  const byteRatio = results.rawBytes / results.simplifiedBytes;
  const savedRatio = results.rawBytes / results.savedBytes;

  console.log("Compression benchmark (live capture-time simplification, src/board.ts appendStrokePoint + serializeBoard)");
  console.log(`Strokes: ${results.strokeCount}`);
  console.log(`Raw points: ${results.totalRawPoints}  Simplified points: ${results.totalSimplifiedPoints}  Point reduction: ${pointRatio.toFixed(2)}x`);
  console.log(`Raw JSON bytes: ${results.rawBytes}`);
  console.log(`Simplified JSON bytes (full precision): ${results.simplifiedBytes}  Size reduction: ${byteRatio.toFixed(2)}x`);
  console.log(`Saved JSON bytes (simplified + serializeBoard rounding, actual on-disk format): ${results.savedBytes}  Size reduction: ${savedRatio.toFixed(2)}x`);
  console.log(`Fidelity loss: max deviation ${results.maxDeviationPx.toFixed(4)} px, mean deviation ${results.meanDeviationPx.toFixed(4)} px (per-stroke mean, averaged across strokes)`);

  if (savedRatio < 1) throw new Error("Simplification made the board larger, not smaller.");
} finally {
  await browser.close();
}
