// src/core/instances/__tests__/viewSyncKey.test.js
// The routing rule that decides whether a peer's visualization/camera update
// reaches a local instance.
//
// THE BUG THIS PINS: every client that opens a dataset POSTs /views and gets
// its own fresh view UUID, so two headsets showing the SAME dataset hold two
// different viewConfigIds. Matching on viewConfigId alone silently dropped
// every cross-client patch — the change applied locally, the peer never saw
// it, and nothing logged a failure.

import { describe, test, expect } from "vitest";
import { resolveViewSyncKey, instanceMatchesViewUpdate } from "../viewSyncKey.js";

describe("resolveViewSyncKey", () => {
  test("prefers the dataset id over the view id", () => {
    const instance = {
      viewConfigId: "view-a",
      datasetId: "dataset-1",
      instanceData: { dataset: { id: "dataset-1" } },
    };
    expect(resolveViewSyncKey(instance)).toBe("dataset-1");
  });

  test("yields the same key for the wrapper and the handler's instanceData", () => {
    // The publisher usually holds an instanceData while the receiver walks
    // workspaceManager's instance wrappers. If these two shapes disagreed, a
    // client would fail to match its own peers.
    const instanceData = { viewConfigId: "view-a", datasetId: "dataset-1", dataset: { id: "dataset-1" } };
    const wrapper = { viewConfigId: "view-a", datasetId: "dataset-1", instanceData };

    expect(resolveViewSyncKey(wrapper)).toBe(resolveViewSyncKey(instanceData));
  });

  test("falls back to viewConfigId when no dataset is loaded yet", () => {
    expect(resolveViewSyncKey({ viewConfigId: "view-a" })).toBe("view-a");
  });

  test("returns null when nothing identifies the instance", () => {
    expect(resolveViewSyncKey({})).toBeNull();
    expect(resolveViewSyncKey(null)).toBeNull();
    expect(resolveViewSyncKey(undefined)).toBeNull();
  });
});

describe("instanceMatchesViewUpdate", () => {
  // The reported defect, stated directly.
  test("matches a peer that minted its own viewConfigId over the same dataset", () => {
    const localInstance = {
      viewConfigId: "view-local",
      datasetId: "dataset-1",
      instanceData: { dataset: { id: "dataset-1" } },
    };

    // Headset A published under ITS view id, with the shared dataset key.
    expect(instanceMatchesViewUpdate(localInstance, "view-remote", "dataset-1")).toBe(true);
  });

  test("does not match a peer viewing a different dataset", () => {
    const localInstance = {
      viewConfigId: "view-local",
      datasetId: "dataset-1",
      instanceData: { dataset: { id: "dataset-1" } },
    };

    expect(instanceMatchesViewUpdate(localInstance, "view-remote", "dataset-2")).toBe(false);
  });

  // REGRESSION: the path that already worked (saved workspace views, linked
  // views) shares one viewConfigId and must keep matching untouched.
  test("still matches on an identical viewConfigId", () => {
    const localInstance = { viewConfigId: "view-shared", datasetId: "dataset-1" };

    expect(instanceMatchesViewUpdate(localInstance, "view-shared", "dataset-1")).toBe(true);
    // ...even when the sender sent no sync key at all (older client).
    expect(instanceMatchesViewUpdate(localInstance, "view-shared", null)).toBe(true);
  });

  test("without a syncKey, a mismatched viewId matches nothing", () => {
    const localInstance = { viewConfigId: "view-local", datasetId: "dataset-1" };
    expect(instanceMatchesViewUpdate(localInstance, "view-remote", null)).toBe(false);
  });

  test("never matches a missing instance", () => {
    expect(instanceMatchesViewUpdate(null, "view-1", "dataset-1")).toBe(false);
  });
});
