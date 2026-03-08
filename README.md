# Dock Poker

Clean online Texas Hold'em for private games with friends, plus a local solo mode with bots.

Live site: [https://dock.poker](https://dock.poker)

## Overview

Dock Poker is a table-first poker app built for quick private games. Create a room, share the URL, join from different devices, and play a synced hand in real time. If you just want to play instantly, solo mode lets you seat bots locally at the same table.

The game uses the [Deck of Cards API](https://deckofcardsapi.com/) for shuffle and draw requests, and runs the table state on a Node server with Socket.IO.

## Features

- Private multiplayer rooms with shareable room URLs
- Local single-player mode with easy, medium, and hard bots
- Clean grid-based poker table UI built for desktop play
- Texas Hold'em flow with blinds, betting rounds, board reveals, and showdown resolution
- Reconnect flow for multiplayer seats
- Scrollable table feed with latest action pinned at the bottom
- Showdown panel with winner and pot breakdown
- File-backed room persistence on the server
- Recovery path if a board reveal fails because the Deck API is temporarily unavailable
- Built-in test coverage for core game logic

## Stack

- React 19
- Vite
- Express
- Socket.IO
- `pokersolver`
- Deck of Cards API

## Game Modes

### Multiplayer

- Create a room from the lobby
- Share the room link or room code
- Join from separate devices or browser sessions
- One host controls hand start and reveal recovery when needed

### Solo

- Start a local table instantly
- Add bots directly to open seats
- Choose bot difficulty per seat: easy, medium, or hard


## Project Structure

```text
src/           React app, routes, table UI, solo controller, sounds
server/        Express server, poker engine, Deck API adapter, persistence, tests
public/        Static assets
```

## Persistence

Multiplayer room state is persisted to:

```text
server/data/rooms.json
```

That lets rooms survive a server restart on a traditional host such as EC2.


## Notes

- This project is built for casual online poker sessions, not real-money play
- Deck creation and card draws depend on the public Deck of Cards API

