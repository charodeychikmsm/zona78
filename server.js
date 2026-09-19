const express = require('express');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const PORT = process.env.PORT || 3000;

const rooms = new Map();

function genCode() {
  let c;
  do { c = Math.random().toString(36).slice(2, 6).toUpperCase(); } while (rooms.has(c));
  return c;
}
function broadcast(room, msg) {
  const d = JSON.stringify(msg);
  for (const p of room.players.values()) if (p.ws.readyState === 1) p.ws.send(d);
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
function resetPuzzle(room) {
  room.puzzle = {
    keyCollected: false, doorOpen: false,
    plates: [false, false, false, false],
    plateSequence: shuffle([0, 1, 2, 3]),
    nextPlateIdx: 0, leverPulled: false, levers: [false, false]
  };
  room.doorState = { p1: false, p2: false };
}
function updateDoor(room) {
  const pz = room.puzzle, lv = room.level;
  if (lv === 1) pz.doorOpen = pz.keyCollected;
  else if (lv === 2) pz.doorOpen = pz.nextPlateIdx === 4;
  else if (lv === 3) pz.doorOpen = pz.leverPulled;
  else if (lv === 4) pz.doorOpen = pz.levers[0] && pz.levers[1];
  else if (lv === 5) pz.doorOpen = pz.keyCollected && pz.nextPlateIdx === 4;
  else if (lv === 6) pz.doorOpen = pz.leverPulled;
  else if (lv === 7) pz.doorOpen = pz.plates[0] && pz.plates[1];
  else if (lv === 8) pz.doorOpen = pz.keyCollected;
  else if (lv === 9) pz.doorOpen = pz.plates[0] && pz.plates[1] && pz.keyCollected;
  else if (lv === 10) pz.doorOpen = pz.keyCollected && pz.nextPlateIdx === 4;
  else if (lv === 11) pz.doorOpen = true;
  else if (lv === 12) pz.doorOpen = true;
  else if (lv === 13) pz.doorOpen = true;
  else if (lv === 14) pz.doorOpen = true;
  else if (lv === 15) pz.doorOpen = true;
  else if (lv === 16) pz.doorOpen = true;
  else if (lv === 17) pz.doorOpen = true;
  else if (lv === 18) pz.doorOpen = pz.leverPulled;
  else if (lv === 19) pz.doorOpen = pz.levers[0] && pz.levers[1];
  else if (lv === 20) pz.doorOpen = pz.keyCollected;
  else pz.doorOpen = false;
}
function checkLevelDone(room) {
  if (room.puzzle.doorOpen && room.doorState.p1 && room.doorState.p2) {
    const now = Date.now();
    if (now - room.lastLevelDone > 1500) {
      room.lastLevelDone = now;
      room.level++;
      resetPuzzle(room);
      broadcast(room, { type: 'level', level: room.level, puzzle: room.puzzle });
    }
  }
}

wss.on('connection', function(ws) {
  let roomCode = null, playerId = null;

  ws.on('message', function(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    if (msg.type === 'create') {
      const code = genCode();
      roomCode = code; playerId = 'p1';
      const room = {
        code: code,
        players: new Map([[playerId, { id: playerId, color: msg.color, ws: ws }]]),
        level: 1, lastLevelDone: 0, lastDeath: 0
      };
      resetPuzzle(room);
      rooms.set(code, room);
      ws.send(JSON.stringify({ type: 'created', code: code, playerId: playerId }));
      return;
    }

    if (msg.type === 'join') {
      const room = rooms.get(msg.code);
      if (!room) { ws.send(JSON.stringify({ type: 'error', message: 'Комната не найдена' })); return; }
      if (room.players.size >= 2) { ws.send(JSON.stringify({ type: 'error', message: 'Комната заполнена' })); return; }
      roomCode = msg.code; playerId = 'p2';
      const p1 = room.players.get('p1');
      room.players.set(playerId, { id: playerId, color: msg.color, ws: ws });
      ws.send(JSON.stringify({
        type: 'joined', code: room.code, playerId: playerId,
        level: room.level, puzzle: room.puzzle, otherColor: p1.color
      }));
      broadcast(room, { type: 'playerJoined', color: msg.color, id: playerId, level: room.level, puzzle: room.puzzle });
      return;
    }

    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;

    if (msg.type === 'state') {
      for (const p of room.players.values()) {
        if (p.id !== playerId && p.ws.readyState === 1)
          p.ws.send(JSON.stringify({ type: 'state', data: msg.data }));
      }
      return;
    }

    if (msg.type === 'event') {
      let changed = false;
      const pz = room.puzzle;
      const lv = room.level;

      if (msg.event === 'death') {
        const now = Date.now();
        if (now - (room.lastDeath || 0) < 1200) return;
        room.lastDeath = now;
        resetPuzzle(room);
        broadcast(room, { type: 'death', puzzle: room.puzzle });
        return;
      }
      else if (msg.event === 'key' && !pz.keyCollected) {
        pz.keyCollected = true; updateDoor(room); changed = true;
      }
      else if (msg.event === 'plate') {
        const i = msg.index;
        if (i >= 0 && i < 4 && !pz.plates[i]) {
          const seqLevels = [2, 5, 10];
          if (seqLevels.indexOf(lv) >= 0) {
            if (i === pz.plateSequence[pz.nextPlateIdx]) {
              pz.plates[i] = true; pz.nextPlateIdx++;
            } else {
              pz.plates = [false, false, false, false]; pz.nextPlateIdx = 0;
            }
          } else {
            pz.plates[i] = true;
          }
          updateDoor(room); changed = true;
        }
      }
      else if (msg.event === 'lever' && !pz.leverPulled) {
        pz.leverPulled = true; updateDoor(room); changed = true;
      }
      else if (msg.event === 'sync') {
        pz.levers[msg.which] = true;
        updateDoor(room); changed = true;
        setTimeout(function() {
          const r = rooms.get(roomCode);
          if (!r || r.level !== 4 || r.puzzle.doorOpen) return;
          r.puzzle.levers = [false, false];
          broadcast(r, { type: 'puzzle', state: r.puzzle });
        }, 3000);
      }
      else if (msg.event === 'door') {
        room.doorState[playerId] = msg.value;
        checkLevelDone(room);
        return;
      }

      if (changed) {
        broadcast(room, { type: 'puzzle', state: pz });
        checkLevelDone(room);
      }
    }
  });

  ws.on('close', function() {
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;
    room.players.delete(playerId);
    broadcast(room, { type: 'playerLeft' });
    if (room.players.size === 0) rooms.delete(roomCode);
  });
});

server.listen(PORT, function() {
  console.log('🎮 ZONA78 запущен на http://localhost:' + PORT);
});
