import assert from "node:assert/strict";
import test from "node:test";

import { PokerRoomManager } from "./game.js";

function createCard(code) {
  return {
    code,
    image: `https://example.com/${code}.png`
  };
}

function createDeckApi(...draws) {
  return {
    async createDeck() {
      return {
        deck_id: "deck-test"
      };
    },

    async drawCards(_deckId, count) {
      const next = draws.shift();

      if (next instanceof Error) {
        throw next;
      }

      assert.ok(Array.isArray(next), "Expected an array of cards.");
      assert.equal(next.length, count, `Expected ${count} cards but received ${next.length}.`);

      return {
        cards: next
      };
    }
  };
}

function seatPlayers(manager, roomId, count) {
  const players = [];

  for (let index = 0; index < count; index += 1) {
    const result = manager.joinRoom({
      roomId,
      socketId: `socket-${index + 1}`,
      name: `Player ${index + 1}`,
      playerId: null
    });

    players.push(result.player);
  }

  return players;
}

test("startHand rolls back fully when the deck service fails", async () => {
  const manager = new PokerRoomManager({
    deckApi: {
      async createDeck() {
        throw new Error("Deck service offline");
      },
      async drawCards() {
        throw new Error("draw should not run");
      }
    }
  });
  const room = manager.createRoom();
  const players = seatPlayers(manager, room.id, 2);

  await assert.rejects(() => manager.startHand(players[0].socketId), /Deck service offline/);

  assert.equal(room.phase, "waiting");
  assert.equal(room.handNumber, 0);
  assert.equal(room.deckId, null);
  assert.equal(room.communityCards.length, 0);
  assert.equal(room.pot, 0);

  for (const player of room.players) {
    assert.equal(player.inHand, false);
    assert.equal(player.holeCards.length, 0);
    assert.equal(player.streetContribution, 0);
    assert.equal(player.totalContribution, 0);
  }
});

test("a failed street reveal pauses the hand and resumeHand continues it", async () => {
  const manager = new PokerRoomManager({
    deckApi: createDeckApi(
      [
        createCard("AS"),
        createCard("KH"),
        createCard("QC"),
        createCard("JD")
      ],
      new Error("Flop temporarily unavailable"),
      [
        createCard("2C"),
        createCard("7H"),
        createCard("8D"),
        createCard("9S")
      ]
    )
  });
  const room = manager.createRoom();
  const [host, opponent] = seatPlayers(manager, room.id, 2);

  await manager.startHand(host.socketId);
  await manager.handleAction(host.socketId, {
    type: "call"
  });

  await manager.handleAction(opponent.socketId, {
    type: "check"
  });

  assert.equal(room.phase, "preflop");
  assert.equal(room.pendingReveal, "flop");
  assert.match(room.pendingDeckMessage, /Unable to reveal the flop/i);
  assert.equal(room.communityCards.length, 0);
  assert.equal(room.currentTurnPlayerId, null);

  await manager.resumeHand(host.socketId);

  assert.equal(room.phase, "flop");
  assert.equal(room.pendingReveal, null);
  assert.equal(room.pendingDeckMessage, "");
  assert.equal(room.communityCards.length, 3);
  assert.equal(room.currentTurnPlayerId, opponent.id);
});

test("exportRooms and importRooms preserve room state for restarts", async () => {
  const manager = new PokerRoomManager({
    deckApi: createDeckApi([
      createCard("AS"),
      createCard("KH"),
      createCard("QC"),
      createCard("JD")
    ])
  });
  const room = manager.createRoom();
  const [host] = seatPlayers(manager, room.id, 2);

  await manager.startHand(host.socketId);

  const snapshot = manager.exportRooms();
  assert.equal(snapshot.length, 1);
  assert.ok(snapshot[0].players.every((player) => player.connected === false && player.socketId === null));

  const restoredManager = new PokerRoomManager();
  restoredManager.importRooms(snapshot);
  const restoredRoom = restoredManager.getRoom(room.id);

  assert.ok(restoredRoom);
  assert.equal(restoredRoom.phase, "preflop");
  assert.equal(restoredRoom.players.length, 2);
  assert.ok(restoredRoom.players.every((player) => player.connected === false && player.socketId === null));
  assert.equal(restoredRoom.communityCards.length, 0);
});

test("resolveShowdown pays main and side pots correctly", () => {
  const manager = new PokerRoomManager();
  const room = manager.createRoom();
  const [playerA, playerB, playerC] = seatPlayers(manager, room.id, 3);

  room.phase = "river";
  room.dealerSeat = playerA.seat;
  room.communityCards = [
    createCard("2H"),
    createCard("3H"),
    createCard("4H"),
    createCard("5C"),
    createCard("9D")
  ];
  room.pot = 500;

  Object.assign(playerA, {
    chips: 0,
    inHand: true,
    folded: false,
    totalContribution: 100,
    holeCards: [createCard("AH"), createCard("KH")]
  });
  Object.assign(playerB, {
    chips: 0,
    inHand: true,
    folded: false,
    totalContribution: 200,
    holeCards: [createCard("6S"), createCard("6D")]
  });
  Object.assign(playerC, {
    chips: 0,
    inHand: true,
    folded: false,
    totalContribution: 200,
    holeCards: [createCard("QH"), createCard("JH")]
  });

  manager.resolveShowdown(room);

  const winners = room.showdown.winners.map((winner) => [winner.name, winner.amount]);

  assert.deepEqual(winners, [
    [playerA.name, 300],
    [playerC.name, 200]
  ]);
  assert.equal(playerA.chips, 300);
  assert.equal(playerB.chips, 0);
  assert.equal(playerC.chips, 200);
});
