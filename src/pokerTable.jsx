import { useEffect, useRef } from "react";

const PHASE_LABELS = {
  waiting: "Waiting",
  preflop: "Pre-Flop",
  flop: "Flop",
  turn: "Turn",
  river: "River",
  showdown: "Showdown"
};

const TABLE_SEAT_ROWS = [
  [4, 3, 2],
  [5, 0, 1]
];

function getRelativeSeat(seat, anchorSeat, maxPlayers) {
  return (seat - anchorSeat + maxPlayers) % maxPlayers;
}

export function formatChips(amount) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0
  }).format(amount ?? 0);
}

export function TableSurface({ room, viewerPlayerId }) {
  const viewerId = viewerPlayerId ?? room?.viewerPlayerId ?? null;
  const viewer = room?.players.find((player) => player.id === viewerId) ?? null;
  const viewerSeat = viewer?.seat ?? 0;
  const seatMap = new Map();

  if (room) {
    for (const player of room.players) {
      seatMap.set(getRelativeSeat(player.seat, viewerSeat, room.maxPlayers), player);
    }
  }

  return (
    <div className="table-stage">
      <div className="table-surface">
        <div className="table-rim" />
        <div className="table-grid">
          <div className="table-seat-row">
            {TABLE_SEAT_ROWS[0].map((relativeSeat) => {
              const player = seatMap.get(relativeSeat) ?? null;

              return (
                <div key={relativeSeat} className="table-seat-slot">
                  {player ? (
                    <SeatCard
                      player={player}
                      backCardImage={room?.backCardImage}
                      isTurn={room?.currentTurnPlayerId === player.id}
                      isViewer={player.id === viewerId}
                    />
                  ) : (
                    <div className="seat-card empty-seat">
                      <span>Open seat</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

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

          <div className="table-seat-row table-seat-row-bottom">
            {TABLE_SEAT_ROWS[1].map((relativeSeat) => {
              const player = seatMap.get(relativeSeat) ?? null;

              return (
                <div
                  key={relativeSeat}
                  className={`table-seat-slot ${relativeSeat === 0 ? "table-seat-slot-viewer" : ""}`}
                >
                  {player ? (
                    <SeatCard
                      player={player}
                      backCardImage={room?.backCardImage}
                      isTurn={room?.currentTurnPlayerId === player.id}
                      isViewer={player.id === viewerId}
                    />
                  ) : (
                    <div className="seat-card empty-seat">
                      <span>Open seat</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

export function InviteCard({ shareUrl, copied, onCopy }) {
  return (
    <section className="rail-card">
      <div className="rail-card-header">
        <span className="section-label">Share</span>
        <strong>Invite players</strong>
      </div>
      <p className="muted-text">{shareUrl}</p>
      <button className="secondary-button wide-button" onClick={onCopy} type="button">
        {copied ? "Copied" : "Copy invite link"}
      </button>
    </section>
  );
}

export function ShowdownPanel({ showdown }) {
  return (
    <section className="rail-card">
      <div className="rail-card-header">
        <span className="section-label">Showdown</span>
        <strong>Latest result</strong>
      </div>
      {showdown?.winners?.length ? (
        <div className="showdown-list">
          {showdown.winners.map((winner) => (
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
  );
}

export function ActionFeed({ actionLog }) {
  const logRef = useRef(null);

  useEffect(() => {
    const logElement = logRef.current;

    if (!logElement) {
      return;
    }

    logElement.scrollTop = logElement.scrollHeight;
  }, [actionLog]);

  return (
    <section className="rail-card rail-card-feed">
      <div className="rail-card-header">
        <span className="section-label">Action</span>
        <strong>Table feed</strong>
      </div>
      <div ref={logRef} className="log-list">
        {(actionLog ?? []).map((entry) => (
          <div key={entry.id} className="log-entry">
            {entry.text}
          </div>
        ))}
        {!actionLog?.length ? <p className="muted-text">Actions will appear here.</p> : null}
      </div>
    </section>
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

  if (player.isBot && player.botDifficulty) {
    badges.push(player.botDifficulty);
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
