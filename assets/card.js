(() => {
  const body = document.body;
  const id = body.dataset.id;

  if (body.dataset.status === "pending") {
    const started = Date.now();
    const timer = setInterval(async () => {
      if (Date.now() - started > 600000) {
        clearInterval(timer);
        document.querySelector("h1").textContent = "Could not make this memo";
        const p = document.createElement("p");
        p.className = "error";
        p.textContent = "Timed out waiting for the memo.";
        document.querySelector("main").appendChild(p);
        return;
      }
      try {
        const res = await fetch(`/b/${id}/meta.json`, { cache: "no-store" });
        const meta = await res.json();
        if (meta.status !== "pending") location.reload();
      } catch (_) { /* keep polling */ }
    }, 1500);
    return;
  }

  const audio = document.getElementById("audio");
  if (!audio) return;
  const play = document.getElementById("play");
  const seek = document.getElementById("seek");
  const time = document.getElementById("time");
  const speed = document.getElementById("speed");
  const back = document.getElementById("back");
  const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const total = () => (isFinite(audio.duration) ? audio.duration : 0);
  const toggle = () => (audio.paused ? audio.play() : audio.pause());

  play.addEventListener("click", toggle);
  back.addEventListener("click", () => { audio.currentTime = Math.max(0, audio.currentTime - 10); });
  const speeds = [1, 1.25, 1.5];
  speed.addEventListener("click", () => {
    const next = speeds[(speeds.indexOf(audio.playbackRate) + 1) % speeds.length];
    audio.playbackRate = next;
    speed.textContent = `${next}x`;
  });
  seek.addEventListener("input", () => { if (total()) audio.currentTime = (seek.value / 1000) * total(); });

  const paint = () => {
    play.classList.toggle("playing", !audio.paused);
    play.setAttribute("aria-label", audio.paused ? "Play" : "Pause");
    if (total()) seek.value = String(Math.round((audio.currentTime / total()) * 1000));
    time.textContent = `${fmt(audio.currentTime)} / ${fmt(total())}`;
  };
  ["play", "pause", "timeupdate", "loadedmetadata", "ended"].forEach((e) => audio.addEventListener(e, paint));

  if ("mediaSession" in navigator) {
    const ms = navigator.mediaSession;
    ms.metadata = new MediaMetadata({ title: body.dataset.title || "Memo", artist: "Earshot" });
    ms.setActionHandler("play", () => audio.play());
    ms.setActionHandler("pause", () => audio.pause());
    ms.setActionHandler("seekbackward", () => { audio.currentTime = Math.max(0, audio.currentTime - 10); });
    ms.setActionHandler("seekforward", () => { audio.currentTime = Math.min(total(), audio.currentTime + 10); });
    ms.setActionHandler("seekto", (d) => { audio.currentTime = d.seekTime; });
  }
})();
