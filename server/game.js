import { nanoid } from "nanoid";
import pokersolver from "pokersolver";

import { createDeck, drawCards } from "./deckApi.js";

const { Hand } = pokersolver;

const MAX_PLAYERS = 6;
const STARTING_CHIPS = 2000;
const SMALL_BLIND = 10;
const BIG_BLIND = 20;
const MAX_LOG_ENTRIES = 60;
const ROOM_TTL_MS = 1000 * 60 * 60 * 6;
const BACK_CARD_IMAGE = "https://deckofcardsapi.com/static/img/back.png";
const LIVE_PHASES = new Set(["preflop", "flop", "turn", "river"]);

function cloneValue(value) {
  if (typeof structuredClone === "function") {
    return structuredClone(value);
  }

  return JSON.parse(JSON.stringify(value));
}

function cleanName(value) {
  return `${value ?? ""}`.trim().replace(/\s+/g, " ").slice(0, 18) || "Player";
}

function formatChips(amount) {
  return `$${amount.toLocaleString()}`;
}

function clampWholeNumber(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function addLog(room, text) {
  room.actionLog.push({
    id: nanoid(8),
    text
  });
  room.actionLog = room.actionLog.slice(-MAX_LOG_ENTRIES);
}

function restoreRoomSnapshot(room, snapshot) {
  for (const key of Object.keys(room)) {
    delete room[key];
  }

  Object.assign(room, cloneValue(snapshot));
}

function getPendingRevealStreet(phase) {
  switch (phase) {
    case "preflop":
      return "flop";
    case "flop":
      return "turn";
    case "turn":
      return "river";
    default:
      return null;
  }
}

function buildRevealRetryMessage(street, cause) {
  const prefix = street ? `Unable to reveal the ${street}.` : "Unable to continue the hand.";
  const detail = cause instanceof Error ? cause.message : "Deck service unavailable.";
  return `${prefix} ${detail}`;
}

function getPlayersInSeatOrder(room, filter = () => true) {
  return room.players.filter(filter).sort((left, right) => left.seat - right.seat);
}

function getPlayersStartingAfterSeat(room, seat, filter = () => true) {
  const players = getPlayersInSeatOrder(room, filter);

  if (!players.length) {
    return [];
  }

  const nextIndex = players.findIndex((player) => player.seat > seat);

  if (nextIndex === -1) {
    return players;
  }

  return players.slice(nextIndex).concat(players.slice(0, nextIndex));
}

function getNextPlayerAfterSeat(room, seat, filter = () => true) {
  return getPlayersStartingAfterSeat(room, seat, filter)[0] ?? null;
}

function getLowestOpenSeat(room) {
  for (let seat = 0; seat < room.maxPlayers; seat += 1) {
    if (!room.players.some((player) => player.seat === seat)) {
      return seat;
    }
  }

  return -1;
}

function getEligiblePlayers(room) {
  return getPlayersInSeatOrder(room, (player) => player.chips > 0 && player.connected);
}

function getContenders(room) {
  return room.players.filter((player) => player.inHand && !player.folded);
}

function getActionablePlayers(room) {
  return room.players.filter(
    (player) => player.inHand && !player.folded && !player.allIn && player.chips > 0
  );
}

function getPlayer(room, playerId) {
  return room.players.find((player) => player.id === playerId) ?? null;
}

function postChips(room, player, amount) {
  const wager = Math.max(0, Math.min(player.chips, clampWholeNumber(amount)));

  player.chips -= wager;
  player.streetContribution += wager;
  player.totalContribution += wager;
  room.pot += wager;
  player.allIn = player.chips === 0;

  return wager;
}

function resetPlayerForHand(player) {
  player.inHand = false;
  player.folded = false;
  player.allIn = false;
  player.hasActed = false;
  player.holeCards = [];
  player.streetContribution = 0;
  player.totalContribution = 0;
  player.lastAction = "";
  player.bestHandName = null;
  player.lastWinAmount = 0;
}

function resetStreet(room) {
  room.currentBet = 0;
  room.minimumRaise = BIG_BLIND;

  for (const player of room.players) {
    if (!player.inHand || player.folded) {
      continue;
    }

    player.streetContribution = 0;
    player.hasActed = false;
    player.allIn = player.chips === 0;
  }
}

function buildTableMessage(room) {
  if (room.pendingDeckMessage) {
    return room.pendingDeckMessage;
  }

  if (room.phase === "waiting") {
    if (getEligiblePlayers(room).length < 2) {
      return "Share the room URL. Two players are needed to deal.";
    }

    return "Table is ready for the next hand.";
  }

  if (room.phase === "showdown") {
    return room.showdown?.message ?? "Hand complete.";
  }

  const turnPlayer = getPlayer(room, room.currentTurnPlayerId);

  if (turnPlayer) {
    return `${turnPlayer.name} to act`;
  }

  return "Hand in progress";
}

function toSolverCard(card) {
  const rawRank = card.code[0];
  const rank = rawRank === "0" ? "T" : rawRank;
  const suitMap = {
    S: "s",
    H: "h",
    D: "d",
    C: "c"
  };

  return `${rank}${suitMap[card.code[1]]}`;
}

function getWinnersInSeatOrder(room, winners) {
  const winnerIds = new Set(winners.map((player) => player.id));
  return getPlayersStartingAfterSeat(room, room.dealerSeat, (player) => winnerIds.has(player.id));
}

export class PokerRoomManager {
  constructor({ deckApi } = {}) {
    this.rooms = new Map();
    this.socketIndex = new Map();
    this.deckApi = deckApi ?? {
      createDeck,
      drawCards
    };
  }

  createRoom() {
    let roomId = nanoid(6).toUpperCase();

    while (this.rooms.has(roomId)) {
      roomId = nanoid(6).toUpperCase();
    }

    const room = {
      id: roomId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      players: [],
      hostId: null,
      maxPlayers: MAX_PLAYERS,
      phase: "waiting",
      handNumber: 0,
      dealerSeat: -1,
      smallBlind: SMALL_BLIND,
      bigBlind: BIG_BLIND,
      smallBlindPlayerId: null,
      bigBlindPlayerId: null,
      deckId: null,
      communityCards: [],
      pot: 0,
      currentBet: 0,
      minimumRaise: BIG_BLIND,
      currentTurnPlayerId: null,
      pendingReveal: null,
      pendingDeckMessage: "",
      showdown: null,
      actionLog: []
    };

    this.rooms.set(roomId, room);
    addLog(room, "Room created");
    return room;
  }

  getRoom(roomId) {
    return this.rooms.get(roomId) ?? null;
  }

  getRoomIdForSocket(socketId) {
    return this.socketIndex.get(socketId)?.roomId ?? null;
  }

  exportRooms() {
    return [...this.rooms.values()].map((room) => {
      const snapshot = cloneValue(room);

      snapshot.players = snapshot.players.map((player) => ({
        ...player,
        connected: false,
        socketId: null
      }));

      return snapshot;
    });
  }

  importRooms(rooms = []) {
    this.rooms.clear();
    this.socketIndex.clear();

    for (const rawRoom of rooms) {
      if (!rawRoom?.id) {
        continue;
      }

      const room = cloneValue(rawRoom);
      room.maxPlayers = room.maxPlayers ?? MAX_PLAYERS;
      room.smallBlind = room.smallBlind ?? SMALL_BLIND;
      room.bigBlind = room.bigBlind ?? BIG_BLIND;
      room.minimumRaise = room.minimumRaise ?? BIG_BLIND;
      room.communityCards = room.communityCards ?? [];
      room.actionLog = room.actionLog ?? [];
      room.showdown = room.showdown ?? null;
      room.pendingReveal = room.pendingReveal ?? null;
      room.pendingDeckMessage = room.pendingDeckMessage ?? "";
      room.players = (room.players ?? []).map((player) => ({
        ...player,
        connected: false,
        socketId: null,
        isBot: Boolean(player.isBot),
        botDifficulty: player.botDifficulty ?? null
      }));

      this.rooms.set(room.id, room);
    }
  }

  pruneRooms() {
    const now = Date.now();
    let removedCount = 0;

    for (const [roomId, room] of this.rooms.entries()) {
      const hasConnectedPlayers = room.players.some((player) => player.connected);
      const isExpired = now - room.updatedAt > ROOM_TTL_MS;

      if (!hasConnectedPlayers && isExpired) {
        this.rooms.delete(roomId);
        removedCount += 1;
      }
    }

    return removedCount;
  }

  joinRoom({ roomId, socketId, name, playerId }) {
    const room = this.getRoom(roomId);

    if (!room) {
      throw new Error("Room not found. Create a new room from the lobby.");
    }

    const requestedName = cleanName(name);
    let player = playerId ? getPlayer(room, playerId) : null;

    if (player) {
      if (player.socketId && player.socketId !== socketId) {
        this.socketIndex.delete(player.socketId);
      }

      player.name = requestedName;
      player.socketId = socketId;
      player.connected = true;
      player.lastSeenAt = Date.now();
    } else {
      const seat = getLowestOpenSeat(room);

      if (seat === -1) {
        throw new Error("This table is full.");
      }

      player = {
        id: nanoid(10),
        socketId,
        connected: true,
        lastSeenAt: Date.now(),
        name: requestedName,
        seat,
        chips: STARTING_CHIPS,
        inHand: false,
        folded: false,
        allIn: false,
        hasActed: false,
        holeCards: [],
        streetContribution: 0,
        totalContribution: 0,
        lastAction: "",
        bestHandName: null,
        lastWinAmount: 0
      };

      room.players.push(player);
      addLog(room, `${player.name} joined seat ${seat + 1}`);
    }

    if (!room.hostId) {
      room.hostId = player.id;
    }

    this.socketIndex.set(socketId, {
      roomId,
      playerId: player.id
    });

    this.promoteHost(room);
    room.updatedAt = Date.now();

    return { room, player };
  }

  leaveSeat(socketId) {
    const { room, player } = this.requirePlayerContext(socketId);

    if (this.isHandLive(room) && player.inHand) {
      throw new Error("Finish the current hand before leaving the table.");
    }

    if (player.socketId) {
      this.socketIndex.delete(player.socketId);
    }

    room.players = room.players.filter((candidate) => candidate.id !== player.id);
    addLog(room, `${player.name} left the table`);
    this.promoteHost(room);
    room.updatedAt = Date.now();

    return { room, playerId: player.id };
  }

  removePlayer(roomId, playerId) {
    const room = this.getRoom(roomId);

    if (!room) {
      throw new Error("Room not found.");
    }

    if (this.isHandLive(room)) {
      throw new Error("Finish the current hand before changing seats.");
    }

    const playerIndex = room.players.findIndex((player) => player.id === playerId);

    if (playerIndex === -1) {
      throw new Error("Player seat not found.");
    }

    const [player] = room.players.splice(playerIndex, 1);

    if (player?.socketId) {
      this.socketIndex.delete(player.socketId);
    }

    if (player) {
      addLog(room, `${player.name} left the table`);
    }

    this.promoteHost(room);
    room.updatedAt = Date.now();
    return room;
  }

  async disconnectSocket(socketId) {
    const mapping = this.socketIndex.get(socketId);

    if (!mapping) {
      return null;
    }

    this.socketIndex.delete(socketId);
    const room = this.getRoom(mapping.roomId);

    if (!room) {
      return null;
    }

    const player = getPlayer(room, mapping.playerId);

    if (!player || player.socketId !== socketId) {
      return room;
    }

    player.connected = false;
    player.socketId = null;
    player.lastSeenAt = Date.now();
    room.updatedAt = Date.now();
    addLog(room, `${player.name} disconnected`);

    this.promoteHost(room);

    if (this.isHandLive(room) && room.currentTurnPlayerId === player.id) {
      const autoAction = room.currentBet > player.streetContribution ? "fold" : "check";
      const snapshot = cloneValue(room);

      try {
        await this.applyAction(room, player, { type: autoAction }, { auto: true });
      } catch (error) {
        restoreRoomSnapshot(room, snapshot);
      }
    }

    return room;
  }

  async startHand(socketId) {
    const { room, player } = this.requirePlayerContext(socketId);
    const snapshot = cloneValue(room);

    if (room.hostId !== player.id) {
      throw new Error("Only the host can start the next hand.");
    }

    if (this.isHandLive(room)) {
      throw new Error("Finish the current hand before dealing again.");
    }

    const eligiblePlayers = getEligiblePlayers(room);

    if (eligiblePlayers.length < 2) {
      throw new Error("At least two players with chips are required.");
    }

    try {
      room.handNumber += 1;
      room.phase = "preflop";
      room.deckId = null;
      room.communityCards = [];
      room.pot = 0;
      room.currentBet = 0;
      room.minimumRaise = BIG_BLIND;
      room.currentTurnPlayerId = null;
      room.pendingReveal = null;
      room.pendingDeckMessage = "";
      room.showdown = null;
      room.smallBlindPlayerId = null;
      room.bigBlindPlayerId = null;
      room.updatedAt = Date.now();

      for (const seatedPlayer of room.players) {
        resetPlayerForHand(seatedPlayer);
      }

      room.dealerSeat = getNextPlayerAfterSeat(
        room,
        room.dealerSeat,
        (candidate) => candidate.chips > 0 && candidate.connected
      ).seat;

      for (const seatedPlayer of eligiblePlayers) {
        seatedPlayer.inHand = true;
      }

      const dealer = getPlayerBySeat(room, room.dealerSeat);
      const smallBlindPlayer =
        eligiblePlayers.length === 2
          ? dealer
          : getNextPlayerAfterSeat(room, room.dealerSeat, (candidate) => candidate.inHand);
      const bigBlindPlayer = getNextPlayerAfterSeat(room, smallBlindPlayer.seat, (candidate) => candidate.inHand);

      room.smallBlindPlayerId = smallBlindPlayer.id;
      room.bigBlindPlayerId = bigBlindPlayer.id;

      const deck = await this.deckApi.createDeck(1);
      room.deckId = deck.deck_id;

      const dealOrder = getPlayersStartingAfterSeat(room, smallBlindPlayer.seat - 1, (candidate) => candidate.inHand);
      const holeCardCount = dealOrder.length * 2;
      const drawResponse = await this.deckApi.drawCards(room.deckId, holeCardCount);

      drawResponse.cards.forEach((card, index) => {
        const recipient = dealOrder[index % dealOrder.length];
        recipient.holeCards.push(card);
      });

      const smallBlindPosted = postChips(room, smallBlindPlayer, SMALL_BLIND);
      const bigBlindPosted = postChips(room, bigBlindPlayer, BIG_BLIND);

      smallBlindPlayer.lastAction = `Small blind ${formatChips(smallBlindPosted)}`;
      bigBlindPlayer.lastAction = `Big blind ${formatChips(bigBlindPosted)}`;
      room.currentBet = Math.max(smallBlindPosted, bigBlindPosted);
      room.minimumRaise = BIG_BLIND;

      addLog(
        room,
        `Hand ${room.handNumber} started. ${smallBlindPlayer.name} posted ${formatChips(
          smallBlindPosted
        )}, ${bigBlindPlayer.name} posted ${formatChips(bigBlindPosted)}`
      );

      const firstToAct = getNextPlayerAfterSeat(
        room,
        bigBlindPlayer.seat,
        (candidate) => candidate.inHand && !candidate.allIn
      );
      room.currentTurnPlayerId = firstToAct?.id ?? null;

      if (!room.currentTurnPlayerId) {
        await this.runOutBoardToShowdown(room);
      }

      return room;
    } catch (error) {
      restoreRoomSnapshot(room, snapshot);
      throw error;
    }
  }

  async handleAction(socketId, payload) {
    const { room, player } = this.requirePlayerContext(socketId);
    const snapshot = cloneValue(room);

    try {
      await this.applyAction(room, player, payload);
      room.updatedAt = Date.now();
      return room;
    } catch (error) {
      restoreRoomSnapshot(room, snapshot);
      throw error;
    }
  }

  async resumeHand(socketId) {
    const { room, player } = this.requirePlayerContext(socketId);

    if (room.hostId !== player.id) {
      throw new Error("Only the host can continue the hand.");
    }

    if (!room.pendingReveal) {
      throw new Error("There is nothing to continue right now.");
    }

    room.pendingDeckMessage = "";
    await this.advanceStreetOrShowdown(room);
    room.updatedAt = Date.now();
    return room;
  }

  serializeRoomForPlayer(roomId, viewerId) {
    const room = this.getRoom(roomId);

    if (!room) {
      return null;
    }

    const viewer = getPlayer(room, viewerId);
    const callGap = viewer ? Math.max(0, room.currentBet - viewer.streetContribution) : 0;
    const callAmount = Math.min(callGap, viewer?.chips ?? 0);
    const maxRaiseTo = viewer ? viewer.streetContribution + viewer.chips : 0;
    const rawMinRaiseTo = room.currentBet === 0 ? BIG_BLIND : room.currentBet + room.minimumRaise;
    const canAct =
      viewer &&
      room.currentTurnPlayerId === viewer.id &&
      this.isHandLive(room) &&
      !room.pendingReveal &&
      viewer.inHand &&
      !viewer.folded &&
      !viewer.allIn;
    const canRaise = canAct && maxRaiseTo >= rawMinRaiseTo && maxRaiseTo > room.currentBet;

    return {
      roomId: room.id,
      backCardImage: BACK_CARD_IMAGE,
      phase: room.phase,
      handNumber: room.handNumber,
      pot: room.pot,
      currentBet: room.currentBet,
      minimumRaise: room.minimumRaise,
      smallBlind: room.smallBlind,
      bigBlind: room.bigBlind,
      dealerSeat: room.dealerSeat,
      currentTurnPlayerId: room.currentTurnPlayerId,
      pendingReveal: room.pendingReveal,
      pendingDeckMessage: room.pendingDeckMessage,
      hostId: room.hostId,
      maxPlayers: room.maxPlayers,
      tableMessage: buildTableMessage(room),
      communityCards: room.communityCards,
      actionLog: room.actionLog,
      showdown: room.showdown,
      viewerPlayerId: viewer?.id ?? null,
      players: getPlayersInSeatOrder(room).map((player) => {
        const revealCards =
          player.id === viewerId || (room.phase === "showdown" && player.inHand && !player.folded);

        return {
          id: player.id,
          name: player.name,
          isBot: Boolean(player.isBot),
          botDifficulty: player.botDifficulty ?? null,
          seat: player.seat,
          chips: player.chips,
          connected: player.connected,
          inHand: player.inHand,
          folded: player.folded,
          allIn: player.allIn,
          lastAction: player.lastAction,
          streetContribution: player.streetContribution,
          totalContribution: player.totalContribution,
          bestHandName: player.bestHandName,
          lastWinAmount: player.lastWinAmount,
          isHost: room.hostId === player.id,
          isDealer: room.dealerSeat === player.seat,
          isSmallBlind: room.smallBlindPlayerId === player.id,
          isBigBlind: room.bigBlindPlayerId === player.id,
          holeCards: revealCards ? player.holeCards : [],
          cardCount: player.inHand ? player.holeCards.length : 0,
          revealCards
        };
      }),
      controls: {
        canAct,
        canCheck: canAct && callGap === 0,
        canCall: canAct && callGap > 0,
        canFold: canAct,
        canRaise,
        callAmount,
        minRaiseTo: canRaise ? rawMinRaiseTo : null,
        maxRaiseTo: canRaise ? maxRaiseTo : null
      },
      canStartHand:
        viewer &&
        viewer.id === room.hostId &&
        !this.isHandLive(room) &&
        getEligiblePlayers(room).length >= 2,
      canResumeHand:
        viewer &&
        viewer.id === room.hostId &&
        this.isHandLive(room) &&
        Boolean(room.pendingReveal)
    };
  }

  requirePlayerContext(socketId) {
    const mapping = this.socketIndex.get(socketId);

    if (!mapping) {
      throw new Error("You are not seated at a room.");
    }

    const room = this.getRoom(mapping.roomId);

    if (!room) {
      throw new Error("Room not found.");
    }

    const player = getPlayer(room, mapping.playerId);

    if (!player) {
      throw new Error("Player seat not found.");
    }

    return { room, player };
  }

  promoteHost(room) {
    const currentHost = getPlayer(room, room.hostId);

    if (currentHost?.connected) {
      return;
    }

    room.hostId =
      getPlayersInSeatOrder(room, (player) => player.connected)[0]?.id ??
      getPlayersInSeatOrder(room)[0]?.id ??
      null;
  }

  isHandLive(room) {
    return LIVE_PHASES.has(room.phase);
  }

  async applyAction(room, player, payload, options = {}) {
    if (!this.isHandLive(room)) {
      throw new Error("There is no active hand to act on.");
    }

    if (room.currentTurnPlayerId !== player.id) {
      throw new Error("It is not your turn.");
    }

    if (!player.inHand || player.folded || player.allIn) {
      throw new Error("This seat cannot act.");
    }

    const action = payload?.type;
    const toCall = Math.max(0, room.currentBet - player.streetContribution);

    switch (action) {
      case "fold": {
        player.folded = true;
        player.hasActed = true;
        player.lastAction = options.auto ? "Auto-fold" : "Fold";
        addLog(room, `${player.name} ${options.auto ? "auto-folded" : "folded"}`);
        break;
      }

      case "check": {
        if (toCall > 0) {
          throw new Error("You cannot check while facing a bet.");
        }

        player.hasActed = true;
        player.lastAction = options.auto ? "Auto-check" : "Check";
        addLog(room, `${player.name} ${options.auto ? "auto-checked" : "checked"}`);
        break;
      }

      case "call": {
        if (toCall === 0) {
          throw new Error("There is nothing to call.");
        }

        const committed = postChips(room, player, toCall);
        player.hasActed = true;
        player.lastAction =
          committed < toCall ? `All in ${formatChips(committed)}` : `Call ${formatChips(committed)}`;
        addLog(
          room,
          `${player.name} ${committed < toCall ? "moved all in for" : "called"} ${formatChips(committed)}`
        );
        break;
      }

      case "raise": {
        const target = clampWholeNumber(payload?.amount);
        const previousBet = room.currentBet;
        const maxTarget = player.streetContribution + player.chips;
        const minTarget = previousBet === 0 ? BIG_BLIND : previousBet + room.minimumRaise;

        if (maxTarget <= previousBet) {
          throw new Error("Your stack only covers a call.");
        }

        if (target < minTarget) {
          throw new Error(`Minimum raise is ${formatChips(minTarget)}.`);
        }

        if (target > maxTarget) {
          throw new Error("Raise exceeds your stack.");
        }

        const additional = target - player.streetContribution;
        const committed = postChips(room, player, additional);

        if (committed !== additional) {
          throw new Error("Unable to post the requested raise.");
        }

        player.hasActed = true;
        player.lastAction = previousBet === 0 ? `Bet ${formatChips(target)}` : `Raise to ${formatChips(target)}`;
        room.currentBet = player.streetContribution;
        room.minimumRaise = Math.max(BIG_BLIND, room.currentBet - previousBet);

        for (const seatedPlayer of room.players) {
          if (seatedPlayer.id === player.id) {
            continue;
          }

          if (!seatedPlayer.inHand || seatedPlayer.folded || seatedPlayer.allIn) {
            continue;
          }

          seatedPlayer.hasActed = false;
        }

        addLog(
          room,
          `${player.name} ${previousBet === 0 ? "bet" : "raised to"} ${formatChips(room.currentBet)}`
        );
        break;
      }

      default:
        throw new Error("Unknown action.");
    }

    await this.advanceHand(room, player.seat);
  }

  async advanceHand(room, actingSeat) {
    if (getContenders(room).length === 1) {
      this.resolveUncontested(room);
      return;
    }

    if (this.isBettingRoundComplete(room)) {
      await this.advanceStreetOrShowdown(room);
      return;
    }

    const nextPlayer = getNextPlayerAfterSeat(
      room,
      actingSeat,
      (candidate) => candidate.inHand && !candidate.folded && !candidate.allIn
    );

    room.currentTurnPlayerId = nextPlayer?.id ?? null;

    if (!room.currentTurnPlayerId) {
      await this.advanceStreetOrShowdown(room);
    }
  }

  isBettingRoundComplete(room) {
    const actionable = getActionablePlayers(room);

    if (!actionable.length) {
      return true;
    }

    return actionable.every(
      (player) => player.hasActed && player.streetContribution === room.currentBet
    );
  }

  pauseForRevealRetry(room, error) {
    const street = getPendingRevealStreet(room.phase);
    room.currentTurnPlayerId = null;
    room.pendingReveal = street;
    room.pendingDeckMessage = buildRevealRetryMessage(street, error);
  }

  async advanceStreetOrShowdown(room) {
    if (getContenders(room).length <= 1) {
      this.resolveUncontested(room);
      return;
    }

    room.currentTurnPlayerId = null;

    if (room.phase === "river") {
      this.resolveShowdown(room);
      return;
    }

    try {
      await this.revealNextStreet(room);
      room.pendingReveal = null;
      room.pendingDeckMessage = "";
    } catch (error) {
      this.pauseForRevealRetry(room, error);
      return;
    }

    resetStreet(room);

    if (getContenders(room).length <= 1) {
      this.resolveUncontested(room);
      return;
    }

    if (getActionablePlayers(room).length <= 1) {
      await this.runOutBoardToShowdown(room);
      return;
    }

    const nextPlayer = getNextPlayerAfterSeat(
      room,
      room.dealerSeat,
      (candidate) => candidate.inHand && !candidate.folded && !candidate.allIn
    );

    room.currentTurnPlayerId = nextPlayer?.id ?? null;

    if (!room.currentTurnPlayerId) {
      await this.runOutBoardToShowdown(room);
    }
  }

  async revealNextStreet(room) {
    if (!room.deckId) {
      throw new Error("Deck is not ready.");
    }

    if (room.phase === "preflop") {
      const reveal = await this.deckApi.drawCards(room.deckId, 4);
      room.communityCards.push(...reveal.cards.slice(1));
      room.phase = "flop";
      addLog(room, `Flop: ${reveal.cards
        .slice(1)
        .map((card) => card.code)
        .join(" ")}`);
      return;
    }

    if (room.phase === "flop") {
      const reveal = await this.deckApi.drawCards(room.deckId, 2);
      room.communityCards.push(reveal.cards[1]);
      room.phase = "turn";
      addLog(room, `Turn: ${reveal.cards[1].code}`);
      return;
    }

    if (room.phase === "turn") {
      const reveal = await this.deckApi.drawCards(room.deckId, 2);
      room.communityCards.push(reveal.cards[1]);
      room.phase = "river";
      addLog(room, `River: ${reveal.cards[1].code}`);
    }
  }

  async runOutBoardToShowdown(room) {
    while (room.phase !== "river") {
      await this.revealNextStreet(room);
    }

    this.resolveShowdown(room);
  }

  resolveUncontested(room) {
    const winner = getContenders(room)[0];

    if (!winner) {
      room.phase = "waiting";
      return;
    }

    winner.chips += room.pot;
    winner.lastWinAmount = room.pot;
    room.phase = "showdown";
    room.currentTurnPlayerId = null;
    room.pendingReveal = null;
    room.pendingDeckMessage = "";
    room.currentBet = 0;
    room.minimumRaise = BIG_BLIND;
    room.showdown = {
      winners: [
        {
          playerId: winner.id,
          name: winner.name,
          amount: room.pot,
          hand: "Uncontested"
        }
      ],
      pots: [
        {
          amount: room.pot,
          winnerIds: [winner.id]
        }
      ],
      message: `${winner.name} won ${formatChips(room.pot)} uncontested`
    };

    addLog(room, `${winner.name} won ${formatChips(room.pot)} uncontested`);
  }

  resolveShowdown(room) {
    const contenders = getContenders(room);
    const contributions = room.players.filter((player) => player.totalContribution > 0);

    if (!contenders.length || !contributions.length) {
      room.phase = "showdown";
      room.currentTurnPlayerId = null;
      room.pendingReveal = null;
      room.pendingDeckMessage = "";
      room.currentBet = 0;
      room.minimumRaise = BIG_BLIND;
      room.showdown = {
        winners: [],
        pots: [],
        message: "Showdown complete"
      };
      return;
    }

    const winnerTotals = new Map();
    const pots = [];

    for (const contender of contenders) {
      const solved = Hand.solve(
        [...contender.holeCards, ...room.communityCards].map((card) => toSolverCard(card))
      );

      contender.bestHandName = solved.descr;
      contender.solvedHand = solved;
    }

    const levels = [...new Set(contributions.map((player) => player.totalContribution))].sort(
      (left, right) => left - right
    );

    let previousLevel = 0;

    for (const level of levels) {
      const amount = contributions.reduce((sum, player) => {
        const portion = Math.max(0, Math.min(player.totalContribution, level) - previousLevel);
        return sum + portion;
      }, 0);

      if (!amount) {
        previousLevel = level;
        continue;
      }

      const eligible = contenders.filter((player) => player.totalContribution >= level);
      const winningHands = Hand.winners(eligible.map((player) => player.solvedHand));
      const winners = eligible.filter((player) =>
        winningHands.some((winningHand) => winningHand === player.solvedHand)
      );
      const orderedWinners = getWinnersInSeatOrder(room, winners);
      const baseShare = Math.floor(amount / orderedWinners.length);
      let remainder = amount % orderedWinners.length;

      for (const winner of orderedWinners) {
        const bonusChip = remainder > 0 ? 1 : 0;
        remainder = Math.max(0, remainder - 1);
        const payout = baseShare + bonusChip;

        winnerTotals.set(winner.id, (winnerTotals.get(winner.id) ?? 0) + payout);
      }

      pots.push({
        amount,
        winnerIds: orderedWinners.map((winner) => winner.id)
      });

      previousLevel = level;
    }

    for (const player of room.players) {
      player.chips += winnerTotals.get(player.id) ?? 0;
      player.lastWinAmount = winnerTotals.get(player.id) ?? 0;
      delete player.solvedHand;
    }

    const winners = [...winnerTotals.entries()]
      .map(([playerId, amount]) => {
        const player = getPlayer(room, playerId);
        return {
          playerId,
          name: player?.name ?? "Player",
          amount,
          hand: player?.bestHandName ?? ""
        };
      })
      .sort((left, right) => right.amount - left.amount);

    room.phase = "showdown";
    room.currentTurnPlayerId = null;
    room.pendingReveal = null;
    room.pendingDeckMessage = "";
    room.currentBet = 0;
    room.minimumRaise = BIG_BLIND;
    room.showdown = {
      winners,
      pots,
      message:
        winners.length === 1
          ? `${winners[0].name} won ${formatChips(winners[0].amount)} with ${winners[0].hand}`
          : `Split pot: ${winners
              .map((winner) => `${winner.name} ${formatChips(winner.amount)}`)
              .join(" / ")}`
    };

    addLog(room, room.showdown.message);
  }
}

function getPlayerBySeat(room, seat) {
  return room.players.find((player) => player.seat === seat) ?? null;
}
