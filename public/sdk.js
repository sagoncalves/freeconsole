/**
 * The console platform SDK — FreeConsole-compatible.
 *
 * The API deliberately mirrors AirConsole's (airconsole-api 1.11.0), so games written for
 * that platform port almost unchanged: device ids with the screen at 0, a derived master
 * controller, active-player numbers, custom device state, and URL navigation. `AirConsole`
 * is kept as an alias at the bottom of this file for exactly that reason.
 *
 * The one structural difference is transport. FreeConsole navigates the whole page to a game
 * URL; we load games in a sandboxed iframe and relay over postMessage, so a third-party
 * game never touches our Firebase session. Games can't tell the difference — this file is
 * the only thing they talk to either way.
 *
 *   var console_ = new FreeConsole();
 *   console_.onReady = function (code) { ... };
 *   console_.onMessage = function (device_id, data) { ... };
 */
(function (global) {
  "use strict";

  var PROTOCOL = "console-sdk/2";
  var HANDSHAKE_TIMEOUT_MS = 10000;

  /**
   * @param {object} [opts]
   * @param {string} [opts.orientation]
   * @param {boolean} [opts.synchronize_time]
   */
  function FreeConsole(opts) {
    opts = opts || {};

    this.devices = [];          // slot -> DeviceState (sparse, index === device_id)
    this.device_id = undefined; // this device's slot; SCREEN (0) on the screen
    this.code = undefined;      // the room code

    this._ready = false;
    this._outbox = [];
    this._seq = 0;
    this._shellOrigin = null;
    this._activePlayers = [];   // device_ids in player-number order
    this._clockOffset = 0;      // ms to add to Date.now() for a room-wide clock

    var self = this;
    global.addEventListener("message", function (event) {
      self._onWindowMessage(event);
    });

    // Announce ourselves to the shell. Everything a game calls before the handshake
    // completes is queued, so games needn't care about timing.
    this._send({
      protocol: PROTOCOL,
      type: "hello",
      payload: { orientation: opts.orientation || null },
      seq: this._seq++,
    });
  }

  /** The screen is always device 0. Use this rather than a literal. */
  FreeConsole.SCREEN = 0;
  FreeConsole.ORIENTATION_PORTRAIT = "portrait";
  FreeConsole.ORIENTATION_LANDSCAPE = "landscape";

  /* ---------------------------------------------------------------- player colours */

  /**
   * The platform's player palette, indexed by DEVICE SLOT.
   *
   * Kept in step with /player-colors.js, which the shell imports. This file is a classic
   * script rather than a module so that games can load it with a plain <script> tag, so the
   * values are duplicated here rather than imported; a test asserts the two never diverge.
   */
  FreeConsole.PLAYER_COLORS = [
    "#35f0e0", "#ff2e88", "#9dff4f", "#ffc247",
    "#7b6cff", "#4fd2ff", "#ff7a3d", "#ff5ec4",
  ];

  /**
   * The colour the platform uses for a device, as a CSS string.
   *
   * Indexed by device id, NOT by position in getControllerDeviceIds(). Those agree only
   * while slots are contiguous: once device 2 leaves, device 3 sits at array index 1, and a
   * game colouring by position would show it device 2's colour while the room bar still
   * showed the original. Keying off the id keeps a player's colour stable everywhere it
   * appears - on the screen, on their phone, and in the room bar.
   *
   * @param {number} [device_id] Defaults to this device.
   * @return {string} e.g. "#35f0e0"
   */
  FreeConsole.prototype.getPlayerColor = function (device_id) {
    if (device_id === undefined) device_id = this.device_id;
    var slot = Math.max(1, Number(device_id) || 1);
    return FreeConsole.PLAYER_COLORS[(slot - 1) % FreeConsole.PLAYER_COLORS.length];
  };

  /**
   * The same colour as a 0xRRGGBB number, for WebGL and canvas APIs that want an integer.
   *
   * @param {number} [device_id] Defaults to this device.
   * @return {number} e.g. 0x35f0e0
   */
  FreeConsole.prototype.getPlayerColorHex = function (device_id) {
    return parseInt(this.getPlayerColor(device_id).slice(1), 16);
  };

  /* ---------------------------------------------------------------- transport */

  FreeConsole.prototype._send = function (message) {
    if (global.parent === global) {
      console.error("[console-sdk] no parent shell: a game must be loaded by the console shell.");
      return;
    }
    global.parent.postMessage(message, this._shellOrigin || "*");
  };

  FreeConsole.prototype._post = function (type, payload) {
    var message = { protocol: PROTOCOL, type: type, payload: payload, seq: this._seq++ };
    if (!this._ready) {
      this._outbox.push(message);
      return;
    }
    this._send(message);
  };

  FreeConsole.prototype._flush = function () {
    var queued = this._outbox.splice(0, this._outbox.length);
    for (var i = 0; i < queued.length; i++) this._send(queued[i]);
  };

  FreeConsole.prototype._safe = function (fn, args) {
    if (typeof fn !== "function") return;
    try {
      fn.apply(this, args);
    } catch (err) {
      // A throwing game callback must not kill the message pump.
      console.error("[console-sdk] callback threw:", err);
    }
  };

  FreeConsole.prototype._onWindowMessage = function (event) {
    var data = event.data;
    if (!data || data.protocol !== PROTOCOL) return;
    if (this._shellOrigin && event.origin !== this._shellOrigin) return;
    if (event.source !== global.parent) return;

    switch (data.type) {
      case "clock":
        this._clockOffset = data.payload.offset || 0;
        break;

      case "welcome":
        this._shellOrigin = event.origin;
        this._clockOffset = data.payload.clockOffset || 0;
        this.device_id = data.payload.device_id;
        this.code = data.payload.code;
        this.devices = data.payload.devices || [];
        this._ready = true;
        this._flush();

        this._safe(this.onReady, [this.code]);

        // onReady also fires onConnect for devices already here, and
        // onCustomDeviceStateChange for any that already published state - so a game
        // written against the callbacks alone still sees everyone who arrived first.
        for (var i = 0; i < this.devices.length; i++) {
          if (i === this.device_id || !this.devices[i]) continue;
          if (!this._inSameLocation(i)) continue;
          this._safe(this.onConnect, [i]);
          if (this.devices[i].custom !== undefined) {
            this._safe(this.onCustomDeviceStateChange, [i, this.devices[i].custom]);
          }
        }
        break;

      case "devices": {
        // The shell sends the whole device table; we diff it so games get the granular
        // callbacks FreeConsole defines.
        var before = this.devices || [];
        var after = data.payload || [];
        this.devices = after;

        var max = Math.max(before.length, after.length);
        for (var slot = 0; slot < max; slot++) {
          if (slot === this.device_id) continue;
          var was = before[slot];
          var now = after[slot];

          var wasHere = !!was && was.connected && this._locationMatches(was.location);
          var isHere = !!now && now.connected && this._locationMatches(now.location);

          if (JSON.stringify(was) !== JSON.stringify(now)) {
            this._safe(this.onDeviceStateChange, [slot, now]);
          }
          if (isHere && !wasHere) this._safe(this.onConnect, [slot]);
          else if (!isHere && wasHere) this._safe(this.onDisconnect, [slot]);

          if (isHere && now && was && JSON.stringify(was.custom) !== JSON.stringify(now.custom)) {
            this._safe(this.onCustomDeviceStateChange, [slot, now.custom]);
          }
        }
        break;
      }

      case "message":
        this._safe(this.onMessage, [data.payload.from, data.payload.data]);
        break;

      case "activePlayers":
        this._activePlayers = data.payload || [];
        this._safe(this.onActivePlayersChange, [
          this.convertDeviceIdToPlayerNumber(this.device_id),
        ]);
        break;

      case "reconnect":
        this._safe(this.onReconnect, []);
        break;

      case "error":
        console.error("[console-sdk]", data.payload && data.payload.message);
        break;
    }
  };

  /* ---------------------------------------------------------------- locations */

  // Two devices are "together" when they're on the same game URL, ignoring any hash
  // parameters - the same rule FreeConsole uses to decide who is in your game.
  FreeConsole.prototype._gameUrl = function (url) {
    if (!url) return "";
    return String(url).split("#")[0].split("?")[0];
  };

  FreeConsole.prototype._locationMatches = function (location) {
    var mine = this.devices[this.device_id];
    if (!mine) return false;
    return this._gameUrl(location) === this._gameUrl(mine.location);
  };

  FreeConsole.prototype._inSameLocation = function (device_id) {
    var device = this.devices[device_id];
    return !!device && device.connected && this._locationMatches(device.location);
  };

  /* ---------------------------------------------------------------- connectivity */

  /** This device's id. The screen is always FreeConsole.SCREEN (0). */
  FreeConsole.prototype.getDeviceId = function () {
    return this.device_id;
  };

  /** Device ids of all controllers currently on the same game as this device. */
  FreeConsole.prototype.getControllerDeviceIds = function () {
    var result = [];
    for (var i = FreeConsole.SCREEN + 1; i < this.devices.length; i++) {
      if (this._inSameLocation(i)) result.push(i);
    }
    return result;
  };

  /**
   * The master controller: the lowest-numbered connected controller.
   *
   * Derived on every call rather than stored, exactly as FreeConsole does it. That makes
   * migration free - when the master leaves, the next controller simply *is* the master,
   * with no handover to coordinate.
   */
  FreeConsole.prototype.getMasterControllerDeviceId = function () {
    return this.getControllerDeviceIds()[0];
  };

  /**
   * Time on a clock every device in the room agrees on, in ms.
   *
   * Device clocks are routinely seconds apart, so two devices cannot compare their own
   * timestamps - doing that silently broke message ordering earlier in this platform's
   * life. The shell measures this device's offset from the server and passes it in, so
   * getServerTime() is comparable across devices even though Date.now() is not.
   *
   * Use this, never Date.now(), whenever a time is sent to another device.
   */
  FreeConsole.prototype.getServerTime = function () {
    return Date.now() + (this._clockOffset || 0);
  };

  /**
   * How far this device's clock is from the shared one, in ms.
   * Mostly useful for diagnostics; getServerTime() already applies it.
   */
  FreeConsole.prototype.getClockOffset = function () {
    return this._clockOffset || 0;
  };

  FreeConsole.prototype.getNickname = function (device_id) {
    if (device_id === undefined) device_id = this.device_id;
    var device = this.devices[device_id];
    return (device && device.nickname) || ("Player " + device_id);
  };

  /* ---------------------------------------------------------------- messaging */

  /**
   * Sends a message to one device, or to every other device when device_id is undefined.
   */
  FreeConsole.prototype.message = function (device_id, data) {
    this._post("message", { to: device_id === undefined ? null : device_id, data: data });
  };

  /** Sends a message to all devices. */
  FreeConsole.prototype.broadcast = function (data) {
    this._post("message", { to: null, data: data });
  };

  /* ---------------------------------------------------------------- device state */

  /** Custom state of a device, readable by every device at any time. */
  FreeConsole.prototype.getCustomDeviceState = function (device_id) {
    if (device_id === undefined) device_id = this.device_id;
    var device = this.devices[device_id];
    return device ? device.custom : undefined;
  };

  /**
   * Publishes this device's custom state.
   *
   * Prefer this over broadcast() for anything a late joiner needs: custom state is
   * replayed to devices that arrive afterwards, a broadcast is not.
   */
  FreeConsole.prototype.setCustomDeviceState = function (data) {
    if (this.devices[this.device_id]) this.devices[this.device_id].custom = data;
    this._post("customState", data);
  };

  /** Sets one key of this device's custom state, leaving the rest intact. */
  FreeConsole.prototype.setCustomDeviceStateProperty = function (key, value) {
    var state = this.getCustomDeviceState();
    if (state === undefined) state = {};
    else if (typeof state !== "object") throw "Custom DeviceState needs to be of type object";
    state[key] = value;
    this.setCustomDeviceState(state);
  };

  /* ---------------------------------------------------------------- active players */

  /**
   * Assigns consecutive player numbers (from 0) to the connected controllers.
   * Screen only. Pass 0 to clear the assignment at the end of a round.
   */
  FreeConsole.prototype.setActivePlayers = function (max_players) {
    if (this.device_id !== FreeConsole.SCREEN) {
      throw "Only the screen can set the active players!";
    }
    this._post("setActivePlayers", { max: max_players === undefined ? -1 : max_players });
  };

  /** Device ids of the active players, in player-number order. */
  FreeConsole.prototype.getActivePlayerDeviceIds = function () {
    return this._activePlayers.slice();
  };

  FreeConsole.prototype.convertPlayerNumberToDeviceId = function (player_number) {
    return this._activePlayers[player_number];
  };

  FreeConsole.prototype.convertDeviceIdToPlayerNumber = function (device_id) {
    var index = this._activePlayers.indexOf(device_id);
    return index === -1 ? undefined : index;
  };

  /* ---------------------------------------------------------------- navigation */

  /**
   * Asks every device to load a game.
   *
   * @param {string} url A game id, an absolute https:// URL, or a /path on this host.
   */
  FreeConsole.prototype.navigateTo = function (url) {
    this._post("navigate", { url: url });
  };

  /** Sends every device back to the store. */
  FreeConsole.prototype.navigateHome = function () {
    this._post("navigate", { url: null });
  };

  /* ---------------------------------------------------------------- ui */

  FreeConsole.prototype.setOrientation = function (orientation) {
    this._post("orientation", { orientation: orientation });
  };

  /** Vibrates the device, where supported. Controllers only. */
  FreeConsole.prototype.vibrate = function (time) {
    if (global.navigator && global.navigator.vibrate) global.navigator.vibrate(time);
  };

  /* ---------------------------------------------------------------- callbacks */
  /* Games assign these; the defaults are no-ops so none are required. */

  /** @param {string} code The room's join code. */
  FreeConsole.prototype.onReady = function (code) {};
  /** @param {number} device_id */
  FreeConsole.prototype.onConnect = function (device_id) {};
  /** @param {number} device_id */
  FreeConsole.prototype.onDisconnect = function (device_id) {};
  /** @param {number} device_id @param {*} data */
  FreeConsole.prototype.onMessage = function (device_id, data) {};
  /** @param {number} device_id @param {object|undefined} user_data */
  FreeConsole.prototype.onDeviceStateChange = function (device_id, user_data) {};
  /** @param {number} device_id @param {object} custom_data */
  FreeConsole.prototype.onCustomDeviceStateChange = function (device_id, custom_data) {};
  /** @param {number|undefined} player_number This device's number, or undefined. */
  FreeConsole.prototype.onActivePlayersChange = function (player_number) {};
  /**
   * The shell's connection dropped and has come back — typically the phone's screen locking
   * mid-game and being woken again.
   *
   * The frame was never reloaded, so the game is still holding whatever state it had when the
   * gap started: most importantly any input it believes is still held. A controller should
   * release its buttons here; a screen should resend anything a controller needs to redraw.
   * Not a replacement for onReady, which fires once per frame and does not repeat.
   */
  FreeConsole.prototype.onReconnect = function () {};

  global.FreeConsole = FreeConsole;
  // Compatibility alias. The API was built to match AirConsole's so their games and docs
  // carry over; keeping the old global means an existing game runs here unmodified.
  global.AirConsole = FreeConsole;
})(window);
