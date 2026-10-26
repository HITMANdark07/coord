import { describe, expect, it } from "vitest";
import { slugify } from "./slug";

describe("slugify", () => {
  it("slugifies", () => {
    expect(slugify("Fix the Login redirect!!")).toBe("fix-the-login-redirect");
    expect(slugify("")).toBe("task");
    expect(slugify("!!!")).toBe("task");
    expect(slugify("a".repeat(60)).length).toBe(40);
  });
});
