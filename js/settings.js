// ===================================================================
// 設定画面（HUD 右端の歯車ボタンで開く）
// 今の項目は SOUND ON/OFF だけ。値の保存と効果音の停止は sound.js の Sound.setEnabled が行う
// ===================================================================
(() => {
  const settingsEl = document.getElementById("settings");
  const soundButtons = settingsEl.querySelectorAll("[data-sound]");

  function updateSoundButtons() {
    const current = Sound.isEnabled() ? "on" : "off";
    for (const button of soundButtons) {
      button.setAttribute("aria-pressed", String(button.dataset.sound === current));
    }
  }

  function open() {
    updateSoundButtons();
    settingsEl.hidden = false;
  }

  function close() {
    settingsEl.hidden = true;
  }

  document.getElementById("settings-button").addEventListener("click", open);
  document.getElementById("settings-close").addEventListener("click", close);
  // パネルの外（暗い部分）をタップしても閉じる
  settingsEl.addEventListener("click", (event) => {
    if (event.target === settingsEl) close();
  });

  for (const button of soundButtons) {
    button.addEventListener("click", () => {
      Sound.setEnabled(button.dataset.sound === "on");
      updateSoundButtons();
    });
  }
})();
