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

## Local Development

### Requirements

- Node.js 22 or newer recommended
- npm

### Install

```bash
npm ci
```

### Run in development

```bash
npm run dev
```

This starts:

- the Vite client on `http://localhost:5173`
- the Node server on `http://localhost:3001`

### Build for production

```bash
npm run build
```

### Start the production server

```bash
npm start
```

The production server serves the built client and the multiplayer backend from the same process.

## Scripts

- `npm run dev` - run client and server together for development
- `npm run build` - build the frontend
- `npm test` - run server-side game tests
- `npm start` - run the production server

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

## Production Notes

- The app expects a long-running Node server for multiplayer
- Socket.IO makes it a better fit for EC2, a VPS, Render, Railway, or Fly than pure serverless hosting
- On production, place Nginx or another reverse proxy in front of the Node server
- Make sure ports `80` and `443` are open if you are serving the app publicly

## Testing

Current tests cover core engine behavior, including:

- failed hand start rollback
- reveal retry and hand resume flow
- room export and import across restarts
- main pot and side pot showdown resolution

Run them with:

```bash
npm test
```

## Notes

- This project is built for casual online poker sessions, not real-money play
- Deck creation and card draws depend on the public Deck of Cards API

