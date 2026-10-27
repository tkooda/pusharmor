// Pins the router table to routes.json, the allow-list the release bundle check
// (server/deploy/check-bundle.mjs) holds the built bundle to.
import { expect, it } from "vitest";
import { ROUTES } from "../src/router";
import pinned from "../routes.json";

it("the router serves exactly the pinned routes", () => {
  expect(ROUTES.map((r) => `${r.method} ${r.path}`)).toEqual(pinned.routes);
});
