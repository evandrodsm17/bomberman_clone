const WebSocket = require('ws');
const http = require('http');
const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// --- Constantes do Jogo ---
const MAP_WIDTH = 15;
const MAP_HEIGHT = 13;
const TILE_EMPTY = 0;
const TILE_SOLID = 1;
const TILE_SOFT = 2;

// Mapa base (Spawn points são 0)
const ORIGINAL_MAP = [
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
  [1, 0, 0, 2, 2, 2, 2, 2, 2, 2, 2, 2, 0, 0, 1],
  [1, 0, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 0, 1],
  [1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1],
  [1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1],
  [1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1],
  [1, 0, 1, 2, 1, 2, 0, 0, 0, 2, 1, 2, 1, 0, 1], // Área central limpa
  [1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1],
  [1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1],
  [1, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1],
  [1, 0, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 0, 1],
  [1, 0, 0, 2, 2, 2, 2, 2, 2, 2, 2, 2, 0, 0, 1],
  [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
];

// Pontos de spawn (Garantido que sejam 0 no mapa base)
const SPAWN_POINTS = [
  { x: 1, y: 1 },  // Canto Superior Esquerdo
  { x: 13, y: 1 }, // Canto Superior Direito
  { x: 1, y: 11 }, // Canto Inferior Esquerdo
  { x: 13, y: 11 },// Canto Inferior Direito
  { x: 7, y: 6 }   // Centro
];

const PLAYER_COLORS = ['#FF4136', '#0074D9', '#2ECC40', '#FFDC00', '#B10DC9'];
const COLOR_NAMES = {
  '#ff4136': 'Vermelho', '#0074d9': 'Azul', '#2ecc40': 'Verde',
  '#ffdc00': 'Amarelo', '#b10dc9': 'Roxo'
};

const MAX_WINS = 5;
const POWERUP_CHANCE = 0.35;
const POWERUP_TYPES = ['bomb-up', 'fire-up', 'bomb-pass'];

let rooms = {}; // Armazena todas as salas de jogo

// --- Conexão WebSocket ---
wss.on('connection', (ws) => {
  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message);
      
      // Handlers que NÃO precisam de uma sala
      if (data.type === 'create_room') {
        handleCreateRoom(ws, data);
        return; 
      }
      if (data.type === 'join_room') {
        handleJoinRoom(ws, data);
        return; 
      }

      // Todos os handlers abaixo precisam de uma sala
      const room = rooms[ws.roomId];
      if (!room) return; 

      // Handlers que funcionam no LOBBY (jogo não rodando)
      if (!room.isGameRunning) {
        // if (data.type === 'change_color') handleChangeColor(ws, data); // Removido
        if (data.type === 'change_emoji') handleChangeEmoji(ws, data);
        else if (data.type === 'add_bot') handleAddBot(ws);
        else if (data.type === 'start_game') handleStartGame(ws); 
      } 
      // Handlers que funcionam DURANTE O JOGO (jogo rodando)
      else {
        if (data.type === 'move') handlePlayerMove(ws, data.direction);
        else if (data.type === 'place_bomb') handlePlaceBomb(ws);
      }
      
    } catch (e) {
      console.error('Erro ao processar mensagem:', e);
    }
  });

  ws.on('close', () => {
    handlePlayerDisconnect(ws);
  });
});


// --- Funções de Lobby ---

function handleCreateRoom(ws, data) {
  const roomCode = generateRoomCode();
  const playerId = uuidv4();
  
  ws.roomId = roomCode;
  ws.playerId = playerId;
  
  const room = {
    code: roomCode,
    hostId: playerId,
    players: {},
    gameMap: [],
    bombs: [],
    powerUps: [],
    isGameRunning: false,
    botTimers: [],
    spawnPoints: [...SPAWN_POINTS],
    suddenDeathActivated: false, // Flag para morte súbita
  };
  
  // Atribui a primeira cor disponível (Vermelho)
  const playerColor = PLAYER_COLORS[0]; 
  room.players[playerId] = createPlayer(playerId, data.name, playerColor, false, 0, data.emoji);
  
  rooms[roomCode] = room;
  
  ws.send(JSON.stringify({
    type: 'room_created',
    playerId: playerId,
    roomCode: roomCode,
    hostId: playerId,
    players: room.players
  }));
}

function handleJoinRoom(ws, data) {
  const room = rooms[data.roomCode];
  if (!room) {
    ws.send(JSON.stringify({ type: 'error_message', message: 'Sala não encontrada.' }));
    return;
  }
  if (Object.keys(room.players).length >= 5) {
    ws.send(JSON.stringify({ type: 'error_message', message: 'Sala cheia.' }));
    return;
  }
  
  const playerId = uuidv4();
  ws.roomId = data.roomCode;
  ws.playerId = playerId;
  
  // Atribui a próxima cor disponível
  const usedColors = Object.values(room.players).map(p => p.color);
  const playerColor = PLAYER_COLORS.find(c => !usedColors.includes(c)) || PLAYER_COLORS[PLAYER_COLORS.length - 1]; // Pega a próxima ou a última
  
  const spawnIndex = Object.keys(room.players).length;
  room.players[playerId] = createPlayer(playerId, data.name, playerColor, false, spawnIndex, data.emoji);
  
  ws.send(JSON.stringify({
    type: 'room_joined',
    playerId: playerId,
    roomCode: data.roomCode,
    hostId: room.hostId,
    players: room.players
  }));
  
  broadcast(data.roomCode, {
    type: 'lobby_update',
    players: room.players
  });
}

// Removido - A cor é automática agora
// function handleChangeColor(ws, data) { ... }

function handleChangeEmoji(ws, data) {
  const room = rooms[ws.roomId];
  if (room && room.players[ws.playerId]) {
    room.players[ws.playerId].chosenEmoji = data.emoji || '😀';
    room.players[ws.playerId].displayEmoji = data.emoji || '😀';
    broadcast(ws.roomId, {
      type: 'lobby_update',
      players: room.players
    });
  }
}

function handleAddBot(ws) {
  const room = rooms[ws.roomId];
  if (!room || ws.playerId !== room.hostId) return;
  
  if (Object.keys(room.players).length >= 5) return;

  const botId = uuidv4();
  const spawnIndex = Object.keys(room.players).length;
  const usedColors = Object.values(room.players).map(p => p.color);
  const botColor = PLAYER_COLORS.find(c => !usedColors.includes(c)) || '#888888';
  
  room.players[botId] = createPlayer(botId, 'Bot ' + (spawnIndex + 1), botColor, true, spawnIndex, '🤖');
  
  broadcast(ws.roomId, {
    type: 'lobby_update',
    players: room.players
  });
}


function handleStartGame(ws) {
  const room = rooms[ws.roomId];
  if (!room || ws.playerId !== room.hostId) return;

  room.isGameRunning = true;
  // Gera o estado inicial do jogo
  const initialState = generateRoundState(room.code); 
  
  // Envia 'game_start' em vez de 'round_start'
  broadcast(room.code, {
    type: 'game_start',
    initialState: initialState 
  });
  
  // Inicia a IA dos Bots
  startBotAI(room.code);
}


function handlePlayerDisconnect(ws) {
  const room = rooms[ws.roomId];
  if (!room) return;

  const playerId = ws.playerId;
  if (!playerId) return;
  
  const playerWasHost = room.hostId === playerId;
  delete room.players[playerId];

  if (Object.keys(room.players).length === 0) {
    // Se a sala estiver vazia, pare a IA e delete a sala
    stopBotAI(room.code);
    delete rooms[ws.roomId];
    return;
  }
  
  // Se o host saiu, elege um novo host (o jogador mais antigo)
  if (playerWasHost) {
    room.hostId = Object.keys(room.players)[0];
  }
  
  // Se o jogo estava rolando, avisa os outros
  if (room.isGameRunning) {
    broadcast(ws.roomId, {
      type: 'player_left',
      playerId: playerId,
      newHostId: room.hostId,
    });
    // Verifica se a rodada/jogo acabou
    checkRoundOver(room.code);
  } else {
    // Se estava no lobby, só atualiza o lobby
    broadcast(ws.roomId, {
      type: 'lobby_update',
      players: room.players,
      hostId: room.hostId
    });
  }
}

// --- Funções de Jogo ---

function createPlayer(id, name, color, isBot, spawnIndex, emoji) {
  return {
    id: id,
    name: name,
    color: color,
    chosenEmoji: emoji || '😀', // O emoji que ele escolheu
    displayEmoji: emoji || '😀', // O emoji que aparece (muda para '💀')
    ...SPAWN_POINTS[spawnIndex], // Posição inicial
    startPositionIndex: spawnIndex,
    isBot: isBot,
    isAlive: true,
    score: 0,
    // Status da rodada
    bombPower: 1,
    maxBombs: 1,
    activeBombs: 0,
    canPassBombs: false,
  };
}

function handlePlayerMove(ws, direction) {
  const room = rooms[ws.roomId];
  const player = room.players[ws.playerId];
  if (!player || !player.isAlive) return;

  let { x, y } = player;

  if (direction === 'up') y--;
  else if (direction === 'down') y++;
  else if (direction === 'left') x--;
  else if (direction === 'right') x++;
  
  if (isMoveValid(room, player, x, y)) {
    player.x = x;
    player.y = y;
    
    // Verifica se pegou power-up
    checkPowerUpCollision(room, player);
    
    broadcast(room.code, {
      type: 'player_moved',
      playerId: player.id,
      x: player.x,
      y: player.y
    });
  }
}

function handlePlaceBomb(ws) {
  const room = rooms[ws.roomId];
  const player = room.players[ws.playerId];
  if (!player || !player.isAlive || player.activeBombs >= player.maxBombs) {
    return;
  }
  
  // Impede de colocar bomba onde já tem bomba
  if (room.bombs.some(b => b.x === player.x && b.y === player.y)) {
    return;
  }

  player.activeBombs++;
  
  const bomb = {
    id: uuidv4(),
    ownerId: player.id,
    x: player.x,
    y: player.y,
    power: player.bombPower,
    timer: setTimeout(() => handleExplosion(room.code, bomb.id), 3000)
  };
  
  room.bombs.push(bomb);
  
  broadcast(room.code, {
    type: 'bomb_placed',
    bomb: { id: bomb.id, x: bomb.x, y: bomb.y } // Só envia o essencial
  });
}

function handleExplosion(roomCode, bombId) {
  const room = rooms[roomCode];
  if (!room) return;
  
  const bomb = room.bombs.find(b => b.id === bombId);
  if (!bomb) return;
  
  // Remove a bomba da lista
  room.bombs = room.bombs.filter(b => b.id !== bombId);
  
  // Devolve a "munição" para o dono
  const owner = room.players[bomb.ownerId];
  if (owner) {
    owner.activeBombs--;
  }

  let explosionTiles = [{ x: bomb.x, y: bomb.y }];
  let tilesToUpdate = []; // Paredes destruídas

  // Propagação da explosão (4 direções)
  const directions = [ { dx: 0, dy: 1 }, { dx: 0, dy: -1 }, { dx: 1, dy: 0 }, { dx: -1, dy: 0 } ];

  for (const dir of directions) {
    for (let i = 1; i <= bomb.power; i++) {
      const x = bomb.x + dir.dx * i;
      const y = bomb.y + dir.dy * i;

      if (x < 0 || x >= MAP_WIDTH || y < 0 || y >= MAP_HEIGHT) break;

      const tileType = room.gameMap[y][x];
      
      if (tileType === TILE_SOLID) { // Atingiu parede sólida
        break;
      }
      
      explosionTiles.push({ x, y });
      
      if (tileType === TILE_SOFT) { // Atingiu parede destrutível
        room.gameMap[y][x] = TILE_EMPTY;
        tilesToUpdate.push({ x, y, newType: TILE_EMPTY });
        
        // Chance de dropar power-up
        if (Math.random() < POWERUP_CHANCE) {
          const type = POWERUP_TYPES[Math.floor(Math.random() * POWERUP_TYPES.length)];
          const powerUp = {
            id: uuidv4(),
            type: type,
            x: x,
            y: y
          };
          room.powerUps.push(powerUp);
          broadcast(room.code, { type: 'powerup_spawned', powerUp: powerUp });
        }
        break; // Explosão para ao atingir parede destrutível
      }
      
      // Checa se atingiu outra bomba (explosão em cadeia)
      const hitBomb = room.bombs.find(b => b.x === x && b.y === y);
      if (hitBomb) {
        clearTimeout(hitBomb.timer); // Para o timer da bomba atingida
        handleExplosion(room.code, hitBomb.id); // Detona ela imediatamente
      }
    }
  }
  
  // Avisa os clientes sobre a explosão
  broadcast(room.code, {
    type: 'bomb_exploded',
    bombId: bomb.id,
    explosionTiles: explosionTiles
  });
  
  // Avisa sobre paredes destruídas
  if (tilesToUpdate.length > 0) {
    broadcast(room.code, {
      type: 'map_update',
      tiles: tilesToUpdate
    });
  }
  
  // Verifica se a explosão atingiu jogadores
  Object.values(room.players).forEach(player => {
    if (player.isAlive) {
      const hit = explosionTiles.some(tile => tile.x === player.x && tile.y === player.y);
      if (hit) {
        player.isAlive = false;
        player.displayEmoji = '💀'; 
        
        broadcast(room.code, { 
          type: 'player_update', 
          playerId: player.id, 
          isAlive: false,
          displayEmoji: '💀' 
        });
      }
    }
  });
  
  // Verifica se a rodada acabou
  checkRoundOver(room.code);
}


function isMoveValid(room, player, x, y) {
  // 1. Checa limites do mapa
  if (x < 0 || x >= MAP_WIDTH || y < 0 || y >= MAP_HEIGHT) {
    return false;
  }
  // 2. Checa paredes
  const tileType = room.gameMap[y][x];
  if (tileType === TILE_SOLID || tileType === TILE_SOFT) {
    return false;
  }
  
  // 3. Checa bombas
  const isBombAtPos = room.bombs.some(b => b.x === x && b.y === y);
  if (isBombAtPos) {
    // É válido se o jogador puder passar por bombas
    // OU se a bomba for a que ele acabou de sair
    return player.canPassBombs || (x === player.x && y === player.y);
  }

  return true;
}

function checkPowerUpCollision(room, player) {
  const powerUpIndex = room.powerUps.findIndex(p => p.x === player.x && p.y === player.y);
  
  if (powerUpIndex > -1) {
    const powerUp = room.powerUps[powerUpIndex];
    
    // Aplica o bônus
    if (powerUp.type === 'bomb-up') player.maxBombs++;
    if (powerUp.type === 'fire-up') player.bombPower++;
    if (powerUp.type === 'bomb-pass') player.canPassBombs = true;
    
    // Remove o power-up
    room.powerUps.splice(powerUpIndex, 1);
    
    // Avisa os clientes
    broadcast(room.code, {
      type: 'powerup_collected',
      powerUpId: powerUp.id,
      playerId: player.id
    });
  }
}


function checkRoundOver(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.isGameRunning) return;

  const alivePlayers = Object.values(room.players).filter(p => p.isAlive);
  
  // --- LÓGICA DE MORTE SÚBITA (BOTS) ---
  if (alivePlayers.length > 1 && !room.suddenDeathActivated && alivePlayers.every(p => p.isBot)) {
    room.suddenDeathActivated = true;
    
    alivePlayers.forEach(bot => {
      bot.bombPower = 5; // Poder máximo
      bot.maxBombs = 3;  // Bombas máximas
      
      // Avisa o cliente para atualizar o placar
      broadcast(room.code, { 
        type: 'player_update', 
        playerId: bot.id,
        bombPower: bot.bombPower,
        maxBombs: bot.maxBombs
      });
    });
    
    broadcast(room.code, { type: 'sudden_death' });
  }
  // --- FIM DA LÓGICA DE MORTE SÚBITA ---

  if (alivePlayers.length <= 1) {
    room.isGameRunning = false; // Pausa o jogo
    stopBotAI(room.code); // Para os bots
    
    let winnerName = "Empate";
    let winner = null;
    
    if (alivePlayers.length === 1) {
      winner = alivePlayers[0];
      winner.score++;
      winnerName = winner.name;
    }
    
    // Avisa do fim da rodada
    broadcast(room.code, {
      type: 'round_over',
      winnerName: winnerName
    });
    
    // Avisa da atualização de score
    broadcast(room.code, {
      type: 'score_update',
      players: room.players
    });

    // Checa se o jogo acabou (alguém atingiu MAX_WINS)
    if (winner && winner.score >= MAX_WINS) {
      broadcast(room.code, {
        type: 'game_over',
        winnerName: winner.name
      });
      // Não reinicia, o jogo acabou.
    } else {
      // Agenda o reinício da próxima rodada
      setTimeout(() => startNewRound(roomCode), 5000);
    }
  }
}


function startNewRound(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  room.isGameRunning = true;
  const newState = generateRoundState(roomCode);
  
  broadcast(room.code, {
    type: 'round_start',
    newState: newState
  });
  
  startBotAI(room.code);
}


function generateRoundState(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  // 1. Limpa estado anterior
  room.bombs.forEach(b => clearTimeout(b.timer));
  room.bombs = [];
  room.powerUps = [];
  room.suddenDeathActivated = false; // Reseta a Morte Súbita
  
  // 2. Gera novo mapa aleatório (baseado no original)
  room.gameMap = JSON.parse(JSON.stringify(ORIGINAL_MAP)); // Deep copy
  
  for (let y = 0; y < MAP_HEIGHT; y++) {
    for (let x = 0; x < MAP_WIDTH; x++) {
      // Se não for parede sólida (1) ou chão (0)...
      if (room.gameMap[y][x] !== TILE_SOLID && room.gameMap[y][x] !== TILE_EMPTY) {
         // ... preenche aleatoriamente com parede ou chão
         room.gameMap[y][x] = (Math.random() < 0.75) ? TILE_SOFT : TILE_EMPTY;
      }
    }
  }
  
  // 3. Reseta os jogadores
  Object.values(room.players).forEach(player => {
    const spawnPoint = SPAWN_POINTS[player.startPositionIndex];
    player.x = spawnPoint.x;
    player.y = spawnPoint.y;
    
    player.isAlive = true;
    player.bombPower = 1;
    player.maxBombs = 1;
    player.activeBombs = 0;
    player.canPassBombs = false;
    player.displayEmoji = player.chosenEmoji; 
    
    // Garante que a área de spawn esteja limpa
    const clearRadius = 1; // 1 quadrado ao redor
    for (let dy = -clearRadius; dy <= clearRadius; dy++) {
        for (let dx = -clearRadius; dx <= clearRadius; dx++) {
            // Limpa apenas adjacentes (não diagonais) e o próprio spawn
            if (Math.abs(dx) + Math.abs(dy) <= clearRadius) { 
                const newX = player.x + dx;
                const newY = player.y + dy;
                // Só limpa se for dentro do mapa e for parede destrutível
                if (newX >= 0 && newX < MAP_WIDTH && newY >= 0 && newY < MAP_HEIGHT &&
                    room.gameMap[newY][newX] === TILE_SOFT) {
                    room.gameMap[newY][newX] = TILE_EMPTY;
                }
            }
        }
    }
  });
  
  // 4. Retorna o novo estado (NÃO envia broadcast)
  return {
    players: room.players,
    gameMap: room.gameMap,
    bombs: room.bombs,
    powerUps: room.powerUps
  };
}


// --- IA dos Bots ---

function startBotAI(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  // Limpa timers antigos
  stopBotAI(room.code);
  
  const bots = Object.values(room.players).filter(p => p.isBot);
  
  bots.forEach(bot => {
    const timer = setInterval(() => {
      runBotLogic(room, bot);
    }, 500); // IA "pensa" a cada 500ms
    room.botTimers.push(timer);
  });
}

function stopBotAI(roomCode) {
  const room = rooms[roomCode];
  if (room && room.botTimers.length > 0) {
    room.botTimers.forEach(timer => clearInterval(timer));
    room.botTimers = [];
  }
}

// NOVA FUNÇÃO: Calcula todas as casas inseguras (raios de explosão)
function getDangerZones(room) {
  const dangerSet = new Set();
  const directions = [ { dx: 0, dy: 1 }, { dx: 0, dy: -1 }, { dx: 1, dy: 0 }, { dx: -1, dy: 0 } ];

  for (const bomb of room.bombs) {
    dangerSet.add(`${bomb.x},${bomb.y}`); // A própria casa da bomba é perigosa

    for (const dir of directions) {
      for (let i = 1; i <= bomb.power; i++) {
        const x = bomb.x + dir.dx * i;
        const y = bomb.y + dir.dy * i;

        if (x < 0 || x >= MAP_WIDTH || y < 0 || y >= MAP_HEIGHT) break;
        
        const tileType = room.gameMap[y][x];
        if (tileType === TILE_SOLID) break; // Explosão para em parede sólida
        
        dangerSet.add(`${x},${y}`); // Adiciona casa ao raio de perigo
        
        if (tileType === TILE_SOFT) break; // Explosão para aqui (mas destrói a parede)
      }
    }
  }
  return dangerSet;
}

// IA ATUALIZADA
function runBotLogic(room, bot) {
  if (!bot.isAlive || !room.isGameRunning) return;
  
  const { x, y } = bot;
  const { code: roomCode } = room; 
  const { id: botId } = bot; 

  // --- 1. Get Context (Cálculo de Perigo) ---
  const dangerZones = getDangerZones(room);
  const isBotInDanger = dangerZones.has(`${x},${y}`);
  
  // --- 2. PRIORIDADE MÁXIMA: Fugir do perigo! ---
  if (isBotInDanger) {
    // 1. Tenta achar um local *perfeitamente* seguro
    let escapeMoves = getSafeMoves(room, bot, dangerZones); 
    
    if (escapeMoves.length === 0) {
      // 2. FALHOU. Está preso. Tenta *qualquer* movimento válido (ignorando o perigo futuro).
      //    Qualquer movimento é melhor do que ficar parado na bomba.
      escapeMoves = getSafeMoves(room, bot, new Set()); // Passa um Set de perigo VAZIO
    }

    if (escapeMoves.length > 0) {
      // Foge para o melhor local que encontrou (seja perfeitamente seguro ou não)
      const bestMove = escapeMoves[Math.floor(Math.random() * escapeMoves.length)];
      handlePlayerMove({ roomId: roomCode, playerId: botId }, bestMove);
    }
    // Se ainda não há movimentos (preso por paredes), o bot fica parado.
    return; 
  }

  // Pega todos os movimentos válidos E seguros (para lógica normal)
  const allSafeMoves = getSafeMoves(room, bot, dangerZones); 

  // Define os movimentos adjacentes para checagem
  const adjacentMoves = [
    { dir: 'up',    x: x,     y: y - 1 },
    { dir: 'down',  x: x,     y: y + 1 },
    { dir: 'left',  x: x - 1, y: y     },
    { dir: 'right', x: x + 1, y: y     }
  ];

  // --- 3. PRIORIDADE 2: Pegar Power-ups (se não estiver em perigo) ---
  for (const move of adjacentMoves) {
    const isPowerUp = room.powerUps.some(p => p.x === move.x && p.y === move.y);
    // Se for um powerup E for um movimento válido E seguro
    if (isPowerUp && isMoveValid(room, bot, move.x, move.y) && !dangerZones.has(`${move.x},${move.y}`)) {
      handlePlayerMove({ roomId: roomCode, playerId: botId }, move.dir);
      return; // Pegou o power-up, encerra o "pensamento"
    }
  }
  
  // --- 4. PRIORIDADE 3: Colocar Bomba (Estratégico) ---
  // CORREÇÃO: Só coloca bomba se tiver uma rota de fuga
  if (bot.activeBombs < bot.maxBombs && allSafeMoves.length > 0) {
    let placedBomb = false;
    for (const move of adjacentMoves) {
      if (move.x < 0 || move.x >= MAP_WIDTH || move.y < 0 || move.y >= MAP_HEIGHT) continue;
      
      const tileType = room.gameMap[move.y][move.x];
      if (tileType === TILE_SOFT) {
        // Encontrou um alvo!
        handlePlaceBomb({ roomId: roomCode, playerId: botId });
        placedBomb = true;
        // A IA agora vai fugir no próximo tick, pois `isBotInDanger` será true
        break; 
      }
    }
    if (placedBomb) return;
  }

  // --- 5. PRIORIDADE 4: Mover (com segurança) ou Ficar Parado ---
  const action = Math.random();
  if (action < 0.70 && allSafeMoves.length > 0) { // 70% chance de mover
    // Move para um local seguro aleatório
    const bestMove = allSafeMoves[Math.floor(Math.random() * allSafeMoves.length)];
    handlePlayerMove({ roomId: roomCode, playerId: botId }, bestMove);
  }
  // 30% chance de ficar parado (se for seguro)
}

// FUNÇÃO ATUALIZADA: Agora aceita 'dangerZones'
function getSafeMoves(room, bot, dangerZones) {
  const { x, y } = bot;
  const possibleMoves = [
    { dir: 'up',    x: x,     y: y - 1 },
    { dir: 'down',  x: x,     y: y + 1 },
    { dir: 'left',  x: x - 1, y: y     },
    { dir: 'right', x: x + 1, y: y     }
  ];
  
  return possibleMoves
    // É um local válido para andar? (sem paredes/bombas)
    .filter(move => isMoveValid(room, bot, move.x, move.y))
    // É um local SEGURO? (sem explosão futura)
    .filter(move => !dangerZones.has(`${move.x},${move.y}`))
    .map(move => move.dir);
}


// --- Funções Utilitárias ---
function generateRoomCode() {
  let code = '';
  const chars = 'ABCDEFGHIJKLMNPQRSTUVWXYZ123456789'; // Sem 'O' e '0'
  for (let i = 0; i < 4; i++) {
    code += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  // Garante que o código seja único
  if (rooms[code]) return generateRoomCode();
  return code;
}

function broadcast(roomCode, data) {
  const room = rooms[roomCode];
  if (!room) return;

  const message = JSON.stringify(data);
  
  wss.clients.forEach(client => {
    if (client.readyState === WebSocket.OPEN && client.roomId === roomCode) {
      client.send(message);
    }
  });
}

// Inicia o servidor
server.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  console.log(`Acesse http://localhost:${PORT}`);
});

