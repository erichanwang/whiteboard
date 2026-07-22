import { chromium } from "playwright";
import { readFile } from "node:fs/promises";

const [nativeSource, appSource, capabilitySource, packageSource, cargoSource] = await Promise.all([
  readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8"),
  readFile(new URL("../src/App.tsx", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/capabilities/default.json", import.meta.url), "utf8"),
  readFile(new URL("../package.json", import.meta.url), "utf8"),
  readFile(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8"),
]);
const capability = JSON.parse(capabilitySource);
if (nativeSource.includes("try_fs_scope()") || nativeSource.includes("require_dialog_file")
  || /\bpath:\s*String\b/.test(nativeSource.slice(nativeSource.indexOf("fn open_external_board_dialog")))) {
  throw new Error("External file paths can still cross the renderer IPC boundary.");
}
if (!nativeSource.includes("async fn open_external_image_dialog")
  || !nativeSource.includes("tauri::ipc::Response::new(contents)")) {
  throw new Error("External binary reads can still use JSON number arrays.");
}
if (!appSource.includes('invoke<string | null>("open_encrypted_board_dialog"')
  || appSource.includes("Array.from(encryptionRequest")) {
  throw new Error("Encrypted board opening still copies ciphertext through the webview.");
}
const handlerStart = nativeSource.indexOf("tauri::generate_handler![");
const handlerSource = nativeSource.slice(handlerStart, nativeSource.indexOf("])", handlerStart));
if (handlerStart < 0
  || !appSource.includes('invoke<boolean>("save_encrypted_board_dialog"')
  || appSource.includes('invoke<number[]>("encrypt_board"')
  || /\b(?:encrypt_board|decrypt_board)\b/.test(handlerSource)) {
  throw new Error("Encrypted board export still exposes raw cryptography or ciphertext to the webview.");
}
if (!handlerSource.includes("save_external_png_dialog")
  || !nativeSource.includes("tauri::ipc::InvokeBody::Raw(contents)")
  || !appSource.includes('invoke<boolean>("save_external_png_dialog"')
  || appSource.includes("@tauri-apps/plugin-fs")
  || packageSource.includes('"@tauri-apps/plugin-fs"')
  || appSource.includes("@tauri-apps/plugin-dialog")
  || packageSource.includes('"@tauri-apps/plugin-dialog"')
  || nativeSource.includes("tauri_plugin_fs::init()")
  || /^tauri-plugin-fs\s*=/m.test(cargoSource)) {
  throw new Error("PNG export still depends on a general filesystem write command.");
}
const expectedPermissions = [
  "clipboard-manager:allow-read-text",
  "clipboard-manager:allow-read-image",
  "core:image:allow-new",
  "core:image:allow-rgba",
  "core:image:allow-size",
];
if (JSON.stringify(capability.permissions) !== JSON.stringify(expectedPermissions)) {
  throw new Error(`Unexpected Tauri capability surface: ${JSON.stringify(capability.permissions)}`);
}

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const recentBoard = {
  version: 1,
  id: "recent-board",
  title: "Restored native board",
  theme: "black",
  grid: true,
  strokes: [],
  textObjects: [],
  imageObjects: [],
  updatedAt: "2026-07-21T12:00:00.000Z",
};
await context.addInitScript((board) => {
  if (!sessionStorage.getItem("native-test-seeded")) {
    localStorage.clear();
    sessionStorage.clear();
    sessionStorage.setItem("native-test-seeded", "true");
    localStorage.setItem("whiteboard.recent-board.v1", board.id);
    sessionStorage.setItem(`native-board:${board.id}`, JSON.stringify(board));
  }
  const nextRecovery = sessionStorage.getItem("native-next-recovery");
  if (nextRecovery) {
    localStorage.setItem("whiteboard.document.v1", nextRecovery);
    sessionStorage.removeItem("native-next-recovery");
  }
  globalThis.isTauri = true;
  window.__TAURI_INTERNALS__ = {
    invoke: async (command, args) => {
      const calls = JSON.parse(sessionStorage.getItem("native-calls") ?? "[]");
      calls.push({ command, boardId: args?.boardId, offset: args?.offset, defaultName: args?.defaultName, path: args?.path });
      sessionStorage.setItem("native-calls", JSON.stringify(calls));
      if (command === "open_library_board") {
        const board = sessionStorage.getItem(`native-board:${args.boardId}`);
        if (!board) throw new Error("Missing mocked native board");
        return board;
      }
      if (command === "save_library_board") {
        if (sessionStorage.getItem("reject-native-save") === "true") throw new Error("Mocked save failure");
        sessionStorage.setItem(`native-board:${args.boardId}`, args.boardJson);
        return null;
      }
      if (command === "list_library_boards") {
        const offset = args?.offset ?? 0;
        const boards = Array.from({ length: 55 }, (_, index) => ({
          id: `library-${String(index).padStart(2, "0")}`,
          title: `Library board ${index + 1}`,
          updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 55 - index)).toISOString(),
        }));
        return { boards: boards.slice(offset, offset + 50), hasMore: offset + 50 < boards.length };
      }
      if (command === "open_external_board_dialog") return sessionStorage.getItem("external-board") ?? "";
      if (command === "open_encrypted_board_dialog") {
        if (args?.password !== "password123") throw new Error("Wrong mocked password");
        return sessionStorage.getItem("encrypted-board");
      }
      if (command === "save_encrypted_board_dialog") {
        sessionStorage.setItem("saved-encrypted-board", args?.boardJson ?? "");
        return true;
      }
      throw new Error(`Unexpected native command: ${command}`);
    },
  };
}, recentBoard);

const page = await context.newPage();

try {
  await page.goto("http://127.0.0.1:1420", { waitUntil: "networkidle" });
  await page.getByLabel("Starting Whiteboard").waitFor({ state: "detached" });
  await page.getByLabel("Board title").waitFor();
  if (await page.getByLabel("Board title").inputValue() !== recentBoard.title) {
    throw new Error("The recent native board was not restored before startup completed.");
  }
  const restoreCalls = await page.evaluate(() => JSON.parse(sessionStorage.getItem("native-calls") ?? "[]"));
  if (!restoreCalls.some((call) => call.command === "open_library_board" && call.boardId === "recent-board")) {
    throw new Error("Startup did not request the recent native board.");
  }

  await page.waitForTimeout(500);
  await page.evaluate(() => {
    window.__nativeOriginalStorageSetItem = Storage.prototype.setItem;
    window.__nativeBoardStorageWrites = 0;
    Storage.prototype.setItem = function (key, value) {
      if (this === localStorage && key === "whiteboard.document.v1") window.__nativeBoardStorageWrites += 1;
      return window.__nativeOriginalStorageSetItem.call(this, key, value);
    };
  });
  await page.getByLabel("Board title").fill("Native autosave without recovery churn");
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("native-board:recent-board") ?? "null")?.title
    === "Native autosave without recovery churn");
  const successfulNativeRecoveryWrites = await page.evaluate(() => window.__nativeBoardStorageWrites);
  if (successfulNativeRecoveryWrites !== 0) {
    throw new Error(`Successful native autosave wrote ${successfulNativeRecoveryWrites} full recovery copies.`);
  }

  const crashBoard = { ...recentBoard, id: "crash-board", title: "Crash recovery board" };
  await page.evaluate((board) => {
    sessionStorage.setItem("native-calls", "[]");
    sessionStorage.setItem("native-next-recovery", JSON.stringify(board));
    localStorage.setItem("whiteboard.recent-board.v1", "recent-board");
  }, crashBoard);
  await page.reload({ waitUntil: "networkidle" });
  await page.getByLabel("Starting Whiteboard").waitFor({ state: "detached" });
  if (await page.getByLabel("Board title").inputValue() !== crashBoard.title) {
    throw new Error("The crash-recovery board did not take precedence over the recent marker.");
  }
  await page.waitForFunction(() => localStorage.getItem("whiteboard.document.v1") === null
    && localStorage.getItem("whiteboard.recent-board.v1") === "crash-board");
  const crashCalls = await page.evaluate(() => JSON.parse(sessionStorage.getItem("native-calls") ?? "[]"));
  if (crashCalls.some((call) => call.command === "open_library_board")) {
    throw new Error("Startup opened a native board despite having a crash-recovery copy.");
  }

  await page.evaluate((board) => {
    sessionStorage.setItem("reject-native-save", "true");
    sessionStorage.setItem("native-next-recovery", JSON.stringify({ ...board, title: "Unsaved recovery board" }));
  }, crashBoard);
  await page.reload({ waitUntil: "networkidle" });
  await page.getByText("Save failed").waitFor();
  const retainedRecovery = await page.evaluate(() => localStorage.getItem("whiteboard.document.v1"));
  if (!retainedRecovery || JSON.parse(retainedRecovery).title !== "Unsaved recovery board") {
    throw new Error("A failed native save did not retain the full crash-recovery board.");
  }

  const externalBoard = { ...recentBoard, id: "../unsafe-source", title: "Imported without overwrite" };
  await page.evaluate((board) => {
    sessionStorage.setItem("reject-native-save", "false");
    sessionStorage.setItem("native-calls", "[]");
    sessionStorage.setItem("external-board", JSON.stringify(board));
  }, externalBoard);
  await page.getByLabel("Open board").click();
  await page.getByLabel("Board title").waitFor();
  await page.waitForFunction(() => document.querySelector('[aria-label="Board title"]')?.value === "Imported without overwrite");
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("native-calls") ?? "[]")
    .some((call) => call.command === "save_library_board"));
  const importCalls = await page.evaluate(() => JSON.parse(sessionStorage.getItem("native-calls") ?? "[]"));
  if (!importCalls.some((call) => call.command === "open_external_board_dialog")
    || importCalls.some((call) => ["plugin:fs|stat", "plugin:fs|read_file", "plugin:fs|read_text_file", "plugin:fs|write_text_file"].includes(call.command))) {
    throw new Error("Opening a plaintext board bypassed the bounded native reader or modified its source.");
  }
  const importedSave = importCalls.find((call) => call.command === "save_library_board");
  if (!/^[A-Za-z0-9-]{1,80}$/.test(importedSave?.boardId ?? "") || importedSave.boardId === externalBoard.id) {
    throw new Error("An imported filesystem-unsafe board ID was not replaced before native save.");
  }

  await page.evaluate(() => sessionStorage.setItem("native-calls", "[]"));
  await page.getByRole("button", { name: "Encrypted snapshots" }).click();
  await page.getByRole("dialog", { name: "Encrypted snapshots" }).getByRole("button", { name: "Save encrypted snapshot" }).click();
  const encryptDialog = page.getByRole("dialog", { name: "Encrypt board" });
  await encryptDialog.getByLabel("Passphrase", { exact: true }).fill("password123");
  await encryptDialog.getByLabel("Confirm passphrase").fill("password123");
  await encryptDialog.getByRole("button", { name: "Encrypt and save" }).click();
  await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("native-calls") ?? "[]")
    .some((call) => call.command === "save_encrypted_board_dialog"));
  const encryptedSaveCalls = await page.evaluate(() => JSON.parse(sessionStorage.getItem("native-calls") ?? "[]"));
  const encryptedSave = encryptedSaveCalls.find((call) => call.command === "save_encrypted_board_dialog");
  if (encryptedSave?.defaultName !== "Imported without overwrite.whiteboard.enc" || encryptedSave.path !== undefined) {
    throw new Error(`Encrypted save did not keep its destination native-only: ${JSON.stringify(encryptedSave)}`);
  }

  const encryptedBoard = { ...recentBoard, id: "encrypted-import", title: "Opened encrypted snapshot" };
  await page.evaluate((next) => {
    sessionStorage.setItem("native-calls", "[]");
    sessionStorage.setItem("encrypted-board", JSON.stringify(next));
  }, encryptedBoard);
  await page.getByRole("button", { name: "Encrypted snapshots" }).click();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("dialog", { name: "Encrypted snapshots" }).getByRole("button", { name: "Open encrypted snapshot" }).click();
  const unlockDialog = page.getByRole("dialog", { name: "Unlock board" });
  await unlockDialog.getByLabel("Passphrase", { exact: true }).fill("password123");
  await unlockDialog.getByRole("button", { name: "Unlock" }).click();
  await page.waitForFunction(() => document.querySelector('[aria-label="Board title"]')?.value === "Opened encrypted snapshot");
  const encryptedOpenCalls = await page.evaluate(() => JSON.parse(sessionStorage.getItem("native-calls") ?? "[]"));
  if (!encryptedOpenCalls.some((call) => call.command === "open_encrypted_board_dialog" && call.path === undefined)) {
    throw new Error("Encrypted open exposed a filesystem path to the renderer.");
  }

  await page.evaluate(() => sessionStorage.setItem("native-calls", "[]"));
  await page.getByRole("button", { name: "Board Library", exact: true }).click();
  await page.getByRole("dialog", { name: "Board Library" }).waitFor();
  await page.getByText("Page 1", { exact: true }).waitFor();
  const libraryRows = page.locator(".library-list > button");
  if (await libraryRows.count() !== 50) throw new Error("The first Library page did not stay at 50 rows.");
  if (!await page.getByLabel("Newer boards").isDisabled() || await page.getByLabel("Older boards").isDisabled()) {
    throw new Error("The first Library page navigation state is incorrect.");
  }
  const firstPageCalls = await page.evaluate(() => JSON.parse(sessionStorage.getItem("native-calls") ?? "[]"));
  if (!firstPageCalls.some((call) => call.command === "list_library_boards" && call.offset === 0)) {
    throw new Error("The Library did not request its first fixed page.");
  }

  await page.getByLabel("Older boards").click();
  await page.getByText("Page 2", { exact: true }).waitFor();
  if (await libraryRows.count() !== 5 || !await page.getByText("Library board 55", { exact: true }).isVisible()) {
    throw new Error("The older Library page did not show the remaining boards.");
  }
  if (await page.getByLabel("Newer boards").isDisabled() || !await page.getByLabel("Older boards").isDisabled()) {
    throw new Error("The final Library page navigation state is incorrect.");
  }
  await page.getByLabel("Newer boards").click();
  await page.getByText("Page 1", { exact: true }).waitFor();
  if (await libraryRows.count() !== 50) throw new Error("Returning to the newer Library page replaced its fixed size.");
} finally {
  await browser.close();
}

console.log("Native storage tests passed.");
