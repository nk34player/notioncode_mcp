import assert from "node:assert/strict";
import test from "node:test";
import { bootstrapAccounts, extractWorkspaces, unwrapRecord } from "../src/bootstrap.js";

function modernBootstrapPayload() {
  return {
    recordMap: {
      notion_user: {
        "user-1": {
          role: "reader",
          value: {
            id: "user-1",
            given_name: "Test",
            family_name: "User",
            email: "test@example.test",
          },
        },
      },
      space_view: {
        "view-1": {
          role: "reader",
          value: {
            type: "space_view",
            value: { id: "view-1", space_id: "space-1" },
          },
        },
        "view-2": {
          role: "reader",
          value: {
            type: "space_view",
            value: { id: "view-2", space_id: "space-2" },
          },
        },
      },
      space: {
        "space-1": {
          role: "editor",
          value: {
            type: "space",
            value: { id: "space-1", name: "Engineering", domain: "engineering" },
          },
        },
        "space-2": {
          role: "editor",
          value: {
            type: "space",
            value: { id: "space-2", name: "Product", domain: "product" },
          },
        },
      },
    },
  };
}

test("unwrapRecord unwraps tagged modern record envelopes", () => {
  const record = {
    role: "editor",
    value: {
      type: "space",
      value: { id: "space-1", name: "Engineering" },
    },
  };

  assert.deepEqual(unwrapRecord(record), { id: "space-1", name: "Engineering" });
});

test("extractWorkspaces reads names and domains from tagged modern space records", () => {
  assert.deepEqual(extractWorkspaces(modernBootstrapPayload()), [
    {
      space_id: "space-1",
      space_view_id: "view-1",
      space_name: "Engineering",
      domain: "engineering",
    },
    {
      space_id: "space-2",
      space_view_id: "view-2",
      space_name: "Product",
      domain: "product",
    },
  ]);
});

test("bootstrapAccounts preserves modern workspace metadata in every account", async () => {
  const accounts = await bootstrapAccounts({
    tokenV2: "test-token",
    browserId: "browser-1",
    transport: async () => ({
      status: 200,
      json: async () => modernBootstrapPayload(),
    }),
  });

  assert.deepEqual(
    accounts.map((account) => ({
      space_id: account.space_id,
      space_view_id: account.space_view_id,
      space_name: account.space_name,
      space_domain: account.space_domain,
    })),
    [
      {
        space_id: "space-1",
        space_view_id: "view-1",
        space_name: "Engineering",
        space_domain: "engineering",
      },
      {
        space_id: "space-2",
        space_view_id: "view-2",
        space_name: "Product",
        space_domain: "product",
      },
    ],
  );
});
