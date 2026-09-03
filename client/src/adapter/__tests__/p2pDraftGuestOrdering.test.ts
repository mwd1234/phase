import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const persistence = vi.hoisted(() => ({
  saveDraftGuestSession: vi.fn(async () => {}),
  saveActiveDraftGuest: vi.fn(),
  clearDraftGuestRecovery: vi.fn(async () => {}),
  clearDraftDeckSubmission: vi.fn(async () => {}),
  loadDraftDeckSubmission: vi.fn(async () => null),
  saveDraftDeckSubmission: vi.fn(async () => {}),
}));

vi.mock("../../services/draftPersistence", () => persistence);

import { EMPTY_DRAFT_POOL_GROUPS, type DraftPlayerView } from "../draft-adapter";
import { P2PDraftGuest, type DraftGuestConnection, type DraftGuestEvent } from "../p2p-draft-guest";
import { DRAFT_PROTOCOL_VERSION, decodeDraftWireMessage, type DraftP2PMessage } from "../../network/draftProtocol";
import { FakeDraftDataConnection } from "../../network/__tests__/fakeDraftDataConnection";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

/** Use the supported raw frame so only persistence, not decompression, yields. */
function rawMessage(message: DraftP2PMessage): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(message));
  const bytes = new Uint8Array(json.length + 1);
  bytes.set(json, 1);
  return bytes;
}

function view(pickNumber: number): DraftPlayerView {
  return {
    status: "Drafting",
    kind: "Premier",
    launch_capability: "None",
    current_pack_number: 0,
    pick_number: pickNumber,
    pass_direction: "Left",
    current_pack: [{
      instance_id: `pack-${pickNumber}-card`,
      name: "Island",
      set_code: "TST",
      collector_number: "1",
      rarity: "common",
      colors: [],
      cmc: 0,
      type_line: "Basic Land — Island",
    }],
    required_pick_count: 1,
    pick_selection_mode: "Direct",
    pool: [],
    draft_effects: [],
    pool_groups: EMPTY_DRAFT_POOL_GROUPS,
    seats: Array.from({ length: 4 }, (_, seatIndex) => ({
      seat_index: seatIndex,
      display_name: `Player ${seatIndex}`,
      is_bot: false,
      connected: true,
      has_submitted_deck: false,
      pick_status: "Pending",
      active_pack_count: 1,
      face_up_draft_cards: [],
    })),
    cards_per_pack: 14,
    pick_steps_per_pack: 14,
    pack_count: 3,
    min_deck_size: 40,
    addable_cards: ["Island"],
    timer_remaining_ms: 30_000,
    standings: [],
    current_round: 0,
    next_pairing_round: 1,
    tournament_format: "Swiss",
    pod_policy: "Competitive",
    pairings: [],
    match_config: { match_type: "Bo1" },
  };
}

function welcome(initialView: DraftPlayerView): DraftP2PMessage {
  return {
    type: "draft_welcome",
    draftProtocolVersion: DRAFT_PROTOCOL_VERSION,
    draftToken: "guest-token",
    seatIndex: 2,
    draftCode: "draft-xyz",
    workspaceState: null,
    view: initialView,
  };
}

function firstContact(kind: "new" | "reconnect", initialView: DraftPlayerView): DraftP2PMessage {
  return kind === "new"
    ? welcome(initialView)
    : {
      type: "draft_reconnect_ack",
      draftProtocolVersion: DRAFT_PROTOCOL_VERSION,
      seatIndex: 2,
      draftCode: "draft-xyz",
      workspaceState: null,
      view: initialView,
    };
}

const flushAsync = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("P2P draft guest receive ordering", () => {
  const guests: P2PDraftGuest[] = [];

  function createGuest(connection: DraftGuestConnection) {
    const conn = new FakeDraftDataConnection();
    // The fake implements only the DataConnection subset used by the session.
    const guest = new P2PDraftGuest({} as never, "phase2-ABCDE", conn as never, connection);
    guests.push(guest);
    const events: DraftGuestEvent[] = [];
    guest.onEvent((event) => events.push(event));
    return { guest, conn, events };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const guest of guests.splice(0)) guest.dispose();
  });

  it.each(["new", "reconnect"] as const)(
    "publishes the %s handshake view before a later update when recovery persistence is delayed",
    async (kind) => {
      const recoverySaved = deferred();
      persistence.saveDraftGuestSession.mockReturnValueOnce(recoverySaved.promise);
      const connection: DraftGuestConnection = kind === "new"
        ? { kind, roomCode: "ABCDE", displayName: "Alice" }
        : { kind, roomCode: "ABCDE", displayName: "Alice", draftToken: "guest-token" };
      const { guest, conn, events } = createGuest(connection);
      const initialized = guest.initialize();
      const initialView = view(1);
      const nextView = view(2);
      const firstReceived = conn.receiveRaw(rawMessage(firstContact(kind, initialView)));
      await vi.waitFor(() => expect(persistence.saveDraftGuestSession).toHaveBeenCalledOnce());
      // Reach the real adapter's asynchronous persistence branch before the
      // second frame arrives. No session or codec is mocked in this suite.
      expect(guest.view).toEqual(initialView);
      const secondReceived = conn.receiveRaw(rawMessage({ type: "draft_state_update", view: nextView }));
      await flushAsync();
      recoverySaved.resolve();
      await Promise.all([firstReceived, secondReceived, initialized]);

      expect(events.filter((event) => event.type === "viewUpdated").map((event) => event.view))
        .toEqual([initialView, nextView]);
      expect(guest.view).toEqual(nextView);
      expect(events.some((event) => event.type === (kind === "new" ? "joined" : "reconnected")))
        .toBe(true);
    },
  );

  it.each(["new", "reconnect"] as const)(
    "does not publish the %s acknowledgement if the connection errors during recovery persistence",
    async (kind) => {
      const recoverySaved = deferred();
      persistence.saveDraftGuestSession.mockReturnValueOnce(recoverySaved.promise);
      const connection: DraftGuestConnection = kind === "new"
        ? { kind, roomCode: "ABCDE", displayName: "Alice" }
        : { kind, roomCode: "ABCDE", displayName: "Alice", draftToken: "guest-token" };
      const { guest, conn, events } = createGuest(connection);
      const rejected = expect(guest.initialize(undefined, 1))
        .rejects.toThrow("Draft host disconnected before acknowledging");
      const received = conn.receiveRaw(rawMessage(firstContact(kind, view(1))));
      await vi.waitFor(() => expect(persistence.saveDraftGuestSession).toHaveBeenCalledOnce());

      conn.simulateError(new Error("Transport failed"));
      await rejected;
      recoverySaved.resolve();
      await received;

      expect(events).toEqual([]);
    },
  );

  it("publishes a deck acknowledgement before a later view while clearing the durable outbox", async () => {
    const { guest, conn, events } = createGuest({ kind: "new", roomCode: "ABCDE", displayName: "Alice" });
    const initialized = guest.initialize();
    await conn.receiveRaw(rawMessage(welcome(view(1))));
    await initialized;
    events.length = 0;

    const submitted = guest.submitDeck(["Island"], []);
    await vi.waitFor(() => expect(conn.sentRaw).toHaveLength(2));
    const command = await decodeDraftWireMessage(conn.sentRaw[1]!);
    expect(command.type).toBe("draft_submit_deck");
    if (command.type !== "draft_submit_deck") throw new Error("Expected draft deck submission");

    const outboxCleared = deferred();
    persistence.clearDraftDeckSubmission.mockReturnValueOnce(outboxCleared.promise);
    const acknowledgedView = { ...view(2), status: "Deckbuilding" as const };
    const nextView = { ...view(3), status: "Pairing" as const };
    const ackReceived = conn.receiveRaw(rawMessage({
      type: "draft_deck_submit_ack",
      submissionId: command.submissionId,
      view: acknowledgedView,
    }));
    await vi.waitFor(() => expect(persistence.clearDraftDeckSubmission).toHaveBeenCalledWith(
      "phase2-ABCDE", command.submissionId,
    ));
    const nextReceived = conn.receiveRaw(rawMessage({ type: "draft_state_update", view: nextView }));
    await flushAsync();
    outboxCleared.resolve();
    await Promise.all([ackReceived, nextReceived, submitted]);

    expect(events.filter((event) => event.type === "viewUpdated").map((event) => event.view))
      .toEqual([acknowledgedView, nextView]);
    expect(events).toContainEqual({
      type: "deckSubmissionAcknowledged", submissionId: command.submissionId, view: acknowledgedView,
    });
    expect(guest.view).toEqual(nextView);
  });

  it("settles a durable deck receipt without publishing its view after a connection error", async () => {
    const { guest, conn, events } = createGuest({ kind: "new", roomCode: "ABCDE", displayName: "Alice" });
    const initialized = guest.initialize();
    await conn.receiveRaw(rawMessage(welcome(view(1))));
    await initialized;
    events.length = 0;

    const submitted = guest.submitDeck(["Island"], []);
    await vi.waitFor(() => expect(conn.sentRaw).toHaveLength(2));
    const command = await decodeDraftWireMessage(conn.sentRaw[1]!);
    expect(command.type).toBe("draft_submit_deck");
    if (command.type !== "draft_submit_deck") throw new Error("Expected draft deck submission");

    const outboxCleared = deferred();
    persistence.clearDraftDeckSubmission.mockReturnValueOnce(outboxCleared.promise);
    const received = conn.receiveRaw(rawMessage({
      type: "draft_deck_submit_ack", submissionId: command.submissionId, view: view(2),
    }));
    await vi.waitFor(() => expect(persistence.clearDraftDeckSubmission).toHaveBeenCalledWith(
      "phase2-ABCDE", command.submissionId,
    ));

    conn.simulateError(new Error("Transport failed"));
    outboxCleared.resolve();
    await Promise.all([received, submitted]);

    expect(events).toEqual([{ type: "reconnecting", attempt: 1 }]);
  });

  it("honors a leave acknowledgement queued behind persistence before the host closes", async () => {
    const { guest, conn, events } = createGuest({ kind: "new", roomCode: "ABCDE", displayName: "Alice" });
    const initialized = guest.initialize();
    await conn.receiveRaw(rawMessage(welcome(view(1))));
    await initialized;

    const submitted = guest.submitDeck(["Island"], []);
    await vi.waitFor(() => expect(conn.sentRaw).toHaveLength(2));
    const submission = await decodeDraftWireMessage(conn.sentRaw[1]!);
    expect(submission.type).toBe("draft_submit_deck");
    if (submission.type !== "draft_submit_deck") throw new Error("Expected draft deck submission");

    const outboxCleared = deferred();
    persistence.clearDraftDeckSubmission.mockReturnValueOnce(outboxCleared.promise);
    const deckAckReceived = conn.receiveRaw(rawMessage({
      type: "draft_deck_submit_ack", submissionId: submission.submissionId, view: view(2),
    }));
    await vi.waitFor(() => expect(persistence.clearDraftDeckSubmission).toHaveBeenCalledWith(
      "phase2-ABCDE", submission.submissionId,
    ));

    const leaveResult = guest.leave().then(
      () => ({ status: "fulfilled" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await vi.waitFor(() => expect(conn.sentRaw).toHaveLength(3));
    await expect(decodeDraftWireMessage(conn.sentRaw[2]!)).resolves.toEqual({
      type: "draft_leave", draftProtocolVersion: DRAFT_PROTOCOL_VERSION, draftToken: "guest-token",
    });
    const leaveAckReceived = conn.receiveRaw(rawMessage({
      type: "draft_leave_ack", draftProtocolVersion: DRAFT_PROTOCOL_VERSION, draftToken: "guest-token",
    }));
    conn.simulateClose();
    outboxCleared.resolve();
    await Promise.all([deckAckReceived, leaveAckReceived, submitted]);

    await expect(leaveResult).resolves.toEqual({ status: "fulfilled" });
    expect(guest.isRecoveryRevoked).toBe(true);
    expect(persistence.clearDraftGuestRecovery).toHaveBeenCalledWith("phase2-ABCDE");
    expect(events.some((event) => event.type === "reconnecting")).toBe(false);
  });

  it("still reports an active handshake persistence failure", async () => {
    persistence.saveDraftGuestSession.mockRejectedValueOnce(new Error("IDB unavailable"));
    const { guest, conn, events } = createGuest({ kind: "new", roomCode: "ABCDE", displayName: "Alice" });
    const rejected = expect(guest.initialize()).rejects.toThrow("IDB unavailable");

    await conn.receiveRaw(rawMessage(welcome(view(1))));
    await rejected;

    expect(events).toEqual([{ type: "error", message: "Could not save draft recovery details" }]);
    expect(persistence.saveActiveDraftGuest).not.toHaveBeenCalled();
  });
});
