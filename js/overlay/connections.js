// tosu data/settings WebSockets, watchdogs and reconnect ownership.

function connectTosu() {
  clearTimeout(tosuReconnectTimer);
  clearInterval(tosuWatchdogTimer);
  const connectionId = ++tosuConnectionId;

  try {
    tosuSocket?.close();
  } catch {
    // The old socket may already be closed.
  }

  let socket;
  try { socket = new WebSocket(`${CONFIG.tosuWebSocket}?l=${getCounterPathForQuery()}`); }
  catch (error) {
    setStatus(`tosu connect failed: ${error.message}`);
    tosuReconnectTimer = setTimeout(connectTosu, 5000);
    return;
  }
  tosuSocket = socket;

  socket.addEventListener("open", () => {
    if (connectionId !== tosuConnectionId) return;
    setStatus("tosu websocket: connected");
    tosuReconnectAttempts = 0;
    tosuLastMessageAt = Date.now();
    let checking = false;
    tosuWatchdogTimer = setInterval(async () => {
      if (checking || connectionId !== tosuConnectionId || Date.now() - tosuLastMessageAt < 12000) return;
      checking = true;
      try {
        const response = await fetch(toTosuUrl("/json"), { signal: AbortSignal.timeout(4000), cache: "no-store" });
        if (connectionId !== tosuConnectionId) return;
        if (response.status === 500) {
          setStatus("tosu connected; waiting for osu to become ready");
          return;
        }
        socket.close();
      } catch { if (connectionId === tosuConnectionId) socket.close(); }
      finally { checking = false; }
    }, 4000);
  });

  socket.addEventListener("message", (event) => {
    if (connectionId !== tosuConnectionId) return;
    tosuLastMessageAt = Date.now();

    try {
      const data = JSON.parse(event.data);
      if (data.error) { setStatus(`tosu waiting: ${data.error}`); return; }
      latestTrackPayload = data;
      const info = trackInfoFromPayload(data);
      const beatmap = info.beatmap;
      const incomingKey = info.key;
      const incomingLiveTime = Number(beatmap.time?.live || 0);
      const liveTimeReset = lastSeenLiveTime > 5000 && incomingLiveTime < Math.max(1200, lastSeenLiveTime - 3000);
      const trackChanged = Boolean(incomingKey && incomingKey !== lastSeenTrackKey);

      if (info.rawTitle && incomingKey && trackChanged) {
        lastSeenTrackKey = incomingKey;
        if ((loadedLyricsTrackKey && loadedLyricsTrackKey !== incomingKey) || (loadingLyricsTrackKey && loadingLyricsTrackKey !== incomingKey)) {
          lyricLoadToken += 1;
          clearDisplayedLyrics("Searching lyrics");
        }
      } else if (liveTimeReset && !incomingKey) {
        currentTrackKey = "";
        pendingTrackKey = "";
        pendingTrackPayload = null;
        pendingTrackSince = 0;
        clearTimeout(pendingTrackTimer);
        lyricLoadToken += 1;
        clearDisplayedLyrics("Searching lyrics");
      }

      lastSeenLiveTime = incomingLiveTime;
      lastLiveTime = Number(beatmap.time?.live || 0);
      if (trackChanged) resetSongIconPlayback();
      updateSongIconPlayback(lastLiveTime);
      updateMvPlaybackState(lastLiveTime);
      updateTimelineDuration(beatmap, data);

      refreshTrack(data, info).catch((error) => {
        setStatus(`track refresh error: ${error.message}`);
      });
      renderTimeline(lastLiveTime);
      syncMvBackground(lastLiveTime);
      renderLyrics(lastLiveTime);
    } catch (error) {
      setStatus(`tosu data error: ${error.message}`);
    }
  });

  socket.addEventListener("close", () => {
    if (connectionId !== tosuConnectionId) return;
    setStatus("tosu websocket: reconnecting (cannot receive beatmap/time data)");
    resetSongIconPlayback();
    clearInterval(tosuWatchdogTimer);
    clearTimeout(tosuReconnectTimer);
    tosuReconnectTimer = setTimeout(connectTosu, Math.min(15000, CONFIG.retryDelayMs * 2 ** tosuReconnectAttempts++));
  });

  socket.addEventListener("error", () => {
    if (connectionId !== tosuConnectionId) return;
    socket.close();
  });
}

function sendSettingsCommand(name = "getSettings", command = getCounterPathForCommand(), retries = 1) {
  if (!settingsSocket || settingsSocket.readyState !== WebSocket.OPEN) {
    if (retries <= 6) {
      setTimeout(() => sendSettingsCommand(name, command, retries + 1), 120);
    }
    return;
  }

  try {
    const payload = typeof command === "object" ? JSON.stringify(command) : command;
    settingsSocket.send(`${name}:${payload}`);
  } catch (error) {
    if (retries <= 6) {
      setTimeout(() => sendSettingsCommand(name, command, retries + 1), 300);
      return;
    }

    console.info("settings command failed", error);
  }
}

function connectSettings() {
  clearTimeout(settingsReconnectTimer);
  clearInterval(settingsLiveSyncTimer);
  const connectionId = ++settingsConnectionId;

  try {
    settingsSocket?.close();
  } catch {
    // The old socket may already be closed.
  }

  try {
    const url = new URL("websocket/commands", toTosuHttpBase());
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.searchParams.set("l", getCounterPathForQuery());
    settingsSocket = new WebSocket(url.toString());
  } catch {
    return;
  }

  settingsSocket.addEventListener("open", () => {
    if (connectionId !== settingsConnectionId) return;
    settingsReconnectAttempts = 0;

    sendSettingsCommand("getSettings", getCounterPathForCommand());
    settingsLiveSyncTimer = setInterval(() => {
      if (connectionId !== settingsConnectionId) return;
      sendSettingsCommand("getSettings", getCounterPathForCommand());
    }, 1000);
  });

  settingsSocket.addEventListener("message", (event) => {
    if (connectionId !== settingsConnectionId) return;

    try {
      const payload = JSON.parse(event.data);
      if (payload?.error || payload?.message?.error) return;

      const command = payload.command || payload.event || payload.type;
      const commandName = String(command || "").toLowerCase();
      let source = null;

      if (Array.isArray(payload)) {
        source = payload;
      } else if (command === "getSettings") {
        source = payload.message || payload.settings || payload.data || payload;
      } else if (!command || commandName.includes("setting")) {
        source = payload.settings || payload.data || payload.message || payload;
      }

      if (source) {
        applySettings(source, { silent: true });
      }
    } catch (error) {
      console.info("settings hot reload message ignored", error);
    }
  });

  settingsSocket.addEventListener("close", () => {
    if (connectionId !== settingsConnectionId) return;
    clearInterval(settingsLiveSyncTimer);
    settingsReconnectTimer = setTimeout(connectSettings, Math.min(15000, CONFIG.retryDelayMs * 2 ** settingsReconnectAttempts++));
  });

  settingsSocket.addEventListener("error", (error) => {
    if (connectionId !== settingsConnectionId) return;
    console.info("settings hot reload unavailable", error);
    try {
      settingsSocket?.close();
    } catch {
      // The close handler owns reconnecting this optional channel.
    }
  });
}
