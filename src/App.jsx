import { useEffect, useRef, useState } from "react";
import { BrowserRouter, Link, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { io } from "socket.io-client";

const PHASE_LABELS = {
  waiting: "Waiting",
  preflop: "Pre-Flop",
  flop: "Flop",
  turn: "Turn",
  river: "River",
  showdown: "Showdown"
};

const SEAT_CLASSES = [
  "seat-bottom",
  "seat-bottom-left",
  "seat-top-left",
  "seat-top",
  "seat-top-right",
  "seat-bottom-right"
];

function formatChips(amount) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(amount ?? 0);
}

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

function getRelativeSeat(seat, anchorSeat, maxPlayers) {
  return (seat - anchorSeat + maxPlayers) % maxPlayers;
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
            Create a room, share the link, and deal Texas Hold&apos;em hands backed by the Deck of Cards API.
          </p>
          <div className="hero-actions">
            <button className="primary-button" onClick={handleCreateRoom} disabled={creating}>
              {creating ? "Creating room..." : "Create Room"}
            </button>
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
                <small>Deck</small>
                <strong>API-driven</strong>
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

  const viewer = room?.players.find((player) => player.id === room.viewerPlayerId) ?? null;
  const viewerSeat = viewer?.seat ?? 0;
  const seatMap = new Map();

  if (room) {
    for (const player of room.players) {
      seatMap.set(getRelativeSeat(player.seat, viewerSeat, room.maxPlayers), player);
    }
  }

  const seats = Array.from({ length: room?.maxPlayers ?? 6 }, (_, index) => ({
    relativeSeat: index,
    player: seatMap.get(index) ?? null
  }));

  const quickRaiseOptions = buildQuickRaiseOptions(room, viewer);
  const shareUrl =
    typeof window === "undefined" ? "" : `${window.location.origin}/room/${roomId}`;

  async function handleCopyLink() {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
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
          <button className="secondary-button" onClick={handleCopyLink}>
            {copied ? "Link copied" : "Copy room link"}
          </button>
        </div>
      </header>

      {error ? <div className="error-banner room-error">{error}</div> : null}

      <section className="table-layout">
        <div className="table-stage">
          <div className="table-surface">
            <div className="table-rim" />
            <div className="table-center">
              <div className="center-pill">
                <span>{PHASE_LABELS[room?.phase ?? "waiting"]}</span>
                <strong>{formatChips(room?.pot ?? 0)}</strong>
                <small>Pot</small>
              </div>

              <div className="community-row">
                {Array.from({ length: 5 }, (_, index) => room?.communityCards?.[index] ?? null).map((card, index) => (
                  <CardFace
                    key={card?.code ?? `community-${index}`}
                    card={card}
                    backCardImage={room?.backCardImage}
                    placeholder={!card}
                  />
                ))}
              </div>

              <div className="table-meta">
                <div>
                  <small>Current bet</small>
                  <strong>{formatChips(room?.currentBet ?? 0)}</strong>
                </div>
                <div>
                  <small>Blinds</small>
                  <strong>
                    {formatChips(room?.smallBlind ?? 10)} / {formatChips(room?.bigBlind ?? 20)}
                  </strong>
                </div>
                <div>
                  <small>Hand</small>
                  <strong>#{room?.handNumber ?? 0}</strong>
                </div>
              </div>
            </div>

            {seats.map(({ relativeSeat, player }) => (
              <div key={relativeSeat} className={`seat-shell ${SEAT_CLASSES[relativeSeat]}`}>
                {player ? (
                  <SeatCard
                    player={player}
                    backCardImage={room?.backCardImage}
                    isTurn={room?.currentTurnPlayerId === player.id}
                    isViewer={player.id === room?.viewerPlayerId}
                  />
                ) : (
                  <div className="seat-card empty-seat">
                    <span>Open seat</span>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <aside className="side-rail">
          <section className="rail-card">
            <div className="rail-card-header">
              <span className="section-label">Share</span>
              <strong>Invite players</strong>
            </div>
            <p className="muted-text">{shareUrl}</p>
            <button className="secondary-button wide-button" onClick={handleCopyLink}>
              {copied ? "Copied" : "Copy invite link"}
            </button>
          </section>

          <section className="rail-card">
            <div className="rail-card-header">
              <span className="section-label">Showdown</span>
              <strong>Latest result</strong>
            </div>
            {room?.showdown?.winners?.length ? (
              <div className="showdown-list">
                {room.showdown.winners.map((winner) => (
                  <div key={winner.playerId} className="showdown-item">
                    <div>
                      <strong>{winner.name}</strong>
                      <p>{winner.hand || "Split pot"}</p>
                    </div>
                    <span>{formatChips(winner.amount)}</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="muted-text">Results appear here after each showdown.</p>
            )}
          </section>

          <section className="rail-card">
            <div className="rail-card-header">
              <span className="section-label">Action</span>
              <strong>Table feed</strong>
            </div>
            <div className="log-list">
              {(room?.actionLog ?? []).map((entry) => (
                <div key={entry.id} className="log-entry">
                  {entry.text}
                </div>
              ))}
              {!room?.actionLog?.length ? <p className="muted-text">Actions will appear here.</p> : null}
            </div>
          </section>
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
            <button className="primary-button" onClick={handleStartHand}>
              Start Hand
            </button>
          </div>
        ) : room?.controls?.canAct ? (
          <div className="action-panel action-panel-live">
            <div className="action-summary">
              <span className="section-label">Your action</span>
              <h2>{viewer?.name}</h2>
              <p>
                Stack {formatChips(viewer?.chips ?? 0)}. Current contribution{" "}
                {formatChips(viewer?.streetContribution ?? 0)}.
              </p>
            </div>

            <div className="action-buttons">
              <button className="ghost-button" onClick={() => handleAction("fold")}>
                Fold
              </button>
              <button
                className="secondary-button"
                onClick={() => handleAction(room.controls.canCall ? "call" : "check")}
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
                      onClick={() => setRaiseTarget(option.value)}
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
                  <button className="primary-button" onClick={() => handleAction("raise", raiseTarget)}>
                    {room.currentBet === 0 ? "Bet" : "Raise"}
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="action-panel">
            <div>
              <span className="section-label">Table status</span>
              <h2>{room?.tableMessage ?? "Waiting for room state"}</h2>
              <p>
                {viewer
                  ? `Stack ${formatChips(viewer.chips)}${viewer.bestHandName ? ` • ${viewer.bestHandName}` : ""}`
                  : "Join the table from this device to receive your own seat and cards."}
              </p>
            </div>
            {room?.phase === "showdown" && room?.canStartHand ? (
              <button className="primary-button" onClick={handleStartHand}>
                Next Hand
              </button>
            ) : null}
          </div>
        )}
      </section>
    </main>
  );
}

function SeatCard({ player, backCardImage, isTurn, isViewer }) {
  const badges = [];

  if (player.isDealer) {
    badges.push("D");
  }

  if (player.isSmallBlind) {
    badges.push("SB");
  }

  if (player.isBigBlind) {
    badges.push("BB");
  }

  if (!player.connected) {
    badges.push("Away");
  }

  if (player.folded) {
    badges.push("Folded");
  }

  if (player.allIn) {
    badges.push("All in");
  }

  const cards =
    player.holeCards.length > 0
      ? player.holeCards
      : Array.from({ length: player.cardCount }, (_, index) => ({
          code: `BACK-${index}`,
          image: backCardImage
        }));

  return (
    <div className={`seat-card ${isTurn ? "is-turn" : ""} ${isViewer ? "is-viewer" : ""}`}>
      <div className="seat-header">
        <div>
          <strong>{player.name}</strong>
          <p>{formatChips(player.chips)}</p>
        </div>
        {player.lastWinAmount > 0 ? <span className="win-pill">+{formatChips(player.lastWinAmount)}</span> : null}
      </div>

      <div className="seat-badges">
        {badges.map((badge) => (
          <span key={badge}>{badge}</span>
        ))}
        {player.isHost ? <span>Host</span> : null}
      </div>

      <div className={`seat-cards ${player.folded ? "is-muted" : ""}`}>
        {cards.map((card) => (
          <CardFace key={card.code} card={card} backCardImage={backCardImage} />
        ))}
      </div>

      <div className="seat-footer">
        <span>{player.lastAction || "Waiting"}</span>
        {player.bestHandName ? <strong>{player.bestHandName}</strong> : null}
      </div>
    </div>
  );
}

function CardFace({ card, backCardImage, placeholder = false }) {
  if (placeholder) {
    return <div className="card-face placeholder-card" />;
  }

  return (
    <div className="card-face">
      <img src={card?.image ?? backCardImage} alt={card?.code ?? "Card back"} />
    </div>
  );
}

export default App;
