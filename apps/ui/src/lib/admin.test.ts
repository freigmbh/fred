import { ConvexError } from "convex/values";
import { describe, expect, it } from "vitest";
import { errorText } from "./admin";

describe("errorText", () => {
  it("prefers the controller's message, then a known code's sentence, then the fallback", () => {
    expect(errorText(new ConvexError({ code: "project_token", message: "This project is not connected." }), "Check failed")).toBe("This project is not connected.");
    expect(errorText(new ConvexError("pipeline_changed"), "Save failed")).toBe("Changed elsewhere. Reset to reload.");
    expect(errorText(new ConvexError("something_new"), "Save failed")).toBe("Save failed");
    expect(errorText(new Error("offline"), "Save failed")).toBe("Save failed");
  });

  it("falls back to the bare code or the error's first line without Convex's bracketed prefixes", () => {
    expect(errorText(new ConvexError("something_new"))).toBe("something_new");
    expect(errorText(new Error("[CONVEX Q(admin:exportPage)] [Request ID: 1a2b] Server Error\n  Called by client"))).toBe("Server Error");
    expect(errorText("thrown string")).toBe("unknown error");
  });
});
