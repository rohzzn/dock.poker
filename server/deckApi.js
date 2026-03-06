const DECK_API_BASE = "https://deckofcardsapi.com/api/deck";

async function deckRequest(path) {
  const response = await fetch(`${DECK_API_BASE}${path}`);

  if (!response.ok) {
    throw new Error(`Deck API request failed with status ${response.status}`);
  }

  const payload = await response.json();

  if (!payload.success) {
    throw new Error("Deck API returned an unsuccessful response");
  }

  return payload;
}

export async function createDeck(deckCount = 1) {
  return deckRequest(`/new/shuffle/?deck_count=${deckCount}`);
}

export async function drawCards(deckId, count) {
  return deckRequest(`/${deckId}/draw/?count=${count}`);
}
