import { useEffect, useRef, useState } from "react";
import { BrowserRouter, Link, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { io } from "socket.io-client";

import { ActionFeed, ShowdownPanel, TableSurface, formatChips } from "./pokerTable.jsx";
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
      label: "All in",
      value: maximum
    }
  ]
    .map((option) => ({
      ...option,
      value: clamp(option.value, minimum, maximum)
    }))
    .filter((option, index, collection) => collection.findIndex((item) => item.value === option.value) === index);
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
          <p className="eyebrow">Luxe Hold&apos;em</p>
          <h1>Multiplayer poker with private room URLs and a clean table-first UI.</h1>
          <p className="hero-text">
            Create a room, share the link, deal Texas Hold&apos;em through the Deck of Cards API, or stay local with bots.
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
            <span className="preview-label">Room URLs</span>
            <strong>Private table links</strong>
            <p>Send one URL. Every player lands in the same shared state.</p>
          </div>
          <div className="preview-card floating-card preview-card-02">
            <span className="preview-label">Real multiplayer</span>
            <strong>Socket-synced turns</strong>
            <p>Blinds, betting rounds, board cards, pot, and showdown update live.</p>
          </div>
          <div className="preview-card preview-card-wide">
            <div className="chip-line">
              <span />
              <span />
              <span />
            </div>
            <div className="preview-metrics">
              <div>
                <small>Style</small>
                <strong>Minimal</strong>
              </div>
              <div>
                <small>Game</small>
                <strong>Texas Hold&apos;em</strong>
              </div>
              <div>
                <small>Modes</small>
                <strong>Solo + Rooms</strong>
              </div>
            </div>
          </div>
        </div>
      </section>
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
  const socketRef = useRef(null);
  const copyTimerRef = useRef(null);

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

  function handleAction(type, amount) {
    socketRef.current?.emit("game:action", {
      type,
      amount
    });
  }

  const callLabel =
    room?.controls?.canCall && viewer
      ? room.controls.callAmount < Math.max(0, room.currentBet - viewer.streetContribution)
        ? `All in ${formatChips(room.controls.callAmount)}`
        : `Call ${formatChips(room.controls.callAmount)}`
      : "Check";

  return (
    <main className="room-shell">
      <div className="home-noise" />
      <header className="room-header">
        <div>
          <Link className="room-link" to="/">
            Lobby
          </Link>
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
          <ActionFeed actionLog={room?.actionLog} />
        </aside>
      </section>

      <section className="action-dock">
        {!session?.name ? (
          <form className="join-panel" onSubmit={handleJoinTable}>
            <div>
              <span className="section-label">Seat</span>
              <h2>Take your place at the table</h2>
              <p>Choose the name that will appear in the room.</p>
            </div>
            <div className="join-panel-controls">
              <input
                className="text-input"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Display name"
                maxLength={18}
              />
              <button className="primary-button" type="submit">
                Join Table
              </button>
            </div>
          </form>
        ) : room?.canStartHand ? (
          <div className="action-panel">
            <div>
              <span className="section-label">Host control</span>
              <h2>Deal the next hand</h2>
              <p>Everyone seated with chips will be dealt in.</p>
            </div>
            <button className="primary-button" onClick={handleStartHand} type="button">
              Start Hand
            </button>
          </div>
        ) : room?.controls?.canAct ? (
          <PlayerActionPanel
            callLabel={callLabel}
            onAction={handleAction}
            quickRaiseOptions={quickRaiseOptions}
            raiseTarget={raiseTarget}
            room={room}
            setRaiseTarget={setRaiseTarget}
            viewer={viewer}
          />
        ) : (
          <div className="action-panel">
            <div>
              <span className="section-label">Table status</span>
              <h2>{room?.tableMessage ?? "Waiting for room state"}</h2>
              <p>
                {viewer
                  ? `Stack ${formatChips(viewer.chips)}${viewer.bestHandName ? ` | ${viewer.bestHandName}` : ""}`
                  : "Join the table from this device to receive your own seat and cards."}
              </p>
            </div>
            {room?.phase === "showdown" && room?.canStartHand ? (
              <button className="primary-button" onClick={handleStartHand} type="button">
                Next Hand
              </button>
            ) : null}
          </div>
        )}
      </section>
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
        ? `All in ${formatChips(room.controls.callAmount)}`
        : `Call ${formatChips(room.controls.callAmount)}`
      : "Check";

  return (
    <main className="room-shell">
      <div className="home-noise" />
      <header className="room-header">
        <div>
          <Link className="room-link" to="/">
            Lobby
          </Link>
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
          <ActionFeed actionLog={room?.actionLog} />
        </aside>
      </section>

      <section className="action-dock">
        {room?.canStartHand ? (
          <div className="action-panel">
            <div>
              <span className="section-label">Local hand</span>
              <h2>Deal the next hand</h2>
              <p>Bots act automatically after you or each other.</p>
            </div>
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
            onAction={handleAction}
            quickRaiseOptions={quickRaiseOptions}
            raiseTarget={raiseTarget}
            room={room}
            setRaiseTarget={setRaiseTarget}
            viewer={viewer}
          />
        ) : (
          <div className="action-panel">
            <div>
              <span className="section-label">Table status</span>
              <h2>{botThinking ? "Bots are acting..." : room?.tableMessage ?? "Waiting for local table"}</h2>
              <p>
                {viewer
                  ? `Stack ${formatChips(viewer.chips)}${viewer.bestHandName ? ` | ${viewer.bestHandName}` : ""}`
                  : "Add bots from the open seats to begin."}
              </p>
            </div>
            {!room?.players?.some((player) => player.isBot) ? (
              <span className="status-pill is-offline">Add a bot to start</span>
            ) : null}
          </div>
        )}
      </section>
    </main>
  );
}

function PlayerActionPanel({
  botThinking = false,
  callLabel,
  onAction,
  quickRaiseOptions,
  raiseTarget,
  room,
  setRaiseTarget,
  viewer
}) {
  return (
    <div className="action-panel action-panel-live">
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

export default App;
