// ═══════════════════════════════════════════════════════════════
// SecureChat v3 — Client Script
// ═══════════════════════════════════════════════════════════════

// ─── АДРЕС СЕРВЕРА (Termux) ───
// В APK нет "своего" сервера — грузим адрес, который ты вводишь в приложении
// (Настройки → Адрес сервера). Хранится в localStorage, переживает обновления.
// Для сайта (если открываешь просто в браузере с того же сервера) — оставляем пусто = same-origin.
const isNative = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
let SERVER_URL = localStorage.getItem('server_url') || window.BAKED_SERVER_URL || '';
const socket = io(SERVER_URL || undefined, { transports: ['websocket', 'polling'], reconnection: true, reconnectionDelay: 1000, reconnectionAttempts: Infinity });

// ─── СОСТОЯНИЕ ───
let me = localStorage.getItem('u') || '';
let myDN = '', myBio = '', myDevId = localStorage.getItem('did') || '';
let iAmAdmin = false;
let curChat = '', curPartner = '', curIsGroup = false;
let allUsers = [], activeChats = [], msgs = {}, groups = [];
let unread = {}, replyId = null, pendingMedia = null, pendingMediaType = null, pendingAvaUrl = null;
let onlineAll = [], onlineVisible = [];
let typTimer = null, typIndTimer = null;
let speakerOn = true;
let heartbeatInterval = null;

// ─── ИНИЦИАЛИЗАЦИЯ ───
window.onload = () => {
  applyTheme(localStorage.getItem('theme') || 'dark');
  loadPrefsUI();
  initResizer();
  initAudio();
  unlockAudio();
  setupKeyboard();
  requestAllPermissions();
  if (isNative && !SERVER_URL) {
    promptServerUrl();
  } else if (isNative && SERVER_URL && !localStorage.getItem('server_url')) {
    // Адрес зашит при сборке (Tailscale IP) — сохраняем его, чтобы можно было
    // потом сменить вручную через changeServerUrl(), если понадобится.
    localStorage.setItem('server_url', SERVER_URL);
    if (me && myDevId) socket.emit('relogin', { username: me, oldDeviceId: myDevId });
  } else if (me && myDevId) {
    socket.emit('relogin', { username: me, oldDeviceId: myDevId });
  }
};

// ─── АДРЕС СЕРВЕРА: экран настройки (только APK) ───
function promptServerUrl() {
  const val = prompt('Адрес твоего сервера (Termux), например:\nhttp://100.x.x.x:3000  (Tailscale IP)\nили http://192.168.1.50:3000 (локальная сеть)');
  if (val && val.trim()) {
    localStorage.setItem('server_url', val.trim());
    location.reload();
  }
}
// Вызывай вручную из настроек, если захочешь сменить адрес сервера
function changeServerUrl() { promptServerUrl(); }

// ─── РАЗРЕШЕНИЯ (камера/микрофон/уведомления/вибрация) ───
async function requestAllPermissions() {
  try {
    if (window.Notification && Notification.permission === 'default') {
      await Notification.requestPermission();
    }
  } catch (e) {}
  try {
    if (isNative && window.Capacitor.Plugins.LocalNotifications) {
      await window.Capacitor.Plugins.LocalNotifications.requestPermissions();
    }
  } catch (e) {}
  // Камеру/микрофон не запрашиваем заранее отдельным диалогом —
  // Android спросит их сам при первом звонке (getUserMedia),
  // а системные разрешения CAMERA/RECORD_AUDIO/POST_NOTIFICATIONS/VIBRATE
  // уже объявлены в AndroidManifest и предзапрашиваются нативным кодом при старте приложения.
}

function initAudio() {
  const ring = document.getElementById('snd-ringtone');
  const notif = document.getElementById('snd-notif');
  // Рингтон и звук уведомлений сохраняются в localStorage
  if (ring) ring.src = localStorage.getItem('ringtone') || 'https://assets.mixkit.co/active_storage/sfx/1359/1359-84.wav';
  if (notif) notif.src = localStorage.getItem('notif_sound') || 'https://assets.mixkit.co/active_storage/sfx/2869/2869-84.wav';
}

function unlockAudio() {
  const fn = () => {
    ['snd-ringtone', 'snd-notif', 'remote-aud'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      const p = el.play();
      if (p) p.then(() => { el.pause(); el.currentTime = 0; }).catch(() => {});
    });
  };
  document.addEventListener('click', fn, { once: true });
  document.addEventListener('touchstart', fn, { once: true });
}

function startHeartbeat() {
  stopHeartbeat();
  socket.emit('heartbeat');
  heartbeatInterval = setInterval(() => socket.emit('heartbeat'), 10000);
}
function stopHeartbeat() {
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
}

function setupKeyboard() {
  document.addEventListener('DOMContentLoaded', () => {});
  // Работаем без DOMContentLoaded — всё уже загружено при вызове window.onload
  const lUser = document.getElementById('l-user');
  const lPass = document.getElementById('l-pass');
  const rPass2 = document.getElementById('r-pass2');
  const searchInp = document.getElementById('search-inp');
  const msgInp = document.getElementById('msg-inp');
  const fsCap = document.getElementById('fs-caption');

  if (lUser) lUser.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  if (lPass) lPass.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  if (rPass2) rPass2.addEventListener('keydown', e => { if (e.key === 'Enter') doRegister(); });
  if (searchInp) searchInp.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
  if (msgInp) {
    msgInp.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); sendMsg(); } });
    msgInp.addEventListener('input', () => {
      if (!curChat) return;
      socket.emit('typing', { chatId: curChat, isTyping: true });
      clearTimeout(typTimer);
      typTimer = setTimeout(() => socket.emit('typing', { chatId: curChat, isTyping: false }), 1500);
    });
  }
  if (fsCap) fsCap.addEventListener('keydown', e => { if (e.key === 'Enter') confirmSend(); });
}

// ─── АВТОРИЗАЦИЯ ───
function switchTab(t) {
  document.getElementById('tab-login').classList.toggle('hidden', t !== 'login');
  document.getElementById('tab-reg').classList.toggle('hidden', t !== 'reg');
  document.querySelectorAll('.tab').forEach((el, i) =>
    el.classList.toggle('active', (i === 0 && t === 'login') || (i === 1 && t === 'reg')));
}

function doLogin() {
  const u = (document.getElementById('l-user').value || '').trim();
  const p = document.getElementById('l-pass').value || '';
  if (!u || !p) return toast('⚠️ Заполните все поля');
  socket.emit('login', { username: u, password: p });
  document.getElementById('l-pass').value = '';
}

function doRegister() {
  const u = (document.getElementById('r-user').value || '').trim();
  const p = document.getElementById('r-pass').value || '';
  const p2 = document.getElementById('r-pass2').value || '';
  if (!u || !p || !p2) return toast('⚠️ Заполните все поля');
  if (p !== p2) return toast('❌ Пароли не совпадают');
  socket.emit('register', { username: u, password: p });
  document.getElementById('r-pass').value = '';
  document.getElementById('r-pass2').value = '';
}

socket.on('authError', m => toast(m || '❌ Ошибка'));
socket.on('profileError', m => toast(m || '❌ Ошибка обновления профиля'));

socket.on('authSuccess', data => {
  me = data.username || '';
  myDN = data.displayName || '';
  myBio = data.bio || '';
  iAmAdmin = !!data.isAdmin;
  if (data.newDeviceId) myDevId = data.newDeviceId;
  localStorage.setItem('u', me);
  localStorage.setItem('did', myDevId);

  document.getElementById('login-screen').classList.remove('active');
  document.getElementById('app-screen').classList.add('active');
  document.getElementById('my-dname').innerText = myDN;
  document.getElementById('my-uname').innerText = '@' + me;
  setAva('my-ava', data.avatar, myDN);
  document.getElementById('admin-btn').style.display = iAmAdmin ? 'flex' : 'none';

  startHeartbeat();
});

socket.on('initData', data => {
  allUsers = data.users || [];
  activeChats = data.activeChats || [];
  msgs = data.messages || {};
  groups = data.groups || [];
  renderSidebar();
  if (curChat) renderMsgs();
});

socket.on('onlineUpdate', data => {
  onlineAll = data.all || [];
  onlineVisible = data.visible || [];
  renderChats();
  updateChatHeader();
});

socket.on('userProfileGlobalUpdate', u => {
  if (!u) return;
  if (u.oldName && u.oldName !== u.name) {
    const i = activeChats.indexOf(u.oldName);
    if (i !== -1) activeChats[i] = u.name;
    if (curPartner === u.oldName) curPartner = u.name;
  }
  const idx = allUsers.findIndex(x => x.name === u.name);
  if (idx !== -1) { allUsers[idx].displayName = u.displayName; allUsers[idx].avatar = u.avatar; allUsers[idx].bio = u.bio; }
  else allUsers.push(u);
  if (curPartner === u.name) {
    document.getElementById('ch-title').innerText = esc(u.displayName || u.name);
    setAva('ch-ava', u.avatar, u.displayName);
    // Обновляем аватарки в списке чатов
    setAva('ci-' + u.name, u.avatar, u.displayName);
  }
  renderSidebar();
});

socket.on('userDeletedGlobal', ({ name }) => {
  activeChats = activeChats.filter(u => u !== name);
  allUsers = allUsers.filter(u => u.name !== name);
  if (curPartner === name) { curChat = ''; curPartner = ''; closeMobile(); resetChat(); }
  renderSidebar();
});

socket.on('adminAnnouncement', d => toast('📢 ' + (d.text || ''), 7000));

// ─── ПОИСК ───
function doSearch() {
  const q = (document.getElementById('search-inp').value || '').trim();
  const res = document.getElementById('search-res');
  if (!q) { res.innerHTML = ''; return; }
  socket.emit('searchUser', q);
}

socket.on('searchResult', results => {
  const res = document.getElementById('search-res');
  res.innerHTML = '';
  if (!results.length) { res.innerHTML = '<div class="search-empty">Не найдено</div>'; return; }
  results.forEach(u => {
    if (u.name === me) return;
    const div = document.createElement('div');
    div.className = 'chat-item';
    div.innerHTML = `<div class="avatar sm" id="sr-${esc(u.name)}"></div><div class="ci-info"><div class="ci-top"><b>${esc(u.displayName || u.name)}</b></div><div class="ci-sub">@${esc(u.name)}</div></div>`;
    div.onclick = () => {
      const cid = chatId(me, u.name);
      if (!activeChats.includes(u.name)) activeChats.push(u.name);
      const ex = allUsers.findIndex(x => x.name === u.name);
      if (ex === -1) allUsers.push(u); else allUsers[ex] = { ...allUsers[ex], ...u };
      res.innerHTML = '';
      document.getElementById('search-inp').value = '';
      openChat(cid, u.name);
    };
    res.appendChild(div);
    setAva('sr-' + u.name, u.avatar, u.displayName);
  });
});

// ─── БОКОВАЯ ПАНЕЛЬ ───
function renderSidebar() { renderChats(); renderGroups(); }

function renderChats() {
  const list = document.getElementById('chat-list');
  list.innerHTML = '';
  if (!activeChats.length) {
    list.innerHTML = '<div class="empty-hint">Нет переписок.<br>Найдите контакт выше 🔍</div>';
    return;
  }
  const data = activeChats.map(u => {
    const cid = chatId(me, u);
    const m = msgs[cid] || [];
    const last = m[m.length - 1];
    let lastTxt = 'Нет сообщений';
    if (last) lastTxt = last.text ? esc(last.text.slice(0, 38)) : (last.mediaType === 'video' ? '🎬 Видео' : '📸 Фото');
    const f = allUsers.find(x => x.name === u);
    return {
      u, cid, lastTxt,
      lastTime: last ? (last.time || '') : '',
      unread: unread[cid] || 0,
      avatar: f ? f.avatar : '',
      dn: f ? f.displayName : u,
      online: onlineVisible.includes(u)
    };
  }).sort((a, b) => b.unread - a.unread);

  data.forEach(c => {
    const div = document.createElement('div');
    div.className = 'chat-item' + (curChat === c.cid ? ' active' : '');
    div.innerHTML = `
      <div class="avatar sm" id="ci-${esc(c.u)}"></div>
      <div class="ci-info">
        <div class="ci-top">
          <b>${esc(c.dn)} ${c.online ? '<span class="dot-online"></span>' : ''}</b>
          ${c.unread > 0 ? `<span class="badge">${c.unread}</span>` : `<span class="last-time">${esc(c.lastTime)}</span>`}
        </div>
        <div class="ci-sub">${c.lastTxt}</div>
      </div>`;
    div.onclick = () => openChat(c.cid, c.u);
    list.appendChild(div);
    // Аватарка собеседника в списке чатов
    setAva('ci-' + c.u, c.avatar, c.dn);
  });
}

function renderGroups() {
  const list = document.getElementById('group-list');
  list.innerHTML = '';
  const myGroups = groups.filter(g => g.members.includes(me));
  if (!myGroups.length) { list.innerHTML = '<div class="empty-hint">Нет групп</div>'; return; }
  myGroups.forEach(g => {
    const cid = 'group_' + g.id;
    const m = msgs[cid] || [];
    const last = m[m.length - 1];
    let lastTxt = 'Нет сообщений';
    if (last) lastTxt = last.text ? esc(last.text.slice(0, 35)) : '📎 Медиа';
    const div = document.createElement('div');
    div.className = 'chat-item' + (curChat === cid ? ' active' : '');
    div.innerHTML = `
      <div class="avatar sm" style="background:linear-gradient(135deg,#7c3aed,#06b6d4)">👥</div>
      <div class="ci-info">
        <div class="ci-top"><b>${esc(g.name)}</b>${(unread[cid] || 0) > 0 ? `<span class="badge">${unread[cid]}</span>` : ''}</div>
        <div class="ci-sub">${lastTxt}</div>
      </div>`;
    div.onclick = () => openGroupChat(cid, g);
    list.appendChild(div);
  });
}

// ─── ОТКРЫТИЕ ЧАТА ───
function openChat(cid, partner) {
  curChat = cid; curPartner = partner; curIsGroup = false;
  unread[cid] = 0;
  hideChatMenu();
  const f = allUsers.find(u => u.name === partner);
  const dn = f ? f.displayName : partner;
  const el = document.getElementById('ch-ava');
  el.style.display = 'flex';
  setAva('ch-ava', f ? f.avatar : '', dn);
  document.getElementById('ch-title').innerText = esc(dn);
  updateChatHeader();
  document.getElementById('input-bar').style.display = 'flex';
  document.getElementById('btn-acall').style.display = 'flex';
  document.getElementById('btn-vcall').style.display = 'flex';
  document.getElementById('btn-menu').style.display = 'flex';
  socket.emit('readChat', { chatId: cid });
  renderSidebar(); renderMsgs(); openMobile();
}

function openGroupChat(cid, group) {
  curChat = cid; curPartner = ''; curIsGroup = true;
  unread[cid] = 0;
  hideChatMenu();
  document.getElementById('ch-ava').style.display = 'none';
  document.getElementById('ch-title').innerText = esc(group.name);
  document.getElementById('ch-sub').innerText = `👥 ${group.members.length} участников`;
  document.getElementById('ch-sub').style.color = 'var(--fg2)';
  document.getElementById('input-bar').style.display = 'flex';
  document.getElementById('btn-acall').style.display = 'none';
  document.getElementById('btn-vcall').style.display = 'none';
  document.getElementById('btn-menu').style.display = 'flex';
  socket.emit('readChat', { chatId: cid });
  renderSidebar(); renderMsgs(); openMobile();
}

function updateChatHeader() {
  if (!curChat || curIsGroup) return;
  const isOnline = onlineVisible.includes(curPartner);
  const sub = document.getElementById('ch-sub');
  sub.innerText = isOnline ? '🟢 В сети' : '⚫ Не в сети';
  sub.style.color = isOnline ? 'var(--ok)' : 'var(--fg2)';
}

function resetChat() {
  document.getElementById('ch-title').innerText = 'Выберите чат';
  document.getElementById('ch-sub').innerText = 'Выберите контакт слева';
  document.getElementById('ch-sub').style.color = 'var(--fg2)';
  document.getElementById('ch-ava').style.display = 'none';
  document.getElementById('input-bar').style.display = 'none';
  document.getElementById('btn-acall').style.display = 'none';
  document.getElementById('btn-vcall').style.display = 'none';
  document.getElementById('btn-menu').style.display = 'none';
  document.getElementById('msgs').innerHTML = '<div class="empty-msgs">Выберите чат</div>';
  hideChatMenu();
}

// ─── МЕНЮ ЧАТА (3 точки) ───
function toggleChatMenu() {
  document.getElementById('chat-menu').classList.toggle('hidden');
}
function hideChatMenu() {
  document.getElementById('chat-menu').classList.add('hidden');
}
function menuProfile() {
  hideChatMenu();
  if (!curPartner) return;
  openPeerProfile();
}
function menuClear() {
  hideChatMenu();
  if (!curChat) return;
  if (confirm('Очистить переписку? Сообщения удалятся у обоих.')) {
    socket.emit('clearChat', { chatId: curChat });
  }
}
function menuDelete() {
  hideChatMenu();
  if (!curChat) return;
  if (confirm('Удалить этот чат из списка?')) {
    socket.emit('deleteChat', { chatId: curChat });
    activeChats = activeChats.filter(u => u !== curPartner);
    curChat = ''; curPartner = '';
    closeMobile(); resetChat(); renderSidebar();
  }
}
socket.on('chatDeleted', ({ chatId: cid }) => {
  if (cid === curChat) { curChat = ''; curPartner = ''; closeMobile(); resetChat(); }
  renderSidebar();
});

// ─── ПРОФИЛЬ СОБЕСЕДНИКА ───
function openPeerProfile() {
  if (!curPartner) return;
  socket.emit('getUserProfile', curPartner);
}
socket.on('userProfile', data => {
  setAva('peer-modal-ava', data.avatar, data.displayName);
  document.getElementById('peer-modal-dname').innerText = esc(data.displayName || data.name);
  document.getElementById('peer-modal-uname').innerText = '@' + esc(data.name);
  const bio = document.getElementById('peer-modal-bio');
  bio.innerText = data.bio || '';
  bio.style.display = data.bio ? 'block' : 'none';
  const info = document.getElementById('peer-modal-info');
  info.innerHTML = '';
  if (data.online !== null && data.online !== undefined) {
    const row = document.createElement('div');
    row.style = 'display:flex;justify-content:space-between;padding:8px 12px;background:var(--bg2);border-radius:8px;font-size:13px';
    row.innerHTML = `<span style="color:var(--fg2)">Статус</span><span>${data.online ? '🟢 В сети' : '⚫ Не в сети'}</span>`;
    info.appendChild(row);
  }
  if (data.createdAt) {
    const row = document.createElement('div');
    row.style = 'display:flex;justify-content:space-between;padding:8px 12px;background:var(--bg2);border-radius:8px;font-size:13px';
    row.innerHTML = `<span style="color:var(--fg2)">Зарегистрирован</span><span>${new Date(data.createdAt).toLocaleDateString('ru-RU')}</span>`;
    info.appendChild(row);
  }
  document.getElementById('modal-peer').classList.remove('hidden');
});
function closePeerProfile() { document.getElementById('modal-peer').classList.add('hidden'); }

// ─── СООБЩЕНИЯ ───
function sendMsg() {
  const inp = document.getElementById('msg-inp');
  const text = (inp.value || '').trim();
  if (!curChat) return toast('⚠️ Выберите чат');
  if (!text) return;
  inp.value = '';
  socket.emit('sendMessage', { chatId: curChat, text, replyTo: replyId });
  cancelReply();
  playPing();
  socket.emit('typing', { chatId: curChat, isTyping: false });
}

socket.on('newMessage', ({ chatId: cid, msg }) => {
  if (!msgs[cid]) msgs[cid] = [];
  msgs[cid].push(msg);

  // Если новый чат — добавляем в activeChats
  if (!cid.startsWith('group_') && cid.includes('_')) {
    const partner = cid.split('_').find(p => p !== me) || '';
    if (partner && !activeChats.includes(partner)) activeChats.push(partner);
  }

  if (cid === curChat) {
    if (msg.from !== me) socket.emit('readChat', { chatId: cid });
    renderMsgs();
  } else if (msg.from !== me) {
    unread[cid] = (unread[cid] || 0) + 1;
    if (soundOn()) document.getElementById('snd-notif').play().catch(() => {});
    vib(180);
    notifyLocal(displayNameOf(msg.from), msg.text ? msg.text.slice(0, 100) : '📎 Медиа');
  }
  renderSidebar();
});

// ─── Локальные уведомления (работают даже когда приложение свёрнуто, пока фоновый сервис жив) ───
function displayNameOf(username) {
  const u = allUsers.find(x => x.name === username);
  return (u && u.displayName) || username;
}
function notifyLocal(title, body) {
  // В браузере/на экране приложения — обычные Web Notifications
  if (document.hidden || isNative) {
    try {
      if (isNative && window.Capacitor && window.Capacitor.Plugins.LocalNotifications) {
        window.Capacitor.Plugins.LocalNotifications.schedule({
          notifications: [{ id: Date.now() % 2147483647, title, body, sound: null, smallIcon: 'ic_stat_notify' }]
        });
      } else if (window.Notification && Notification.permission === 'granted') {
        new Notification(title, { body });
      }
    } catch (e) {}
  }
}

socket.on('messageDeleted', ({ chatId: cid, msgId }) => {
  if (msgs[cid]) msgs[cid] = msgs[cid].filter(m => m.id !== msgId);
  if (cid === curChat) renderMsgs();
  renderSidebar();
});

socket.on('chatCleared', ({ chatId: cid }) => {
  msgs[cid] = [];
  if (cid === curChat) renderMsgs();
  renderSidebar();
});

socket.on('userTyping', ({ chatId: cid, from, isTyping }) => {
  if (cid !== curChat || from === me) return;
  const sub = document.getElementById('ch-sub');
  clearTimeout(typIndTimer);
  if (isTyping) {
    sub.innerText = '✏️ печатает...';
    sub.style.color = 'var(--acl)';
    typIndTimer = setTimeout(updateChatHeader, 3000);
  } else { updateChatHeader(); }
});

socket.on('chatReadUpdate', ({ chatId: cid }) => {
  if (msgs[cid]) msgs[cid].forEach(m => { m.isRead = true; });
  if (cid === curChat) renderMsgs();
});

socket.on('reactionUpdated', ({ chatId: cid, msgId, reactions }) => {
  if (msgs[cid]) { const m = msgs[cid].find(x => x.id === msgId); if (m) m.reactions = reactions; }
  if (cid === curChat) renderMsgs();
});

function renderMsgs() {
  const box = document.getElementById('msgs');
  box.innerHTML = '';
  const list = msgs[curChat] || [];
  if (!list.length) { box.innerHTML = '<div class="empty-msgs">💬<br>Начните переписку</div>'; return; }

  list.forEach(m => {
    const isMine = m.from === me;
    const wrap = document.createElement('div');
    wrap.className = 'msg-wrap ' + (isMine ? 'me' : 'peer');

    let replyHtml = '';
    if (m.replyTo) {
      const orig = list.find(x => x.id === m.replyTo);
      if (orig) replyHtml = `<div class="reply-zone">↪️ ${esc((orig.text || '[медиа]').slice(0, 30))}</div>`;
    }

    let rcounts = {};
    if (m.reactions) Object.values(m.reactions).forEach(e => { rcounts[e] = (rcounts[e] || 0) + 1; });
    const reactHtml = Object.entries(rcounts).map(([e, n]) =>
      `<span class="react-chip" onclick="react('${ea(m.id)}','${ea(e)}')">${e} ${n}</span>`).join('');

    const ticks = isMine ? (m.isRead ? '<span class="ticks-read">✓✓</span>' : '<span style="opacity:.4">✓</span>') : '';
    const senderLine = curIsGroup && !isMine ? `<div class="msg-sender">@${esc(m.from)}</div>` : '';

    let mediaHtml = '';
    if (m.media) {
      if (m.mediaType === 'video') {
        mediaHtml = `<div class="vid-wrap" onclick="viewMedia('${ea(m.media)}','video')"><video src="${ea(m.media)}" muted></video><div class="vid-play">▶</div></div>`;
      } else {
        mediaHtml = `<img class="msg-img" src="${ea(m.media)}" onclick="viewMedia('${ea(m.media)}','image')" alt="фото">`;
      }
    }

    const delBtn = isMine ? `<button class="msg-action-btn" onclick="delMsg('${ea(m.id)}')">🗑️</button>` : '';

    wrap.innerHTML = `<div class="msg-bub">
      ${senderLine}
      ${replyHtml}
      ${m.text ? `<div class="msg-text">${esc(m.text)}</div>` : ''}
      ${mediaHtml}
      <div class="msg-foot">${m.time || ''} ${ticks}</div>
      <div class="msg-actions">
        <button class="msg-action-btn" onclick="setReply('${ea(m.id)}','${ea(m.text || '[медиа]')}')">↩️</button>
        <button class="msg-action-btn" onclick="pickReact('${ea(m.id)}')">😊</button>
        ${delBtn}
      </div>
      ${reactHtml ? `<div class="react-bar">${reactHtml}</div>` : ''}
    </div>`;
    box.appendChild(wrap);
  });
  box.scrollTop = box.scrollHeight;
}

function delMsg(id) {
  if (!curChat || !confirm('Удалить сообщение?')) return;
  socket.emit('deleteMessage', { chatId: curChat, msgId: id });
}
function setReply(id, text) {
  replyId = id;
  document.getElementById('reply-bar').classList.remove('hidden');
  document.getElementById('reply-txt').innerText = (text || '').slice(0, 35);
  document.getElementById('msg-inp').focus();
}
function cancelReply() {
  replyId = null;
  document.getElementById('reply-bar').classList.add('hidden');
}
function pickReact(id) {
  const e = prompt('Смайлик для реакции:', '👍');
  if (e && e.trim()) react(id, e.trim());
}
function react(msgId, emoji) {
  if (!curChat) return;
  socket.emit('sendReaction', { chatId: curChat, msgId, emoji });
}

// ─── МЕДИА ───
function compress(file, maxD, q) {
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = e => {
      const img = new Image();
      img.onload = () => {
        let { width: w, height: h } = img;
        if (w > maxD || h > maxD) {
          if (w > h) { h = Math.round(h * (maxD / w)); w = maxD; }
          else { w = Math.round(w * (maxD / h)); h = maxD; }
        }
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        res(c.toDataURL('image/jpeg', q));
      };
      img.onerror = rej; img.src = e.target.result;
    };
    r.onerror = rej; r.readAsDataURL(file);
  });
}

async function handleFile() {
  const inp = document.getElementById('file-inp');
  if (!inp.files[0]) return;
  const file = inp.files[0];
  const isVid = file.type.startsWith('video/');
  inp.value = '';
  try {
    if (isVid) {
      if (file.size > 15 * 1024 * 1024) return toast('⚠️ Видео > 15 МБ');
      const r = new FileReader();
      r.onload = e => showCompose(e.target.result, 'video');
      r.readAsDataURL(file);
    } else {
      const url = await compress(file, 1280, 0.82);
      showCompose(url, 'image');
    }
  } catch(e) { toast('❌ Ошибка файла'); }
}

function showCompose(url, type) {
  pendingMedia = url; pendingMediaType = type;
  const img = document.getElementById('fs-img');
  const vid = document.getElementById('fs-vid');
  document.getElementById('fs-caption').value = '';
  if (type === 'video') { vid.src = url; vid.classList.remove('hidden'); img.classList.add('hidden'); }
  else { img.src = url; img.classList.remove('hidden'); vid.classList.add('hidden'); vid.src = ''; }
  document.getElementById('fs-compose').classList.remove('hidden');
  document.getElementById('media-fs').classList.remove('hidden');
}

function viewMedia(url, type) {
  const img = document.getElementById('fs-img');
  const vid = document.getElementById('fs-vid');
  document.getElementById('fs-compose').classList.add('hidden');
  if (type === 'video') { vid.src = url; vid.classList.remove('hidden'); img.classList.add('hidden'); }
  else { img.src = url; img.classList.remove('hidden'); vid.classList.add('hidden'); vid.src = ''; }
  document.getElementById('media-fs').classList.remove('hidden');
}

function closeFS() {
  document.getElementById('media-fs').classList.add('hidden');
  document.getElementById('fs-compose').classList.add('hidden');
  const vid = document.getElementById('fs-vid');
  vid.pause(); vid.classList.add('hidden');
  document.getElementById('fs-img').classList.add('hidden');
  pendingMedia = null; pendingMediaType = null;
}

function confirmSend() {
  if (!pendingMedia) { closeFS(); return; }
  const cap = (document.getElementById('fs-caption').value || '').trim();
  const m = pendingMedia, t = pendingMediaType;
  pendingMedia = null; pendingMediaType = null;
  closeFS();
  socket.emit('sendMessage', { chatId: curChat, text: cap, media: m, mediaType: t, replyTo: replyId });
  cancelReply();
  playPing();
}

// ─── НАСТРОЙКИ ───
function openSettings() {
  document.getElementById('modal-settings').classList.remove('hidden');
  document.getElementById('inp-dname').value = myDN;
  document.getElementById('inp-uname').value = me;
  document.getElementById('inp-bio').value = myBio;
  document.getElementById('inp-pass').value = '';
  pendingAvaUrl = null;
  document.getElementById('ava-preview-wrap').style.display = 'none';
  loadPrefsUI();
  refreshThemeBtns();
  socket.emit('getDevices');
}
function closeSettings() { document.getElementById('modal-settings').classList.add('hidden'); }

function loadPrefsUI() {
  const sw = document.getElementById('sw-sound');
  const sv = document.getElementById('sw-vib');
  if (sw) sw.checked = soundOn();
  if (sv) sv.checked = vibOn();
}
function savePref() {
  localStorage.setItem('pref_sound', document.getElementById('sw-sound').checked ? '1' : '0');
  localStorage.setItem('pref_vib', document.getElementById('sw-vib').checked ? '1' : '0');
}
function savePrivacy() {
  const hideOnline = document.getElementById('sw-hide-online').checked;
  const hideCreated = document.getElementById('sw-hide-created').checked;
  socket.emit('updateProfile', { privacy: { hideOnline, hideCreated } });
}
function soundOn() { return localStorage.getItem('pref_sound') !== '0'; }
function vibOn() { return localStorage.getItem('pref_vib') !== '0'; }
function vib(ms) { if (vibOn() && navigator.vibrate) try { navigator.vibrate(ms); } catch(e) {} }
function playPing() {
  if (!soundOn()) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(); const g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = 700;
    g.gain.setValueAtTime(0.07, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.15);
    o.start(); o.stop(ctx.currentTime + 0.15);
    o.onended = () => ctx.close();
  } catch(e) {}
}

function saveRingtone() {
  const f = document.getElementById('inp-ring').files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = e => {
    localStorage.setItem('ringtone', e.target.result);
    document.getElementById('snd-ringtone').src = e.target.result;
    toast('✅ Рингтон сохранён');
  };
  r.readAsDataURL(f);
}
function saveNotifSound() {
  const f = document.getElementById('inp-notif').files[0];
  if (!f) return;
  const r = new FileReader();
  r.onload = e => {
    localStorage.setItem('notif_sound', e.target.result);
    document.getElementById('snd-notif').src = e.target.result;
    toast('✅ Звук уведомления сохранён');
  };
  r.readAsDataURL(f);
}

function setTheme(t) { document.body.dataset.theme = t; localStorage.setItem('theme', t); refreshThemeBtns(); }
function applyTheme(t) { document.body.dataset.theme = t || 'dark'; }
function refreshThemeBtns() {
  const cur = localStorage.getItem('theme') || 'dark';
  document.querySelectorAll('.theme-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === cur));
}

async function previewAva() {
  const f = document.getElementById('inp-ava').files[0];
  if (!f) return;
  try {
    pendingAvaUrl = await compress(f, 512, 0.85);
    const wrap = document.getElementById('ava-preview-wrap');
    wrap.style.display = 'block';
    setAva('ava-preview', pendingAvaUrl, myDN);
    toast('✅ Фото выбрано — нажмите «Сохранить»');
  } catch(e) { toast('❌ Ошибка обработки фото'); }
}

function saveProfile() {
  const payload = {
    newDisplayName: (document.getElementById('inp-dname').value || '').trim(),
    newPassword: document.getElementById('inp-pass').value || '',
    newUsername: (document.getElementById('inp-uname').value || '').trim(),
    newBio: (document.getElementById('inp-bio').value || '').trim(),
    newAvatar: pendingAvaUrl
  };
  socket.emit('updateProfile', payload);
}

socket.on('profileUpdated', data => {
  toast('✅ Профиль обновлён!');
  myDN = data.displayName; me = data.username; myBio = data.bio || '';
  localStorage.setItem('u', me);
  document.getElementById('my-dname').innerText = myDN;
  document.getElementById('my-uname').innerText = '@' + me;
  setAva('my-ava', data.avatar, myDN);
  pendingAvaUrl = null;
  document.getElementById('ava-preview-wrap').style.display = 'none';
  document.getElementById('inp-pass').value = '';
  closeSettings();
});

socket.on('devicesList', list => {
  const c = document.getElementById('devices-list');
  if (!c) return;
  c.innerHTML = '';
  (list || []).forEach(d => {
    const div = document.createElement('div');
    div.className = 'device-row';
    const cur = d.id === socket.id;
    div.innerHTML = `<span>${esc((d.name || 'Устройство').slice(0, 40))}<br><small>${esc(d.time || '')}</small></span>${cur ? '<span class="cur">✓ Текущее</span>' : `<span class="kick" onclick="kickDev('${ea(d.id)}')">❌ Удалить</span>`}`;
    c.appendChild(div);
  });
});

function kickDev(id) { if (confirm('Удалить сессию?')) socket.emit('kickDevice', id); }

socket.on('kickMe', () => {
  stopHeartbeat();
  toast('🚪 Сессия завершена');
  setTimeout(() => { localStorage.removeItem('u'); localStorage.removeItem('did'); location.reload(); }, 1500);
});

function doLogout() {
  if (!confirm('Выйти из аккаунта?')) return;
  stopHeartbeat();
  socket.emit('logout');
  localStorage.removeItem('u'); localStorage.removeItem('did');
  location.reload();
}

// ─── ГРУППЫ ───
function openCreateGroup() { document.getElementById('modal-group').classList.remove('hidden'); }
function closeCreateGroup() { document.getElementById('modal-group').classList.add('hidden'); }

function createGroup() {
  const name = (document.getElementById('grp-name').value || '').trim();
  const raw = (document.getElementById('grp-members').value || '').trim();
  if (!name) return toast('❌ Введите название');
  const members = raw ? raw.split(',').map(s => s.trim().toLowerCase().replace('@', '')).filter(Boolean) : [];
  socket.emit('createGroup', { name, members });
  document.getElementById('grp-name').value = '';
  document.getElementById('grp-members').value = '';
  closeCreateGroup();
}

socket.on('groupCreated', group => {
  const idx = groups.findIndex(g => g.id === group.id);
  if (idx !== -1) groups[idx] = group; else groups.push(group);
  renderSidebar();
  toast(`✅ Группа «${group.name}» создана`);
});
socket.on('groupUpdated', group => {
  const idx = groups.findIndex(g => g.id === group.id);
  if (idx !== -1) groups[idx] = group; else groups.push(group);
  renderSidebar();
});
socket.on('leftGroup', ({ groupId }) => {
  groups = groups.filter(g => g.id !== groupId);
  if (curChat === 'group_' + groupId) { curChat = ''; curPartner = ''; closeMobile(); resetChat(); }
  renderSidebar();
});
socket.on('groupDeleted', ({ groupId }) => {
  groups = groups.filter(g => g.id !== groupId);
  if (curChat === 'group_' + groupId) { curChat = ''; curPartner = ''; closeMobile(); resetChat(); }
  renderSidebar(); toast('🗑️ Группа была удалена администратором');
});

// ─── МОБИЛЬНЫЙ РЕЖИМ ───
function isMobile() { return window.matchMedia('(max-width:860px)').matches; }
function openMobile() { if (isMobile()) document.getElementById('app-screen').classList.add('chat-open'); }
function closeMobile() { document.getElementById('app-screen').classList.remove('chat-open'); }

// ─── РЕСАЙЗЕР ───
function initResizer() {
  const r = document.getElementById('resizer');
  const s = document.getElementById('sidebar');
  if (!r || !s) return;
  const w = localStorage.getItem('sw');
  if (w) s.style.width = w + 'px';
  let drag = false;
  r.addEventListener('mousedown', () => { drag = true; document.body.style.cursor = 'col-resize'; document.body.style.userSelect = 'none'; });
  window.addEventListener('mousemove', e => { if (!drag) return; const nw = Math.max(260, Math.min(560, e.clientX - s.parentElement.getBoundingClientRect().left)); s.style.width = nw + 'px'; localStorage.setItem('sw', nw); });
  window.addEventListener('mouseup', () => { drag = false; document.body.style.cursor = ''; document.body.style.userSelect = ''; });
}

// Закрывать меню чата при клике вне него
document.addEventListener('click', e => {
  const menu = document.getElementById('chat-menu');
  const btn = document.getElementById('btn-menu');
  if (menu && !menu.classList.contains('hidden') && !menu.contains(e.target) && e.target !== btn) {
    hideChatMenu();
  }
});

// ─── АВАТАРКИ ─── (главный фикс: показываем фото ТОЛЬКО если оно есть)
function setAva(id, url, name) {
  const el = document.getElementById(id);
  if (!el) return;
  const v = (url || '').trim();
  if (v && v.length > 10) {  // url должен быть непустым и не слишком коротким
    el.style.backgroundImage = `url("${v}")`;
    el.style.backgroundSize = 'cover';
    el.style.backgroundPosition = 'center';
    el.innerText = '';
  } else {
    el.style.backgroundImage = 'none';
    el.innerText = (name && name.trim()) ? name.trim()[0].toUpperCase() : '?';
  }
}

// ─── УТИЛИТЫ ───
function chatId(a, b) { return [a, b].sort().join('_'); }
function esc(t) {
  if (!t) return '';
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}
function ea(v) {
  if (!v) return '';
  return String(v).replace(/'/g, "\\'").replace(/"/g, '&quot;');
}

function toast(text, ms) {
  const c = document.getElementById('toasts');
  if (!c) return;
  const t = document.createElement('div');
  t.className = 'toast'; t.innerText = text; c.appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 280); }, ms || 3500);
}

// ─── АДМИН ───
function openAdmin() {
  if (!iAmAdmin) return;
  document.getElementById('modal-admin').classList.remove('hidden');
  socket.emit('adminGetUsers'); socket.emit('adminGetStats');
}
function closeAdmin() { document.getElementById('modal-admin').classList.add('hidden'); }

socket.on('adminStats', s => {
  const el = document.getElementById('admin-stats'); if (!el) return;
  const h = Math.floor(s.uptimeSeconds / 3600), mn = Math.floor((s.uptimeSeconds % 3600) / 60);
  el.innerHTML = `
    <div class="stat-card"><strong>${s.totalUsers}</strong><span>Юзеров</span></div>
    <div class="stat-card"><strong>${s.onlineNow}</strong><span>Онлайн</span></div>
    <div class="stat-card"><strong>${s.totalChats}</strong><span>Чатов</span></div>
    <div class="stat-card"><strong>${s.totalGroups}</strong><span>Групп</span></div>
    <div class="stat-card"><strong>${s.totalMessages}</strong><span>Сообщений</span></div>
    <div class="stat-card"><strong>${h}ч ${mn}м</strong><span>Аптайм</span></div>`;
});

socket.on('adminUsersList', list => {
  const el = document.getElementById('admin-users'); if (!el) return;
  el.innerHTML = '';
  list.forEach(u => {
    const div = document.createElement('div'); div.className = 'admin-user';
    const cr = u.createdAt ? new Date(u.createdAt).toLocaleDateString('ru-RU') : '—';
    const ls = u.lastSeen ? new Date(u.lastSeen).toLocaleString('ru-RU') : '—';
    div.innerHTML = `<div class="avatar sm" id="au-${esc(u.name)}"></div>
      <div class="admin-user-info">
        <b>${esc(u.displayName)} ${u.online ? '<span class="dot-online"></span>' : ''} ${u.banned ? '<span class="ban-tag">БАН</span>' : ''} ${u.muted ? '<span class="mute-tag">МУТ</span>' : ''}</b>
        <span>@${esc(u.name)} · ${u.devices} устр. · рег. ${cr}</span>
        <span>Онлайн: ${esc(ls)}</span>
        <div class="admin-user-btns">
          <button class="mini-btn" onclick="adminDo('adminKickUser','${ea(u.name)}')">Кик</button>
          <button class="mini-btn ${u.banned ? 'green' : 'red'}" onclick="adminDo('adminToggleBan','${ea(u.name)}')">${u.banned ? 'Разбан' : 'Бан'}</button>
          <button class="mini-btn ${u.muted ? 'green' : 'red'}" onclick="adminDo('adminToggleMute','${ea(u.name)}')">${u.muted ? 'Размут' : 'Мут'}</button>
          <button class="mini-btn" onclick="adminResetPass('${ea(u.name)}')">Пароль</button>
          <button class="mini-btn red" onclick="adminDel('${ea(u.name)}')">Удалить</button>
        </div>
      </div>`;
    el.appendChild(div);
    setAva('au-' + u.name, u.avatar, u.displayName);
  });
  const gl = document.getElementById('admin-groups-list'); if (gl) {
    gl.innerHTML = '';
    groups.forEach(g => {
      const row = document.createElement('div'); row.className = 'admin-group-row';
      row.innerHTML = `<span><b>${esc(g.name)}</b> (${g.members.length} уч.)</span><button class="mini-btn red" onclick="adminDelGroup('${ea(g.id)}')">Удалить</button>`;
      gl.appendChild(row);
    });
  }
});

function adminDo(ev, u) { socket.emit(ev, u); }
function adminDel(u) { if (confirm(`Удалить @${u}?`)) socket.emit('adminDeleteUser', u); }
function adminDelGroup(id) { if (confirm('Удалить группу?')) socket.emit('adminDeleteGroup', id); }
function adminResetPass(u) {
  const p = prompt(`Новый пароль для @${u}:`);
  if (!p || p.length < 4) return toast('❌ Минимум 4 символа');
  socket.emit('adminResetPassword', { targetUsername: u, newPassword: p });
}
function adminBc() {
  const t = (document.getElementById('admin-bc').value || '').trim();
  if (!t) return;
  socket.emit('adminBroadcast', t);
  document.getElementById('admin-bc').value = '';
}
function adminClearChat() {
  const id = (document.getElementById('admin-clearchat-id').value || '').trim();
  if (!id) return toast('❌ Введите ID чата');
  if (confirm(`Очистить чат "${id}"?`)) socket.emit('adminClearChat', { chatId: id });
}
socket.on('adminLog', entries => {
  const el = document.getElementById('admin-log'); if (!el) return;
  el.innerHTML = entries.map(e => `<div>[${esc(e.time)}] ${esc(e.msg)}</div>`).join('');
  el.scrollTop = el.scrollHeight;
});
socket.on('adminActionDone', m => { toast(m); socket.emit('adminGetUsers'); socket.emit('adminGetStats'); });

// ─── ЗВОНКИ ───
// TURN-серверы для работы через разные сети (Wi-Fi ↔ 4G).
//Xirsys задаётся в www/config.js (генерируется автоматически из GitHub Secrets при сборке APK,
// см. .github/workflows/build-apk.yml). Если config.js не подгрузился — используем бесплатный
// Open Relay как запасной вариант, чтобы звонки не сломались.
const ICE = (window.XIRSYS_ICE && window.XIRSYS_ICE.length) ? window.XIRSYS_ICE : [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turns:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
];

let callUser = '', localStream = null, pc = null, callTO = null;
let timerInterval = null, timerStart = null, isVideo = false;
let audioCtx = null, analyser = null, anaData = null;

function setupVideoUI() {
  const vbox = document.getElementById('call-video-box');
  const wave = document.getElementById('call-wave');
  const vbtn = document.getElementById('btn-vid-tog');
  if (isVideo) { vbox.classList.remove('hidden'); wave.classList.add('hidden'); vbtn.style.display = 'flex'; }
  else { vbox.classList.add('hidden'); wave.classList.remove('hidden'); vbtn.style.display = 'none'; }
}

function pcHandlers(p, toUser) {
  p.onicecandidate = e => { if (e.candidate) socket.emit('iceCandidate', { to: toUser, candidate: e.candidate }); };
  p.onconnectionstatechange = () => {
    const state = p.connectionState;
    if (state === 'failed') { toast('❌ Соединение прервано'); endCall(); }
  };
  p.ontrack = e => {
    const stream = e.streams[0];
    if (isVideo) {
      const rv = document.getElementById('remote-vid');
      if (rv) { rv.srcObject = stream; rv.play().catch(() => {}); }
    }
    const ra = document.getElementById('remote-aud');
    if (ra) {
      ra.srcObject = stream;
      ra.play().catch(() => {});
      // Громкая связь через динамик
      if (speakerOn && ra.setSinkId) ra.setSinkId('').catch(() => {});
    }
    startVoiceAnim(stream);
    startTimer();
    document.getElementById('call-status').innerText = '🎤 В разговоре';
  };
}

socket.on('incomingCall', data => {
  if (data.to !== me) return;
  callUser = data.from;
  window.__offer = data.offer;
  window.__callType = data.callType || 'audio';

  document.getElementById('call-overlay').classList.remove('hidden');
  document.getElementById('call-status').innerText = data.callType === 'video' ? '📹 Входящий видеозвонок...' : '📞 Входящий звонок...';
  document.getElementById('call-name').innerText = data.fromDisplayName || data.from;
  document.getElementById('call-login').innerText = '@' + esc(data.from);
  document.getElementById('btn-accept').style.display = 'flex';
  setAva('call-ava', data.fromAvatar || '', data.fromDisplayName || data.from);

  const ring = document.getElementById('snd-ringtone');
  if (ring && soundOn()) ring.play().catch(() => {});
  // Вибрация при входящем звонке — повторяющийся паттерн
  if (vibOn() && navigator.vibrate) {
    try {
      navigator.vibrate([500, 300, 500, 300, 500, 300, 500]);
    } catch(e) {}
  }
  notifyLocal((data.fromDisplayName || data.from) + ' звонит', data.callType === 'video' ? '📹 Видеозвонок' : '📞 Аудиозвонок');
});

async function startCall(to, withVideo) {
  if (!to) { if (!curPartner) return toast('⚠️ Выберите контакт'); to = curPartner; }
  callUser = to; isVideo = !!withVideo;
  const f = allUsers.find(u => u.name === to);
  const dn = f ? f.displayName : to;

  document.getElementById('call-overlay').classList.remove('hidden');
  document.getElementById('call-status').innerText = isVideo ? '📹 Видеовызов...' : '📞 Звонок...';
  document.getElementById('call-name').innerText = esc(dn);
  document.getElementById('call-login').innerText = '@' + esc(to);
  document.getElementById('btn-accept').style.display = 'none';
  setAva('call-ava', f ? f.avatar : '', dn);
  setupVideoUI();

  try { localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: isVideo }); }
  catch(e) {
    if (isVideo) {
      isVideo = false; setupVideoUI();
      try { localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); }
      catch(e2) { toast('❌ Микрофон недоступен'); cleanCall(); return; }
    } else { toast('❌ Микрофон недоступен'); cleanCall(); return; }
  }

  if (isVideo) { const lv = document.getElementById('local-vid'); if (lv) lv.srcObject = localStream; }

  try {
    pc = new RTCPeerConnection({ iceServers: ICE, iceCandidatePoolSize: 10 });
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    pcHandlers(pc, to);
    const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: isVideo });
    await pc.setLocalDescription(offer);
    socket.emit('callUser', { to, offer, callType: isVideo ? 'video' : 'audio' });
    callTO = setTimeout(() => {
      document.getElementById('call-status').innerText = '⏱️ Нет ответа';
      setTimeout(() => { socket.emit('endCall', { to: callUser, reason: 'timeout' }); cleanCall(); }, 2000);
    }, 30000);
  } catch(e) { toast('❌ Ошибка соединения: ' + e.message); cleanCall(); }
}

async function acceptCall() {
  const ring = document.getElementById('snd-ringtone');
  if (ring) { ring.pause(); ring.currentTime = 0; }
  if (vibOn() && navigator.vibrate) try { navigator.vibrate(0); } catch(e) {}
  document.getElementById('btn-accept').style.display = 'none';
  document.getElementById('call-status').innerText = '🔗 Соединение...';
  isVideo = window.__callType === 'video';
  setupVideoUI();

  try { localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: isVideo }); }
  catch(e) {
    if (isVideo) {
      isVideo = false; setupVideoUI();
      try { localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false }); }
      catch(e2) { toast('❌ Микрофон недоступен'); cleanCall(); return; }
    } else { toast('❌ Микрофон недоступен'); cleanCall(); return; }
  }

  if (isVideo) { const lv = document.getElementById('local-vid'); if (lv) lv.srcObject = localStream; }

  try {
    pc = new RTCPeerConnection({ iceServers: ICE, iceCandidatePoolSize: 10 });
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    pcHandlers(pc, callUser);
    await pc.setRemoteDescription(new RTCSessionDescription(window.__offer));
    const ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
    socket.emit('answerCall', { to: callUser, answer: ans });
  } catch(e) { toast('❌ Ошибка: ' + e.message); cleanCall(); }
}

socket.on('callAnswered', async data => {
  if (data.to !== me || !pc) return;
  clearTimeout(callTO);
  document.getElementById('call-status').innerText = '🔗 Соединение...';
  try { await pc.setRemoteDescription(new RTCSessionDescription(data.answer)); } catch(e) {}
});

socket.on('iceCandidate', async data => {
  if (data.to !== me || !pc) return;
  try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch(e) {}
});

socket.on('callEnded', data => {
  if (data.to !== me) return;
  clearTimeout(callTO);
  document.getElementById('call-status').innerText = data.reason === 'timeout' ? '⏱️ Нет ответа' : '📞 Завершено';
  setTimeout(cleanCall, data.reason === 'timeout' ? 2200 : 800);
});

function endCall() {
  clearTimeout(callTO);
  if (callUser) socket.emit('endCall', { to: callUser, reason: 'declined' });
  cleanCall();
}

function cleanCall() {
  clearTimeout(callTO); callTO = null;
  const ring = document.getElementById('snd-ringtone');
  if (ring) { ring.pause(); ring.currentTime = 0; }
  if (vibOn() && navigator.vibrate) try { navigator.vibrate(0); } catch(e) {}
  if (pc) { pc.close(); pc = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  document.getElementById('call-overlay').classList.add('hidden');
  document.getElementById('call-wave').classList.remove('speaking', 'hidden');
  document.getElementById('call-video-box').classList.add('hidden');
  const rv = document.getElementById('remote-vid'); if (rv) rv.srcObject = null;
  const lv = document.getElementById('local-vid'); if (lv) lv.srcObject = null;
  const ra = document.getElementById('remote-aud'); if (ra) ra.srcObject = null;
  document.getElementById('btn-vid-tog').style.display = 'none';
  document.getElementById('btn-mic').classList.add('on'); document.getElementById('btn-mic').classList.remove('off');
  document.getElementById('btn-spk').classList.add('on'); document.getElementById('btn-spk').classList.remove('off');
  document.getElementById('btn-vid-tog').classList.add('on'); document.getElementById('btn-vid-tog').classList.remove('off');
  if (audioCtx) { audioCtx.close().catch(() => {}); audioCtx = null; }
  analyser = null; anaData = null; callUser = ''; isVideo = false;
  stopTimer();
}

function toggleMic() {
  if (!localStream) return;
  const t = localStream.getAudioTracks()[0]; if (!t) return;
  t.enabled = !t.enabled;
  const b = document.getElementById('btn-mic');
  b.classList.toggle('on', t.enabled); b.classList.toggle('off', !t.enabled);
}

function toggleSpeaker() {
  speakerOn = !speakerOn;
  const b = document.getElementById('btn-spk');
  b.classList.toggle('on', speakerOn); b.classList.toggle('off', !speakerOn);
  const ra = document.getElementById('remote-aud');
  if (!ra) return;
  if (ra.setSinkId) {
    // На поддерживаемых браузерах переключаем вывод
    ra.setSinkId(speakerOn ? '' : 'default').catch(() => {});
  }
  if (!speakerOn) { ra.volume = 0.3; } else { ra.volume = 1.0; }
}

function toggleVideo() {
  if (!localStream) return;
  const t = localStream.getVideoTracks()[0]; if (!t) return;
  t.enabled = !t.enabled;
  const b = document.getElementById('btn-vid-tog');
  b.classList.toggle('on', t.enabled); b.classList.toggle('off', !t.enabled);
  const lv = document.getElementById('local-vid'); if (lv) lv.style.visibility = t.enabled ? 'visible' : 'hidden';
}

function startTimer() {
  if (timerInterval) return;
  timerStart = Date.now();
  const el = document.getElementById('call-timer');
  el.classList.remove('hidden');
  timerInterval = setInterval(() => {
    const s = Math.floor((Date.now() - timerStart) / 1000);
    el.innerText = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);
}
function stopTimer() {
  clearInterval(timerInterval); timerInterval = null;
  const el = document.getElementById('call-timer');
  if (el) { el.innerText = '00:00'; el.classList.add('hidden'); }
}

function startVoiceAnim(stream) {
  try {
    if (audioCtx) audioCtx.close().catch(() => {});
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    const src = audioCtx.createMediaStreamSource(stream);
    analyser = audioCtx.createAnalyser(); analyser.fftSize = 256;
    src.connect(analyser); anaData = new Uint8Array(analyser.frequencyBinCount);
    checkVol();
  } catch(e) {}
}
function checkVol() {
  if (!audioCtx || !analyser || !anaData) return;
  analyser.getByteFrequencyData(anaData);
  const avg = anaData.reduce((s, v) => s + v, 0) / anaData.length;
  document.getElementById('call-wave').classList.toggle('speaking', avg > 10);
  requestAnimationFrame(checkVol);
}
