import { describe, expect, it } from "vitest";
import { splitPatch } from "./split-patch";

const two = [
  "diff --git a/a.ts b/a.ts",
  "index 111..222 100644",
  "--- a/a.ts",
  "+++ b/a.ts",
  "@@ -1,2 +1,2 @@",
  " keep",
  "-old",
  "+new",
  "diff --git a/b.ts b/b.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/b.ts",
  "@@ -0,0 +1 @@",
  "+hello",
  "",
].join("\n");

describe("splitPatch", () => {
  it("splits two files and keeps each hunk's lines, leading +/-/space intact", () => {
    expect(splitPatch(two)).toEqual([
      { path: "a.ts", binary: false, lines: ["@@ -1,2 +1,2 @@", " keep", "-old", "+new"] },
      { path: "b.ts", binary: false, lines: ["@@ -0,0 +1 @@", "+hello"] },
    ]);
  });

  it("marks a binary file", () => {
    const patch =
      "diff --git a/logo.png b/logo.png\nindex 1..2 100644\nBinary files a/logo.png and b/logo.png differ\n";
    expect(splitPatch(patch)).toEqual([{ path: "logo.png", binary: true, lines: [] }]);
  });

  it("names a rename by its new path", () => {
    const patch =
      "diff --git a/old.ts b/new.ts\nsimilarity index 100%\nrename from old.ts\nrename to new.ts\n";
    expect(splitPatch(patch)).toEqual([{ path: "new.ts", binary: false, lines: [] }]);
  });

  it("returns nothing for an empty patch", () => {
    expect(splitPatch("")).toEqual([]);
  });
});
