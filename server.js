const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const app = express();
// ==== ДИАГНОСТИКА ====
const fs = require('fs');
console.log('=== ДИАГНОСТИКА ===');
console.log('__dirname:', __dirname);
const publicPath = path.join(__dirname, 'public');
console.log('public path:', publicPath);
console.log('public exists:', fs.existsSync(publicPath));
if (fs.existsSync(publicPath)) {
  console.log('files in public:', fs.readdirSync(publicPath));
  const indexPath = path.join(publicPath, 'index.html');
  console.log('index.html exists:', fs.existsSync(indexPath));
  if (fs.existsSync(indexPath)) {
    console.log('index.html size:', fs.statSync(indexPath).size);
  }
}
console.log('==================');

app.use(express.static(publicPath));
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

const rooms = new Map();

function genCode() {
  let code;
  do {
    code = Math.random().toString(36).slice(2, 6).toUpperCase();
  } while (rooms.has(code));
  return code;
}

function broadcast(room, msg) {
  const data = JSON.stringify(msg);
  for (const p of room.players.values()) {
    if (p.ws.readyState === 1) p.ws.send(data);
  }
}

function resetPuzzle(room) {
  room.puzzle = { keyCollected: false, doorOpen: false, plates: { a: false, b: false }, leverPulled: false };
  room.doorState = { p1: false, p2: false };
}

function checkLevelDone(room) {
  if (room.puzzle.doorOpen && room.doorState.p1 && room.doorState.p2) {
    const now = Date.now();
    if (now - room.lastLevelDone > 1500) {
      room.lastLevelDone = now;
      room.level++;
      resetPuzzle(room);
      broadcast(room, { type: 'level', level: room.level });
    }
  }
}

wss.on('connection', (ws) => {
  let roomCode = null;
  let playerId = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // === СОЗДАТЬ КОМНАТУ ===
    if (msg.type === 'create') {
      const code = genCode();
      roomCode = code;
      playerId = 'p1';
      rooms.set(code, {
        code,
        players: new Map([[playerId, { id: playerId, color: msg.color, ws }]]),
        level: 1,
        puzzle: { keyCollected: false, doorOpen: false, plates: { a: false, b: false }, leverPulled: false },
        doorState: { p1: false, p2: false },
        lastLevelDone: 0
      });
      ws.send(JSON.stringify({ type: 'created', code, playerId }));
      console.log(`[+] Комната ${code} создана`);
      return;
    }

    // === ВОЙТИ В КОМНАТУ ===
    if (msg.type === 'join') {
      const room = rooms.get(msg.code);
      if (!room) { ws.send(JSON.stringify({ type: 'error', message: 'Комната не найдена' })); return; }
      if (room.players.size >= 2) { ws.send(JSON.stringify({ type: 'error', message: 'Комната заполнена' })); return; }

      roomCode = msg.code;
      playerId = 'p2';
      const p1 = room.players.get('p1');
      room.players.set(playerId, { id: playerId, color: msg.color, ws });

      ws.send(JSON.stringify({
        type: 'joined',
        code: room.code,
        playerId,
        level: room.level,
        otherColor: p1.color
      }));
      broadcast(room, { type: 'playerJoined', color: msg.color, id: playerId });
      console.log(`[+] Игрок вошёл в ${msg.code}`);
      return;
    }

    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;

    // === РЕЛЕЙ СОСТОЯНИЯ ИГРОКА ===
    if (msg.type === 'state') {
      for (const p of room.players.values()) {
        if (p.id === playerId) continue;
        if (p.ws.readyState === 1) p.ws.send(JSON.stringify({ type: 'state', data: msg.data }));
      }
      return;
    }

    // === СОБЫТИЯ ===
    if (msg.type === 'event') {
      let puzzleChanged = false;

      if (msg.event === 'key' && !room.puzzle.keyCollected) {
        room.puzzle.keyCollected = true;
        room.puzzle.doorOpen = true;
        puzzleChanged = true;
      } else if (msg.event === 'plate') {
        const was = room.puzzle.plates[msg.plate];
        room.puzzle.plates[msg.plate] = msg.value;
        if (was !== msg.value) {
          room.puzzle.doorOpen = room.puzzle.plates.a && room.puzzle.plates.b;
          puzzleChanged = true;
        }
      } else if (msg.event === 'lever' && !room.puzzle.leverPulled) {
        room.puzzle.leverPulled = true;
        room.puzzle.doorOpen = true;
        puzzleChanged = true;
      } else if (msg.event === 'door') {
        room.doorState[playerId] = msg.value;
        checkLevelDone(room);
        return;
      }

      if (puzzleChanged) {
        broadcast(room, { type: 'puzzle', state: room.puzzle });
        checkLevelDone(room);
      }
    }
  });

  ws.on('close', () => {
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;
    room.players.delete(playerId);
    broadcast(room, { type: 'playerLeft' });
    if (room.players.size === 0) rooms.delete(roomCode);
    console.log(`[-] Игрок вышел из ${roomCode}`);
  });
});

server.listen(PORT, () => {
  console.log(`🎮 ZONA78 запущен на http://localhost:${PORT}`);
});