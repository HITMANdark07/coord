import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import {
  DAEMON_EVENT_CHANNEL,
  DAEMON_REQUEST_CHANNEL,
  PICK_FOLDER_CHANNEL,
  type DaemonPush,
  type CoordBridge,
} from "../shared/ipc";

const bridge: CoordBridge = {
  request: (req) => ipcRenderer.invoke(DAEMON_REQUEST_CHANNEL, req),
  pickFolder: () => ipcRenderer.invoke(PICK_FOLDER_CHANNEL),
  onPush: (listener) => {
    const handler = (_event: IpcRendererEvent, push: DaemonPush) => listener(push);
    ipcRenderer.on(DAEMON_EVENT_CHANNEL, handler);
    return () => ipcRenderer.removeListener(DAEMON_EVENT_CHANNEL, handler);
  },
};

contextBridge.exposeInMainWorld("coord", bridge);
