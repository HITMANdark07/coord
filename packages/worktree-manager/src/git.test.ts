import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { git } from "./git";
import { isNotARepoError } from "./repo";

const GERMAN = { LANG: "de_DE.UTF-8", LC_ALL: "de_DE.UTF-8", LC_MESSAGES: "de_DE.UTF-8", LANGUAGE: "de" };

describe("git", () => {
  it("runs git in the C locale, so its messages match whatever the user's locale", async () => {
    const dir = await mkdtemp(join(tmpdir(), "coord-wm-locale-"));
    const err = await git(["rev-parse", "--show-toplevel"], { cwd: dir, env: GERMAN }).catch(
      (e: unknown) => e,
    );
    expect(isNotARepoError(err)).toBe(true);
    // Also where git has no translations installed: the env git gets says C.
    const env = await git(["-c", "alias.env=!env", "env"], { cwd: dir, env: GERMAN });
    expect(env).toMatch(/^LC_ALL=C$/m);
    expect(env).toMatch(/^LANGUAGE=C$/m);
  });
});
