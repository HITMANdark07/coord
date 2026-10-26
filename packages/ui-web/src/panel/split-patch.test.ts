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

  it("reads quoted headers with octal escapes and keeps the next file's lines out", () => {
    const patch = [
      'diff --git "a/caf\\303\\251.ts" "b/caf\\303\\251.ts"',
      "@@ -1 +1 @@",
      "-a",
      "+b",
      'diff --git "a/tab\\there \\"q\\".ts" "b/tab\\there \\"q\\".ts"',
      "@@ -1 +1 @@",
      "+c",
      "diff --git a/plain.ts b/plain.ts",
      "@@ -1 +1 @@",
      "+d",
    ].join("\n");
    expect(splitPatch(patch)).toEqual([
      { path: "café.ts", binary: false, lines: ["@@ -1 +1 @@", "-a", "+b"] },
      { path: 'tab\there "q".ts', binary: false, lines: ["@@ -1 +1 @@", "+c"] },
      { path: "plain.ts", binary: false, lines: ["@@ -1 +1 @@", "+d"] },
    ]);
  });

  it("does not split on a content line that looks like a header", () => {
    const patch = "diff --git a/x b/x\n@@ -0,0 +1 @@\n+diff --git a/y b/y\n";
    expect(splitPatch(patch)).toEqual([
      { path: "x", binary: false, lines: ["@@ -0,0 +1 @@", "+diff --git a/y b/y"] },
    ]);
  });

  it("handles CRLF line endings", () => {
    const patch = "diff --git a/x b/x\r\n@@ -1 +1 @@\r\n-a\r\n+b\r\n";
    expect(splitPatch(patch)).toEqual([{ path: "x", binary: false, lines: ["@@ -1 +1 @@", "-a", "+b"] }]);
  });

  it("keeps what it has of a patch cut mid-file", () => {
    const patch = "diff --git a/x b/x\n@@ -1,3 +1,3 @@\n a\n-b";
    expect(splitPatch(patch)).toEqual([{ path: "x", binary: false, lines: ["@@ -1,3 +1,3 @@", " a", "-b"] }]);
  });
});
