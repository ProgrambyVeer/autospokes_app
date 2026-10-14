import { describe, expect, it } from "vitest";
import { expectedAutospokesDatabaseName } from "../src/database.js";

describe("dedicated database guard", () => {
  it("accepts an explicitly named Autospokes database", () => {
    expect(
      expectedAutospokesDatabaseName(
        "postgresql://autospokes_app:example@127.0.0.1:5432/autospokes_dev?schema=public",
      ),
    ).toBe("autospokes_dev");
  });

  it("refuses a generic or missing database URL", () => {
    expect(() =>
      expectedAutospokesDatabaseName("postgresql://user:password@127.0.0.1:5432/postgres"),
    ).toThrow(/dedicated Autospokes(?: PostgreSQL)? database/);
    expect(() => expectedAutospokesDatabaseName(undefined)).toThrow(
      /dedicated Autospokes(?: PostgreSQL)? database/,
    );
  });
});
