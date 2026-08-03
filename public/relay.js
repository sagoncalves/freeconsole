/**
 * The Firebase relay.
 *
 * This module holds the only Firebase connection in the system. Games run inside a sandboxed
 * iframe and speak to it over postMessage via sdk.js; this side translates those calls into
 * RTDB reads and writes and pushes device/message updates back down.
 *
 * Keeping Firebase entirely on this side is what lets a game be hosted on any domain: the
 * game never needs our credentials or our session, only a postMessage channel to whoever
 * embedded it.
 */
import { initializeApp } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/11.1.0/firebase-auth.js";
import { getDatabase } from "https://www.gstatic.com/firebasejs/11.1.0/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js?v=202608011900";

const PROTOCOL = "console-sdk/2";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

export { app, auth, db };

/** Resolves with the anonymous user, signing in on first call. */
export function ensureAuth() {
  return new Promise((resolve, reject) => {
    let settled = false;
    const stop = onAuthStateChanged(
      auth,
      (user) => {
        if (settled) return;
        if (user) {
          settled = true;
          stop();
          resolve(user);
          return;
        }
        // Only sign in anonymously when nobody is signed in. Calling it unconditionally
        // replaces a real (e.g. admin) session with an anonymous one, because Firebase Auth
        // holds a single user per browser - which silently demoted admins who had visited
        // any page that joins a room.
        signInAnonymously(auth).catch((err) => {
          if (settled) return;
          settled = true;
          stop();
          reject(err);
        });
      },
      reject
    );
  });
}

/**
 * Bridges a game iframe to the room.
 *
 * @param {HTMLIFrameElement} frame
 * @param {object} opts
 * @param {string} opts.roomCode
 * @param {number} opts.deviceId      this device's slot
 * @param {string} opts.location      the URL this frame represents
 * @param {() => {devices: Array, home: string}} opts.getRoom  latest room state
 * @param {object} opts.actions       { sendMessage, setCustomState, navigate, setActivePlayers }
 * @returns {{ detach: () => void, pushDevices: (devices:Array) => void,
 *            pushMessage: (from:number, data:*) => void,
 *            pushActivePlayers: (ids:number[]) => void }}
 */
export function attachGameFrame(frame, opts) {
  const { roomCode, deviceId, location, getRoom, actions } = opts;
  const targetOrigin = opts.frameOrigin || "*";

  let ready = false;
  let seq = 0;

  const post = (type, payload) => {
    if (!frame.contentWindow) return;
    frame.contentWindow.postMessage({ protocol: PROTOCOL, type, payload, seq: seq++ }, targetOrigin);
  };

  async function onMessage(event) {
    const data = event.data;
    if (!data || data.protocol !== PROTOCOL) return;
    if (event.source !== frame.contentWindow) return;

    if (data.type === "hello") {
      if (ready) return;
      ready = true;
      const room = getRoom();
      post("welcome", {
        device_id: deviceId, code: roomCode, devices: room.devices,
        clockOffset: opts.clockOffset ? opts.clockOffset() : 0,
      });
      return;
    }

    if (!ready) return;

    try {
      switch (data.type) {
        case "message":
          await actions.sendMessage(data.payload.to, data.payload.data);
          break;
        case "customState":
          await actions.setCustomState(data.payload);
          break;
        case "navigate":
          await actions.navigate(data.payload.url);
          break;
        case "setActivePlayers":
          await actions.setActivePlayers(data.payload.max);
          break;
        case "orientation":
          // Advisory only: a sandboxed iframe can't lock screen orientation, and games
          // are responsible for their own layout either way.
          break;
      }
    } catch (err) {
      console.error("[relay] action failed", data.type, err);
      post("error", { message: err.message || String(err) });
    }
  }

  window.addEventListener("message", onMessage);

  return {
    /** Pushes an updated clock offset once the shell has measured it. */
    pushClock: (clock) => post("clock", { offset: clock.offset || 0 }),
    detach() {
      window.removeEventListener("message", onMessage);
    },
    pushDevices(devices) {
      if (ready) post("devices", devices);
    },
    pushMessage(from, payload) {
      if (ready) post("message", { from, data: payload });
    },
    pushActivePlayers(ids) {
      if (ready) post("activePlayers", ids);
    },
  };
}
