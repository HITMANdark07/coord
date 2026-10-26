// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClient, DaemonError } from "@coord/client";
import { fakeTransport } from "@coord/client/testing";
import { takeDaemonToken } from "./daemon-token";
import { expireTokenOn401, reloadOnNewToken, StaleTokenNotice } from "./stale-token";

// Tells React this is a test, so act() flushes renders without warnings.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  sessionStorage.clear();
  document.body.innerHTML = "";
  window.history.replaceState(null, "", "/");
});

describe("a stale daemon token", () => {
  it("a 401 shows the message and clears the stored token; other errors don't", async () => {
    window.history.replaceState(null, "", "/#token=old-token");
    takeDaemonToken(window.location, window.history, sessionStorage);
    let status = 500;
    const client = createClient(
      expireTokenOn401(
        fakeTransport(() => {
          throw new DaemonError(status, "unauthorized", "nope");
        }),
        sessionStorage,
      ),
    );
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    act(() => root.render(<StaleTokenNotice />));

    await act(() => client.listRepos().catch(() => {}));
    expect(document.body.textContent).toBe("");
    expect(takeDaemonToken(window.location, window.history, sessionStorage)).toBe("old-token");

    status = 401;
    await act(() => client.listRepos().catch(() => {}));
    expect(document.body.textContent).toBe(
      "The daemon restarted, so this link no longer works. Run pnpm coord web and open the new link.",
    );
    expect(document.body.textContent).not.toContain("old-token");
    expect(takeDaemonToken(window.location, window.history, sessionStorage)).toBeUndefined();
    act(() => root.unmount());
  });

  it("pasting a new link in the same tab reloads the page", () => {
    const reload = vi.fn();
    reloadOnNewToken(window, reload);
    window.location.hash = "#section";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(reload).not.toHaveBeenCalled();
    window.location.hash = "#token=new-token";
    window.dispatchEvent(new HashChangeEvent("hashchange"));
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
