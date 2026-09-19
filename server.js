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
  else if (lv >= 11 && lv <= 17) pz.doorOpen = true;
  else if (lv === 18) pz.doorOpen = pz.leverPulled;
  else if (lv === 19) pz.doorOpen = pz.levers[0] && pz.levers[1];
  else if (lv === 20) pz.doorOpen = pz.keyCollected;
  else pz.doorOpen = false;
}
function resetPuzzle(room) {
  room.puzzle = {
    keyCollected: false, doorOpen: false,
    plates: [false, false, false, false],
    plateSequence: shuffle([0, 1, 2, 3]),
    nextPlateIdx: 0, leverPulled: false, levers: [false, false]
  };
  room.doorState = { p1: false, p2: false };
  updateDoor(room);
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

// ============ PVP ============
function initPvp(room) {
  const spawns = [{ x: 100, y: 400 }, { x: 874, y: 400 }];
  room.pvp = { bullets: [], winner: null };
  let i = 0;
  for (const p of room.players.values()) {
    p.hp = 5;
    p.kills = 0;
    p.x = spawns[i].x;
    p.y = spawns[i].y;
    p.angle = 0;
    p.facing = i === 0 ? 1 : -1;
    p.walkPhase = 0;
    i++;
  }
}
function pvpRespawn(room, p) {
  const other = [...room.players.values()].find(function (x) { return x.id !== p.id; });
  p.x = other && other.x < 500 ? 700 : 100;
  p.y = 400;
  p.hp = 5;
}

setInterval(function () {
  const dt = 0.016;
  for (const room of rooms.values()) {
    if (room.mode !== 'pvp' || !room.pvp || room.pvp.winner) continue;
    const bullets = room.pvp.bullets;
    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.ttl -= dt;
      if (b.ttl <= 0 || b.x < 0 || b.x > 1000 || b.y < 0 || b.y > 600) {
        bullets.splice(i, 1); continue;
      }
      let hit = null;
      for (const p of room.players.values()) {
        if (p.id === b.owner) continue;
        if (b.x > p.x && b.x < p.x + 26 && b.y > p.y && b.y < p.y + 40) { hit = p; break; }
      }
      if (hit) {
        hit.hp = (hit.hp || 5) - 1;
        bullets.splice(i, 1);
        if (hit.hp <= 0) {
          const shooter = room.players.get(b.owner);
          if (shooter) shooter.kills = (shooter.kills || 0) + 1;
          pvpRespawn(room, hit);
          broadcast(room, { type: 'pvpKill', killer: b.owner, victim: hit.id });
          if (shooter && shooter.kills >= 5 && !room.pvp.winner) {
            room.pvp.winner = b.owner;
            broadcast(room, { type: 'pvpWin', winner: b.owner });
          }
        } else {
          broadcast(room, { type: 'pvpHit', target: hit.id, hp: hit.hp });
        }
      }
    }
  }
}, 16);

setInterval(function () {
  for (const room of rooms.values()) {
    if (room.mode !== 'pvp' || !room.pvp) continue;
    const arr = [];
    for (const p of room.players.values()) {
      arr.push({
        id: p.id, color: p.color,
        x: p.x, y: p.y, angle: p.angle || 0,
        facing: p.facing || 1, walkPhase: p.walkPhase || 0,
        hp: p.hp || 5, kills: p.kills || 0
      });
    }
    broadcast(room, {
      type: 'pvpState',
      players: arr,
      bullets: room.pvp.bullets.map(function (b) { return { x: b.x, y: b.y }; })
    });
  }
}, 50);

wss.on('connection', function (ws) {
  let roomCode = null, playerId = null;

  ws.on('message', function (raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch (e) { return; }

    if (msg.type === 'create') {
      const code = genCode();
      roomCode = code; playerId = 'p1';
      const room = {
        code: code, mode: msg.mode || 'story',
        players: new Map([[playerId, { id: playerId, color: msg.color, ws: ws, x: 100, y: 400 }]]),
        level: 1, lastLevelDone: 0, lastDeath: 0
      };
      resetPuzzle(room);
      if (room.mode === 'pvp') initPvp(room);
      rooms.set(code, room);
      ws.send(JSON.stringify({ type: 'created', code: code, playerId: playerId, mode: room.mode }));
      return;
    }

    if (msg.type === 'join') {
      const room = rooms.get(msg.code);
      if (!room) { ws.send(JSON.stringify({ type: 'error', message: 'Комната не найдена' })); return; }
      if (room.players.size >= 2) { ws.send(JSON.stringify({ type: 'error', message: 'Комната заполнена' })); return; }
      roomCode = msg.code; playerId = 'p2';
      const p1 = room.players.get('p1');
      room.players.set(playerId, { id: playerId, color: msg.color, ws: ws, x: 874, y: 400 });
      ws.send(JSON.stringify({
        type: 'joined', code: room.code, playerId: playerId,
        mode: room.mode, level: room.level, puzzle: room.puzzle, otherColor: p1.color
      }));
      if (room.mode === 'pvp') {
        initPvp(room);
        broadcast(room, { type: 'pvpStart' });
      } else {
        broadcast(room, { type: 'playerJoined', color: msg.color, id: playerId, level: room.level, puzzle: room.puzzle });
      }
      return;
    }

    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;

    if (msg.type === 'state') {
      const p = room.players.get(playerId);
      if (p && room.mode === 'pvp' && msg.data) {
        p.x = msg.data.x;
        p.y = msg.data.y;
        p.angle = msg.data.angle || 0;
        p.facing = msg.data.facing || 1;
        p.walkPhase = msg.data.walkPhase || 0;
        return;
      }
      for (const q of room.players.values()) {
        if (q.id !== playerId && q.ws.readyState === 1)
          q.ws.send(JSON.stringify({ type: 'state', data: msg.data }));
      }
      return;
    }

    if (msg.type === 'shoot' && room.mode === 'pvp' && room.pvp && !room.pvp.winner) {
      const p = room.players.get(playerId);
      if (!p) return;
      const now = Date.now();
      if (now - (p.lastShot || 0) < 350) return;
      p.lastShot = now;
      const a = msg.angle || 0;
      room.pvp.bullets.push({
        owner: playerId,
        x: p.x + 13, y: p.y + 20,
        vx: Math.cos(a) * 800,
        vy: Math.sin(a) * 800,
        ttl: 1.2
      });
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
      } else if (msg.event === 'key' && !pz.keyCollected) {
        pz.keyCollected = true; updateDoor(room); changed = true;
      } else if (msg.event === 'plate') {
        const i = msg.index;
        if (i >= 0 && i < 4 && !pz.plates[i]) {
          const seqLevels = [2, 5, 10];
          if (seqLevels.indexOf(lv) >= 0) {
            if (i === pz.plateSequence[pz.nextPlateIdx]) { pz.plates[i] = true; pz.nextPlateIdx++; }
            else { pz.plates = [false, false, false, false]; pz.nextPlateIdx = 0; }
          } else { pz.plates[i] = true; }
          updateDoor(room); changed = true;
        }
      } else if (msg.event === 'lever' && !pz.leverPulled) {
        pz.leverPulled = true; updateDoor(room); changed = true;
      } else if (msg.event === 'sync') {
        pz.levers[msg.which] = true; updateDoor(room); changed = true;
        setTimeout(function () {
          const r = rooms.get(roomCode);
          if (!r || (r.level !== 4 && r.level !== 19) || r.puzzle.doorOpen) return;
          r.puzzle.levers = [false, false];
          broadcast(r, { type: 'puzzle', state: r.puzzle });
        }, 3000);
      } else if (msg.event === 'door') {
        room.doorState[playerId] = msg.value;
        checkLevelDone(room);
        return;
      }
      if (changed) { broadcast(room, { type: 'puzzle', state: pz }); checkLevelDone(room); }
    }
  });

  ws.on('close', function () {
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;
    room.players.delete(playerId);
    broadcast(room, { type: 'playerLeft' });
    if (room.players.size === 0) rooms.delete(roomCode);
  });
});

server.listen(PORT, function () {
  console.log('🎮 ZONA78 запущен на http://localhost:' + PORT);
});
