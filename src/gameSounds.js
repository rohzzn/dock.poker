import { useEffect, useRef } from "react";

import betSoundUrl from "./sounds/bet.mp3";
import checkSoundUrl from "./sounds/check.mp3";
import flipCardSoundUrl from "./sounds/flipcard.mp3";
import foldSoundUrl from "./sounds/fold.mp3";

let sharedSoundBank = null;
let unlockListenersInstalled = false;

const SOUND_DEFINITIONS = {
  bet: {
    duration: 260,
    src: betSoundUrl,
    volume: 0.74
  },
  check: {
    duration: 180,
    src: checkSoundUrl,
    volume: 0.66
  },
  flipcard: {
    duration: 360,
    src: flipCardSoundUrl,
    volume: 0.72
  },
  fold: {
    duration: 320,
    src: foldSoundUrl,
    volume: 0.74
  }
};

function createSoundTemplate({ src, volume }) {
  const audio = new Audio(src);
  audio.preload = "auto";
  audio.volume = volume;
  audio.load();
  return audio;
}

function createSoundBank() {
  const templates = new Map(
    Object.entries(SOUND_DEFINITIONS).map(([name, config]) => [name, createSoundTemplate(config)])
  );
  const activePlayers = new Set();

  async function unlock() {
    await Promise.all(
      [...templates.values()].map(async (audio) => {
        try {
          audio.muted = true;
          audio.currentTime = 0;
          await audio.play();
          audio.pause();
          audio.currentTime = 0;
        } catch {
          // Browser autoplay policy may still block until a valid user gesture.
        } finally {
          audio.muted = false;
        }
      })
    );
  }

  function play(name, offset = 0) {
    const config = SOUND_DEFINITIONS[name];
    const template = templates.get(name);

    if (!config || !template || typeof window === "undefined") {
      return 0;
    }

    const startPlayback = () => {
      const audio = template.cloneNode();
      audio.volume = template.volume;
      audio.currentTime = 0;
      activePlayers.add(audio);

      const cleanup = () => {
        activePlayers.delete(audio);
      };

      audio.addEventListener("ended", cleanup, { once: true });
      audio.addEventListener("error", cleanup, { once: true });
      void audio.play().catch(cleanup);
    };

    if (offset > 0) {
      window.setTimeout(startPlayback, offset);
    } else {
      startPlayback();
    }

    return config.duration;
  }

  return {
    play,
    unlock
  };
}

function getSoundBank() {
  if (!sharedSoundBank) {
    sharedSoundBank = createSoundBank();
  }

  return sharedSoundBank;
}

function installUnlockListeners() {
  if (unlockListenersInstalled || typeof window === "undefined") {
    return;
  }

  unlockListenersInstalled = true;

  const unlock = () => {
    void getSoundBank().unlock();
  };

  window.addEventListener("pointerdown", unlock, { passive: true });
  window.addEventListener("keydown", unlock);
  window.addEventListener("touchstart", unlock, { passive: true });
}

function getNewLogEntries(previousRoom, room) {
  const previousLastId = previousRoom?.actionLog?.at(-1)?.id;

  if (!previousLastId) {
    return [];
  }

  const nextLog = room?.actionLog ?? [];
  const previousIndex = nextLog.findIndex((entry) => entry.id === previousLastId);

  if (previousIndex === -1) {
    return nextLog.slice(-1);
  }

  return nextLog.slice(previousIndex + 1);
}

function playLogEntry(soundBank, text, offset) {
  if (/^Hand \d+ started\./.test(text)) {
    return soundBank.play("flipcard", offset);
  }

  if (text.startsWith("Flop:") || text.startsWith("Turn:") || text.startsWith("River:")) {
    return soundBank.play("flipcard", offset);
  }

  if (text.includes("folded")) {
    return soundBank.play("fold", offset);
  }

  if (text.includes("checked")) {
    return soundBank.play("check", offset);
  }

  if (
    text.includes("called") ||
    text.includes("bet ") ||
    text.includes("raised to") ||
    text.includes("moved all in for")
  ) {
    return soundBank.play("bet", offset);
  }

  return 0;
}

export function useRoomSounds(room) {
  const previousRoomRef = useRef(null);

  useEffect(() => {
    installUnlockListeners();
  }, []);

  useEffect(() => {
    if (!room) {
      return;
    }

    const previousRoom = previousRoomRef.current;
    previousRoomRef.current = room;

    if (!previousRoom) {
      return;
    }

    const soundBank = getSoundBank();
    const newEntries = getNewLogEntries(previousRoom, room);
    let offset = 0;

    for (const entry of newEntries) {
      offset += playLogEntry(soundBank, entry.text, offset);
    }
  }, [room]);
}
