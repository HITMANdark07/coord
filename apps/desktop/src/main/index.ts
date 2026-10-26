import { join } from "node:path";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { createClient, httpTransport, localDaemonUrl, type ConnectionStatus } from "@coord/client";
import { daemonPort, localTransport } from "@coord/local-daemon";
import {
  DAEMON_EVENT_CHANNEL,
  DAEMON_REQUEST_CHANNEL,
  isDaemonRequest,
  toIpcReply,
  type IpcReply,
} from "../shared/ipc";
import { ensureDaemon } from "./daemon";

// Authenticated with the token the daemon writes for this OS user (re-read if it restarts).
const daemon = localTransport();
// /health needs no token. Startup probes use a short timeout so a silent port can't stall startup.
const probe = createClient(httpTransport({ baseUrl: localDaemonUrl(daemonPort()), timeoutMs: 1_000 }));

ipcMain.handle(DAEMON_REQUEST_CHANNEL, async (_event, req: unknown): Promise<IpcReply> => {
  if (!isDaemonRequest(req)) {
    return { ok: false, status: 400, error: { code: "invalid_request", message: "invalid daemon request" } };
  }
  try {
    return { ok: true, body: await daemon.request(req) };
  } catch (err) {
    return toIpcReply(err);
  }
});

// One daemon subscription for the whole app, fanned out to every window. The last status is
// kept so windows that load (or reload) later learn the current connection state.
let connection: ConnectionStatus = "closed";
daemon.subscribe({
  onEvent: (event) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(DAEMON_EVENT_CHANNEL, { event });
  },
  onStatus: (status) => {
    connection = status;
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(DAEMON_EVENT_CHANNEL, { status });
  },
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1100,
    height: 760,
    title: "Coord",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  // External links open in the browser; the window itself never navigates away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("did-finish-load", () =>
    win.webContents.send(DAEMON_EVENT_CHANNEL, { status: connection }),
  );

  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(__dirname, "../renderer/index.html"));
}

void app.whenReady().then(async () => {
  // Show the window right away; the UI says "connecting" until the daemon answers.
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
  await ensureDaemon(probe.health).catch((err: unknown) => console.error("[coord] daemon:", err));
});

// The daemon keeps running after the window closes (PRD FR-30); only the UI quits.
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
