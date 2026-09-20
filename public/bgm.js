// public/bgm.js
// トランプ人狼 - 背景音楽（既存ファイルは一切変更しません）
(function () {
  const AUDIO_SRC = "/bgm.mp3";
  const VOLUME = 0.35;
  const STORAGE_KEY = "trump_jinro_bgm_muted";

  const audio = new Audio(AUDIO_SRC);
  audio.loop = true;
  audio.volume = VOLUME;
  audio.preload = "auto";

  function isMuted() { return localStorage.getItem(STORAGE_KEY) === "1"; }
  function setMuted(m) {
    localStorage.setItem(STORAGE_KEY, m ? "1" : "0");
    audio.muted = m;
    if (!m) audio.play().catch(() => {});
    updateButton();
  }
  audio.muted = isMuted();

  // ブラウザの自動再生制限対策：最初のクリック/タップで再生開始
  function unlockOnce() {
    if (!isMuted()) audio.play().catch(() => {});
    document.removeEventListener("click", unlockOnce);
    document.removeEventListener("touchstart", unlockOnce);
  }
  document.addEventListener("click", unlockOnce);
  document.addEventListener("touchstart", unlockOnce);

  let btn = null;
  function updateButton() {
    if (!btn) return;
    btn.textContent = isMuted() ? "BGM OFF" : "BGM ON";
  }
  function ensureButton() {
    if (document.getElementById("bgmToggleBtn")) { btn = document.getElementById("bgmToggleBtn"); return; }
    btn = document.createElement("button");
    btn.id = "bgmToggleBtn";
    btn.style.cssText = `
      position: fixed; left: 10px; bottom: calc(6px + env(safe-area-inset-bottom));
      z-index: 200; font-size: 10px; font-weight: 700; letter-spacing: 0.05em;
      padding: 4px 10px; border-radius: 20px;
      background: rgba(8,4,18,0.55); color: rgba(255,255,255,0.75);
      border: 1px solid rgba(255,215,0,0.2); cursor: pointer;
    `;
    btn.onclick = () => setMuted(!isMuted());
    document.body.appendChild(btn);
    updateButton();
  }

  // main.jsがinnerHTMLを丸ごと差し替えてもボタンが消えないよう監視
  const observer = new MutationObserver(ensureButton);
  observer.observe(document.body, { childList: true, subtree: true });
  ensureButton();
})();
