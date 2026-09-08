import { chromium } from "playwright";

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

try {
  await page.goto("http://127.0.0.1:1420", { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.clear());
  await page.evaluate(() => {
    const createdAt = new Date().toISOString();
    const samples = Array.from({ length: 605 }, (_, index) => ({
      id: `sample-${index}`,
      label: "a",
      image: "AA==",
      exercise: "lowercase",
      mode: "text",
      createdAt,
      ignored: "discard me",
    }));
    samples.push({ id: "malformed", label: "x", image: "not base64", createdAt });
    const corrections = Array.from({ length: 105 }, (_, index) => ({
      id: `correction-${index}`,
      mode: "text",
      original: "a",
      corrected: "b",
      createdAt,
      ignored: "discard me",
    }));
    corrections.push({ id: "malformed", mode: "unknown", original: "a", corrected: "b", createdAt });
    localStorage.setItem("whiteboard.recognition.v1", JSON.stringify({
      provider: "untrusted",
      model: "x".repeat(300),
      handwritingFontEnabled: "true",
      samples,
      corrections,
    }));
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.getByLabel("Starting Whiteboard").waitFor({ state: "detached" });
  await page.waitForFunction(() => {
    const profile = JSON.parse(localStorage.getItem("whiteboard.recognition.v1"));
    return profile.samples.length === 600 && profile.corrections.length === 100;
  });
  const normalizedProfile = await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.recognition.v1")));
  if (normalizedProfile.provider !== "nvidia" || normalizedProfile.handwritingFontEnabled !== false) {
    throw new Error("Recognition profile did not normalize provider settings.");
  }
  if (normalizedProfile.samples[0]?.id !== "sample-5" || normalizedProfile.samples.at(-1)?.id !== "sample-604") {
    throw new Error("Recognition profile did not retain the newest 600 valid samples.");
  }
  if (normalizedProfile.corrections[0]?.id !== "correction-5" || normalizedProfile.corrections.at(-1)?.id !== "correction-104") {
    throw new Error("Recognition profile did not retain the newest 100 valid corrections.");
  }
  if ("ignored" in normalizedProfile.samples[0] || "ignored" in normalizedProfile.corrections[0]) {
    throw new Error("Recognition profile retained unknown nested properties.");
  }
  await page.evaluate(() => localStorage.removeItem("whiteboard.recognition.v1"));
  await page.reload({ waitUntil: "networkidle" });
  await page.getByLabel("Starting Whiteboard").waitFor({ state: "detached" });

  await page.getByText("Start drawing").waitFor();
  const batchedRedrawCount = await page.evaluate(async () => {
    const prototype = CanvasRenderingContext2D.prototype;
    const original = prototype.clearRect;
    let clears = 0;
    prototype.clearRect = function (...args) {
      clears += 1;
      return original.apply(this, args);
    };
    for (let index = 0; index < 50; index += 1) window.dispatchEvent(new Event("whiteboard-image-loaded"));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    prototype.clearRect = original;
    return clears;
  });
  if (batchedRedrawCount < 1 || batchedRedrawCount > 2) {
    throw new Error(`Canvas redraw requests were not batched to animation frames: ${batchedRedrawCount}`);
  }

  const canvasPixelBudget = await page.evaluate(async () => {
    const { canvasPixelRatio, MAX_DISPLAY_CANVAS_PIXELS } = await import("/src/board.ts");
    const normal = canvasPixelRatio(1200, 800, 2);
    const large = canvasPixelRatio(3840, 2160, 2);
    const wide = canvasPixelRatio(20_000, 1000, 1);
    return {
      normal,
      largePixels: Math.round(3840 * large) * Math.round(2160 * large),
      wideWidth: Math.round(20_000 * wide),
      maximumPixels: MAX_DISPLAY_CANVAS_PIXELS,
    };
  });
  if (canvasPixelBudget.normal !== 2
    || canvasPixelBudget.largePixels > canvasPixelBudget.maximumPixels
    || canvasPixelBudget.wideWidth > 8192) {
    throw new Error(`Display canvas pixel budget was not enforced: ${JSON.stringify(canvasPixelBudget)}`);
  }

  const handwritingGlyphCache = await page.evaluate(async () => {
    const { buildHandwritingGlyphs } = await import("/src/App.tsx");
    const samples = [..."abcdefghijklmnopqrstuvwxyz"].map((letter) => ({
      id: `sample-${letter}`,
      label: letter,
      image: `image-${letter}`,
      exercise: "lowercase",
      mode: "text",
      createdAt: "2026-01-01T00:00:00.000Z",
    }));
    const cache = new Map();
    let decodes = 0;
    let activeDecodes = 0;
    let maximumActiveDecodes = 0;
    const decode = async (image) => {
      decodes += 1;
      activeDecodes += 1;
      maximumActiveDecodes = Math.max(maximumActiveDecodes, activeDecodes);
      await Promise.resolve();
      activeDecodes -= 1;
      return image === "invalid" ? null : { dataUrl: image, aspect: 1 };
    };
    const first = await buildHandwritingGlyphs(samples, cache, {}, decode);
    const afterInitial = decodes;
    const second = await buildHandwritingGlyphs([
      ...samples,
      { id: "feedback", label: "words", image: "feedback-image", exercise: "feedback", mode: "text", createdAt: "2026-01-02T00:00:00.000Z" },
    ], cache, first, decode);
    const afterUnrelated = decodes;
    const replacement = [
      ...samples,
      { id: "replacement-a", label: "a", image: "replacement-image", exercise: "lowercase", mode: "text", createdAt: "2026-01-03T00:00:00.000Z" },
    ];
    const third = await buildHandwritingGlyphs(replacement, cache, second, decode);
    const afterReplacement = decodes;
    const invalidReplacement = [
      ...replacement,
      { id: "invalid-a", label: "a", image: "invalid", exercise: "lowercase", mode: "text", createdAt: "2026-01-04T00:00:00.000Z" },
    ];
    const fourth = await buildHandwritingGlyphs(invalidReplacement, cache, third, decode);
    const withoutB = await buildHandwritingGlyphs(
      invalidReplacement.filter((sample) => sample.label !== "b"),
      cache,
      fourth,
      decode,
    );
    return {
      afterInitial,
      afterUnrelated,
      afterReplacement,
      afterInvalidReplacement: decodes,
      unrelatedReusedResult: second === first,
      replacedA: third.a?.dataUrl,
      invalidAIsAbsent: !("a" in fourth),
      deletedBIsAbsent: !("b" in withoutB) && !cache.has("b"),
      cacheSize: cache.size,
      maximumActiveDecodes,
    };
  });
  if (handwritingGlyphCache.afterInitial !== 26
    || handwritingGlyphCache.afterUnrelated !== 26
    || !handwritingGlyphCache.unrelatedReusedResult
    || handwritingGlyphCache.afterReplacement !== 27
    || handwritingGlyphCache.replacedA !== "replacement-image"
    || handwritingGlyphCache.afterInvalidReplacement !== 28
    || !handwritingGlyphCache.invalidAIsAbsent
    || !handwritingGlyphCache.deletedBIsAbsent
    || handwritingGlyphCache.cacheSize !== 25
    || handwritingGlyphCache.maximumActiveDecodes !== 1) {
    throw new Error(`Handwriting glyph cache did not reuse, replace, or remove entries correctly: ${JSON.stringify(handwritingGlyphCache)}`);
  }

  const selectionMaterialization = await page.evaluate(async () => {
    const { transformSelection } = await import("/src/App.tsx");
    const untouched = { id: "untouched", color: "auto", width: 3, pointerType: "mouse", points: [{ x: 2, y: 3, pressure: 0.5 }] };
    const selected = { id: "selected-stroke", color: "auto", width: 0.5, pointerType: "mouse", points: [{ x: 20, y: 30, pressure: 0.7 }] };
    const original = {
      version: 1,
      id: "selection-transform-test",
      title: "Selection transform",
      theme: "white",
      grid: true,
      strokes: [untouched, selected],
      textObjects: [{ id: "selected-text", x: 20, y: 30, value: "a", color: "auto", kind: "text", fontSize: 4 }],
      imageObjects: [{ id: "selected-image", x: 20, y: 30, width: 2, height: 3, dataUrl: "data:image/png;base64,AA==" }],
      updatedAt: new Date().toISOString(),
    };
    const result = transformSelection(
      original,
      new Set(["selected-stroke", "selected-text", "selected-image"]),
      { x: 10, y: 10, width: 20, height: 30 },
      2,
      4,
      0.1,
      0.1,
    );
    return {
      originalPointX: original.strokes[1].points[0].x,
      selectedPoint: result.strokes[1].points[0],
      strokeWidth: result.strokes[1].width,
      fontSize: result.textObjects[0].fontSize,
      imageWidth: result.imageObjects[0].width,
      imageHeight: result.imageObjects[0].height,
      untouchedReused: result.strokes[0] === untouched,
    };
  });
  if (selectionMaterialization.originalPointX !== 20
    || selectionMaterialization.selectedPoint.x !== 13
    || selectionMaterialization.selectedPoint.y !== 16
    || selectionMaterialization.strokeWidth !== 1
    || selectionMaterialization.fontSize !== 8
    || selectionMaterialization.imageWidth !== 8
    || selectionMaterialization.imageHeight !== 8
    || !selectionMaterialization.untouchedReused) {
    throw new Error(`Selection materialization changed transform or clamp semantics: ${JSON.stringify(selectionMaterialization)}`);
  }

  const overlayContext = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const overlayPage = await overlayContext.newPage();
  await overlayPage.bringToFront();
  await overlayPage.addInitScript(() => {
    const updatedAt = new Date().toISOString();
    localStorage.setItem("whiteboard.document.v1", JSON.stringify({
      version: 1,
      id: "overlay-culling-test",
      title: "Overlay culling",
      theme: "white",
      grid: true,
      strokes: [],
      textObjects: [
        { id: "nearby", x: 1600, y: 300, value: "x^2", color: "auto", kind: "latex" },
        ...Array.from({ length: 4999 }, (_, index) => ({
          id: `offscreen-${index}`,
          x: 100_000 + index,
          y: 100_000,
          value: "x^2 + y^2",
          color: "auto",
          kind: "latex",
        })),
      ],
      imageObjects: [],
      updatedAt,
    }));
  });
  await overlayPage.goto("http://127.0.0.1:1420", { waitUntil: "networkidle" });
  await overlayPage.getByLabel("Starting Whiteboard").waitFor({ state: "detached" });
  if (await overlayPage.locator(".latex-board-object").count() !== 0) {
    throw new Error("Offscreen LaTeX objects were mounted before entering the viewport.");
  }
  const overlayNodeCount = await overlayPage.locator("*").count();
  if (overlayNodeCount > 500) throw new Error(`Offscreen LaTeX created too many DOM nodes: ${overlayNodeCount}`);
  const overlayCanvas = overlayPage.getByLabel(/Whiteboard\. Left drag/);
  const overlayBox = await overlayCanvas.boundingBox();
  if (!overlayBox) throw new Error("Overlay culling canvas did not render.");
  await overlayPage.mouse.move(overlayBox.x + 1100, overlayBox.y + 350);
  await overlayPage.mouse.down({ button: "middle" });
  await overlayPage.mouse.move(overlayBox.x + 200, overlayBox.y + 350, { steps: 4 });
  await overlayPage.mouse.up({ button: "middle" });
  await overlayPage.waitForFunction(() => Number(document.querySelector(".board-canvas")?.getAttribute("data-view-x")) < -800);
  await overlayPage.waitForTimeout(250);
  if (await overlayCanvas.getAttribute("data-visible-text-count") !== "1") {
    const storedOverlay = await overlayPage.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.document.v1")));
    throw new Error(`Visible LaTeX was not selected after panning: size=${await overlayCanvas.getAttribute("data-canvas-width")}x${await overlayCanvas.getAttribute("data-canvas-height")}, view=${await overlayCanvas.getAttribute("data-view-x")}, stored=${storedOverlay.textObjects.length}/${storedOverlay.textObjects[0]?.x}`);
  }
  await overlayPage.locator(".latex-board-object").waitFor();
  if (await overlayPage.locator(".latex-board-object").count() !== 1) {
    throw new Error("A LaTeX object was not mounted after entering the viewport.");
  }
  await overlayPage.mouse.move(overlayBox.x + 200, overlayBox.y + 350);
  await overlayPage.mouse.down({ button: "middle" });
  await overlayPage.mouse.move(overlayBox.x + 1100, overlayBox.y + 350, { steps: 4 });
  await overlayPage.mouse.up({ button: "middle" });
  await overlayPage.waitForFunction(() => Number(document.querySelector(".board-canvas")?.getAttribute("data-view-x")) > -100);
  await overlayPage.locator(".latex-board-object").waitFor({ state: "detached" });
  await overlayContext.close();
  await page.bringToFront();

  const parsedImport = await page.evaluate(async () => {
    const { parseBoard } = await import("/src/board.ts");
    const parsed = parseBoard(JSON.stringify({
      version: 1,
      id: "import-test",
      title: "Validated import",
      theme: "white",
      grid: true,
      updatedAt: new Date().toISOString(),
      strokes: [
        {
          id: "valid-stroke",
          color: "#111111",
          width: 999,
          pointerType: "pen",
          points: [
            { x: 10, y: 20, pressure: 5, time: 30 },
            { x: 15, y: 25, pressure: 0.5 },
            { x: "invalid", y: 20, pressure: 0.5, time: 31 },
          ],
        },
        { id: "invalid-stroke", color: "#111111", width: "wide", pointerType: "pen", points: [] },
      ],
      textObjects: [
        { id: "valid-text", x: 10, y: 20, value: "hello", color: "#111111", kind: "text", fontSize: 999 },
        { id: "invalid-text", x: "invalid", y: 20, value: "hello", color: "#111111", kind: "text" },
      ],
      imageObjects: [
        { id: "valid-image", x: 10, y: 20, width: 1, height: 1, dataUrl: "data:image/png;base64,AA==" },
        { id: "invalid-image", x: 10, y: 20, width: -1, height: 1, dataUrl: "data:image/png;base64,AA==" },
      ],
    }));
    return {
      strokeCount: parsed.strokes.length,
      pointCount: parsed.strokes[0]?.points.length,
      width: parsed.strokes[0]?.width,
      pressure: parsed.strokes[0]?.points[0]?.pressure,
      retainsLegacyTime: parsed.strokes[0]?.points.some((point) => Object.hasOwn(point, "time")),
      textCount: parsed.textObjects.length,
      fontSize: parsed.textObjects[0]?.fontSize,
      imageCount: parsed.imageObjects.length,
    };
  });
  if (parsedImport.strokeCount !== 1 || parsedImport.pointCount !== 2 || parsedImport.retainsLegacyTime) {
    throw new Error(`Board import did not discard malformed strokes and points: ${JSON.stringify(parsedImport)}`);
  }
  if (!(parsedImport.width > 0 && parsedImport.width <= 256) || !(parsedImport.pressure >= 0 && parsedImport.pressure <= 1)) {
    throw new Error(`Board import did not clamp stroke values: ${JSON.stringify(parsedImport)}`);
  }
  if (parsedImport.textCount !== 1 || !(parsedImport.fontSize >= 8 && parsedImport.fontSize <= 256)) {
    throw new Error(`Board import did not validate text objects: ${JSON.stringify(parsedImport)}`);
  }
  if (parsedImport.imageCount !== 1) throw new Error(`Board import did not reject invalid image dimensions: ${JSON.stringify(parsedImport)}`);

  const profileSheetMemory = await page.evaluate(async () => {
    const { buildProfileSheet } = await import("/src/practice.ts");
    const NativeImage = window.Image;
    const nativeDrawImage = CanvasRenderingContext2D.prototype.drawImage;
    const nativeToDataUrl = HTMLCanvasElement.prototype.toDataURL;
    let pending = 0;
    let maxPending = 0;
    let created = 0;
    let released = 0;
    class MockImage {
      width = 200;
      height = 100;
      onload = null;
      onerror = null;
      set src(_value) {
        created += 1;
        pending += 1;
        maxPending = Math.max(maxPending, pending);
        setTimeout(() => {
          pending -= 1;
          this.onload?.();
        }, 0);
      }
      removeAttribute() {
        released += 1;
      }
    }
    window.Image = MockImage;
    CanvasRenderingContext2D.prototype.drawImage = function () {};
    HTMLCanvasElement.prototype.toDataURL = function () { return "data:image/png;base64,AA=="; };
    try {
      const header = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
      const samples = Array.from({ length: 120 }, (_, index) => ({
        id: `memory-${index}`,
        label: `label-${index}`,
        image: header,
        exercise: "lowercase",
        mode: "text",
        createdAt: new Date().toISOString(),
      }));
      const sheet = await buildProfileSheet(samples);
      const headerBytes = Uint8Array.from(atob(header), (value) => value.charCodeAt(0));
      headerBytes.set([0, 0, 16, 0], 16);
      const oversized = btoa(String.fromCharCode(...headerBytes));
      const createdBeforeOversized = created;
      const oversizedSheet = await buildProfileSheet([{ ...samples[0], id: "oversized", image: oversized }]);
      return { maxPending, created, released, createdBeforeOversized, sheet, oversizedSheet };
    } finally {
      window.Image = NativeImage;
      CanvasRenderingContext2D.prototype.drawImage = nativeDrawImage;
      HTMLCanvasElement.prototype.toDataURL = nativeToDataUrl;
    }
  });
  if (profileSheetMemory.maxPending !== 1 || profileSheetMemory.createdBeforeOversized !== 120
    || profileSheetMemory.released !== 120 || !profileSheetMemory.sheet) {
    throw new Error(`Handwriting profile images were not decoded and released sequentially: ${JSON.stringify(profileSheetMemory)}`);
  }
  if (profileSheetMemory.created !== profileSheetMemory.createdBeforeOversized || profileSheetMemory.oversizedSheet !== null) {
    throw new Error(`Oversized handwriting sample reached the image decoder: ${JSON.stringify(profileSheetMemory)}`);
  }

  const recognitionProfileCache = await page.evaluate(async () => {
    const { profileSheetForRecognition } = await import("/src/recognition.ts");
    const NativeImage = window.Image;
    const nativeDrawImage = CanvasRenderingContext2D.prototype.drawImage;
    const nativeFillText = CanvasRenderingContext2D.prototype.fillText;
    const nativeToDataUrl = HTMLCanvasElement.prototype.toDataURL;
    const nativeCreateElement = document.createElement.bind(document);
    let created = 0;
    let pending = 0;
    let maxPending = 0;
    let encoded = 0;
    let canvasCreated = 0;
    let failEncoding = false;
    const labels = [];
    class MockImage {
      width = 1;
      height = 1;
      onload = null;
      onerror = null;
      set src(_value) {
        created += 1;
        pending += 1;
        maxPending = Math.max(maxPending, pending);
        setTimeout(() => {
          pending -= 1;
          this.onload?.();
        }, 0);
      }
      removeAttribute() {}
    }
    window.Image = MockImage;
    CanvasRenderingContext2D.prototype.drawImage = function () {};
    CanvasRenderingContext2D.prototype.fillText = function (value) { labels.push(value); };
    HTMLCanvasElement.prototype.toDataURL = function () {
      if (failEncoding) throw new Error("test encoding failure");
      encoded += 1;
      return `data:image/png;base64,sheet-${encoded}`;
    };
    document.createElement = function (tagName, options) {
      if (String(tagName).toLowerCase() === "canvas") canvasCreated += 1;
      return nativeCreateElement(tagName, options);
    };
    try {
      const header = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB";
      const createdAt = new Date().toISOString();
      const samples = [
        { id: "manual", label: "manual", image: header, mode: "text", createdAt },
        { id: "lowercase", label: "lower", image: header, exercise: "lowercase", mode: "text", createdAt },
        { id: "latex", label: "latex", image: header, exercise: "math", mode: "latex", createdAt },
      ];
      const firstPending = profileSheetForRecognition(samples, "text");
      const concurrentPending = profileSheetForRecognition(samples, "text");
      const samePending = firstPending === concurrentPending;
      const [first, concurrent] = await Promise.all([firstPending, concurrentPending]);
      const createdAfterText = created;
      const cached = await profileSheetForRecognition(samples, "text");
      const createdAfterCached = created;
      const latex = await profileSheetForRecognition(samples, "latex");
      const createdAfterLatex = created;
      const replacement = await profileSheetForRecognition([...samples], "text");
      const createdAfterReplacement = created;

      const headerBytes = Uint8Array.from(atob(header), (value) => value.charCodeAt(0));
      headerBytes.set([0, 0, 16, 0], 16);
      const oversized = btoa(String.fromCharCode(...headerBytes));
      const invalidSamples = [{ ...samples[0], id: "oversized-cache", image: oversized }];
      const canvasesBeforeNull = canvasCreated;
      const firstNull = await profileSheetForRecognition(invalidSamples, "text");
      const secondNull = await profileSheetForRecognition(invalidSamples, "text");
      const nullCanvasCount = canvasCreated - canvasesBeforeNull;

      const retrySamples = [{ ...samples[0], id: "retry" }];
      failEncoding = true;
      let rejected = false;
      try {
        await profileSheetForRecognition(retrySamples, "text");
      } catch {
        rejected = true;
      }
      failEncoding = false;
      const retried = await profileSheetForRecognition(retrySamples, "text");
      return {
        samePending, first, concurrent, cached, latex, replacement,
        createdAfterText, createdAfterCached, createdAfterLatex, createdAfterReplacement,
        firstNull, secondNull, nullCanvasCount, rejected, retried, maxPending, labels,
      };
    } finally {
      window.Image = NativeImage;
      CanvasRenderingContext2D.prototype.drawImage = nativeDrawImage;
      CanvasRenderingContext2D.prototype.fillText = nativeFillText;
      HTMLCanvasElement.prototype.toDataURL = nativeToDataUrl;
      document.createElement = nativeCreateElement;
    }
  });
  if (!recognitionProfileCache.samePending
    || recognitionProfileCache.first !== recognitionProfileCache.concurrent
    || recognitionProfileCache.first !== recognitionProfileCache.cached
    || recognitionProfileCache.createdAfterText !== 2
    || recognitionProfileCache.createdAfterCached !== 2
    || recognitionProfileCache.createdAfterLatex !== 4
    || recognitionProfileCache.createdAfterReplacement !== 6) {
    throw new Error(`Recognition profile cache did not reuse or invalidate by mode and sample identity: ${JSON.stringify(recognitionProfileCache)}`);
  }
  if (recognitionProfileCache.firstNull !== null || recognitionProfileCache.secondNull !== null
    || recognitionProfileCache.nullCanvasCount !== 1 || !recognitionProfileCache.rejected
    || !recognitionProfileCache.retried || recognitionProfileCache.maxPending !== 1) {
    throw new Error(`Recognition profile cache changed null/error behavior or sequential decoding: ${JSON.stringify(recognitionProfileCache)}`);
  }
  if (recognitionProfileCache.labels.join(",") !== "manual,lower,lower,latex,manual,lower,manual,manual") {
    throw new Error(`Recognition profile cache changed sample selection semantics: ${JSON.stringify(recognitionProfileCache.labels)}`);
  }

  const recognitionRaster = await page.evaluate(async () => {
    const { renderSelectionImage } = await import("/src/board.ts");
    const original = HTMLCanvasElement.prototype.toDataURL;
    let dimensions = null;
    let renderedCanvas = null;
    HTMLCanvasElement.prototype.toDataURL = function () {
      renderedCanvas = this;
      dimensions = { width: this.width, height: this.height };
      return "data:image/png;base64,";
    };
    try {
      renderSelectionImage([{
        id: "wide-recognition-stroke",
        color: "#111111",
        width: 4,
        pointerType: "pen",
        points: [
          { x: 0, y: 0, pressure: 0.5, time: 0 },
          { x: 4000, y: 4000, pressure: 0.5, time: 1 },
        ],
      }], "white");
      return {
        encoded: dimensions,
        released: renderedCanvas ? { width: renderedCanvas.width, height: renderedCanvas.height } : null,
      };
    } finally {
      HTMLCanvasElement.prototype.toDataURL = original;
    }
  });
  if (!recognitionRaster.encoded || recognitionRaster.encoded.width > 1100 || recognitionRaster.encoded.height > 1100
    || recognitionRaster.released?.width !== 0 || recognitionRaster.released?.height !== 0) {
    throw new Error(`Recognition raster exceeded its resource bound: ${JSON.stringify(recognitionRaster)}`);
  }

  const strokePointHandling = await page.evaluate(async () => {
    const { appendStrokePoint, drawBoard, eraseStrokesAt, pointHitsStroke, MAX_LIVE_STROKE_POINTS } = await import("/src/board.ts");
    const makeStroke = () => ({
      id: crypto.randomUUID(),
      color: "#111111",
      width: 4,
      pointerType: "pen",
      points: [],
    });
    const point = (x, y, pressure = 0.5, time = x + y) => ({ x, y, pressure, time });

    const straight = makeStroke();
    for (let x = 0; x <= 200; x += 1) appendStrokePoint(straight, point(x, 0));

    const curved = makeStroke();
    for (let x = 0; x <= 100; x += 2) appendStrokePoint(curved, point(x, 0));
    for (let y = 2; y <= 100; y += 2) appendStrokePoint(curved, point(100, y, 0.5, 100 + y));

    const circle = makeStroke();
    for (let index = 0; index < 1000; index += 1) {
      const angle = (index / 999) * Math.PI * 2;
      appendStrokePoint(circle, point(200 + 100 * Math.cos(angle), 200 + 100 * Math.sin(angle), 0.5, index));
    }

    const pressure = makeStroke();
    for (let x = 0; x <= 200; x += 2) {
      appendStrokePoint(pressure, point(x, 0, x === 100 ? 0.9 : 0.5));
    }

    const capped = makeStroke();
    let finalCappedPoint;
    for (let index = 0; index < 40_100; index += 1) {
      finalCappedPoint = point(index, index % 2 === 0 ? 0 : 10, 0.75, index);
      appendStrokePoint(capped, finalCappedPoint);
    }

    const pressureCanvas = document.createElement("canvas");
    pressureCanvas.width = 240;
    pressureCanvas.height = 100;
    const pressureContext = pressureCanvas.getContext("2d");
    const pressureStroke = {
      ...makeStroke(),
      width: 12,
      points: [point(20, 50, 0.05), point(80, 50, 0.05), point(160, 50, 1), point(220, 50, 1)],
    };
    drawBoard(pressureContext, [pressureStroke], [], [], "white");
    const offscreenStrokes = Array.from({ length: 1000 }, (_, strokeIndex) => ({
      ...makeStroke(),
      points: Array.from({ length: 20 }, (_, pointIndex) => point(100_000 + strokeIndex * 40 + pointIndex, 100_000)),
    }));
    const nativeHypot = Math.hypot;
    let offscreenDistanceChecks = 0;
    Math.hypot = (...values) => {
      offscreenDistanceChecks += 1;
      return nativeHypot(...values);
    };
    const offscreenHit = offscreenStrokes.some((stroke) => pointHitsStroke(0, 0, stroke, 10));
    Math.hypot = nativeHypot;
    const cacheInvalidationStroke = {
      ...makeStroke(),
      points: [point(1000, 1000)],
    };
    pointHitsStroke(0, 0, cacheInvalidationStroke, 1);
    appendStrokePoint(cacheInvalidationStroke, point(0, 0));
    const appendedPointHit = pointHitsStroke(0, 0, cacheInvalidationStroke, 1);
    const expandedBoundaryHit = pointHitsStroke(88, 100, {
      ...makeStroke(),
      width: 4,
      points: [point(100, 100), point(200, 100)],
    }, 10);
    const emptyStrokeHit = pointHitsStroke(0, 0, makeStroke(), 10);
    const eraserMiss = eraseStrokesAt(offscreenStrokes, 0, 0, 10);
    const eraserTargets = [
      { ...makeStroke(), id: "keep-first", points: [point(0, 100)] },
      { ...makeStroke(), id: "remove-middle", points: [point(0, 0)] },
      { ...makeStroke(), id: "keep-last", points: [point(0, 200)] },
      { ...makeStroke(), id: "remove-last", points: [point(5, 0)] },
    ];
    const eraserHit = eraseStrokesAt(eraserTargets, 0, 0, 10);
    const emptyEraserInput = [];
    const columnInk = (x) => {
      const pixels = pressureContext.getImageData(x, 0, 1, pressureCanvas.height).data;
      let count = 0;
      for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) count += 1;
      return count;
    };

    const cullingCanvas = document.createElement("canvas");
    cullingCanvas.width = 100;
    cullingCanvas.height = 100;
    const cullingContext = cullingCanvas.getContext("2d");
    const originalStroke = cullingContext.stroke.bind(cullingContext);
    let drawCalls = 0;
    cullingContext.stroke = (...args) => {
      drawCalls += 1;
      return originalStroke(...args);
    };
    const visibleBounds = { x: 0, y: 0, width: 100, height: 100 };
    drawBoard(cullingContext, [{
      ...makeStroke(),
      points: [point(10_000, 10_000, 0.2), point(10_050, 10_050, 0.8)],
    }], [], [], "white", new Set(), false, true, visibleBounds);
    const offscreenDrawCalls = drawCalls;
    drawBoard(cullingContext, [{
      ...makeStroke(),
      points: [point(10, 10, 0.2), point(50, 50, 0.8)],
    }], [], [], "white", new Set(), false, true, visibleBounds);

    const NativePath2D = window.Path2D;
    let pressurePathAllocations = 0;
    window.Path2D = class extends NativePath2D {
      constructor(...args) {
        super(...args);
        pressurePathAllocations += 1;
      }
    };
    try {
      const allocationStroke = makeStroke();
      allocationStroke.points = Array.from({ length: 50 }, (_, index) => point(index, 80, index % 2 ? 0.8 : 0.2));
      drawBoard(cullingContext, [allocationStroke], [], [], "white");
      const allocationsAfterFirstDraw = pressurePathAllocations;
      drawBoard(cullingContext, [allocationStroke], [], [], "white");
      const allocationsAfterCachedDraw = pressurePathAllocations;
      appendStrokePoint(allocationStroke, point(55, 80, 0.9));
      drawBoard(cullingContext, [allocationStroke], [], [], "white");
      var cachedPathAllocations = { allocationsAfterFirstDraw, allocationsAfterCachedDraw, allocationsAfterInvalidation: pressurePathAllocations };
    } finally {
      window.Path2D = NativePath2D;
    }

    return {
      straightCount: straight.points.length,
      straightEnd: straight.points.at(-1),
      curvedCount: curved.points.length,
      circleCount: circle.points.length,
      retainedCorner: curved.points.some((item) => Math.hypot(item.x - 100, item.y) <= 3),
      retainedPressureChange: pressure.points.some((item) => item.x === 100 && item.pressure === 0.9),
      maxLiveStrokePoints: MAX_LIVE_STROKE_POINTS,
      cappedCount: capped.points.length,
      cappedEnd: capped.points.at(-1),
      finalCappedPoint,
      simplifiedSegmentHit: pointHitsStroke(100, 0, straight, 1),
      thinInk: columnInk(50),
      thickInk: columnInk(190),
      endpointInk: pressureContext.getImageData(220, 50, 1, 1).data[3],
      offscreenDrawCalls,
      visibleDrawCalls: drawCalls - offscreenDrawCalls,
      pressurePathAllocations,
      cachedPathAllocations,
      offscreenDistanceChecks,
      offscreenHit,
      appendedPointHit,
      expandedBoundaryHit,
      emptyStrokeHit,
      eraserMissReusedInput: eraserMiss === offscreenStrokes,
      eraserHitIds: eraserHit.map((stroke) => stroke.id),
      eraserHitPreservedIdentities: eraserHit[0] === eraserTargets[0] && eraserHit[1] === eraserTargets[2],
      emptyEraserReusedInput: eraseStrokesAt(emptyEraserInput, 0, 0, 10) === emptyEraserInput,
    };
  });
  if (!(strokePointHandling.straightCount >= 2 && strokePointHandling.straightCount < 25)) {
    throw new Error(`Straight stroke samples were not reduced: ${JSON.stringify(strokePointHandling)}`);
  }
  if (strokePointHandling.straightEnd?.x !== 200 || strokePointHandling.straightEnd?.y !== 0) {
    throw new Error(`Stroke reduction did not preserve the latest endpoint: ${JSON.stringify(strokePointHandling)}`);
  }
  if (!strokePointHandling.retainedCorner || strokePointHandling.curvedCount <= strokePointHandling.straightCount) {
    throw new Error(`Stroke reduction discarded meaningful curvature: ${JSON.stringify(strokePointHandling)}`);
  }
  if (strokePointHandling.circleCount < 30 || strokePointHandling.circleCount > 200) {
    throw new Error(`Stroke reduction over- or under-simplified a smooth loop: ${JSON.stringify(strokePointHandling)}`);
  }
  if (!strokePointHandling.retainedPressureChange) {
    throw new Error(`Stroke reduction discarded a pressure change: ${JSON.stringify(strokePointHandling)}`);
  }
  if (strokePointHandling.maxLiveStrokePoints !== 20_000
    || strokePointHandling.cappedCount > strokePointHandling.maxLiveStrokePoints
    || JSON.stringify(strokePointHandling.cappedEnd) !== JSON.stringify(strokePointHandling.finalCappedPoint)) {
    throw new Error(`Stroke point cap did not preserve the latest endpoint: ${JSON.stringify(strokePointHandling)}`);
  }
  if (!strokePointHandling.simplifiedSegmentHit) throw new Error("Eraser hit-testing missed the segment between simplified points.");
  if (strokePointHandling.offscreenHit || strokePointHandling.offscreenDistanceChecks !== 0) {
    throw new Error(`Eraser hit-testing scanned offscreen stroke segments: ${JSON.stringify(strokePointHandling)}`);
  }
  if (!strokePointHandling.appendedPointHit || !strokePointHandling.expandedBoundaryHit || strokePointHandling.emptyStrokeHit) {
    throw new Error(`Eraser bounds rejected reachable ink: ${JSON.stringify(strokePointHandling)}`);
  }
  if (!strokePointHandling.eraserMissReusedInput || !strokePointHandling.emptyEraserReusedInput
    || !strokePointHandling.eraserHitPreservedIdentities
    || JSON.stringify(strokePointHandling.eraserHitIds) !== JSON.stringify(["keep-first", "keep-last"])) {
    throw new Error(`Eraser allocation optimization changed removal behavior: ${JSON.stringify(strokePointHandling)}`);
  }
  if (strokePointHandling.offscreenDrawCalls !== 0 || strokePointHandling.visibleDrawCalls < 1) {
    throw new Error(`Viewport culling did not skip only offscreen strokes: ${JSON.stringify(strokePointHandling)}`);
  }
  if (strokePointHandling.cachedPathAllocations.allocationsAfterFirstDraw < 1
    || strokePointHandling.cachedPathAllocations.allocationsAfterCachedDraw !== strokePointHandling.cachedPathAllocations.allocationsAfterFirstDraw
    || strokePointHandling.cachedPathAllocations.allocationsAfterInvalidation <= strokePointHandling.cachedPathAllocations.allocationsAfterCachedDraw) {
    throw new Error(`Stroke render paths were not cached and invalidated correctly: ${JSON.stringify(strokePointHandling)}`);
  }
  if (!(strokePointHandling.thickInk > strokePointHandling.thinInk)) {
    throw new Error(`Pressure did not change rendered stroke width: ${JSON.stringify(strokePointHandling)}`);
  }
  if (!strokePointHandling.endpointInk) throw new Error("Stroke rendering did not reach the final point.");

  const historyEstimateCache = await page.evaluate(async () => {
    const { estimatedBoardBytes } = await import("/src/App.tsx");
    const strokes = [{ id: "stroke", color: "#111", width: 4, pointerType: "pen", points: [{ x: 0, y: 0, pressure: 0.5 }] }];
    let strokeReads = 0;
    const board = {
      version: 1,
      id: "history-cache",
      title: "History cache",
      theme: "white",
      grid: true,
      get strokes() {
        strokeReads += 1;
        return strokes;
      },
      textObjects: [],
      imageObjects: [],
      updatedAt: new Date().toISOString(),
    };
    const first = estimatedBoardBytes(board);
    const readsAfterFirst = strokeReads;
    const second = estimatedBoardBytes(board);
    return { first, second, readsAfterFirst, readsAfterSecond: strokeReads };
  });
  if (historyEstimateCache.first !== historyEstimateCache.second
    || historyEstimateCache.readsAfterFirst < 1
    || historyEstimateCache.readsAfterSecond !== historyEstimateCache.readsAfterFirst) {
    throw new Error(`History size estimates rescanned immutable snapshots: ${JSON.stringify(historyEstimateCache)}`);
  }

  const inspectedImages = await page.evaluate(async () => {
    const { inspectImageFile } = await import("/src/image.ts");
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
    new DataView(png.buffer).setUint32(16, 640);
    new DataView(png.buffer).setUint32(20, 480);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0, 7, 8, 1, 0xe0, 2, 0x80, 0xff, 0xd9]);
    const webp = new Uint8Array(30);
    webp.set([..."RIFF"].map((value) => value.charCodeAt(0)), 0);
    webp.set([..."WEBPVP8X"].map((value) => value.charCodeAt(0)), 8);
    new DataView(webp.buffer).setUint32(16, 10, true);
    webp.set([0x7f, 0x02, 0, 0x67, 0x01, 0], 24);
    let oversizedRejected = false;
    const oversized = png.slice();
    new DataView(oversized.buffer).setUint32(16, 8192);
    new DataView(oversized.buffer).setUint32(20, 8192);
    try {
      inspectImageFile(oversized);
    } catch {
      oversizedRejected = true;
    }
    let malformedRejected = false;
    try {
      inspectImageFile(new Uint8Array([1, 2, 3, 4]));
    } catch {
      malformedRejected = true;
    }
    return {
      png: inspectImageFile(png),
      jpeg: inspectImageFile(jpeg),
      webp: inspectImageFile(webp),
      oversizedRejected,
      malformedRejected,
    };
  });
  if (inspectedImages.png.mime !== "image/png" || inspectedImages.png.width !== 640 || inspectedImages.png.height !== 480) {
    throw new Error(`PNG dimensions were not inspected correctly: ${JSON.stringify(inspectedImages.png)}`);
  }
  if (inspectedImages.jpeg.mime !== "image/jpeg" || inspectedImages.jpeg.width !== 640 || inspectedImages.jpeg.height !== 480) {
    throw new Error(`JPEG dimensions were not inspected correctly: ${JSON.stringify(inspectedImages.jpeg)}`);
  }
  if (inspectedImages.webp.mime !== "image/webp" || inspectedImages.webp.width !== 640 || inspectedImages.webp.height !== 360) {
    throw new Error(`WebP dimensions were not inspected correctly: ${JSON.stringify(inspectedImages.webp)}`);
  }
  if (!inspectedImages.oversizedRejected || !inspectedImages.malformedRejected) {
    throw new Error(`Unsafe image headers were accepted: ${JSON.stringify(inspectedImages)}`);
  }

  const embeddedImageLifetime = await page.evaluate(async () => {
    const { prepareEmbeddedImage } = await import("/src/App.tsx");
    const sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = 2;
    sourceCanvas.height = 2;
    const blob = await new Promise((resolve) => sourceCanvas.toBlob(resolve, "image/png"));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const originalCreate = URL.createObjectURL.bind(URL);
    const originalRevoke = URL.revokeObjectURL.bind(URL);
    const created = [];
    const revoked = [];
    URL.createObjectURL = (value) => {
      const url = originalCreate(value);
      created.push(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      revoked.push(url);
      originalRevoke(url);
    };
    try {
      const image = await prepareEmbeddedImage(bytes, "image/png", { width: 2, height: 2 });
      return { created, revoked, dataUrl: image.dataUrl, width: image.width, height: image.height };
    } finally {
      URL.createObjectURL = originalCreate;
      URL.revokeObjectURL = originalRevoke;
    }
  });
  if (embeddedImageLifetime.created.length !== 1
    || embeddedImageLifetime.revoked[0] !== embeddedImageLifetime.created[0]
    || !embeddedImageLifetime.dataUrl.startsWith("data:image/png;base64,")
    || embeddedImageLifetime.width !== 2
    || embeddedImageLifetime.height !== 2) {
    throw new Error(`Embedded image temporary resources were not released: ${JSON.stringify(embeddedImageLifetime)}`);
  }

  const initialTitle = await page.getByLabel("Board title").inputValue();
  if (!/^Whiteboard \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}$/.test(initialTitle)) {
    throw new Error(`Default board title does not contain the local date and time: ${initialTitle}`);
  }
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    window.__whiteboardOriginalStorageSetItem = Storage.prototype.setItem;
    window.__whiteboardBoardWrites = 0;
    window.__whiteboardTitleInputs = 0;
    document.querySelector('[aria-label="Board title"]')?.addEventListener("input", () => {
      window.__whiteboardTitleInputs += 1;
    });
    Storage.prototype.setItem = function (key, value) {
      if (this === localStorage && key === "whiteboard.document.v1") window.__whiteboardBoardWrites += 1;
      return window.__whiteboardOriginalStorageSetItem.call(this, key, value);
    };
  });
  const titleInput = page.getByLabel("Board title");
  const autosaveInputStarted = Date.now();
  await titleInput.fill("");
  await titleInput.pressSequentially("Coalesced save");
  const autosaveInputElapsed = Date.now() - autosaveInputStarted;
  const autosaveInputCounts = await page.evaluate(() => ({
    inputs: window.__whiteboardTitleInputs,
    writes: window.__whiteboardBoardWrites,
  }));
  const allowedThrottledWrites = Math.ceil(autosaveInputElapsed / 100) + 1;
  if (autosaveInputCounts.inputs < 10 || autosaveInputCounts.writes > allowedThrottledWrites
    || autosaveInputCounts.writes >= autosaveInputCounts.inputs) {
    throw new Error(`Board autosave did not coalesce rapid input: ${JSON.stringify({ ...autosaveInputCounts, autosaveInputElapsed, allowedThrottledWrites })}`);
  }
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("whiteboard.document.v1")).title === "Coalesced save");
  await page.evaluate(() => {
    Storage.prototype.setItem = window.__whiteboardOriginalStorageSetItem;
    delete window.__whiteboardOriginalStorageSetItem;
    delete window.__whiteboardBoardWrites;
    delete window.__whiteboardTitleInputs;
  });
  const canvas = page.locator("canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Canvas did not render.");

  await page.evaluate(() => {
    window.__whiteboardOriginalToBlob = HTMLCanvasElement.prototype.toBlob;
    window.__whiteboardOriginalToDataURL = HTMLCanvasElement.prototype.toDataURL;
    window.__whiteboardExportBlobCalls = 0;
    window.__whiteboardExportWrites = 0;
    window.__whiteboardExportBytes = 0;
    window.__whiteboardExportNameHeader = "";
    HTMLCanvasElement.prototype.toDataURL = () => {
      throw new Error("PNG export used a base64 data URL.");
    };
    HTMLCanvasElement.prototype.toBlob = function (callback, type) {
      window.__whiteboardExportBlobCalls += 1;
      const png = new Uint8Array(45);
      png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const view = new DataView(png.buffer);
      view.setUint32(8, 13);
      png.set([0x49, 0x48, 0x44, 0x52], 12);
      view.setUint32(16, 1);
      view.setUint32(20, 1);
      png.set([8, 6, 0, 0, 0], 24);
      png.set([0x49, 0x45, 0x4e, 0x44], 37);
      callback(new Blob([png], { type: type ?? "image/png" }));
    };
    window.__TAURI_INTERNALS__ = {
      invoke: async (command, args, options) => {
        if (command === "save_external_png_dialog") {
          window.__whiteboardExportWrites += 1;
          window.__whiteboardExportBytes = args instanceof Uint8Array ? args.byteLength : -1;
          window.__whiteboardExportNameHeader = options?.headers?.["default-name-hex"] ?? "";
          return true;
        }
        throw new Error(`Unexpected export command: ${command}`);
      },
    };
  });
  await page.getByRole("button", { name: "Export PNG" }).click();
  await page.waitForFunction(() => window.__whiteboardExportWrites === 1);
  const exportEncoding = await page.evaluate(() => ({
    blobCalls: window.__whiteboardExportBlobCalls,
    writes: window.__whiteboardExportWrites,
    bytes: window.__whiteboardExportBytes,
    nameHeader: window.__whiteboardExportNameHeader,
  }));
  const expectedNameHeader = Buffer.from("Coalesced save.png", "utf8").toString("hex");
  if (exportEncoding.blobCalls !== 1 || exportEncoding.writes !== 1 || exportEncoding.bytes !== 45
    || exportEncoding.nameHeader !== expectedNameHeader) {
    throw new Error(`PNG export did not use one binary encoding pass: ${JSON.stringify(exportEncoding)}`);
  }
  await page.evaluate(() => {
    HTMLCanvasElement.prototype.toBlob = window.__whiteboardOriginalToBlob;
    HTMLCanvasElement.prototype.toDataURL = window.__whiteboardOriginalToDataURL;
    delete window.__whiteboardOriginalToBlob;
    delete window.__whiteboardOriginalToDataURL;
    delete window.__whiteboardExportBlobCalls;
    delete window.__whiteboardExportWrites;
    delete window.__whiteboardExportBytes;
    delete window.__whiteboardExportNameHeader;
    delete window.__TAURI_INTERNALS__;
  });

  await page.evaluate(() => {
    window.__whiteboardOriginalStructuredClone = window.structuredClone;
    window.__whiteboardStructuredCloneCalls = 0;
    window.structuredClone = (...args) => {
      window.__whiteboardStructuredCloneCalls += 1;
      return window.__whiteboardOriginalStructuredClone(...args);
    };
  });

  await page.mouse.move(box.x + 180, box.y + 180);
  await page.mouse.down();
  await page.mouse.move(box.x + 230, box.y + 220, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(500);

  const strokeCount = await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.document.v1")).strokes.length);
  if (strokeCount !== 1) throw new Error(`Expected 1 saved stroke, found ${strokeCount}.`);
  const historyCloneCalls = await page.evaluate(() => {
    const calls = window.__whiteboardStructuredCloneCalls;
    window.structuredClone = window.__whiteboardOriginalStructuredClone;
    delete window.__whiteboardOriginalStructuredClone;
    delete window.__whiteboardStructuredCloneCalls;
    return calls;
  });
  if (historyCloneCalls !== 0) throw new Error(`History deep-cloned the board ${historyCloneCalls} time(s).`);

  const initialScale = Number(await canvas.getAttribute("data-scale"));
  const viewXBeforeWheel = Number(await canvas.getAttribute("data-view-x"));
  const viewYBeforeWheel = Number(await canvas.getAttribute("data-view-y"));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -80);
  await page.waitForTimeout(50);
  const zoomedScale = Number(await canvas.getAttribute("data-scale"));
  if (!(zoomedScale > initialScale)) throw new Error("Wheel did not zoom at the cursor.");
  if (Number(await canvas.getAttribute("data-view-x")) === viewXBeforeWheel || Number(await canvas.getAttribute("data-view-y")) === viewYBeforeWheel) {
    throw new Error("Cursor-centered wheel zoom did not preserve its focal point.");
  }

  const viewXBeforePan = Number(await canvas.getAttribute("data-view-x"));
  await page.mouse.move(box.x + 420, box.y + 280);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(box.x + 470, box.y + 310, { steps: 4 });
  await page.mouse.up({ button: "middle" });
  const viewXAfterPan = Number(await canvas.getAttribute("data-view-x"));
  if (viewXAfterPan === viewXBeforePan) throw new Error("Middle-button drag did not pan the board.");

  const strokesBeforeLostCapture = Number(await canvas.getAttribute("data-stroke-count"));
  const viewBeforeLostCapture = Number(await canvas.getAttribute("data-view-x"));
  await page.mouse.move(box.x + 420, box.y + 280);
  await page.mouse.down({ button: "middle" });
  await canvas.dispatchEvent("lostpointercapture", { pointerId: 1, pointerType: "mouse", bubbles: true });
  await page.mouse.move(box.x + 470, box.y + 310, { steps: 4 });
  await page.mouse.up({ button: "middle" });
  if (Number(await canvas.getAttribute("data-view-x")) !== viewBeforeLostCapture) {
    throw new Error("Lost pointer capture left middle-button pan active.");
  }
  await page.mouse.move(box.x + 360, box.y + 240);
  await page.mouse.down();
  await page.mouse.move(box.x + 400, box.y + 270, { steps: 4 });
  await page.mouse.up();
  if (Number(await canvas.getAttribute("data-stroke-count")) !== strokesBeforeLostCapture + 1) {
    throw new Error("Lost middle-button capture blocked later drawing.");
  }

  await page.keyboard.press("a");
  if ((await page.getByRole("button", { name: "Select (A)" }).getAttribute("aria-pressed")) !== "true") throw new Error("A did not select the select tool.");
  await page.keyboard.press("s");
  if ((await page.getByRole("button", { name: "Pan (S)" }).getAttribute("aria-pressed")) !== "true") throw new Error("S did not select the pan tool.");
  await page.keyboard.press("d");
  if ((await page.getByRole("button", { name: "Text (D)" }).getAttribute("aria-pressed")) !== "true") throw new Error("D did not select the text tool.");
  await page.keyboard.press("Shift");
  if ((await page.getByRole("button", { name: "Eraser (Shift)" }).getAttribute("aria-pressed")) !== "true") throw new Error("Shift did not select the eraser tool.");
  const sizeField = page.getByLabel("Brush size");
  await sizeField.fill("12");
  if (await sizeField.inputValue() !== "12") throw new Error("Brush size cannot be entered directly.");
  await page.waitForTimeout(50);
  if (JSON.parse(await page.evaluate(() => localStorage.getItem("whiteboard.ui.v1"))).width !== 12) throw new Error("Brush size did not update immediately.");
  const strokesBeforeSizeBinding = Number(await canvas.getAttribute("data-stroke-count"));
  await page.mouse.move(box.x + 300, box.y + 300);
  await page.keyboard.down("z");
  await page.mouse.move(box.x + 330, box.y + 330, { steps: 3 });
  await page.keyboard.up("z");
  await page.waitForTimeout(500);
  const sizedStroke = await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.document.v1")).strokes.at(-1));
  if (Number(await canvas.getAttribute("data-stroke-count")) !== strokesBeforeSizeBinding + 1 || sizedStroke.width !== 12) {
    throw new Error(`Z did not draw with the selected brush size: ${JSON.stringify({ before: strokesBeforeSizeBinding, after: Number(await canvas.getAttribute("data-stroke-count")), width: sizedStroke?.width })}`);
  }

  await page.getByRole("button", { name: "Reset zoom to 100%" }).click();
  await page.mouse.move(box.x + 165, box.y + 165);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(box.x + 245, box.y + 235, { steps: 5 });
  await page.mouse.up({ button: "right" });
  if (Number(await canvas.getAttribute("data-selected-count")) < 1) throw new Error("Right-button drag did not select ink.");

  const gridButton = page.getByRole("button", { name: "Hide grid" });
  await gridButton.click();
  if ((await page.getByRole("button", { name: "Show grid" }).getAttribute("aria-pressed")) !== "false") {
    throw new Error("Grid toggle did not update its persisted state.");
  }
  await page.getByRole("button", { name: "Show grid" }).click();

  const strokesBeforeKeyboardUndo = Number(await canvas.getAttribute("data-stroke-count"));
  await page.keyboard.press("Control+z");
  await page.waitForFunction((expected) => Number(document.querySelector("canvas")?.dataset.strokeCount) === expected, strokesBeforeKeyboardUndo - 1);
  await page.keyboard.press("Control+y");
  await page.waitForFunction((expected) => Number(document.querySelector("canvas")?.dataset.strokeCount) === expected, strokesBeforeKeyboardUndo);
  await page.keyboard.press("Control+z");
  await page.waitForFunction((expected) => Number(document.querySelector("canvas")?.dataset.strokeCount) === expected, strokesBeforeKeyboardUndo - 1);
  await page.getByRole("button", { name: "Hide grid" }).click();
  await page.keyboard.press("Control+y");
  await page.waitForTimeout(50);
  if (Number(await canvas.getAttribute("data-stroke-count")) !== strokesBeforeKeyboardUndo - 1) throw new Error("Redo was not cleared after a newer board change.");
  await page.getByRole("button", { name: "Show grid" }).click();

  await page.getByRole("button", { name: "Blackboard" }).click();
  if (!(await page.locator("main").getAttribute("class"))?.includes("theme-black")) {
    throw new Error("Blackboard theme did not activate.");
  }
  await page.getByRole("button", { name: "Ink color #356f9f" }).click();
  await page.getByRole("button", { name: "New board" }).click();
  if (!(await page.locator("main").getAttribute("class"))?.includes("theme-black")) throw new Error("New board did not keep the blackboard theme.");
  if ((await page.getByRole("button", { name: "Pen (P)" }).getAttribute("aria-pressed")) !== "true") throw new Error("New board did not keep the pen tool.");
  if ((await page.getByRole("button", { name: "Ink color #356f9f" }).getAttribute("aria-pressed")) !== "true") throw new Error("New board did not keep the pen color.");
  if (!(await page.getByRole("button", { name: "Hide grid" }).isVisible())) throw new Error("New board did not keep the grid setting.");
  await page.locator(".tool-group").hover();
  await page.mouse.wheel(0, 40);
  await page.waitForFunction(() => document.querySelector('[aria-label="Eraser (Shift)"]')?.getAttribute("aria-pressed") === "true");
  await page.mouse.wheel(0, -40);
  await page.waitForFunction(() => document.querySelector('[aria-label="Pen (P)"]')?.getAttribute("aria-pressed") === "true");

  await page.getByRole("button", { name: "Recognition settings" }).click();
  await page.getByRole("dialog", { name: "Model recognition" }).waitFor();
  const blackboardSelectStyle = await page.getByLabel("Sample type").evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.color, background: style.backgroundColor, colorScheme: style.colorScheme };
  });
  if (blackboardSelectStyle.colorScheme !== "dark" || blackboardSelectStyle.color !== "rgb(241, 242, 239)" || blackboardSelectStyle.background !== "rgb(32, 35, 36)") {
    throw new Error(`Blackboard dropdown colors are incorrect: ${JSON.stringify(blackboardSelectStyle)}`);
  }
  if (await page.locator(".tool-dock").evaluate((element) => getComputedStyle(element).boxShadow) !== "none") throw new Error("Tool dock still has an excessive shadow.");
  if (!(await page.getByRole("button", { name: "Use my handwriting" }).isDisabled())) throw new Error("Experimental handwriting should remain locked before five samples per lowercase letter.");
  await page.getByLabel("Middle mouse key").focus();
  await page.keyboard.press("Shift");
  await page.getByLabel("Left mouse key").focus();
  await page.keyboard.press("a");
  await page.keyboard.press("b");
  await page.getByRole("button", { name: "Close settings" }).click();

  const viewXBeforeBoundPan = Number(await canvas.getAttribute("data-view-x"));
  await page.mouse.move(box.x + 450, box.y + 300);
  await page.keyboard.down("Shift");
  await page.mouse.move(box.x + 485, box.y + 300, { steps: 4 });
  await page.keyboard.up("Shift");
  if (Number(await canvas.getAttribute("data-view-x")) === viewXBeforeBoundPan) throw new Error("Bound pan key did not act like a mouse button.");

  const strokesBeforeBoundLeft = Number(await canvas.getAttribute("data-stroke-count"));
  await page.mouse.move(box.x + 520, box.y + 330);
  await page.keyboard.down("a");
  await page.mouse.move(box.x + 590, box.y + 390, { steps: 8 });
  await page.keyboard.up("a");
  const strokesAfterBoundLeft = Number(await canvas.getAttribute("data-stroke-count"));
  if (strokesAfterBoundLeft !== strokesBeforeBoundLeft + 1) throw new Error("Bound left-mouse key did not use the current pen tool.");

  await page.mouse.move(box.x + 500, box.y + 310);
  await page.keyboard.down("x");
  await page.mouse.move(box.x + 610, box.y + 410, { steps: 6 });
  await page.keyboard.up("x");
  if (Number(await canvas.getAttribute("data-selected-count")) < 1) throw new Error("Bound right-mouse key did not select ink.");

  await page.getByRole("button", { name: "Handwriting practice" }).click();
  const practice = page.getByRole("complementary", { name: "Handwriting practice" });
  await practice.waitFor();
  await practice.getByLabel("Exercise").selectOption("digits");
  await practice.getByText("0", { exact: true }).first().waitFor();
  const practicePad = practice.getByLabel("Write 0 here");
  const practiceBox = await practicePad.boundingBox();
  if (!practiceBox) throw new Error("Practice writing pad did not render.");
  await page.mouse.move(practiceBox.x + 80, practiceBox.y + 45);
  await page.mouse.down();
  await page.mouse.move(practiceBox.x + 120, practiceBox.y + 130, { steps: 8 });
  await page.mouse.move(practiceBox.x + 70, practiceBox.y + 130, { steps: 5 });
  await page.mouse.move(practiceBox.x + 80, practiceBox.y + 45, { steps: 8 });
  await page.mouse.up();
  if (Number(await practicePad.getAttribute("data-stroke-count")) !== 1) throw new Error("Practice pad did not capture the stroke.");
  await practice.getByRole("button", { name: "Save sample and next" }).click();
  const sampleCount = await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.recognition.v1")).samples.length);
  if (sampleCount !== 1) throw new Error(`Expected 1 practice sample, found ${sampleCount}.`);
  await practice.getByRole("button", { name: "Close practice" }).click();

  await page.reload({ waitUntil: "networkidle" });
  await page.getByLabel("Starting Whiteboard").waitFor({ state: "detached" });
  const restoredBindings = await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.input.v1")));
  if (!restoredBindings.leftKeys.includes("a") || !restoredBindings.leftKeys.includes("b") || !restoredBindings.middleKeys.includes("Shift") || !restoredBindings.rightKeys.includes("x")) {
    throw new Error(`Mouse-key bindings did not persist: ${JSON.stringify(restoredBindings)}`);
  }
  if (!(await page.locator("main").getAttribute("class"))?.includes("theme-black")) throw new Error("Blackboard preference did not persist after restart.");
  if ((await page.getByRole("button", { name: "Ink color #356f9f" }).getAttribute("aria-pressed")) !== "true") throw new Error("Pen color preference did not persist after restart.");
  await page.getByRole("button", { name: "Handwriting practice" }).click();
  const restoredPractice = page.getByRole("complementary", { name: "Handwriting practice" });
  await restoredPractice.getByLabel("Exercise").selectOption("digits");
  if (!(await restoredPractice.getByRole("button", { name: "0: 1 samples" }).isVisible())) {
    throw new Error("Practice sample did not persist after reload.");
  }
  await restoredPractice.getByRole("button", { name: "Close practice" }).click();

  const strokesBeforePad = Number(await page.locator("canvas").first().getAttribute("data-stroke-count"));
  await page.getByRole("button", { name: "Lock cursor (M)" }).click();
  await page.getByText("Cursor locked - hold left click to draw, press M or Esc to release").waitFor();
  await page.mouse.move(box.x + 400, box.y + 300);
  await page.mouse.move(box.x + 430, box.y + 330, { steps: 4 });
  if (Number(await page.locator("canvas").first().getAttribute("data-stroke-count")) !== strokesBeforePad) throw new Error("Locked cursor drew without a left click.");
  await page.mouse.down();
  await page.mouse.move(box.x + 470, box.y + 360, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.press("m");
  await page.getByText("Cursor locked - hold left click to draw, press M or Esc to release").waitFor({ state: "detached" });
  const strokesAfterPad = Number(await page.locator("canvas").first().getAttribute("data-stroke-count"));
  if (strokesAfterPad !== strokesBeforePad + 1) throw new Error("Locked cursor did not add one left-click stroke.");

  await page.getByRole("button", { name: "Save to Board Library" }).click();

  await page.getByRole("button", { name: "Text (D)" }).click();
  await page.mouse.click(box.x + 520, box.y + 210);
  const textEditor = page.getByRole("dialog", { name: "Add text" });
  await textEditor.getByLabel("Text content").fill("Typed note");
  await textEditor.getByRole("button", { name: "Insert text" }).click();
  const textCount = Number(await page.locator("canvas").first().getAttribute("data-text-count"));
  if (textCount !== 1) throw new Error("Text tool did not add a text box.");

  await page.mouse.move(box.x + 500, box.y + 190);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(box.x + 620, box.y + 260, { steps: 5 });
  await page.mouse.up({ button: "right" });
  const transformBox = page.locator(".selection-transform-box");
  const transformBounds = await transformBox.boundingBox();
  if (!transformBounds) throw new Error("Selected text did not show transform controls.");
  await page.mouse.move(transformBounds.x + transformBounds.width / 2, transformBounds.y + transformBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(transformBounds.x + transformBounds.width / 2 + 30, transformBounds.y + transformBounds.height / 2 + 20, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const movedText = await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.document.v1")).textObjects[0]);
  if (Math.abs(movedText.x - 550) > 1 || Math.abs(movedText.y - 230) > 1) {
    throw new Error(`Dragging the selection did not commit the final pointer position: ${movedText.x},${movedText.y}`);
  }
  const cancelBounds = await transformBox.boundingBox();
  if (!cancelBounds) throw new Error("Selection controls disappeared before cancellation test.");
  await page.mouse.move(cancelBounds.x + cancelBounds.width / 2, cancelBounds.y + cancelBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(cancelBounds.x + cancelBounds.width / 2 + 25, cancelBounds.y + cancelBounds.height / 2 + 15, { steps: 3 });
  await transformBox.dispatchEvent("pointercancel", { pointerId: 1, bubbles: true });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const cancelledText = await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.document.v1")).textObjects[0]);
  if (cancelledText.x !== movedText.x || cancelledText.y !== movedText.y) throw new Error("A cancelled selection move was committed.");
  const resizeHandle = page.getByRole("button", { name: "Resize selection" });
  const resizeBounds = await resizeHandle.boundingBox();
  if (!resizeBounds) throw new Error("Selection resize handle did not render.");
  await page.mouse.move(resizeBounds.x + 4, resizeBounds.y + 4);
  await page.mouse.down();
  await page.mouse.move(resizeBounds.x + 44, resizeBounds.y + 34, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const resizedText = await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.document.v1")).textObjects[0]);
  if (!(resizedText.fontSize > 20)) throw new Error("Resizing the selection did not scale text.");
  await page.getByRole("button", { name: "Undo (Ctrl+Z)" }).click();
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("whiteboard.document.v1")).textObjects[0]?.fontSize === 20);
  await page.getByRole("button", { name: "Redo (Ctrl+Y)" }).click();
  await page.waitForFunction((fontSize) => JSON.parse(localStorage.getItem("whiteboard.document.v1")).textObjects[0]?.fontSize === fontSize, resizedText.fontSize);
  await page.mouse.move(box.x + 500, box.y + 190);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(box.x + 700, box.y + 340, { steps: 5 });
  await page.mouse.up({ button: "right" });
  await page.getByRole("button", { name: "Delete selection (Delete)" }).click();
  if (Number(await page.locator("canvas").first().getAttribute("data-text-count")) !== 0) throw new Error("Delete selection button did not remove selected text.");
  await page.getByRole("button", { name: "Undo (Ctrl+Z)" }).click();
  if (Number(await page.locator("canvas").first().getAttribute("data-text-count")) !== 1) throw new Error("Undo button did not restore deleted text.");
  await page.getByRole("button", { name: "Redo (Ctrl+Y)" }).click();
  if (Number(await page.locator("canvas").first().getAttribute("data-text-count")) !== 0) throw new Error("Redo button did not reapply text deletion.");

  const latexChunkPattern = /\/(?:src\/LatexMarkup\.tsx|assets\/LatexMarkup-[^/]+\.js)(?:$|\?)/;
  const latexLoadedBeforeUse = await page.evaluate((pattern) => performance.getEntriesByType("resource").some((entry) => new RegExp(pattern).test(entry.name)), latexChunkPattern.source);
  if (latexLoadedBeforeUse) throw new Error("LaTeX renderer was loaded before the LaTeX feature was used.");
  await page.getByRole("button", { name: "Insert LaTeX" }).click();
  const latexEditor = page.getByRole("dialog", { name: "Add LaTeX" });
  await latexEditor.getByLabel("LaTeX source").fill(String.raw`x^2 + y^2`);
  await latexEditor.getByLabel("LaTeX preview").locator(".katex").waitFor();
  const latexLoadedAfterUse = await page.evaluate((pattern) => performance.getEntriesByType("resource").some((entry) => new RegExp(pattern).test(entry.name)), latexChunkPattern.source);
  if (!latexLoadedAfterUse) throw new Error("LaTeX renderer chunk did not load after the LaTeX feature was used.");
  await latexEditor.getByRole("button", { name: "Insert LaTeX" }).click();
  await page.waitForFunction(() => document.querySelector("canvas")?.getAttribute("data-text-count") === "1");
  await page.waitForFunction(() => JSON.parse(localStorage.getItem("whiteboard.document.v1")).textObjects.at(-1)?.kind === "latex");
  const latexKind = await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.document.v1")).textObjects.at(-1)?.kind);
  if (latexKind !== "latex") throw new Error("LaTeX insertion did not persist a LaTeX text object.");
  await page.locator(".latex-board-object .katex").waitFor();

  await page.getByRole("button", { name: "Clear screen" }).click();
  const clearMenu = page.getByRole("dialog", { name: "Clear content" });
  await clearMenu.getByRole("button", { name: "Clear visible screen" }).click();
  if (Number(await page.locator("canvas").first().getAttribute("data-text-count")) !== 0) throw new Error("Visible-screen clearing did not remove visible text.");
  await page.getByRole("button", { name: "Undo (Ctrl+Z)" }).click();
  if (Number(await page.locator("canvas").first().getAttribute("data-text-count")) !== 1) throw new Error("Visible-screen clearing was not undoable.");

  await page.waitForTimeout(150);
  await page.evaluate(() => {
    const source = document.createElement("canvas");
    source.width = 1;
    source.height = 1;
    const sourceContext = source.getContext("2d");
    sourceContext.fillStyle = "#0000ff";
    sourceContext.fillRect(0, 0, 1, 1);
    const board = JSON.parse(localStorage.getItem("whiteboard.document.v1"));
    board.imageObjects.push({
      id: crypto.randomUUID(),
      x: 300,
      y: 300,
      width: 50,
      height: 50,
      dataUrl: source.toDataURL("image/png"),
    });
    localStorage.setItem("whiteboard.document.v1", JSON.stringify(board));
    const glyphCanvas = document.createElement("canvas");
    glyphCanvas.width = 8;
    glyphCanvas.height = 8;
    const glyphContext = glyphCanvas.getContext("2d");
    glyphContext.fillStyle = "#ffffff";
    glyphContext.fillRect(0, 0, 8, 8);
    glyphContext.fillStyle = "#000000";
    glyphContext.fillRect(2, 1, 4, 6);
    const glyphImage = glyphCanvas.toDataURL("image/png").split(",")[1];
    const recognitionSettings = JSON.parse(localStorage.getItem("whiteboard.recognition.v1"));
    for (const letter of "abcdefghijklmnopqrstuvwxyz") {
      for (let copy = 0; copy < 5; copy += 1) recognitionSettings.samples.push({
        id: crypto.randomUUID(), label: letter, image: glyphImage, exercise: "lowercase", mode: "text", createdAt: new Date().toISOString(),
      });
    }
    localStorage.setItem("whiteboard.recognition.v1", JSON.stringify(recognitionSettings));
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.getByLabel("Starting Whiteboard").waitFor({ state: "detached" });
  const restoredCanvas = page.locator("canvas").first();
  if (Number(await restoredCanvas.getAttribute("data-image-count")) !== 1) throw new Error("Embedded image did not survive board reload.");
  await page.waitForTimeout(100);
  const imagePixelIsBlue = await restoredCanvas.evaluate((element) => {
    const canvas = element;
    const context = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const pixel = context.getImageData(320 * dpr, 320 * dpr, 1, 1).data;
    return pixel[2] > 200 && pixel[0] < 60;
  });
  if (!imagePixelIsBlue) throw new Error("Embedded image was not rendered on the canvas.");
  const restoredBox = await restoredCanvas.boundingBox();
  if (!restoredBox) throw new Error("Restored canvas did not render.");
  await page.mouse.move(restoredBox.x + 290, restoredBox.y + 290);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(restoredBox.x + 360, restoredBox.y + 360, { steps: 5 });
  await page.mouse.up({ button: "right" });
  await page.keyboard.press("Delete");
  if (Number(await restoredCanvas.getAttribute("data-image-count")) !== 0) throw new Error("Delete key did not remove the selected image.");

  await page.getByRole("button", { name: "Clear screen" }).click();
  const entireBoardClear = page.getByRole("dialog", { name: "Clear content" });
  await entireBoardClear.getByRole("button", { name: "Entire board" }).click();
  await entireBoardClear.getByRole("button", { name: "Clear entire board" }).click();
  await page.waitForTimeout(150);
  const clearedBoard = await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.document.v1")));
  if (clearedBoard.strokes.length || clearedBoard.textObjects.length || clearedBoard.imageObjects.length) throw new Error("Entire-board clearing left content behind.");
  await page.getByRole("button", { name: "Undo (Ctrl+Z)" }).click();

  await page.getByRole("button", { name: "Board Library", exact: true }).click();
  await page.getByRole("dialog", { name: "Board Library" }).waitFor();
  await page.getByText("available in the installed Tauri app").waitFor();
  await page.getByRole("button", { name: "Close Board Library" }).click();

  await page.getByRole("button", { name: "Recognition settings" }).click();
  const handwritingToggle = page.getByRole("button", { name: "Use my handwriting" });
  if (await handwritingToggle.isDisabled()) throw new Error("Experimental handwriting did not unlock after five guided samples per lowercase letter.");
  await handwritingToggle.click();
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.getByRole("button", { name: "Text (D)" }).click();
  await page.mouse.click(restoredBox.x + 420, restoredBox.y + 180);
  const handwritingEditor = page.getByRole("dialog", { name: "Add text" });
  await handwritingEditor.getByLabel("Text content").fill("abc");
  await handwritingEditor.getByRole("button", { name: "Insert text" }).click();
  await page.locator(".handwriting-glyph").first().waitFor();
  if (await page.locator(".handwriting-glyph").count() < 3) throw new Error("Experimental handwriting renderer did not use sampled lowercase glyphs.");
  await page.getByRole("button", { name: "Recognition settings" }).click();
  await page.getByRole("button", { name: "Use system font" }).click();
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.waitForFunction(() => !document.querySelector(".handwriting-glyph"));
  await page.getByRole("button", { name: "Recognition settings" }).click();
  await page.getByRole("button", { name: "Use my handwriting" }).click();
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.locator(".handwriting-glyph").first().waitFor();

  await page.evaluate(() => {
    window.__TAURI_INTERNALS__ = {
      invoke: async (command) => command === "recognize_with_nvidia" ? "abc" : [],
    };
  });
  const feedbackBefore = await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.recognition.v1")));
  await page.getByRole("button", { name: "Recognize" }).click();
  const recognitionPanel = page.getByRole("complementary", { name: "Recognition results" });
  await recognitionPanel.getByLabel("Correct the recognized text").waitFor();
  await page.locator(".recognition-highlight").waitFor();
  await recognitionPanel.getByRole("button", { name: "Looks correct" }).click();
  await recognitionPanel.getByText("Verified visual reference saved").waitFor();
  const positiveFeedback = await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.recognition.v1")));
  if (positiveFeedback.samples.length !== feedbackBefore.samples.length + 1 || positiveFeedback.corrections.length !== feedbackBefore.corrections.length) throw new Error("Positive recognition feedback did not save exactly one visual sample.");
  await recognitionPanel.getByRole("button", { name: "Text", exact: true }).click();
  await recognitionPanel.getByLabel("Correct the recognized text").fill("abd");
  await recognitionPanel.getByRole("button", { name: "Save correction" }).click();
  await recognitionPanel.getByText("Correction and visual reference saved").waitFor();
  const correctedFeedback = await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.recognition.v1")));
  if (correctedFeedback.samples.length !== positiveFeedback.samples.length + 1 || correctedFeedback.corrections.length !== positiveFeedback.corrections.length + 1) throw new Error("Corrected recognition did not save one sample and one correction.");
  await recognitionPanel.getByRole("button", { name: "Close recognition" }).click();
  if (await page.locator(".recognition-highlight").count()) throw new Error("Recognition highlight remained after closing the panel.");

  const pasteCanvas = page.locator("canvas").first();
  await page.getByRole("button", { name: "Pen (P)" }).click();
  const pasteBox = await pasteCanvas.boundingBox();
  await page.mouse.click(pasteBox.x + 40, pasteBox.y + 40);
  await page.waitForTimeout(100);
  await page.evaluate(() => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true })));
  await page.waitForTimeout(100);
  const toolAfterPasteShortcut = await pasteCanvas.getAttribute("class");
  if (!toolAfterPasteShortcut.includes("cursor-pen")) throw new Error(`Ctrl+V switched tools instead of leaving the paste shortcut alone: ${toolAfterPasteShortcut}`);
  const sinkFocused = await page.evaluate(() => document.activeElement?.classList.contains("paste-sink"));
  if (!sinkFocused) throw new Error("Canvas interaction did not focus the paste target WebKit needs to deliver paste events.");
  const textsBeforePaste = Number(await pasteCanvas.getAttribute("data-text-count"));
  const imagesBeforePaste = Number(await pasteCanvas.getAttribute("data-image-count"));
  await page.evaluate(() => {
    const transfer = new DataTransfer();
    transfer.setData("text/plain", "pasted note");
    document.activeElement.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true }));
  });
  await page.waitForTimeout(100);
  if (Number(await pasteCanvas.getAttribute("data-text-count")) !== textsBeforePaste + 1) {
    throw new Error("Pasted text did not become a board text object.");
  }
  await page.evaluate(async () => {
    const source = document.createElement("canvas");
    source.width = 4;
    source.height = 4;
    const context = source.getContext("2d");
    context.fillStyle = "#00ff00";
    context.fillRect(0, 0, 4, 4);
    const blob = await new Promise((resolve) => source.toBlob(resolve, "image/png"));
    const transfer = new DataTransfer();
    transfer.items.add(new File([blob], "pasted.png", { type: "image/png" }));
    document.body.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true }));
  });
  await page.waitForTimeout(300);
  if (Number(await pasteCanvas.getAttribute("data-image-count")) !== imagesBeforePaste + 1) {
    throw new Error("Pasted image did not become a board image object.");
  }

  // The toolbar Paste button reads the clipboard directly, the path used when the DOM
  // paste event is unavailable (as in the desktop WebView).
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.evaluate(() => navigator.clipboard.writeText("button pasted note"));
  const textsBeforeButton = Number(await pasteCanvas.getAttribute("data-text-count"));
  await page.getByRole("button", { name: "Paste (Ctrl+V)" }).click();
  await page.waitForTimeout(300);
  if (Number(await pasteCanvas.getAttribute("data-text-count")) !== textsBeforeButton + 1) {
    throw new Error("Paste button did not add a text object from the clipboard.");
  }
  await page.evaluate(async () => {
    const source = document.createElement("canvas");
    source.width = 5;
    source.height = 5;
    const context = source.getContext("2d");
    context.fillStyle = "#3366ff";
    context.fillRect(0, 0, 5, 5);
    const blob = await new Promise((resolve) => source.toBlob(resolve, "image/png"));
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  });
  const imagesBeforeButton = Number(await pasteCanvas.getAttribute("data-image-count"));
  await page.getByRole("button", { name: "Paste (Ctrl+V)" }).click();
  await page.waitForTimeout(400);
  if (Number(await pasteCanvas.getAttribute("data-image-count")) !== imagesBeforeButton + 1) {
    throw new Error("Paste button did not add an image object from the clipboard.");
  }

  await page.setViewportSize({ width: 1280, height: 800 });
  await page.waitForTimeout(100);
  const topbarOverlap = await page.evaluate(() => {
    const status = document.querySelector(".save-state")?.getBoundingClientRect();
    const groups = [...document.querySelectorAll(".topbar-group")].map((group) => group.getBoundingClientRect());
    if (!status) return false;
    return groups.some((group) => group.left < status.right && group.right > status.left);
  });
  if (topbarOverlap) throw new Error("Save status overlaps top-bar controls at an intermediate window width.");

  await page.setViewportSize({ width: 720, height: 600 });
  if (await page.locator(".save-state").isVisible()) throw new Error("Save status should be hidden before it can overlap narrow top-bar controls.");
  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (horizontalOverflow) throw new Error("The app overflows horizontally at the minimum window width.");

  console.log("Smoke test passed: timestamp naming, drawing/autosave, wheel tool cycling and canvas zoom, persistent key bindings and board defaults, undo/redo, move/resize/delete selection controls, visible/entire-board clearing, native text and LaTeX editors, left-click cursor lock, experimental sampled handwriting, embedded images, recognition highlight/positive/corrected feedback, library fallback, and narrow top-bar layout.");
} finally {
  await browser.close();
}
