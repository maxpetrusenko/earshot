(() => {
  const body = document.body;
  const id = body.dataset.id;
  const audio = document.getElementById("audio");
  const buttons = { edited: document.getElementById("play-edited"), original: document.getElementById("play-original") };
  const seek = document.getElementById("seek");
  const time = document.getElementById("time");
  const speed = document.getElementById("speed");
  const back = document.getElementById("back");
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  let meta = null;
  let current = null;

  const known = (track) => {
    const t = meta && meta.tracks && meta.tracks[track];
    if (!t) return 0;
    if (t.duration_s) return t.duration_s;
    return t.chunks.reduce((n, c) => n + (c.duration_s || 0), 0);
  };
  const total = () => (audio && isFinite(audio.duration) && audio.duration > 0 ? audio.duration : current ? known(current) : 0);

  const paint = () => {
    if (!audio) return;
    for (const [track, el] of Object.entries(buttons)) {
      if (!el) continue;
      const playing = current === track && !audio.paused;
      el.classList.toggle("playing", playing);
      el.textContent = `${playing ? "Pause" : "Play"} ${track}`;
    }
    const t = total();
    if (t && audio.currentTime <= t) seek.value = String(Math.round((audio.currentTime / t) * 1000));
    time.textContent = t ? `${fmt(audio.currentTime)} / ${fmt(t)}` : fmt(audio.currentTime);
  };

  const start = (track) => {
    if (current === track) {
      if (audio.paused) audio.play(); else audio.pause();
      return;
    }
    current = track;
    audio.src = `/b/${id}/${track}.mp3`;
    audio.playbackRate = Number(speed.dataset.rate || 1);
    seek.value = "0";
    audio.play().catch(() => {});
    paint();
  };

  if (audio) {
    for (const [track, el] of Object.entries(buttons)) if (el) el.addEventListener("click", () => start(track));
    back.addEventListener("click", () => { audio.currentTime = Math.max(0, audio.currentTime - 10); });
    const speeds = [1, 1.25, 1.5];
    speed.addEventListener("click", () => {
      const next = speeds[(speeds.indexOf(Number(speed.dataset.rate || 1)) + 1) % speeds.length];
      speed.dataset.rate = String(next);
      audio.playbackRate = next;
      speed.textContent = `${next}x`;
    });
    seek.addEventListener("input", () => { if (total()) audio.currentTime = (seek.value / 1000) * total(); });
    ["play", "pause", "timeupdate", "loadedmetadata", "durationchange", "ended"].forEach((e) => audio.addEventListener(e, paint));

    if ("mediaSession" in navigator) {
      const ms = navigator.mediaSession;
      const setMeta = () => { ms.metadata = new MediaMetadata({ title: (meta && meta.title) || body.dataset.title || "Memo", artist: "Earshot", album: current || "" }); };
      setMeta();
      audio.addEventListener("play", setMeta);
      ms.setActionHandler("play", () => audio.play());
      ms.setActionHandler("pause", () => audio.pause());
      ms.setActionHandler("seekbackward", () => { audio.currentTime = Math.max(0, audio.currentTime - 10); });
      ms.setActionHandler("seekforward", () => { audio.currentTime = audio.currentTime + 10; });
      ms.setActionHandler("seekto", (d) => { audio.currentTime = d.seekTime; });
    }
  }

  const sketchHtml = () => {
    if (!meta || !meta.image || document.querySelector(".sketch")) return;
    const sec = document.createElement("section");
    sec.className = "sketch";
    const img = document.createElement("img");
    img.src = `/b/${id}/sketch.svg`;
    img.alt = `Sketch: ${meta.title}`;
    sec.appendChild(img);
    const player = document.querySelector(".player");
    (player || document.querySelector("header")).insertAdjacentElement("afterend", sec);
  };

  /** When the brief settles, take the transcript, evidence link and error from the finished card page. */
  const settle = async () => {
    try {
      const html = await (await fetch(`/b/${id}`, { cache: "no-store" })).text();
      const doc = new DOMParser().parseFromString(html, "text/html");
      document.title = doc.title;
      for (const sel of ["h1", ".byline"]) {
        const a = document.querySelector(sel);
        const b = doc.querySelector(sel);
        if (a && b) a.textContent = b.textContent;
      }
      for (const sel of [".evidence", ".transcript", ".error"]) {
        const old = document.querySelector(sel);
        if (old) old.remove();
        const fresh = doc.querySelector(sel);
        if (fresh) document.querySelector("main").appendChild(document.importNode(fresh, true));
      }
      body.dataset.status = doc.body.dataset.status;
    } catch (_) { /* the page stays as it is */ }
  };

  const apply = () => {
    if (!meta) return;
    const h1 = document.querySelector("h1");
    if (meta.status === "pending" && meta.title && meta.title !== "Working on it") {
      h1.textContent = meta.title;
      document.title = meta.title;
    }
    for (const [track, el] of Object.entries(buttons)) {
      const t = meta.tracks && meta.tracks[track];
      if (el) el.disabled = !t || t.status === "failed";
    }
    sketchHtml();
    paint();
  };

  const busy = () => meta.status === "pending" || Object.values(meta.tracks || {}).some((t) => t.status === "pending");
  const started = Date.now();
  const poll = async () => {
    try {
      meta = await (await fetch(`/b/${id}/meta.json`, { cache: "no-store" })).json();
      apply();
      if (meta.status !== "pending" && body.dataset.status === "pending") await settle();
      if (!busy() || Date.now() - started > 600000) return;
    } catch (_) { /* keep polling */ }
    setTimeout(poll, 1000);
  };
  poll();
})();
