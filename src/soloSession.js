import pokersolver from "pokersolver";

import { PokerRoomManager } from "../server/game.js";

const { Hand } = pokersolver;

const SOLO_HUMAN_SOCKET_ID = "solo-human";
const BOT_LABELS = {
  easy: "Easy Bot",
  medium: "Medium Bot",
  hard: "Hard Bot"
};

const BOT_PROFILES = {
  easy: {
    callFloor: 0.4,
    raiseFloor: 0.84,
    bluffChance: 0.04,
    pressureWeight: 1.15,
    potWeight: 0.4,
    raiseScale: 0.45
  },
  medium: {
    callFloor: 0.32,
    raiseFloor: 0.68,
    bluffChance: 0.1,
    pressureWeight: 0.94,
    potWeight: 0.28,
    raiseScale: 0.75
  },
  hard: {
    callFloor: 0.24,
    raiseFloor: 0.58,
    bluffChance: 0.16,
    pressureWeight: 0.78,
    potWeight: 0.2,
    raiseScale: 1.05
  }
};

const MADE_HAND_STRENGTH = {
  1: 0.14,
  2: 0.4,
  3: 0.56,
  4: 0.72,
  5: 0.78,
  6: 0.86,
  7: 0.92,
  8: 0.97,
  9: 1
};

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function delay(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
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

function rankValue(card) {
  const value = card.code[0];

  switch (value) {
    case "A":
      return 14;
    case "K":
      return 13;
    case "Q":
      return 12;
    case "J":
      return 11;
    case "0":
      return 10;
    default:
      return Number.parseInt(value, 10);
  }
}

function buildBotName(difficulty, index) {
  return `${BOT_LABELS[difficulty]} ${index}`;
}

function roundToTen(value) {
  return Math.round(value / 10) * 10;
}

function evaluatePreflop(holeCards) {
  if (holeCards.length < 2) {
    return 0;
  }

  const values = holeCards.map(rankValue).sort((left, right) => right - left);
  const [high, low] = values;
  const suited = holeCards[0].code[1] === holeCards[1].code[1];
  const pair = high === low;
  const gap = Math.abs(high - low);

  if (pair) {
    return clamp(0.5 + high / 28, 0, 1);
  }

  let score = 0.16 + Math.max(0, high - 9) * 0.055 + Math.max(0, low - 8) * 0.025;

  if (suited) {
    score += 0.08;
  }

  if (gap === 1) {
    score += 0.08;
  } else if (gap === 2) {
    score += 0.04;
  }

  if (high >= 13 && low >= 10) {
    score += 0.12;
  }

  if (high === 14 && low >= 10) {
    score += 0.08;
  }

  return clamp(score, 0, 1);
}

function getStraightDrawBonus(cards) {
  const unique = [...new Set(cards.map(rankValue))].sort((left, right) => left - right);

  if (unique.includes(14)) {
    unique.unshift(1);
  }

  let bestRun = 1;
  let currentRun = 1;

  for (let index = 1; index < unique.length; index += 1) {
    if (unique[index] === unique[index - 1] + 1) {
      currentRun += 1;
      bestRun = Math.max(bestRun, currentRun);
      continue;
    }

    if (unique[index] !== unique[index - 1]) {
      currentRun = 1;
    }
  }

  if (bestRun >= 5) {
    return 0;
  }

  if (bestRun === 4) {
    return 0.08;
  }

  if (bestRun === 3) {
    return 0.03;
  }

  return 0;
}

function getFlushDrawBonus(cards) {
  const counts = cards.reduce((collection, card) => {
    const suit = card.code[1];
    collection[suit] = (collection[suit] ?? 0) + 1;
    return collection;
  }, {});

  const maxSuitCount = Math.max(0, ...Object.values(counts));

  if (maxSuitCount >= 5) {
    return 0;
  }

  if (maxSuitCount === 4) {
    return 0.1;
  }

  if (maxSuitCount === 3) {
    return 0.04;
  }

  return 0;
}

function evaluatePostflop(holeCards, communityCards) {
  const allCards = [...holeCards, ...communityCards];

  if (allCards.length < 5) {
    return evaluatePreflop(holeCards);
  }

  const solved = Hand.solve(allCards.map(toSolverCard));
  const madeStrength = MADE_HAND_STRENGTH[solved.rank] ?? 0.12;
  const drawBonus = getFlushDrawBonus(allCards) + getStraightDrawBonus(allCards);

  return clamp(madeStrength + drawBonus, 0, 1);
}

function buildRaiseTarget(room, player, profile, confidence) {
  const minRaiseTo = room.currentBet === 0 ? room.bigBlind : room.currentBet + room.minimumRaise;
  const maxRaiseTo = player.streetContribution + player.chips;

  if (maxRaiseTo < minRaiseTo || maxRaiseTo <= room.currentBet) {
    return null;
  }

  if (confidence > 0.94) {
    return maxRaiseTo;
  }

  const scaledPot = room.pot * (profile.raiseScale + confidence * 0.6);
  const desired = room.currentBet + room.minimumRaise + scaledPot;

  return clamp(roundToTen(desired), minRaiseTo, maxRaiseTo);
}

function chooseBotAction(room, player) {
  const profile = BOT_PROFILES[player.botDifficulty] ?? BOT_PROFILES.medium;
  const toCall = Math.max(0, room.currentBet - player.streetContribution);
  const cards = [...player.holeCards, ...room.communityCards];
  const preflopStrength = evaluatePreflop(player.holeCards);
  const handStrength =
    room.communityCards.length < 3
      ? preflopStrength
      : preflopStrength * 0.34 + evaluatePostflop(player.holeCards, room.communityCards) * 0.66;
  const confidence = clamp(handStrength + (Math.random() * 0.08 - 0.04), 0, 1);
  const pressure = toCall / Math.max(1, player.chips);
  const potOdds = toCall / Math.max(1, room.pot + toCall);
  const maxRaiseTo = player.streetContribution + player.chips;
  const minRaiseTo = room.currentBet === 0 ? room.bigBlind : room.currentBet + room.minimumRaise;
  const canRaise = maxRaiseTo >= minRaiseTo && maxRaiseTo > room.currentBet;
  const adjustedConfidence = confidence - pressure * profile.pressureWeight - potOdds * profile.potWeight;

  if (toCall === 0) {
    if (canRaise && (confidence >= profile.raiseFloor || (confidence >= 0.45 && Math.random() < profile.bluffChance))) {
      return {
        type: "raise",
        amount: buildRaiseTarget(room, player, profile, confidence)
      };
    }

    return {
      type: "check"
    };
  }

  if (canRaise && confidence >= profile.raiseFloor && Math.random() < 0.78) {
    return {
      type: "raise",
      amount: buildRaiseTarget(room, player, profile, confidence)
    };
  }

  if (adjustedConfidence >= profile.callFloor || toCall <= room.bigBlind * 2 || player.chips <= toCall) {
    return {
      type: "call"
    };
  }

  return {
    type: "fold"
  };
}

export class SoloPokerSession {
  constructor({ onUpdate, onError, onBotState }) {
    this.manager = new PokerRoomManager();
    this.room = this.manager.createRoom();
    this.roomId = this.room.id;
    this.humanPlayerId = null;
    this.botCount = 0;
    this.isBotLoopRunning = false;
    this.isDestroyed = false;
    this.onUpdate = onUpdate;
    this.onError = onError;
    this.onBotState = onBotState;
  }

  ensureHuman(name) {
    const { player } = this.manager.joinRoom({
      roomId: this.roomId,
      socketId: SOLO_HUMAN_SOCKET_ID,
      name,
      playerId: this.humanPlayerId
    });

    this.humanPlayerId = player.id;
    player.isBot = false;
    player.botDifficulty = null;
    this.sync();
  }

  addBot(difficulty) {
    this.botCount += 1;

    const { player } = this.manager.joinRoom({
      roomId: this.roomId,
      socketId: `solo-bot-${this.botCount}`,
      name: buildBotName(difficulty, this.botCount),
      playerId: null
    });

    player.isBot = true;
    player.botDifficulty = difficulty;
    this.sync();
  }

  removePlayer(playerId) {
    if (playerId === this.humanPlayerId) {
      return;
    }

    this.manager.removePlayer(this.roomId, playerId);
    this.sync();
  }

  async startHand() {
    await this.manager.startHand(SOLO_HUMAN_SOCKET_ID);
    this.sync();
    await this.runBots();
  }

  async handleHumanAction(payload) {
    await this.manager.handleAction(SOLO_HUMAN_SOCKET_ID, payload);
    this.sync();
    await this.runBots();
  }

  getSnapshot() {
    return this.manager.serializeRoomForPlayer(this.roomId, this.humanPlayerId);
  }

  async runBots() {
    if (this.isBotLoopRunning || this.isDestroyed) {
      return;
    }

    this.isBotLoopRunning = true;
    this.onBotState?.(true);

    try {
      while (!this.isDestroyed) {
        const room = this.manager.getRoom(this.roomId);

        if (!room || !this.manager.isHandLive(room) || !room.currentTurnPlayerId) {
          break;
        }

        if (room.currentTurnPlayerId === this.humanPlayerId) {
          break;
        }

        const player = room.players.find((candidate) => candidate.id === room.currentTurnPlayerId);

        if (!player?.isBot) {
          break;
        }

        await delay(520);

        if (this.isDestroyed) {
          break;
        }

        const action = chooseBotAction(room, player);
        await this.manager.handleAction(player.socketId, action);
        this.sync();
      }
    } catch (error) {
      this.onError?.(error instanceof Error ? error.message : "Bot action failed.");
    } finally {
      this.isBotLoopRunning = false;
      this.onBotState?.(false);
      this.sync();
    }
  }

  sync() {
    if (this.isDestroyed) {
      return;
    }

    this.onUpdate?.(this.getSnapshot());
  }

  destroy() {
    this.isDestroyed = true;
    this.onBotState?.(false);
  }
}
