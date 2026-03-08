import { useEffect, useRef, useState } from "react";
import { BrowserRouter, Link, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { io } from "socket.io-client";

import { useRoomSounds } from "./gameSounds.js";
import { ActionLog, ShowdownPanel, TableSurface, formatChips } from "./pokerTable.jsx";
import { SoloPokerSession } from "./soloSession.js";

const ACTIVE_PHASES = new Set(["preflop", "flop", "turn", "river"]);
const SOLO_NAME_STORAGE_KEY = "luxe-holdem:solo-name";
const BOT_OPTIONS = [
  {
    id: "easy",
    title: "Easy",
    description: "Loose and predictable."
  },
  {
    id: "medium",
    title: "Medium",
    description: "Balanced and steadier."
  },
  {
    id: "hard",
    title: "Hard",
    description: "More aggressive pressure."
  }
];
const RULE_FLOW = [
  {
    title: "Pre-flop",
    description: "Each player gets two private cards and the first betting round starts after the blinds."
  },
  {
    title: "Flop",
    description: "Three community cards hit the table and betting opens again."
  },
  {
    title: "Turn",
    description: "A fourth community card is revealed, then another betting round begins."
  },
  {
    title: "River",
    description: "The fifth and final community card lands before the last round of betting."
  },
  {
    title: "Showdown",
    description: "Anyone still in the hand makes the best five-card hand from any combination of the seven cards."
  }
];
const RULE_ACTIONS = [
  {
    title: "Check",
    description: "Pass the action when no bet is facing you."
  },
  {
    title: "Call",
    description: "Match the current bet to stay in the hand."
  },
  {
    title: "Raise",
    description: "Increase the price of the hand and put pressure on the table."
  },
  {
    title: "Fold",
    description: "Give up the hand and preserve the chips you have left."
  }
];
const RULE_SAMPLE_HOLE_CARDS = ["AS", "KH"];
const RULE_SAMPLE_BOARD = ["QC", "JD", "9S", "5H", "2D"];
const HAND_LEADERBOARD = [
  {
    title: "Royal Flush",
    description: "A, K, Q, J, 10 of the same suit.",
    codes: ["AS", "KS", "QS", "JS", "0S"]
  },
  {
    title: "Straight Flush",
    description: "Five cards in sequence, all the same suit.",
    codes: ["9H", "8H", "7H", "6H", "5H"]
  },
  {
    title: "Four of a Kind",
    description: "Four cards of the same rank.",
    codes: ["9S", "9H", "9D", "9C", "2H"]
  },
  {
    title: "Full House",
    description: "Three of a kind plus a pair.",
    codes: ["KD", "KS", "KC", "5H", "5C"]
  },
  {
    title: "Flush",
    description: "Five cards of the same suit.",
    codes: ["AH", "QH", "9H", "5H", "2H"]
  },
  {
    title: "Straight",
    description: "Five cards in sequence, mixed suits allowed.",
    codes: ["9S", "8D", "7H", "6C", "5S"]
  },
  {
    title: "Three of a Kind",
    description: "Three cards of the same rank.",
    codes: ["7S", "7D", "7C", "QH", "2D"]
  },
  {
    title: "Two Pair",
    description: "Two separate pairs in the same hand.",
    codes: ["JS", "JD", "4C", "4H", "9D"]
  },
  {
    title: "One Pair",
    description: "Two cards of the same rank.",
    codes: ["AC", "AD", "0H", "7S", "3C"]
  },
  {
    title: "High Card",
    description: "When nothing else lands, the highest card plays.",
    codes: ["AS", "QD", "9H", "6C", "2S"]
  }
];

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function storageKey(roomId) {
  return `luxe-holdem:${roomId}`;
}

function loadStoredSession(roomId) {
  try {
    const raw = window.localStorage.getItem(storageKey(roomId));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveStoredSession(roomId, session) {
  try {
    if (!session?.name) {
      window.localStorage.removeItem(storageKey(roomId));
      return;
    }

    window.localStorage.setItem(storageKey(roomId), JSON.stringify(session));
  } catch {
    // Storage access is optional.
  }
}

function loadSoloName() {
  try {
    return window.localStorage.getItem(SOLO_NAME_STORAGE_KEY) ?? "You";
  } catch {
    return "You";
  }
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall back below.
    }
  }

  try {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand("copy");
    textarea.remove();
    return copied;
  } catch {
    return false;
  }
}

function isHandLive(room) {
  return ACTIVE_PHASES.has(room?.phase ?? "waiting");
}

function buildQuickRaiseOptions(room, viewer) {
  if (!room?.controls?.canRaise || !viewer) {
    return [];
  }

  const minimum = room.controls.minRaiseTo;
  const maximum = room.controls.maxRaiseTo;
  const toCall = room.controls.callAmount;

  return [
    { label: "Min", value: minimum },
    {
      label: "Pressure",
      value: viewer.streetContribution + toCall + Math.max(room.bigBlind * 4, Math.ceil(room.pot / 2))
    },
    {
      label: "Pot",
      value: viewer.streetContribution + toCall + room.pot
    },
    {
      label: "All",
      value: maximum
    }
  ]
    .map((option) => ({
      ...option,
      value: clamp(option.value, minimum, maximum)
    }))
    .filter((option, index, collection) => collection.findIndex((item) => item.value === option.value) === index);
}

function getDeckStaticImage(code) {
  return "https://deckofcardsapi.com/static/img/" + code + ".png";
}

function PokerRulesModal({ open, onClose }) {
  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const previousOverflow = document.body.style.overflow;

    function handleKeyDown(event) {
      if (event.key === "Escape") {
        onClose();
      }
    }

    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handleKeyDown);

    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, open]);

  if (!open) {
    return null;
  }

  return (
    <div className="rules-overlay" onClick={onClose} role="presentation">
      <section
        aria-labelledby="rules-title"
        aria-modal="true"
        className="rules-dialog"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
      >
        <div className="rules-dialog-header">
          <div>
            <span className="section-label">Table guide</span>
            <h2 id="rules-title">How Dock Poker works</h2>
            <p>
              Texas Hold&apos;em uses two private hole cards, five shared community cards, and the best five-card hand at
              showdown.
            </p>
          </div>
          <button aria-label="Close rules" className="ghost-button rules-close-button" onClick={onClose} type="button">
            Close
          </button>
        </div>

        <div className="rules-hero">
          <div className="rules-hero-copy">
            <span className="section-label">Deck of Cards API</span>
            <h3>Real card art, clean hand flow</h3>
            <p>
              Each hand is shuffled and drawn through the Deck of Cards API, then played as a live Hold&apos;em table with
              blinds, betting rounds, and showdown.
            </p>
            <div className="rules-pill-row">
              <span>2 hole cards</span>
              <span>5 community cards</span>
              <span>Best 5-card hand wins</span>
            </div>
          </div>

          <div className="rules-card-stage">
            <div className="rules-card-row">
              {RULE_SAMPLE_HOLE_CARDS.map((code) => (
                <div className="card-face rules-card-face" key={code}>
                  <img alt={"Example hole card " + code} src={getDeckStaticImage(code)} />
                </div>
              ))}
            </div>
            <div className="rules-card-row rules-card-row-board">
              {RULE_SAMPLE_BOARD.map((code) => (
                <div className="card-face rules-card-face" key={code}>
                  <img alt={"Example board card " + code} src={getDeckStaticImage(code)} />
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="rules-grid">
          <section className="rules-panel">
            <span className="section-label">Round flow</span>
            <div className="rules-list">
              {RULE_FLOW.map((item) => (
                <article className="rules-list-item" key={item.title}>
                  <strong>{item.title}</strong>
                  <p>{item.description}</p>
                </article>
              ))}
            </div>
          </section>

          <section className="rules-panel">
            <span className="section-label">Actions</span>
            <div className="rules-list">
              {RULE_ACTIONS.map((item) => (
                <article className="rules-list-item" key={item.title}>
                  <strong>{item.title}</strong>
                  <p>{item.description}</p>
                </article>
              ))}
            </div>
          </section>

          <section className="rules-panel">
            <span className="section-label">Winning the pot</span>
            <div className="rules-list">
              <article className="rules-list-item">
                <strong>Make the best five</strong>
                <p>You can use both hole cards, one, or none. The best five-card combination plays.</p>
              </article>
              <article className="rules-list-item">
                <strong>Split pots happen</strong>
                <p>If two or more players tie, the pot is split as evenly as possible.</p>
              </article>
              <article className="rules-list-item">
                <strong>Blinds keep the action moving</strong>
                <p>
                  The button rotates, blinds post automatically, and betting continues until one player wins or the hand
                  reaches showdown.
                </p>
              </article>
            </div>
          </section>
        </div>
      </section>
    </div>
  );
}

function HomeRulesSection() {
  return (
    <section className="home-rules-shell">
      <div className="home-rules-panel">
        <div className="home-rules-intro">
          <div className="home-rules-copy">
            <span className="section-label">How to play</span>
            <h2>Learn the table before you deal.</h2>
            <p>
              Dock Poker follows classic Texas Hold&apos;em. You get two private cards, share five community cards with the
              table, and make the best five-card hand by the time the action reaches showdown.
            </p>
            <div className="rules-pill-row">
              <span>Blinds rotate every hand</span>
              <span>Use any 5 of 7 cards</span>
              <span>Last player standing wins</span>
            </div>
          </div>

          <div className="rules-card-stage home-rules-card-stage">
            <div className="home-rules-demo-group">
              <span className="section-label">Hole cards</span>
              <div className="rules-card-row">
                {RULE_SAMPLE_HOLE_CARDS.map((code) => (
                  <div className="card-face rules-card-face" key={code}>
                    <img alt={"Example hole card " + code} src={getDeckStaticImage(code)} />
                  </div>
                ))}
              </div>
            </div>

            <div className="home-rules-demo-group">
              <span className="section-label">Board</span>
              <div className="rules-card-row rules-card-row-board">
                {RULE_SAMPLE_BOARD.map((code) => (
                  <div className="card-face rules-card-face" key={code}>
                    <img alt={"Example board card " + code} src={getDeckStaticImage(code)} />
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>

        <div className="home-rules-grid">
          <section className="rules-panel">
            <span className="section-label">Round flow</span>
            <div className="rules-list">
              {RULE_FLOW.map((item) => (
                <article className="rules-list-item" key={item.title}>
                  <strong>{item.title}</strong>
                  <p>{item.description}</p>
                </article>
              ))}
            </div>
          </section>

          <section className="rules-panel">
            <span className="section-label">Actions</span>
            <div className="rules-list">
              {RULE_ACTIONS.map((item) => (
                <article className="rules-list-item" key={item.title}>
                  <strong>{item.title}</strong>
                  <p>{item.description}</p>
                </article>
              ))}
            </div>
          </section>

          <section className="rules-panel">
            <span className="section-label">Table basics</span>
            <div className="rules-list">
              <article className="rules-list-item">
                <strong>Best five cards only</strong>
                <p>You can use both hole cards, one, or none. Only the strongest five-card hand counts.</p>
              </article>
              <article className="rules-list-item">
                <strong>Blinds start the action</strong>
                <p>The small blind and big blind post automatically before cards are dealt.</p>
              </article>
              <article className="rules-list-item">
                <strong>Split pots are possible</strong>
                <p>If players tie with the same best hand, the pot is split between them.</p>
              </article>
            </div>
          </section>
        </div>

        <div className="hand-rank-header">
          <div>
            <span className="section-label">Hand leaderboard</span>
            <h2>Best hands from highest to lowest</h2>
            <p>Keep this ranking guide close when the table gets to showdown.</p>
          </div>
        </div>

        <div className="hand-rank-grid">
          {HAND_LEADERBOARD.map((hand, index) => (
            <article className="hand-rank-card" key={hand.title}>
              <div className="hand-rank-copy">
                <span className="hand-rank-position">#{index + 1}</span>
                <div>
                  <strong>{hand.title}</strong>
                  <p>{hand.description}</p>
                </div>
              </div>
              <div className="hand-rank-cards">
                {hand.codes.map((code) => (
                  <div className="card-face rules-card-face" key={code}>
                    <img alt={hand.title + " example " + code} src={getDeckStaticImage(code)} />
                  </div>
                ))}
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/room/:roomId" element={<RoomPage />} />
        <Route path="/solo" element={<SoloPage />} />
      </Routes>
    </BrowserRouter>
  );
}

function HomePage() {
  const navigate = useNavigate();
  const [roomCode, setRoomCode] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  async function handleCreateRoom() {
    setCreating(true);
    setError("");

    try {
      const response = await fetch("/api/rooms", {
        method: "POST"
      });

      if (!response.ok) {
        throw new Error("Room creation failed.");
      }

      const payload = await response.json();
      navigate(`/room/${payload.roomId}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Room creation failed.");
    } finally {
      setCreating(false);
    }
  }

  function handleJoinRoom(event) {
    event.preventDefault();
    const normalized = roomCode.trim().toUpperCase();

    if (!normalized) {
      setError("Enter a room code or create a new one.");
      return;
    }

    navigate(`/room/${normalized}`);
  }

  return (
    <main className="home-shell">
      <div className="home-noise" />
      <section className="hero-panel">
        <div className="hero-copy">
          <p className="eyebrow">Dock Poker</p>
          <h1>Play Texas Hold&apos;em online with friends.</h1>
          <p className="hero-text">
            Create a private table, join with a room code, or play a local game with bots whenever you want a quick hand.
          </p>
          <div className="hero-actions">
            <button className="primary-button" onClick={handleCreateRoom} disabled={creating} type="button">
              {creating ? "Creating room..." : "Create Room"}
            </button>
            <Link className="secondary-button hero-link-button" to="/solo">
              Single Player
            </Link>
            <form className="join-form" onSubmit={handleJoinRoom}>
              <input
                className="text-input"
                value={roomCode}
                onChange={(event) => setRoomCode(event.target.value.toUpperCase())}
                placeholder="Enter room code"
                maxLength={8}
              />
              <button className="secondary-button" type="submit">
                Join
              </button>
            </form>
          </div>
          {error ? <p className="error-banner">{error}</p> : null}
        </div>

        <div className="hero-preview">
          <div className="preview-card floating-card preview-card-01">
            <span className="preview-label">Private tables</span>
            <strong>Invite your table</strong>
            <p>Create a room, share the link, and get everyone into the same game in seconds.</p>
          </div>
          <div className="preview-card floating-card preview-card-02">
            <span className="preview-label">Table-first play</span>
            <strong>Clean from deal to showdown</strong>
            <p>Follow the board, pot, and action without fighting the screen or losing the flow of the hand.</p>
          </div>
          <div className="preview-card preview-card-wide">
            <div className="chip-line">
              <span />
              <span />
              <span />
            </div>
            <div className="preview-metrics">
              <div>
                <small>Game</small>
                <strong>Texas Hold&apos;em</strong>
              </div>
              <div>
                <small>Play</small>
                <strong>Private rooms</strong>
              </div>
              <div>
                <small>Modes</small>
                <strong>Solo + Friends</strong>
              </div>
            </div>
          </div>
        </div>
      </section>
      <HomeRulesSection />
    </main>
  );
}

function RoomPage() {
  const { roomId: rawRoomId } = useParams();
  const roomId = `${rawRoomId ?? ""}`.trim().toUpperCase();
  const [session, setSession] = useState(() => loadStoredSession(roomId));
  const [sessionRoomId, setSessionRoomId] = useState(roomId);
  const [displayName, setDisplayName] = useState(() => loadStoredSession(roomId)?.name ?? "");
  const [room, setRoom] = useState(null);
  const [error, setError] = useState("");
  const [connected, setConnected] = useState(false);
  const [copied, setCopied] = useState(false);
  const [raiseTarget, setRaiseTarget] = useState(0);
  const [rulesOpen, setRulesOpen] = useState(false);
  const socketRef = useRef(null);
  const copyTimerRef = useRef(null);

  useRoomSounds(room);

  useEffect(() => {
    const saved = loadStoredSession(roomId);
    setSessionRoomId(roomId);
    setSession(saved);
    setDisplayName(saved?.name ?? "");
    setRoom(null);
    setError("");
    setCopied(false);
  }, [roomId]);

  useEffect(() => {
    const socket = io({
      autoConnect: true
    });

    socketRef.current = socket;

    socket.on("connect", () => {
      setConnected(true);
    });

    socket.on("disconnect", () => {
      setConnected(false);
    });

    socket.on("room:joined", (payload) => {
      setSession((current) => {
        const next = {
          name: current?.name || "Player",
          playerId: payload.playerId
        };
        saveStoredSession(roomId, next);
        return next;
      });
      setError("");
    });

    socket.on("room:state", (nextRoom) => {
      setRoom(nextRoom);
      setError("");
    });

    socket.on("room:error", (payload) => {
      setError(payload?.message ?? "Unable to update the room.");
    });

    socket.on("room:left", (payload) => {
      saveStoredSession(roomId, null);
      setSession(null);
      setError("");
      setRoom((current) =>
        current
          ? {
              ...current,
              viewerPlayerId: null,
              players: current.players.filter((player) => player.id !== payload?.playerId)
            }
          : null
      );
    });

    return () => {
      socket.disconnect();
      socketRef.current = null;
    };
  }, [roomId]);

  useEffect(() => {
    if (sessionRoomId !== roomId) {
      return;
    }

    saveStoredSession(roomId, session);
  }, [roomId, session, sessionRoomId]);

  useEffect(() => {
    if (!connected || !session?.name || !socketRef.current) {
      return;
    }

    socketRef.current.emit("room:join", {
      roomId,
      name: session.name,
      playerId: session.playerId
    });
  }, [connected, roomId, session]);

  useEffect(() => {
    if (!room?.controls?.canRaise) {
      setRaiseTarget(0);
      return;
    }

    setRaiseTarget((current) => {
      const next = current || room.controls.minRaiseTo;
      return clamp(next, room.controls.minRaiseTo, room.controls.maxRaiseTo);
    });
  }, [room]);

  useEffect(
    () => () => {
      if (copyTimerRef.current) {
        window.clearTimeout(copyTimerRef.current);
      }
    },
    []
  );

  const viewer = room?.players.find((player) => player.id === room.viewerPlayerId) ?? null;
  const quickRaiseOptions = buildQuickRaiseOptions(room, viewer);
  const shareUrl = typeof window === "undefined" ? `/room/${roomId}` : window.location.href;
  const joinButtonLabel = session?.playerId ? "Rejoin Table" : "Join Table";
  const canLeaveSeat = Boolean(viewer) && (!isHandLive(room) || !viewer.inHand);

  function clearSavedSeat() {
    saveStoredSession(roomId, null);
    setSession(null);
    setError("");
    setRoom((current) =>
      current
        ? {
            ...current,
            viewerPlayerId: null
          }
        : null
    );
  }

  async function handleCopyLink() {
    const copiedLink = await copyText(shareUrl);
    setCopied(copiedLink);

    if (copiedLink) {
      if (copyTimerRef.current) {
        window.clearTimeout(copyTimerRef.current);
      }

      copyTimerRef.current = window.setTimeout(() => setCopied(false), 1500);
      return;
    }

    setError("Unable to copy the invite link on this device.");
  }

  function handleJoinTable(event) {
    event.preventDefault();
    const normalizedName = displayName.trim();

    if (!normalizedName) {
      setError("Enter a name to take a seat.");
      return;
    }

    setSession((current) => ({
      name: normalizedName,
      playerId: current?.playerId ?? null
    }));
    setError("");
  }

  function handleStartHand() {
    socketRef.current?.emit("game:start-hand");
  }

  function handleResumeHand() {
    socketRef.current?.emit("game:resume-hand");
  }

  function handleAction(type, amount) {
    socketRef.current?.emit("game:action", {
      type,
      amount
    });
  }

  function handleLeaveSeat() {
    if (!viewer || !socketRef.current) {
      clearSavedSeat();
      return;
    }

    socketRef.current.emit("room:leave");
  }

  const callLabel =
    room?.controls?.canCall && viewer
      ? room.controls.callAmount < Math.max(0, room.currentBet - viewer.streetContribution)
        ? `All ${formatChips(room.controls.callAmount)}`
        : `Call ${formatChips(room.controls.callAmount)}`
      : "Check";

  return (
    <main className="room-shell">
      <div className="home-noise" />
      <header className="room-header">
        <div>
          <div className="room-header-topline">
            <Link className="room-link" to="/">
              Lobby
            </Link>
            <button className="header-chip-button" onClick={() => setRulesOpen(true)} type="button">
              Rules
            </button>
          </div>
          <h1>Room {roomId}</h1>
          <p>{room?.tableMessage ?? "Connecting to the table..."}</p>
        </div>

        <div className="room-header-actions">
          <span className={`status-pill ${connected ? "is-live" : "is-offline"}`}>
            {connected ? "Live" : "Reconnecting"}
          </span>
          <button className="secondary-button" onClick={handleCopyLink} type="button">
            {copied ? "Link copied" : "Copy room link"}
          </button>
        </div>
      </header>

      {error ? <div className="error-banner room-error">{error}</div> : null}

      <section className="table-layout">
        <TableSurface room={room} />

        <aside className="side-rail">
          <ShowdownPanel showdown={room?.showdown} />
          <FeedRailCard actionLog={room?.actionLog} />
          <ActionRailCard>
            {!viewer ? (
              <form className="rail-action-form" onSubmit={handleJoinTable}>
                <p className="muted-text">
                  {session?.playerId
                    ? "Reconnect to your saved seat, or clear it and join fresh."
                    : "Choose the name that will appear in the room."}
                </p>
                <input
                  className="text-input"
                  value={displayName}
                  onChange={(event) => setDisplayName(event.target.value)}
                  placeholder="Display name"
                  maxLength={18}
                />
                <div className="action-buttons">
                  <button className="primary-button" type="submit">
                    {joinButtonLabel}
                  </button>
                  {session?.playerId ? (
                    <button className="secondary-button" onClick={clearSavedSeat} type="button">
                      Reset Saved Seat
                    </button>
                  ) : null}
                </div>
              </form>
            ) : room?.canResumeHand ? (
              <div className="rail-action-stack">
                <p className="muted-text">
                  {room.pendingDeckMessage ?? `Continue the hand to reveal the ${room.pendingReveal}.`}
                </p>
                <div className="action-buttons">
                  <button className="primary-button" onClick={handleResumeHand} type="button">
                    Continue Hand
                  </button>
                  <button
                    className="secondary-button"
                    disabled={!canLeaveSeat}
                    onClick={handleLeaveSeat}
                    type="button"
                  >
                    Leave Table
                  </button>
                </div>
                {!canLeaveSeat ? <p className="muted-text">Leave is available after the hand.</p> : null}
              </div>
            ) : room?.canStartHand ? (
              <div className="rail-action-stack">
                <p className="muted-text">Everyone seated with chips will be dealt in.</p>
                <div className="action-buttons">
                  <button className="primary-button" onClick={handleStartHand} type="button">
                    Start Hand
                  </button>
                  <button
                    className="secondary-button"
                    disabled={!canLeaveSeat}
                    onClick={handleLeaveSeat}
                    type="button"
                  >
                    Leave Table
                  </button>
                </div>
              </div>
            ) : room?.controls?.canAct ? (
              <PlayerActionPanel
                callLabel={callLabel}
                embedded
                onAction={handleAction}
                quickRaiseOptions={quickRaiseOptions}
                raiseTarget={raiseTarget}
                room={room}
                setRaiseTarget={setRaiseTarget}
                viewer={viewer}
              />
            ) : (
              <div className="rail-action-stack">
                <h3>{room?.tableMessage ?? "Waiting for room state"}</h3>
                <p className="muted-text">
                  {viewer
                    ? `Stack ${formatChips(viewer.chips)}${viewer.bestHandName ? ` | ${viewer.bestHandName}` : ""}`
                    : "Join the table from this device to receive your own seat and cards."}
                </p>
                {viewer ? (
                  <button
                    className="secondary-button"
                    disabled={!canLeaveSeat}
                    onClick={handleLeaveSeat}
                    type="button"
                  >
                    Leave Table
                  </button>
                ) : null}
                {viewer && !canLeaveSeat ? <p className="muted-text">Leave is available after the hand.</p> : null}
                {room?.phase === "showdown" && room?.canStartHand ? (
                  <button className="primary-button" onClick={handleStartHand} type="button">
                    Next Hand
                  </button>
                ) : null}
              </div>
            )}
          </ActionRailCard>
        </aside>
      </section>
      <PokerRulesModal onClose={() => setRulesOpen(false)} open={rulesOpen} />
    </main>
  );
}

function SoloPage() {
  const controllerRef = useRef(null);
  const [playerName] = useState(() => loadSoloName());
  const [room, setRoom] = useState(null);
  const [error, setError] = useState("");
  const [botThinking, setBotThinking] = useState(false);
  const [raiseTarget, setRaiseTarget] = useState(0);
  const [rulesOpen, setRulesOpen] = useState(false);

  useRoomSounds(room);

  useEffect(() => {
    const controller = new SoloPokerSession({
      onUpdate: setRoom,
      onError: setError,
      onBotState: setBotThinking
    });

    controllerRef.current = controller;
    controller.ensureHuman(loadSoloName());

    return () => {
      controller.destroy();
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!room?.controls?.canRaise) {
      setRaiseTarget(0);
      return;
    }

    setRaiseTarget((current) => {
      const next = current || room.controls.minRaiseTo;
      return clamp(next, room.controls.minRaiseTo, room.controls.maxRaiseTo);
    });
  }, [room]);

  const viewer = room?.players.find((player) => player.id === room.viewerPlayerId) ?? null;
  const quickRaiseOptions = buildQuickRaiseOptions(room, viewer);
  const canEditSeats = !isHandLive(room);

  function handleAddBot(difficulty) {
    if (!canEditSeats) {
      setError("Finish the current hand before adding bots.");
      return;
    }

    try {
      controllerRef.current?.addBot(difficulty);
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to add bot.");
    }
  }

  async function handleStartHand() {
    try {
      await controllerRef.current?.startHand();
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to start the hand.");
    }
  }

  async function handleResumeHand() {
    try {
      await controllerRef.current?.resumeHand();
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to continue the hand.");
    }
  }

  async function handleAction(type, amount) {
    try {
      await controllerRef.current?.handleHumanAction({
        type,
        amount
      });
      setError("");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Action failed.");
    }
  }

  const callLabel =
    room?.controls?.canCall && viewer
      ? room.controls.callAmount < Math.max(0, room.currentBet - viewer.streetContribution)
        ? `All ${formatChips(room.controls.callAmount)}`
        : `Call ${formatChips(room.controls.callAmount)}`
      : "Check";

  return (
    <main className="room-shell">
      <div className="home-noise" />
      <header className="room-header">
        <div>
          <div className="room-header-topline">
            <Link className="room-link" to="/">
              Lobby
            </Link>
            <button className="header-chip-button" onClick={() => setRulesOpen(true)} type="button">
              Rules
            </button>
          </div>
          <h1>Solo Table</h1>
          <p>
            {botThinking
              ? "Bots are thinking..."
              : `${playerName} is seated locally. Add bots from any open seat.`}
          </p>
        </div>

        <div className="room-header-actions">
          <span className="status-pill is-live">Local</span>
        </div>
      </header>

      {error ? <div className="error-banner room-error">{error}</div> : null}

      <section className="table-layout">
        <TableSurface
          room={room}
          renderEmptySeat={() => (
            <div className="seat-card empty-seat empty-seat-bot">
              <span className="empty-seat-label">Add bot</span>
              <div className="empty-seat-actions">
                {BOT_OPTIONS.map((option) => (
                  <button
                    key={option.id}
                    className="empty-seat-action"
                    disabled={!canEditSeats || botThinking}
                    onClick={() => handleAddBot(option.id)}
                    type="button"
                  >
                    {option.title}
                  </button>
                ))}
              </div>
            </div>
          )}
        />

        <aside className="side-rail">
          <ShowdownPanel showdown={room?.showdown} />
          <FeedRailCard actionLog={room?.actionLog} />
          <ActionRailCard>
            {room?.canResumeHand ? (
              <div className="rail-action-stack">
                <p className="muted-text">
                  {room.pendingDeckMessage ?? `Continue the hand to reveal the ${room.pendingReveal}.`}
                </p>
                <button
                  className="primary-button"
                  disabled={botThinking}
                  onClick={handleResumeHand}
                  type="button"
                >
                  Continue Hand
                </button>
              </div>
            ) : room?.canStartHand ? (
              <div className="rail-action-stack">
                <p className="muted-text">Bots act automatically after you or each other.</p>
                <button
                  className="primary-button"
                  disabled={botThinking}
                  onClick={handleStartHand}
                  type="button"
                >
                  Start Hand
                </button>
              </div>
            ) : room?.controls?.canAct ? (
              <PlayerActionPanel
                botThinking={botThinking}
                callLabel={callLabel}
                embedded
                onAction={handleAction}
                quickRaiseOptions={quickRaiseOptions}
                raiseTarget={raiseTarget}
                room={room}
                setRaiseTarget={setRaiseTarget}
                viewer={viewer}
              />
            ) : (
              <div className="rail-action-stack">
                <h3>{botThinking ? "Bots are acting..." : room?.tableMessage ?? "Waiting for local table"}</h3>
                <p className="muted-text">
                  {viewer
                    ? `Stack ${formatChips(viewer.chips)}${viewer.bestHandName ? ` | ${viewer.bestHandName}` : ""}`
                    : "Add bots from the open seats to begin."}
                </p>
                {!room?.players?.some((player) => player.isBot) ? (
                  <span className="status-pill is-offline">Add a bot to start</span>
                ) : null}
              </div>
            )}
          </ActionRailCard>
        </aside>
      </section>
      <PokerRulesModal onClose={() => setRulesOpen(false)} open={rulesOpen} />
    </main>
  );
}

function PlayerActionPanel({
  botThinking = false,
  callLabel,
  embedded = false,
  onAction,
  quickRaiseOptions,
  raiseTarget,
  room,
  setRaiseTarget,
  viewer
}) {
  return (
    <div className={`action-panel action-panel-live ${embedded ? "action-panel-embedded" : ""}`}>
      <div className="action-summary">
        <span className="section-label">Your action</span>
        <h2>{viewer?.name}</h2>
        <p>
          Stack {formatChips(viewer?.chips ?? 0)}. Current contribution {formatChips(viewer?.streetContribution ?? 0)}.
        </p>
      </div>

      <div className="action-buttons">
        <button className="ghost-button" disabled={botThinking} onClick={() => onAction("fold")} type="button">
          Fold
        </button>
        <button
          className="secondary-button"
          disabled={botThinking}
          onClick={() => onAction(room.controls.canCall ? "call" : "check")}
          type="button"
        >
          {callLabel}
        </button>
      </div>

      {room.controls.canRaise ? (
        <div className="raise-panel">
          <div className="raise-header">
            <span>{room.currentBet === 0 ? "Bet" : "Raise to"}</span>
            <strong>{formatChips(raiseTarget)}</strong>
          </div>
          <input
            className="raise-slider"
            type="range"
            min={room.controls.minRaiseTo}
            max={room.controls.maxRaiseTo}
            step="10"
            value={raiseTarget}
            onChange={(event) => setRaiseTarget(Number(event.target.value))}
          />
          <div className="raise-quick-row">
            {quickRaiseOptions.map((option) => (
              <button
                key={option.label}
                className="chip-button"
                disabled={botThinking}
                onClick={() => setRaiseTarget(option.value)}
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
          <div className="raise-submit-row">
            <input
              className="amount-input"
              type="number"
              min={room.controls.minRaiseTo}
              max={room.controls.maxRaiseTo}
              step="10"
              value={raiseTarget}
              onChange={(event) =>
                setRaiseTarget(
                  clamp(Number(event.target.value), room.controls.minRaiseTo, room.controls.maxRaiseTo)
                )
              }
            />
            <button
              className="primary-button"
              disabled={botThinking}
              onClick={() => onAction("raise", raiseTarget)}
              type="button"
            >
              {room.currentBet === 0 ? "Bet" : "Raise"}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function FeedRailCard({ actionLog }) {
  return (
    <section className="rail-card rail-card-feed">
      <div className="rail-card-header">
        <span className="section-label">Table feed</span>
        <strong>Latest actions</strong>
      </div>
      <ActionLog actionLog={actionLog} />
    </section>
  );
}

function ActionRailCard({ children }) {
  return (
    <section className="rail-card rail-card-action">
      <div className="rail-card-header">
        <span className="section-label">Action</span>
        <strong>Table control</strong>
      </div>
      {children}
    </section>
  );
}

export default App;
