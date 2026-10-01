import { describe, expect, it } from "vitest";
import { MemoryRateLimiter } from "../src/limiter";

describe("MemoryRateLimiter", () => {
  it("allows `limit` calls per key per period, then refuses until the period ends", async () => {
    let now = 0;
    const limiter = new MemoryRateLimiter(2, 60, () => now);
    const call = (key: string) => limiter.limit({ key }).then((r) => r.success);
    expect([await call("a"), await call("a"), await call("a")]).toEqual([true, true, false]);
    expect(await call("b")).toBe(true);
    now = 60_000;
    expect(await call("a")).toBe(true);
    limiter.close();
  });
});
