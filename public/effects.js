// public/effects.js
// トランプ人狼 - 派手演出アドオン（既存ファイルは一切変更しません）
(function () {
  const STYLE_ID = "tj-fx-style";
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      /* 市民カード：緑のほわほわオーラ（手札） */
      .hand-card.suit-black, .hand-card.suit-red {
        animation: tjAuraPulse 2.2s ease-in-out infinite;
      }
      @keyframes tjAuraPulse {
        0%, 100% {
          box-shadow: 0 2px 6px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(255,255,255,0.1),
                      0 0 6px rgba(90,255,140,0.35);
        }
        50% {
          box-shadow: 0 2px 6px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(255,255,255,0.1),
                      0 0 24px rgba(90,255,140,0.9), 0 0 42px rgba(90,255,140,0.35);
        }
      }

      /* 役職カード：手札にある時だけ、金の粒子が外側に広がる演出 */
      .hand-card.role-frame {
        position: relative;
        overflow: visible !important;
        animation: tjGoldGlow 2.2s ease-in-out infinite;
      }
      @keyframes tjGoldGlow {
        0%, 100% {
          box-shadow: 0 2px 6px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(255,255,255,0.1),
                      0 0 6px rgba(255,215,0,0.35);
        }
        50% {
          box-shadow: 0 2px 6px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(255,255,255,0.1),
                      0 0 22px rgba(255,215,0,0.85), 0 0 38px rgba(255,200,80,0.35);
        }
      }
      .hand-card.role-frame::before {
        content: "";
        position: absolute;
        inset: -14px;
        border-radius: 50%;
        pointer-events: none;
        background:
          radial-gradient(3px 3px at 50% 8%,  #ffe9a0 0%, rgba(255,233,160,0) 70%),
          radial-gradient(3px 3px at 82% 22%, #ffd76a 0%, rgba(255,215,106,0) 70%),
          radial-gradient(2.5px 2.5px at 88% 55%, #fff3c4 0%, rgba(255,243,196,0) 70%),
          radial-gradient(3px 3px at 70% 85%, #ffe9a0 0%, rgba(255,233,160,0) 70%),
          radial-gradient(2.5px 2.5px at 30% 88%, #ffd76a 0%, rgba(255,215,106,0) 70%),
          radial-gradient(3px 3px at 12% 60%, #fff3c4 0%, rgba(255,243,196,0) 70%),
          radial-gradient(2.5px 2.5px at 18% 25%, #ffe9a0 0%, rgba(255,233,160,0) 70%);
        opacity: 0;
        animation: tjGoldParticles 2.2s ease-out infinite;
      }
      @keyframes tjGoldParticles {
        0%   { transform: scale(0.55); opacity: 0; }
        35%  { opacity: 1; }
        100% { transform: scale(1.35); opacity: 0; }
      }

      /* 場に置いた役職カードには演出なし（元のデザインのまま） */
      .field-card.role-frame::before,
      .field-card.role-frame::after {
        content: none !important;
        animation: none !important;
      }

      /* リーチ演出：勝利まであと1枚の枠がぷおんぷおん */
      .field-slot.empty.tj-reach {
        border-color: #ffd700 !important;
        background: rgba(255,215,0,0.14) !important;
        animation: tjReachPump 0.85s ease-in-out infinite;
      }
      @keyframes tjReachPump {
        0%, 100% { transform: scale(1);    box-shadow: 0 0 8px rgba(255,215,0,0.4); }
        50%      { transform: scale(1.18); box-shadow: 0 0 26px rgba(255,215,0,0.95); }
      }
    `;
    document.head.appendChild(style);
  }

  // 自分の市民カード列を見て「あと1枠で勝利」を検出する
  function applyReachEffect() {
    document.querySelectorAll(".field-slot.tj-reach").forEach((el) => el.classList.remove("tj-reach"));
    const row = document.querySelector(".zone-my-field .slot-row:first-child");
    if (!row) return;
    const slots = Array.from(row.children);
    const emptySlots = slots.filter((el) => el.classList.contains("field-slot") && el.classList.contains("empty"));
    if (emptySlots.length === 1) {
      emptySlots[0].classList.add("tj-reach");
    }
  }

  let scheduled = false;
  function scheduleRun() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; applyReachEffect(); });
  }

  // main.js は再描画のたびに innerHTML を丸ごと入れ替えるため、
  // MutationObserver でDOM変化を監視して効果を再適用する
  const observer = new MutationObserver(scheduleRun);
  observer.observe(document.body, { childList: true, subtree: true });

  scheduleRun();
})();
