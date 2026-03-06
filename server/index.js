import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import express from "express";
import { createServer } from "node:http";
import { Server } from "socket.io";

import { PokerRoomManager } from "./game.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const host = process.env.HOST ?? "0.0.0.0";
const port = Number(process.env.PORT ?? 3001);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);
const manager = new PokerRoomManager();

app.use(express.json());

app.get("/api/health", (_request, response) => {
  response.json({ ok: true });
});

app.post("/api/rooms", (_request, response) => {
  const room = manager.createRoom();
  response.status(201).json({
    roomId: room.id
  });
});

if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));

  app.use((_request, response) => {
    response.sendFile(path.join(distDir, "index.html"));
  });
} else {
  app.get("/", (_request, response) => {
    response.type("text/plain").send("Client build not found. Run `npm run dev` for local development.");
  });
}

function emitRoom(roomId) {
  const room = manager.getRoom(roomId);

  if (!room) {
    return;
  }

  for (const player of room.players) {
    if (!player.socketId) {
      continue;
    }

    const socket = io.sockets.sockets.get(player.socketId);

    if (!socket) {
      continue;
    }

    socket.emit("room:state", manager.serializeRoomForPlayer(roomId, player.id));
  }
}

io.on("connection", (socket) => {
  socket.on("room:join", async (payload) => {
    try {
      const { room, player } = manager.joinRoom({
        roomId: `${payload?.roomId ?? ""}`.trim().toUpperCase(),
        socketId: socket.id,
        name: payload?.name,
        playerId: payload?.playerId
      });

      socket.join(room.id);
      socket.emit("room:joined", {
        roomId: room.id,
        playerId: player.id
      });
      emitRoom(room.id);
    } catch (error) {
      socket.emit("room:error", {
        message: error instanceof Error ? error.message : "Unable to join room."
      });
    }
  });

  socket.on("game:start-hand", async () => {
    try {
      const roomId = manager.getRoomIdForSocket(socket.id);

      if (!roomId) {
        throw new Error("Join a room first.");
      }

      await manager.startHand(socket.id);
      emitRoom(roomId);
    } catch (error) {
      socket.emit("room:error", {
        message: error instanceof Error ? error.message : "Unable to start the hand."
      });
    }
  });

  socket.on("game:action", async (payload) => {
    try {
      const roomId = manager.getRoomIdForSocket(socket.id);

      if (!roomId) {
        throw new Error("Join a room first.");
      }

      await manager.handleAction(socket.id, payload);
      emitRoom(roomId);
    } catch (error) {
      socket.emit("room:error", {
        message: error instanceof Error ? error.message : "Action failed."
      });
    }
  });

  socket.on("disconnect", async () => {
    const room = await manager.disconnectSocket(socket.id);

    if (room) {
      emitRoom(room.id);
    }
  });
});

setInterval(() => {
  manager.pruneRooms();
}, 1000 * 60 * 15);

httpServer.listen(port, host, () => {
  const interfaces = Object.values(os.networkInterfaces())
    .flat()
    .filter((network) => network && network.family === "IPv4" && !network.internal)
    .map((network) => `http://${network.address}:${port}`);

  console.log(`Poker server listening on http://${host}:${port}`);

  if (interfaces.length) {
    console.log(`LAN URLs: ${interfaces.join(", ")}`);
  }
});
