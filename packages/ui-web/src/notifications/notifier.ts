import type { Notify } from "../app";

/** Web Notification API wrapper; Electron's renderer and browsers both have it. */
export function browserNotifier(): Notify | null {
  if (typeof Notification === "undefined") return null;
  return ({ title, body, onClick }) => {
    // Silent without permission: the web surface asks from a button click, not here.
    if (Notification.permission !== "granted") return;
    const n = new Notification(title, { body });
    n.onclick = onClick;
  };
}
