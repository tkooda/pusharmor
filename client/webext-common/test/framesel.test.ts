import assert from "node:assert/strict";
import { test } from "node:test";
import { onMenuClick, readTabSelection } from "../src/shellkit.ts";

test("the selection is read from the frame that was clicked", async () => {
  const targets: unknown[] = [];
  const b = {
    scripting: {
      executeScript: async (d: { target: unknown }) => {
        targets.push(d.target);
        return [{ result: "from frame" }];
      },
    },
  };
  assert.equal(await readTabSelection(b as never, { id: 3 } as never, "x", 7), "from frame");
  assert.deepEqual(targets, [{ tabId: 3, frameIds: [7] }]);
});

test("a menu click passes its frame id to the selection reader", async () => {
  const seen: (number | undefined)[] = [];
  const engine = { p: { notify: () => undefined, setBadge: () => undefined }, updateBadge: async () => undefined };
  onMenuClick({} as never, async () => ({ engine }) as never, async (_t, _x, f) => {
    seen.push(f);
    return "";
  })({ menuItemId: "pa-sel|all", selectionText: "x", frameId: 5 } as never, { id: 3 } as never);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(seen, [5]);
});
