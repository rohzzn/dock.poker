import fs from "node:fs/promises";
import path from "node:path";

export class RoomPersistence {
  constructor({ filePath, manager, debounceMs = 150 }) {
    this.filePath = filePath;
    this.manager = manager;
    this.debounceMs = debounceMs;
    this.flushTimer = null;
    this.isWriting = false;
    this.hasPendingWrite = false;
  }

  async load() {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const payload = JSON.parse(raw);
      const rooms = Array.isArray(payload?.rooms) ? payload.rooms : [];

      this.manager.importRooms(rooms);
      this.manager.pruneRooms();
      return this.manager.exportRooms().length;
    } catch (error) {
      if (error?.code === "ENOENT") {
        return 0;
      }

      throw error;
    }
  }

  scheduleSave() {
    if (this.flushTimer) {
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.debounceMs);
  }

  async flush() {
    if (this.isWriting) {
      this.hasPendingWrite = true;
      return;
    }

    this.isWriting = true;

    try {
      const payload = JSON.stringify(
        {
          savedAt: Date.now(),
          version: 1,
          rooms: this.manager.exportRooms()
        },
        null,
        2
      );

      await fs.mkdir(path.dirname(this.filePath), {
        recursive: true
      });

      const tempPath = `${this.filePath}.tmp`;
      await fs.writeFile(tempPath, payload, "utf8");
      await fs.rename(tempPath, this.filePath);
    } finally {
      this.isWriting = false;

      if (this.hasPendingWrite) {
        this.hasPendingWrite = false;
        this.scheduleSave();
      }
    }
  }
}
