#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import sys

with open('public/app.js', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Update makeInviteUrl for deep linking
old_invite = """function makeInviteUrl() {
  const base = window.location.origin + window.location.pathname;
  const room = encodeURIComponent(state.roomId);
  return `${base}?room=${room}`;
}"""

new_invite = """function makeInviteUrl() {
  // FIX: Telegram Mini App Deep Link
  const botUsername = 'rave_tma_bot';
  return `https://t.me/${botUsername}?startapp=${encodeURIComponent(state.roomId)}`;
}"""

content = content.replace(old_invite, new_invite)

# 2. Update inviteFriend for deep linking
old_friend = """async function inviteFriend() {
  const inviteUrl = makeInviteUrl();

  try {
    await navigator.clipboard.writeText(inviteUrl);
    showSnack('🔗 Ссылка-приглашение скопирована');
  } catch (e) {
    console.warn('[Invite] Clipboard недоступен:', e);
    els.urlInput.value = inviteUrl;
    openDrawer();
    showSnack('🔗 Ссылка скопирована в поле ввода');
  }
}"""

new_friend = """async function inviteFriend() {
  const inviteUrl = makeInviteUrl();

  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(inviteUrl);
    } else if (window.Telegram?.WebApp?.Clipboard) {
      await window.Telegram.WebApp.Clipboard.writeText(inviteUrl);
    } else {
      throw new Error('Clipboard недоступен');
    }
    showSnack('🔗 Ссылка скопирована!');
  } catch (e) {
    console.warn('[Invite] Clipboard недоступен:', e);
    els.urlInput.value = inviteUrl;
    openDrawer();
    showSnack('🔗 Ссылка скопирована в поле ввода');
  }
}"""

content = content.replace(old_friend, new_friend)

# 3. Remove setupMobileAutoplayFix call in showRoomView
old_showroom = """  if (/Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    setTimeout(setupMobileAutoplayFix, 500);
  }
}"""

new_showroom = """  // FIX: Автоплей без overlay — плееры создаются с muted:1
}"""

content = content.replace(old_showroom, new_showroom)

# Remove the entire setupMobileAutoplayFix function
old_setup = """function setupMobileAutoplayFix() {
  const container = document.getElementById('player-container');
  if (!container || state.isUserInteracted) return;

  const overlay = document.createElement('div');
  overlay.id = 'unblock-autoplay-overlay';
  overlay.style.cssText = `
    position: absolute; top: 0; left: 0; width: 100%; height: 100%;
    z-index: 99; background: rgba(0,0,0,0.35); display: flex;
    justify-content: center; align-items: center; color: white;
    font-weight: bold; font-size: 14px; cursor: pointer;
    text-align: center; padding: 20px; box-sizing: border-box;
  `;
  overlay.innerText = 'Нажмите на экран для старта видео 🍿';

  const unlock = () => {
    state.isUserInteracted = true;
    overlay.remove();

    const player = getActivePlayer();
    if (player && player.playVideo) {
      try { player.unMute(); } catch (e) { /* ignore */ }
      player.playVideo();
    }
  };

  overlay.addEventListener('click', unlock, { once: true });
  overlay.addEventListener('touchend', (e) => {
    e.preventDefault();
    unlock();
  }, { once: true });

  container.appendChild(overlay);
}"""

content = content.replace(old_setup, '')

# 4. Update applyVideoSync for stable sync
old_sync = """  if (Math.abs(timeDiff) <= 0.5) {
    setPlayerSpeed(player, 1.0);
    return;
  }

  if (Math.abs(timeDiff) > 0.5 && Math.abs(timeDiff) <= 4.0) {
    if (timeDiff > 0) {
      setPlayerSpeed(player, 1.15);
    } else {
      setPlayerSpeed(player, 0.85);
    }
    return;
  }

  console.log(`[Sync] Крупный рассинхрон (${timeDiff.toFixed(1)}s), делаем seekTo`);
  setPlayerSpeed(player, 1.0);
  if (player.seekTo) {
    player.seekTo(targetTime, true);
  } else {
    player.currentTime = targetTime;
  }"""

new_sync = """  // FIX: Стабильная синхронизация — плавная подгонка скорости вместо seekTo
  if (Math.abs(timeDiff) <= 0.5) {
    setPlayerSpeed(player, 1.0);
    return;
  }

  if (Math.abs(timeDiff) > 0.5 && Math.abs(timeDiff) <= 3.0) {
    if (timeDiff > 0) {
      setPlayerSpeed(player, 1.15);
    } else {
      setPlayerSpeed(player, 0.85);
    }
    return;
  }

  console.log(`[Sync] Крупный рассинхрон (${timeDiff.toFixed(1)}s), делаем seekTo`);
  setPlayerSpeed(player, 1.0);
  if (player.seekTo) {
    player.seekTo(targetTime, true);
  } else {
    player.currentTime = targetTime;
  }"""

content = content.replace(old_sync, new_sync)

# 5. Change sync interval from 4s to 3s
content = content.replace('}, 4000);', '}, 3000);')

# 6. Add start_param deep link check
old_init = """  let roomFromTelegram =
    initData.start_param ||
    new URLSearchParams(window.location.search).get('room') ||
    '';

  if (roomFromTelegram && /^[a-zA-Z0-9_-]{1,64}$/.test(roomFromTelegram)) {
    state.roomId = roomFromTelegram;
  } else if (!state.roomId) {
    state.roomId = generateRoomId();
  }"""

new_init = """  // FIX: Deep linking через start_param (Telegram Mini App)
  let roomFromTelegram =
    initData.start_param ||
    new URLSearchParams(window.location.search).get('room') ||
    '';

  if (roomFromTelegram && /^[a-zA-Z0-9_-]{1,64}$/.test(roomFromTelegram)) {
    state.roomId = roomFromTelegram;
  } else if (!state.roomId) {
    state.roomId = generateRoomId();
  }

  // FIX: Если пришли по deep link — сразу подключаемся к комнате
  if (roomFromTelegram && /^[a-zA-Z0-9_-]{1,64}$/.test(roomFromTelegram)) {
    console.log('[Telegram] Deep link room:', roomFromTelegram);
  }"""

content = content.replace(old_init, new_init)

with open('public/app.js', 'w', encoding='utf-8') as f:
    f.write(content)

print('app.js updated successfully')
