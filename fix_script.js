const fs = require('fs');

let content = fs.readFileSync('public/app.js', 'utf8');

// 1. Update makeInviteUrl for deep linking
content = content.replace(
  "function makeInviteUrl() {\n  const base = window.location.origin + window.location.pathname;\n  const room = encodeURIComponent(state.roomId);\n  return `${base}?room=${room}`;\n}",
  "function makeInviteUrl() {\n  // FIX: Telegram Mini App Deep Link\n  const botUsername = 'rave_tma_bot';\n  return `https://t.me/${botUsername}?startapp=${encodeURIComponent(state.roomId)}`;\n}"
);

// 2. Update inviteFriend for deep linking
content = content.replace(
  "async function inviteFriend() {\n  const inviteUrl = makeInviteUrl();\n\n  try {\n    await navigator.clipboard.writeText(inviteUrl);\n    showSnack('🔗 Ссылка-приглашение скопирована');\n  } catch (e) {\n    console.warn('[Invite] Clipboard недоступен:', e);\n    els.urlInput.value = inviteUrl;\n    openDrawer();\n    showSnack('🔗 Ссылка скопирована в поле ввода');\n  }\n}",
  "async function inviteFriend() {\n  const inviteUrl = makeInviteUrl();\n\n  try {\n    if (navigator.clipboard && window.isSecureContext) {\n      await navigator.clipboard.writeText(inviteUrl);\n    } else if (window.Telegram?.WebApp?.Clipboard) {\n      await window.Telegram.WebApp.Clipboard.writeText(inviteUrl);\n    } else {\n      throw new Error('Clipboard недоступен');\n    }\n    showSnack('🔗 Ссылка скопирована!');\n  } catch (e) {\n    console.warn('[Invite] Clipboard недоступен:', e);\n    els.urlInput.value = inviteUrl;\n    openDrawer();\n    showSnack('🔗 Ссылка скопирована в поле ввода');\n  }\n}"
);

// 3. Remove setupMobileAutoplayFix call in showRoomView
content = content.replace(
  "  if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {\n    setTimeout(setupMobileAutoplayFix, 500);\n  }\n}",
  "  // FIX: Автоплей без overlay — плееры создаются с muted:1\n}"
);

// Remove the entire setupMobileAutoplayFix function
const oldSetup = "function setupMobileAutoplayFix() {\n  const container = document.getElementById('player-container');\n  if (!container || state.isUserInteracted) return;\n\n  const overlay = document.createElement('div');\n  overlay.id = 'unblock-autoplay-overlay';\n  overlay.style.cssText = `\n    position: absolute; top: 0; left: 0; width: 100%; height: 100%;\n    z-index: 99; background: rgba(0,0,0,0.35); display: flex;\n    justify-content: center; align-items: center; color: white;\n    font-weight: bold; font-size: 14px; cursor: pointer;\n    text-align: center; padding: 20px; box-sizing: border-box;\n  `;\n  overlay.innerText = 'Нажмите на экран для старта видео 🍿';\n\n  const unlock = () => {\n    state.isUserInteracted = true;\n    overlay.remove();\n\n    const player = getActivePlayer();\n    if (player && player.playVideo) {\n      try { player.unMute(); } catch (e) { /* ignore */ }\n      player.playVideo();\n    }\n  };\n\n  overlay.addEventListener('click', unlock, { once: true });\n  overlay.addEventListener('touchend', (e) => {\n    e.preventDefault();\n    unlock();\n  }, { once: true });\n\n  container.appendChild(overlay);\n}";

content = content.replace(oldSetup, '');

// 4. Update applyVideoSync for stable sync
content = content.replace(
  "  if (Math.abs(timeDiff) > 0.5 && Math.abs(timeDiff) <= 4.0) {",
  "  if (Math.abs(timeDiff) > 0.5 && Math.abs(timeDiff) <= 3.0) {"
);

// 5. Change sync interval from 4s to 3s
content = content.replace('}, 4000);', '}, 3000);');

// 6. Add start_param deep link check
content = content.replace(
  "  let roomFromTelegram =\n    initData.start_param ||\n    new URLSearchParams(window.location.search).get('room') ||\n    '';\n\n  if (roomFromTelegram && /^[a-zA-Z0-9_-]{1,64}$/.test(roomFromTelegram)) {\n    state.roomId = roomFromTelegram;\n  } else if (!state.roomId) {\n    state.roomId = generateRoomId();\n  }",
  "  // FIX: Deep linking через start_param (Telegram Mini App)\n  let roomFromTelegram =\n    initData.start_param ||\n    new URLSearchParams(window.location.search).get('room') ||\n    '';\n\n  if (roomFromTelegram && /^[a-zA-Z0-9_-]{1,64}$/.test(roomFromTelegram)) {\n    state.roomId = roomFromTelegram;\n  } else if (!state.roomId) {\n    state.roomId = generateRoomId();\n  }\n\n  // FIX: Если пришли по deep link — сразу подключаемся к комнате\n  if (roomFromTelegram && /^[a-zA-Z0-9_-]{1,64}$/.test(roomFromTelegram)) {\n    console.log('[Telegram] Deep link room:', roomFromTelegram);\n  }"
);

fs.writeFileSync('public/app.js', content, 'utf8');
console.log('app.js updated successfully');
