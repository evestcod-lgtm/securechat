require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 30 * 1024 * 1024  // 30MB — для аватарок и медиа
});

app.use(express.static(path.join(__dirname, 'public')));

const DB = path.join(__dirname, 'db.json');
const ADMIN = 'admin';
// Ключ XOR-шифрования и пароль админа — из .env на телефоне (не коммитятся в git)
const XKEY = process.env.XKEY || 'SecureChat-2024-XorKey!#@%';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'edg1987';

// XOR-шифрование/расшифровка (симметричное, работает в обе стороны)
function xor(str) {
  if (!str) return '';
  let out = '';
  for (let i = 0; i < str.length; i++) {
    out += String.fromCharCode(str.charCodeAt(i) ^ XKEY.charCodeAt(i % XKEY.length));
  }
  return out;
}

let db = { users: {}, messages: {}, activeChats: {}, groups: [], settings: {} };
if (fs.existsSync(DB)) {
  try { db = JSON.parse(fs.readFileSync(DB, 'utf8')); } catch(e) { console.error('DB read error:', e.message); }
}
if (!db.groups) db.groups = [];
if (!db.activeChats) db.activeChats = {};
if (!db.settings) db.settings = {};
if (typeof db.settings.adminFindable !== 'boolean') db.settings.adminFindable = false;

function save() {
  try { fs.writeFileSync(DB, JSON.stringify(db, null, 2)); } catch(e) { console.error('DB write error:', e.message); }
}

// Инициализация admin
if (!db.users[ADMIN]) {
  db.users[ADMIN] = {
    password: ADMIN_PASSWORD, displayName: 'Администратор', avatar: '',
    bio: '', devices: [], createdAt: Date.now(), lastSeen: Date.now(),
    banned: false, muted: false, privacy: { hideOnline: false, hideCreated: false }
  };
  save();
  console.log('✅ Создан аккаунт admin (пароль задаётся в .env → ADMIN_PASSWORD)');
}

const online = new Set();
const serverLog = [];

function slog(msg) {
  const e = { time: new Date().toLocaleTimeString('ru-RU'), msg };
  serverLog.push(e);
  if (serverLog.length > 300) serverLog.shift();
  console.log(msg);
}

function allSockets() { return Array.from(io.sockets.sockets.values()); }
function isAdmin(s) { return s.username === ADMIN; }

function emitOnline() {
  // Отправляем список с учётом приватности
  const list = Array.from(online).filter(u => {
    const user = db.users[u];
    return user && !(user.privacy && user.privacy.hideOnline);
  });
  io.emit('onlineUpdate', { all: Array.from(online), visible: list });
}

// Участники личного чата
function chatParts(chatId) {
  if (!chatId || chatId.startsWith('group_') || !chatId.includes('_')) return null;
  const p = chatId.split('_');
  return p.length === 2 ? p : null;
}

function emitToChat(chatId, event, payload) {
  if (chatId.startsWith('group_')) {
    io.to(chatId).emit(event, payload);
  } else {
    const p = chatParts(chatId);
    if (p) io.to(p[0]).to(p[1]).emit(event, payload);
    else io.emit(event, payload);
  }
}

function makeChatId(a, b) { return [a, b].sort().join('_'); }

function renameUser(oldN, newN) {
  if (!db.users[oldN] || oldN === newN) return false;
  db.users[newN] = db.users[oldN]; delete db.users[oldN];
  if (db.activeChats[oldN]) { db.activeChats[newN] = db.activeChats[oldN]; delete db.activeChats[oldN]; }
  for (const u in db.activeChats) db.activeChats[u] = db.activeChats[u].map(n => n === oldN ? newN : n);
  const nm = {};
  for (const cid in db.messages) {
    let ncid = cid;
    if (!cid.startsWith('group_') && cid.includes('_')) {
      const parts = cid.split('_');
      if (parts.length === 2) ncid = parts.map(p => p === oldN ? newN : p).sort().join('_');
    }
    nm[ncid] = db.messages[cid].map(m => m.from === oldN ? { ...m, from: newN } : m);
  }
  db.messages = nm;
  db.groups.forEach(g => {
    g.members = g.members.map(m => m === oldN ? newN : m);
    if (g.admin === oldN) g.admin = newN;
  });
  if (online.has(oldN)) { online.delete(oldN); online.add(newN); }
  allSockets().forEach(s => { if (s.username === oldN) { s.leave(oldN); s.username = newN; s.join(newN); } });
  save(); return true;
}

// Отправляем данные пользователю при входе
function sendInit(s) {
  try {
    const myActive = db.activeChats[s.username] || [];

    // Расшифровываем сообщения перед отправкой клиенту
    const decrypted = {};
    for (const cid in db.messages) {
      decrypted[cid] = db.messages[cid].map(m => ({
        ...m,
        text: m.text ? xor(m.text) : '',
        media: m.media ? xor(m.media) : null
      }));
    }

    const usersList = Object.keys(db.users)
      .filter(u => u !== ADMIN || s.username === ADMIN || db.settings.adminFindable)
      .map(u => {
        const user = db.users[u];
        const priv = user.privacy || {};
        return {
          name: u,
          displayName: user.displayName || u,
          avatar: user.avatar || '',
          bio: user.bio || '',
          createdAt: priv.hideCreated ? null : (user.createdAt || null),
          lastSeen: user.lastSeen || null
        };
      });

    const myGroups = db.groups.filter(g => g.members.includes(s.username));

    s.emit('initData', {
      users: usersList,
      activeChats: myActive,
      messages: decrypted,
      groups: myGroups
    });
  } catch(e) { slog('sendInit error: ' + e.message); }
}

io.on('connection', (socket) => {
  const ua = (socket.handshake.headers['user-agent'] || 'Unknown').slice(0, 50);
  slog('📱 Подключение: ' + socket.id);

  // Heartbeat — клиент пингует каждые 10 сек, мы обновляем онлайн
  socket.on('heartbeat', () => {
    if (socket.username) {
      online.add(socket.username);
      if (db.users[socket.username]) db.users[socket.username].lastSeen = Date.now();
    }
  });

  function finishAuth(user) {
    socket.username = user;
    socket.join(user);
    online.add(user);
    if (db.users[user]) {
      db.users[user].lastSeen = Date.now();
      if (!db.users[user].privacy) db.users[user].privacy = { hideOnline: false, hideCreated: false };
    }
    save();

    socket.emit('authSuccess', {
      username: user,
      displayName: db.users[user].displayName || user,
      avatar: db.users[user].avatar || '',
      bio: db.users[user].bio || '',
      isAdmin: user === ADMIN,
      newDeviceId: socket.id
    });

    // Присоединяемся к группам
    db.groups.filter(g => g.members.includes(user)).forEach(g => socket.join('group_' + g.id));

    sendInit(socket);
    emitOnline();
    slog(`✅ ${user} вошёл`);
  }

  socket.on('login', ({ username, password }) => {
    if (!username || !password) return socket.emit('authError', '⚠️ Заполните все поля');
    const u = username.toLowerCase().trim();
    if (!db.users[u]) return socket.emit('authError', '❌ Пользователь не найден');
    if (db.users[u].banned) return socket.emit('authError', '🚫 Аккаунт заблокирован');
    if (db.users[u].password !== password) return socket.emit('authError', '❌ Неверный пароль');
    if ((db.users[u].devices || []).length >= 3) return socket.emit('authError', '⚠️ Лимит устройств (3)');
    if (!db.users[u].devices) db.users[u].devices = [];
    db.users[u].devices.push({ id: socket.id, name: ua, time: new Date().toLocaleTimeString('ru-RU') });
    save(); finishAuth(u);
  });

  socket.on('register', ({ username, password }) => {
    if (!username || !password) return socket.emit('authError', '⚠️ Заполните все поля');
    const u = username.toLowerCase().trim();
    if (!/^[a-z0-9_]{3,20}$/.test(u)) return socket.emit('authError', '❌ Логин: 3-20 символов, a-z, 0-9, _');
    if (db.users[u]) return socket.emit('authError', '❌ Логин уже занят');
    if (password.length < 4) return socket.emit('authError', '❌ Пароль минимум 4 символа');
    db.users[u] = {
      password, displayName: u, avatar: '', bio: '',
      devices: [{ id: socket.id, name: ua, time: new Date().toLocaleTimeString('ru-RU') }],
      createdAt: Date.now(), lastSeen: Date.now(), banned: false, muted: false,
      privacy: { hideOnline: false, hideCreated: false }
    };
    save(); finishAuth(u);
  });

  socket.on('relogin', ({ username, oldDeviceId }) => {
    if (!username) return;
    const u = username.toLowerCase().trim();
    if (!db.users[u]) return socket.emit('authError', '❌ Пользователь не найден');
    if (db.users[u].banned) return socket.emit('authError', '🚫 Аккаунт заблокирован');
    if (!db.users[u].devices) db.users[u].devices = [];
    let found = false;
    db.users[u].devices.forEach(d => { if (d.id === oldDeviceId) { d.id = socket.id; d.time = new Date().toLocaleTimeString('ru-RU'); found = true; } });
    if (!found) {
      if (db.users[u].devices.length >= 3) return socket.emit('kickMe');
      db.users[u].devices.push({ id: socket.id, name: ua, time: new Date().toLocaleTimeString('ru-RU') });
    }
    save(); finishAuth(u);
  });

  // Поиск пользователей
  socket.on('searchUser', (q) => {
    const t = (q || '').toLowerCase().trim().replace('@', '');
    if (!t) return socket.emit('searchResult', []);
    const results = Object.keys(db.users)
      .filter(u => u !== socket.username && (u !== ADMIN || socket.username === ADMIN || db.settings.adminFindable))
      .filter(u => u.includes(t) || (db.users[u].displayName || '').toLowerCase().includes(t))
      .sort((a, b) => (a.startsWith(t) ? 0 : 1) - (b.startsWith(t) ? 0 : 1) || a.localeCompare(b))
      .slice(0, 25)
      .map(u => ({
        name: u, displayName: db.users[u].displayName || u, avatar: db.users[u].avatar || '',
        bio: db.users[u].bio || '',
        createdAt: (db.users[u].privacy && db.users[u].privacy.hideCreated) ? null : db.users[u].createdAt
      }));
    socket.emit('searchResult', results);
  });

  // Получить профиль конкретного пользователя
  socket.on('getUserProfile', (targetUsername) => {
    const u = db.users[targetUsername];
    if (!u) return;
    const priv = u.privacy || {};
    socket.emit('userProfile', {
      name: targetUsername,
      displayName: u.displayName || targetUsername,
      avatar: u.avatar || '',
      bio: u.bio || '',
      createdAt: priv.hideCreated ? null : u.createdAt,
      online: priv.hideOnline ? null : online.has(targetUsername),
      lastSeen: priv.hideOnline ? null : u.lastSeen
    });
  });

  // Отправка сообщения — шифруем перед сохранением
  socket.on('sendMessage', ({ chatId, text, media, mediaType, replyTo }) => {
    try {
      if (!socket.username || !chatId || (!text && !media)) return;
      if (db.users[socket.username] && db.users[socket.username].muted) {
        return socket.emit('authError', '🔇 Вы в муте — нельзя отправлять сообщения');
      }
      if (!db.messages[chatId]) db.messages[chatId] = [];

      // Сохраняем зашифрованным
      const msg = {
        id: Date.now() + Math.random(),
        from: socket.username,
        text: text ? xor(text) : '',       // XOR-шифрование
        media: media ? xor(media) : null,  // медиа тоже шифруем
        mediaType: mediaType || null,
        time: new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }),
        replyTo: replyTo || null,
        reactions: {}, isRead: false
      };
      db.messages[chatId].push(msg);

      // Обновляем activeChats для обоих участников
      if (!chatId.startsWith('group_')) {
        const p = chatParts(chatId);
        if (p) {
          [p[0], p[1]].forEach(u => {
            if (!db.activeChats[u]) db.activeChats[u] = [];
            const other = u === p[0] ? p[1] : p[0];
            if (!db.activeChats[u].includes(other)) db.activeChats[u].push(other);
          });
        }
      }
      save();

      // Отправляем РАСШИФРОВАННЫМ клиентам
      emitToChat(chatId, 'newMessage', {
        chatId,
        msg: { ...msg, text: text || '', media: media || null }
      });
    } catch(e) { slog('sendMessage error: ' + e.message); }
  });

  socket.on('deleteMessage', ({ chatId, msgId }) => {
    if (!socket.username || !db.messages[chatId]) return;
    const idx = db.messages[chatId].findIndex(m => m.id === msgId);
    if (idx === -1) return;
    if (db.messages[chatId][idx].from !== socket.username && !isAdmin(socket)) return;
    db.messages[chatId].splice(idx, 1); save();
    emitToChat(chatId, 'messageDeleted', { chatId, msgId });
  });

  socket.on('clearChat', ({ chatId }) => {
    if (!socket.username) return;
    const parts = chatParts(chatId);
    if (parts && !parts.includes(socket.username) && !isAdmin(socket)) return;
    if (chatId.startsWith('group_')) {
      const g = db.groups.find(x => 'group_' + x.id === chatId);
      if (!g || (g.admin !== socket.username && !isAdmin(socket))) return;
    }
    db.messages[chatId] = []; save();
    emitToChat(chatId, 'chatCleared', { chatId });
  });

  socket.on('deleteChat', ({ chatId }) => {
    if (!socket.username) return;
    // Удаляем только у себя (из activeChats)
    const partner = (chatParts(chatId) || []).find(p => p !== socket.username);
    if (partner) {
      db.activeChats[socket.username] = (db.activeChats[socket.username] || []).filter(u => u !== partner);
    }
    save();
    socket.emit('chatDeleted', { chatId });
  });

  socket.on('typing', ({ chatId, isTyping }) => {
    if (!socket.username || !chatId) return;
    emitToChat(chatId, 'userTyping', { chatId, from: socket.username, isTyping: !!isTyping });
  });

  socket.on('readChat', ({ chatId }) => {
    if (!socket.username || !db.messages[chatId]) return;
    let changed = false;
    db.messages[chatId].forEach(m => {
      if (m.from !== socket.username && !m.isRead) { m.isRead = true; changed = true; }
    });
    if (changed) { save(); emitToChat(chatId, 'chatReadUpdate', { chatId }); }
  });

  socket.on('sendReaction', ({ chatId, msgId, emoji }) => {
    if (!socket.username || !db.messages[chatId]) return;
    const msg = db.messages[chatId].find(m => m.id === msgId);
    if (!msg) return;
    if (msg.reactions[socket.username] === emoji) delete msg.reactions[socket.username];
    else msg.reactions[socket.username] = emoji;
    save(); emitToChat(chatId, 'reactionUpdated', { chatId, msgId, reactions: msg.reactions });
  });

  // ГРУППЫ
  socket.on('createGroup', ({ name, members }) => {
    if (!socket.username) return;
    const gName = (name || '').trim();
    if (!gName) return socket.emit('groupError', '❌ Введите название группы');
    const mems = [...new Set([socket.username, ...(members || [])])].filter(m => db.users[m]);
    const group = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      name: gName, avatar: '', admin: socket.username, members: mems, createdAt: Date.now()
    };
    db.groups.push(group); save();
    const chatId = 'group_' + group.id;
    mems.forEach(m => {
      allSockets().filter(s => s.username === m).forEach(s => { s.join(chatId); s.emit('groupCreated', group); });
    });
    slog(`👥 Группа: ${gName} (${mems.join(', ')})`);
  });

  socket.on('leaveGroup', ({ groupId }) => {
    const g = db.groups.find(x => x.id === groupId);
    if (!g) return;
    g.members = g.members.filter(m => m !== socket.username);
    if (g.members.length === 0) { db.groups = db.groups.filter(x => x.id !== groupId); }
    else if (g.admin === socket.username) { g.admin = g.members[0]; }
    save(); socket.leave('group_' + groupId);
    io.to('group_' + groupId).emit('groupUpdated', g);
    socket.emit('leftGroup', { groupId });
  });

  // УСТРОЙСТВА
  socket.on('getDevices', () => {
    if (socket.username && db.users[socket.username])
      socket.emit('devicesList', db.users[socket.username].devices || []);
  });

  socket.on('kickDevice', (id) => {
    if (!socket.username || !db.users[socket.username]) return;
    db.users[socket.username].devices = (db.users[socket.username].devices || []).filter(d => d.id !== id);
    save(); io.to(id).emit('kickMe'); socket.emit('devicesList', db.users[socket.username].devices);
  });

  // ОБНОВЛЕНИЕ ПРОФИЛЯ
  socket.on('updateProfile', ({ newDisplayName, newPassword, newAvatar, newUsername, newBio, privacy }) => {
    try {
      if (!socket.username || !db.users[socket.username]) return;
      const old = socket.username; let renamed = false;

      if (newUsername) {
        const cu = newUsername.toLowerCase().trim();
        if (cu !== old) {
          if (!/^[a-z0-9_]{3,20}$/.test(cu)) return socket.emit('profileError', '❌ Юзернейм: 3-20 символов a-z,0-9,_');
          if (cu === ADMIN && old !== ADMIN) return socket.emit('profileError', '❌ Недоступный юзернейм');
          if (db.users[cu]) return socket.emit('profileError', '❌ Юзернейм уже занят');
          renameUser(old, cu); socket.username = cu; renamed = true;
        }
      }

      const u = db.users[socket.username];
      if (!u) return;
      if (newAvatar !== undefined && newAvatar !== null) u.avatar = newAvatar;
      if (newPassword && newPassword.length >= 4) u.password = newPassword;
      if (newDisplayName) u.displayName = newDisplayName.trim();
      if (newBio !== undefined) u.bio = (newBio || '').trim();
      if (privacy) u.privacy = { ...u.privacy, ...privacy };
      save();

      // Глобальное обновление профиля для всех
      io.emit('userProfileGlobalUpdate', {
        name: socket.username, oldName: renamed ? old : null,
        displayName: u.displayName, avatar: u.avatar || '', bio: u.bio || ''
      });

      socket.emit('profileUpdated', {
        username: socket.username, displayName: u.displayName, avatar: u.avatar || '', bio: u.bio || ''
      });

      sendInit(socket);
      if (renamed) { emitOnline(); slog(`🔀 ${old} → ${socket.username}`); }
    } catch(e) { socket.emit('profileError', '❌ Ошибка обновления профиля'); }
  });

  socket.on('logout', () => {
    if (socket.username && db.users[socket.username]) {
      db.users[socket.username].devices = (db.users[socket.username].devices || []).filter(d => d.id !== socket.id);
      db.users[socket.username].lastSeen = Date.now(); save();
      if (!allSockets().some(s => s.username === socket.username && s.id !== socket.id)) {
        online.delete(socket.username); emitOnline();
      }
    }
  });

  // АДМИН
  socket.on('adminGetUsers', () => {
    if (!isAdmin(socket)) return socket.emit('authError', '⛔ Только для администратора');
    socket.emit('adminUsersList', Object.keys(db.users).map(u => ({
      name: u, displayName: db.users[u].displayName || u, avatar: db.users[u].avatar || '',
      online: online.has(u), devices: (db.users[u].devices || []).length,
      createdAt: db.users[u].createdAt || null, lastSeen: db.users[u].lastSeen || null,
      banned: !!db.users[u].banned, muted: !!db.users[u].muted
    })));
  });

  socket.on('adminGetStats', () => {
    if (!isAdmin(socket)) return;
    socket.emit('adminStats', {
      totalUsers: Object.keys(db.users).length,
      totalMessages: Object.values(db.messages).reduce((s, a) => s + a.length, 0),
      totalChats: Object.keys(db.messages).length,
      totalGroups: db.groups.length,
      onlineNow: online.size,
      uptimeSeconds: Math.floor(process.uptime())
    });
  });

  socket.on('adminGetLog', () => {
    if (!isAdmin(socket)) return;
    socket.emit('adminLog', serverLog.slice(-80));
  });

  socket.on('adminKickUser', (t) => {
    if (!isAdmin(socket)) return;
    const u = (t || '').toLowerCase().trim();
    if (!db.users[u] || u === ADMIN) return;
    allSockets().forEach(s => { if (s.username === u) s.emit('kickMe'); });
    db.users[u].devices = []; save(); online.delete(u); emitOnline();
    socket.emit('adminActionDone', `🚪 @${u} кикнут`);
  });

  socket.on('adminToggleBan', (t) => {
    if (!isAdmin(socket)) return;
    const u = (t || '').toLowerCase().trim();
    if (!db.users[u] || u === ADMIN) return;
    db.users[u].banned = !db.users[u].banned;
    if (db.users[u].banned) {
      allSockets().forEach(s => { if (s.username === u) s.emit('kickMe'); });
      db.users[u].devices = []; online.delete(u); emitOnline();
    }
    save(); socket.emit('adminActionDone', db.users[u].banned ? `🚫 @${u} заблокирован` : `✅ @${u} разблокирован`);
  });

  socket.on('adminToggleMute', (t) => {
    if (!isAdmin(socket)) return;
    const u = (t || '').toLowerCase().trim();
    if (!db.users[u] || u === ADMIN) return;
    db.users[u].muted = !db.users[u].muted; save();
    socket.emit('adminActionDone', db.users[u].muted ? `🔇 @${u} замучен` : `🔊 @${u} размучен`);
  });

  socket.on('adminResetPassword', ({ targetUsername, newPassword }) => {
    if (!isAdmin(socket)) return;
    const u = (targetUsername || '').toLowerCase().trim();
    if (!db.users[u] || !newPassword || newPassword.length < 4) return;
    db.users[u].password = newPassword; save();
    socket.emit('adminActionDone', `🔑 Пароль @${u} сброшен`);
  });

  socket.on('adminDeleteUser', (t) => {
    if (!isAdmin(socket)) return;
    const u = (t || '').toLowerCase().trim();
    if (!u || u === ADMIN || !db.users[u]) return;
    allSockets().forEach(s => { if (s.username === u) s.emit('kickMe'); });
    delete db.users[u]; delete db.activeChats[u];
    for (const k in db.activeChats) db.activeChats[k] = db.activeChats[k].filter(n => n !== u);
    db.groups.forEach(g => { g.members = g.members.filter(m => m !== u); });
    db.groups = db.groups.filter(g => g.members.length > 0);
    online.delete(u); save(); emitOnline();
    io.emit('userDeletedGlobal', { name: u });
    socket.emit('adminActionDone', `🗑️ @${u} удалён`);
  });

  socket.on('adminBroadcast', (text) => {
    if (!isAdmin(socket) || !text) return;
    io.emit('adminAnnouncement', { text: text.trim(), time: new Date().toLocaleTimeString('ru-RU') });
    socket.emit('adminActionDone', '📢 Объявление отправлено всем');
  });

  // Переключатель: находить ли аккаунт admin в поиске у остальных пользователей.
  // По умолчанию — не находить (скрыт из поиска для всех, кроме самого админа).
  socket.on('adminSetFindable', (value) => {
    if (!isAdmin(socket)) return;
    db.settings.adminFindable = !!value;
    save();
    socket.emit('adminFindableState', db.settings.adminFindable);
    socket.emit('adminActionDone', db.settings.adminFindable ? '🔎 Админ теперь находится в поиске' : '🙈 Админ скрыт из поиска');
  });

  socket.on('adminGetFindableState', () => {
    if (!isAdmin(socket)) return;
    socket.emit('adminFindableState', db.settings.adminFindable);
  });

  socket.on('adminClearChat', ({ chatId }) => {
    if (!isAdmin(socket)) return;
    db.messages[chatId] = []; save();
    io.emit('chatCleared', { chatId });
    socket.emit('adminActionDone', '🧹 Чат очищен');
  });

  socket.on('adminDeleteGroup', (groupId) => {
    if (!isAdmin(socket)) return;
    db.groups = db.groups.filter(g => g.id !== groupId);
    delete db.messages['group_' + groupId]; save();
    io.to('group_' + groupId).emit('groupDeleted', { groupId });
    socket.emit('adminActionDone', '🗑️ Группа удалена');
  });

  // ЗВОНКИ (сигналинг через socket.io — TURN-серверы обеспечивают работу через 4G)
  socket.on('callUser', (data) => {
    if (!socket.username || !data.to) return;
    if (!db.users[data.to]) return socket.emit('callFailed', 'Пользователь не найден');
    io.to(data.to).emit('incomingCall', {
      from: socket.username,
      fromDisplayName: db.users[socket.username].displayName || socket.username,
      fromAvatar: db.users[socket.username].avatar || '',
      to: data.to, offer: data.offer, callType: data.callType || 'audio'
    });
    slog(`📞 ${socket.username} → ${data.to} (${data.callType || 'audio'})`);
  });

  socket.on('answerCall', (data) => {
    if (data.to) io.to(data.to).emit('callAnswered', { from: socket.username, to: data.to, answer: data.answer });
  });

  socket.on('iceCandidate', (data) => {
    if (data.to) io.to(data.to).emit('iceCandidate', { from: socket.username, to: data.to, candidate: data.candidate });
  });

  socket.on('endCall', (data) => {
    if (data.to) io.to(data.to).emit('callEnded', { from: socket.username, to: data.to, reason: data.reason });
  });

  socket.on('disconnect', () => {
    if (socket.username && db.users[socket.username]) {
      db.users[socket.username].devices = (db.users[socket.username].devices || []).filter(d => d.id !== socket.id);
      db.users[socket.username].lastSeen = Date.now(); save();
      setTimeout(() => {
        // Даём 2 секунды — вдруг это переподключение
        const hasOther = allSockets().some(s => s.username === socket.username && s.id !== socket.id);
        if (!hasOther) { online.delete(socket.username); emitOnline(); }
      }, 2000);
    }
    slog(`❌ Отключение: ${socket.id}`);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  slog(`🔐 SecureChat v3 запущен: http://localhost:${PORT}`);
  slog(`📌 Для доступа с телефона: node server.js → открой http://localhost:${PORT}`);
  slog(`🌐 Для доступа извне (localhost.run): ssh -R 80:localhost:${PORT} nokey@localhost.run`);
});
process.on('unhandledRejection', r => slog('⚠️ ' + r));
