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

// Serve o index.html na raiz
app.get('/', (req, res) => {
  // Assegura que o index.html seja servido
  res.sendFile(path.join(__dirname, 'index.html'));
});

// --- Constantes do Jogo ---
const MAP_WIDTH = 15;
const MAP_HEIGHT = 13;
const TILE_EMPTY = 0;
const TILE_SOLID = 1;
const TILE_SOFT = 2;
const ROUND_DURATION_MS = 120000; // 2 minutos para Morte Súbita
const SUDDEN_DEATH_INTERVAL_MS = 1000; // 1 bloco por segundo
const ROUND_END_DELAY_MS = 1500; // (NOVO) Delay para ver a explosão final

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
const POWERUP_CHANCE = 0.40; // Aumentei a chance geral
// ATUALIZADO: Adicionado 'wall-pass', 'kick-bomb', 'skull'
const POWERUP_TYPES = ['bomb-up', 'fire-up', 'bomb-pass', 'wall-pass', 'kick-bomb', 'skull'];
const CURSE_TYPES = ['reverse', 'slow']; // Tipos de maldição

// Constantes de Morte Súbita (Bots)
const SUDDEN_DEATH_POWER = 5;
const SUDDEN_DEATH_BOMBS = 5;

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
        if (data.type === 'change_emoji') handleChangeEmoji(ws, data); // Cor é automática
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
    isRoundEnding: false, // (NOVO) Flag para o delay de fim de rodada
    botTimers: [],
    spawnPoints: [...SPAWN_POINTS],
    availableColors: [...PLAYER_COLORS], // Cores disponíveis
    roundTimer: null, // Timer para Morte Súbita (Humanos)
    suddenDeathTimer: null, // Timer para queda de blocos
  };
  
  // Atribui a primeira cor disponível
  const playerColor = room.availableColors.shift() || '#888888';
  
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
  
  // Atribui a primeira cor disponível
  const playerColor = room.availableColors.shift() || '#888888';
  
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

function handleChangeEmoji(ws, data) {
  const room = rooms[ws.roomId];
  if (room && room.players[ws.playerId]) {
    room.players[ws.playerId].emoji = data.emoji || '😀'; // ATUALIZADO (Removido display/chosen)
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
  // Atribui a primeira cor disponível
  const botColor = room.availableColors.shift() || '#888888';
  
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
  room.isRoundEnding = false; // (NOVO) Reseta a flag
  // Gera o estado inicial do jogo
  const initialState = generateRoundState(room.code); 
  
  // Envia 'game_start' em vez de 'round_start'
  broadcast(room.code, {
    type: 'game_start',
    initialState: initialState 
  });
  
  // Inicia a IA dos Bots
  startBotAI(room.code);
  // Inicia timer da Morte Súbita (Humanos)
  room.roundTimer = setTimeout(() => startSuddenDeath(room.code), ROUND_DURATION_MS);
}


function handlePlayerDisconnect(ws) {
  const room = rooms[ws.roomId];
  if (!room) return;

  const playerId = ws.playerId;
  if (!playerId) return;
  
  // Devolve a cor do jogador para a lista de cores disponíveis
  const player = room.players[playerId];
  if (player) {
    room.availableColors.push(player.color);
  }
  
  const playerWasHost = room.hostId === playerId;
  delete room.players[playerId];

  if (Object.keys(room.players).length === 0) {
    // Se a sala estiver vazia, pare a IA e delete a sala
    stopBotAI(room.code);
    if (room.roundTimer) clearTimeout(room.roundTimer);
    if (room.suddenDeathTimer) clearInterval(room.suddenDeathTimer);
    delete rooms[ws.roomId];
    return;
  }
  
  // Se o host saiu, elege um novo host (o jogador mais antigo)
  if (playerWasHost) {
    room.hostId = Object.keys(room.players)[0];
  }
  
  // Se o jogo estava rolando, avisa os outros
  if (room.isGameRunning || room.isRoundEnding) { // (NOVO) Checa se está terminando
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
    color: color, // Cor atribuída automaticamente
    emoji: emoji || '😀', // ATUALIZADO (Removido display/chosen)
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
    canPassWalls: false, 
    canKickBombs: false, // NOVO
    curse: null, // NOVO (reverse, slow)
    slowTick: false, // NOVO (para maldição)
  };
}

function handlePlayerMove(ws, direction) {
  const room = rooms[ws.roomId];
  const player = room.players[ws.playerId];
  if (!player || !player.isAlive) return;

  // Lógica da Maldição "Slow" (Pular 1 movimento)
  if (player.curse === 'slow') {
    if (player.slowTick) {
      player.slowTick = false;
      return; // Pula este movimento
    }
    player.slowTick = true; // Permite o próximo movimento
  }

  let { x, y } = player;
  
  // Lógica da Maldição "Reverse"
  let finalDirection = direction;
  if (player.curse === 'reverse') {
    if (direction === 'up') finalDirection = 'down';
    else if (direction === 'down') finalDirection = 'up';
    else if (direction === 'left') finalDirection = 'right';
    else if (direction === 'right') finalDirection = 'left';
  }

  if (finalDirection === 'up') y--;
  else if (finalDirection === 'down') y++;
  else if (finalDirection === 'left') x--;
  else if (finalDirection === 'right') x++;
  
  // --- Lógica de Chutar Bomba (Kick) ---
  const bombAtTarget = room.bombs.find(b => b.x === x && b.y === y && !b.isKicked);
  if (bombAtTarget && player.canKickBombs && !player.canPassBombs) {
    handleKickBomb(room, bombAtTarget, finalDirection);
    return; // Não move o jogador, apenas chuta a bomba
  }
  // --- Fim da Lógica de Chute ---

  if (isMoveValid(room, player, x, y)) {
    player.x = x;
    player.y = y;
    
    // --- Lógica de Transferência de Maldição ---
    if (player.curse) {
      const hitPlayer = Object.values(room.players).find(p => p.isAlive && p.id !== player.id && p.x === x && p.y === y);
      if (hitPlayer && !hitPlayer.curse) { // Só transfere se o alvo não estiver amaldiçoado
        hitPlayer.curse = player.curse;
        player.curse = null;
        broadcast(room.code, {
          type: 'curse_transferred',
          fromId: player.id,
          toId: hitPlayer.id,
          curse: hitPlayer.curse
        });
      }
    }
    
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
    timer: setTimeout(() => handleExplosion(room.code, bomb.id), 3000),
    isKicked: false, // NOVO
    slideTimer: null // NOVO
  };
  
  room.bombs.push(bomb);
  
  broadcast(room.code, {
    type: 'bomb_placed',
    bomb: { id: bomb.id, x: bomb.x, y: bomb.y } // Só envia o essencial
  });
}

// NOVO: Função para Chutar Bomba
function handleKickBomb(room, bomb, direction) {
  if (bomb.isKicked) return; // Já está deslizando
  bomb.isKicked = true; 

  let dx = 0, dy = 0;
  if (direction === 'up') dy = -1;
  else if (direction === 'down') dy = 1;
  else if (direction === 'left') dx = -1;
  else if (direction === 'right') dx = 1;

  let currentX = bomb.x;
  let currentY = bomb.y;
  
  const slideInterval = setInterval(() => {
    let nextX = currentX + dx;
    let nextY = currentY + dy;

    // Checa obstáculos
    const tileType = room.gameMap[nextY][nextX];
    const isOtherBomb = room.bombs.some(b => b.id !== bomb.id && b.x === nextX && b.y === nextY);
    const isPlayer = Object.values(room.players).some(p => p.isAlive && p.x === nextX && p.y === nextY);

    if (tileType === TILE_EMPTY && !isOtherBomb) {
      currentX = nextX;
      currentY = nextY;
      bomb.x = currentX;
      bomb.y = currentY;
      broadcast(room.code, { type: 'bomb_moved', bombId: bomb.id, x: bomb.x, y: bomb.y });
      
      // Para se atingir um jogador
      if (isPlayer) {
        clearInterval(slideInterval);
        bomb.isKicked = false;
        bomb.slideTimer = null;
      }
    } else {
      // Atingiu parede, jogador, ou outra bomba
      clearInterval(slideInterval);
      bomb.isKicked = false;
      bomb.slideTimer = null;
    }
  }, 100); // Velocidade do chute (100ms por casa)

  bomb.slideTimer = slideInterval; // Armazena o timer para ser limpo na explosão
}

function handleExplosion(roomCode, bombId) {
  const room = rooms[roomCode];
  if (!room) return;
  
  const bomb = room.bombs.find(b => b.id === bombId);
  if (!bomb) return;
  
  // Limpa o timer de chute se houver
  if (bomb.slideTimer) {
    clearInterval(bomb.slideTimer);
  }
  
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
        
        // ATUALIZADO: Lógica de drop ponderada
        if (Math.random() < POWERUP_CHANCE) {
          // --- NOVO: Sistema de Drop Ponderado ---
          const rand = Math.random();
          let type = 'bomb-up';
          if (rand < 0.30) { // 30%
            type = 'bomb-up';
          } else if (rand < 0.55) { // 25%
            type = 'fire-up';
          } else if (rand < 0.70) { // 15%
            type = 'wall-pass'; 
          } else if (rand < 0.85) { // 15%
            type = 'kick-bomb';
          } else if (rand < 0.95) { // 10%
            type = 'skull'; 
          } else { // 5%
            type = 'bomb-pass'; 
          }
          // --- Fim do Sistema Ponderado ---

          const powerUp = {
            id: uuidv4(),
            type: type, // Usa o tipo ponderado
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
        if (hitBomb.slideTimer) clearInterval(hitBomb.slideTimer); // Para o chute
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
        // player.displayEmoji = '💀'; // REMOVIDO (Conforme solicitado)
        
        broadcast(room.code, { 
          type: 'player_update', 
          playerId: player.id, 
          isAlive: false
          // displayEmoji: '💀' // REMOVIDO
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
  
  // 2. Checa paredes (ATUALIZADO)
  const tileType = room.gameMap[y][x];
  if (tileType === TILE_SOLID) {
    return false; // Sempre para em parede sólida
  }
  if (tileType === TILE_SOFT && !player.canPassWalls) {
    return false; // Para em parede destrutível, *a menos* que tenha o power-up
  }
  
  // 3. Checa bombas (ATUALIZADO)
  const isBombAtPos = room.bombs.some(b => b.x === x && b.y === y);
  if (isBombAtPos) {
    if (player.canPassBombs) return true; // Pode passar
    if (player.canKickBombs && !room.bombs.find(b => b.x === x && b.y === y).isKicked) return false; // Não pode passar, mas vai chutar (handlePlayerMove trata)
    return (player.x === x && player.y === y); // Permite "sair" da bomba que acabou de colocar
  }

  return true;
}

function checkPowerUpCollision(room, player) {
  const powerUpIndex = room.powerUps.findIndex(p => p.x === player.x && p.y === player.y);
  
  if (powerUpIndex > -1) {
    const powerUp = room.powerUps[powerUpIndex];
    
    // Aplica o bônus (ATUALIZADO)
    if (powerUp.type === 'bomb-up') player.maxBombs++;
    if (powerUp.type === 'fire-up') player.bombPower++;
    if (powerUp.type === 'bomb-pass') player.canPassBombs = true;
    if (powerUp.type === 'wall-pass') player.canPassWalls = true;
    if (powerUp.type === 'kick-bomb') player.canKickBombs = true;
    if (powerUp.type === 'skull') {
      // Remove maldição anterior, se houver
      player.curse = null;
      // Aplica maldição aleatória
      player.curse = CURSE_TYPES[Math.floor(Math.random() * CURSE_TYPES.length)];
      broadcast(room.code, {
        type: 'player_cursed',
        playerId: player.id,
        curse: player.curse
      });
    }
    
    // Remove o power-up
    room.powerUps.splice(powerUpIndex, 1);
    
    // Avisa os clientes (exceto da caveira, que já foi avisada)
    if (powerUp.type !== 'skull') {
      broadcast(room.code, {
        type: 'powerup_collected',
        powerUpId: powerUp.id,
        playerId: player.id
      });
    }
  }
}


function checkRoundOver(roomCode) {
  const room = rooms[roomCode];
  // (NOVO) Não checa se a rodada já está terminando
  if (!room || !room.isGameRunning || room.isRoundEnding) return;

  const alivePlayers = Object.values(room.players).filter(p => p.isAlive);
  const aliveHumans = alivePlayers.filter(p => !p.isBot);
  
  // Morte Súbita (Bots): Se restarem 0 humanos e 2+ bots
  if (aliveHumans.length === 0 && alivePlayers.length > 1) {
    if (!room.isSuddenDeath) { // Ativa a morte súbita (apenas uma vez)
      room.isSuddenDeath = true;
      broadcast(room.code, { type: 'sudden_death' });
      
      // Dá poder máximo aos bots restantes
      alivePlayers.forEach(bot => {
        bot.bombPower = SUDDEN_DEATH_POWER;
        bot.maxBombs = SUDDEN_DEATH_BOMBS;
        broadcast(room.code, {
          type: 'player_update',
          playerId: bot.id,
          bombPower: bot.bombPower,
          maxBombs: bot.maxBombs
        });
      });
    }
  }

  // Fim da Rodada: Se restar 1 ou 0 jogadores
  if (alivePlayers.length <= 1) {
    // (NOVO) ATIVA A FLAG DE FIM DE RODADA
    room.isRoundEnding = true;
    
    room.isGameRunning = false; // Pausa o jogo
    room.isSuddenDeath = false; // Reseta a morte súbita (bots)
    stopBotAI(room.code); // Para os bots
    
    // Para timers de Morte Súbita (Humanos)
    if (room.roundTimer) clearTimeout(room.roundTimer);
    if (room.suddenDeathTimer) clearInterval(room.suddenDeathTimer);
    room.roundTimer = null;
    room.suddenDeathTimer = null;
    
    let winnerName = "Empate";
    let winner = null;
    
    if (alivePlayers.length === 1) {
      winner = alivePlayers[0];
      winner.score++;
      winnerName = winner.name;
    }
    
    // --- (NOVO) DELAY PARA FIM DA RODADA ---
    // Agenda o anúncio do fim da rodada para daqui a X ms
    setTimeout(() => {
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
          setTimeout(() => startNewRound(roomCode), 5000); // 5s após a msg de fim de rodada
        }
    }, ROUND_END_DELAY_MS); // (NOVO) Espera 1.5s
  }
}

// NOVO: Inicia a Morte Súbita (Humanos)
function startSuddenDeath(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.isGameRunning) return;

  broadcast(room.code, { type: 'sudden_death_starting' });
  
  // Começa a derrubar blocos
  room.suddenDeathTimer = setInterval(() => handleSuddenDeathTick(roomCode), SUDDEN_DEATH_INTERVAL_MS);
}

// NOVO: Lógica da Morte Súbita (Tick)
function handleSuddenDeathTick(roomCode) {
  const room = rooms[roomCode];
  if (!room || !room.isGameRunning) {
    if (room && room.suddenDeathTimer) clearInterval(room.suddenDeathTimer);
    return;
  }
  
  // Encontra todas as casas vazias (chão)
  const emptyTiles = [];
  for (let y = 0; y < MAP_HEIGHT; y++) {
    for (let x = 0; x < MAP_WIDTH; x++) {
      if (room.gameMap[y][x] === TILE_EMPTY) {
        // Não derruba blocos em cima de jogadores ou power-ups
        const isPlayer = Object.values(room.players).some(p => p.x === x && p.y === y);
        const isPowerUp = room.powerUps.some(p => p.x === x && p.y === y);
        if (!isPlayer && !isPowerUp) {
          emptyTiles.push({ x, y });
        }
      }
    }
  }
  
  if (emptyTiles.length === 0) return; // Não há onde derrubar

  // Escolhe uma casa vazia aleatória
  const tile = emptyTiles[Math.floor(Math.random() * emptyTiles.length)];
  
  // Transforma em parede sólida
  room.gameMap[tile.y][tile.x] = TILE_SOLID;
  
  // Avisa os clientes
  broadcast(room.code, {
    type: 'map_update',
    tiles: [{ x: tile.x, y: tile.y, newType: TILE_SOLID }]
  });
}


function startNewRound(roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  room.isGameRunning = true;
  room.isSuddenDeath = false; // Garante que a morte súbita (bots) está desativada
  room.isRoundEnding = false; // (NOVO) Reseta a flag
  
  // Limpa timers antigos e inicia um novo
  if (room.roundTimer) clearTimeout(room.roundTimer);
  if (room.suddenDeathTimer) clearInterval(room.suddenDeathTimer);
  room.roundTimer = setTimeout(() => startSuddenDeath(room.code), ROUND_DURATION_MS);
  
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
  room.bombs.forEach(b => {
    clearTimeout(b.timer);
    if (b.slideTimer) clearInterval(b.slideTimer);
  });
  room.bombs = [];
  room.powerUps = [];
  
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
    player.canPassWalls = false;
    player.canKickBombs = false; // NOVO
    player.curse = null; // NOVO
    // player.displayEmoji = player.chosenEmoji; // REMOVIDO
    
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
  
  // Maldição "Slow" da Caveira
  if (bot.curse === 'slow') {
    if (bot.slowTick) {
      bot.slowTick = false;
      return; // Pula este tick
    }
    bot.slowTick = true;
  }

  const { x, y } = bot;
  const { code: roomCode } = room; 
  const { id: botId } = bot; 

  // --- 1. Get Context (Cálculo de Perigo) ---
  const dangerZones = getDangerZones(room);
  const isBotInDanger = dangerZones.has(`${x},${y}`);
  
  // --- 2. PRIORIDADE 1: Fugir do perigo! ---
  if (isBotInDanger) {
    // 1. Tenta achar um local *perfeitamente* seguro
    let escapeMoves = getSafeMoves(room, bot, dangerZones); 
    
    if (escapeMoves.length === 0) {
      // 2. FALHOU. Está preso. Tenta *qualquer* movimento válido (ignorando o perigo futuro).
      escapeMoves = getSafeMoves(room, bot, new Set()); // Passa um Set de perigo VAZIO
    }

    if (escapeMoves.length > 0) {
      // Foge para o melhor local que encontrou
      const bestMove = escapeMoves[Math.floor(Math.random() * escapeMoves.length)];
      handlePlayerMove({ roomId: roomCode, playerId: botId }, bestMove);
    }
    return; // FIM DO PENSAMENTO (Fugir é prioridade total)
  }

  // Pega todos os movimentos válidos E seguros (para lógica normal)
  const allSafeMoves = getSafeMoves(room, bot, dangerZones); 

  // Define os movimentos adjacentes para checagem
  let adjacentMoves = [
    { dir: 'up',    x: x,     y: y - 1 },
    { dir: 'down',  x: x,     y: y + 1 },
    { dir: 'left',  x: x - 1, y: y     },
    { dir: 'right', x: x + 1, y: y     }
  ];
  
  // Maldição "Reverse" da Caveira
  if (bot.curse === 'reverse') {
     adjacentMoves = [
      { dir: 'down',  x: x,     y: y - 1 }, // Tenta ir para cima, mas lógica manda 'down'
      { dir: 'up',    x: x,     y: y + 1 },
      { dir: 'right', x: x - 1, y: y     },
      { dir: 'left',  x: x + 1, y: y     }
    ];
  }


  // --- 3. PRIORIDADE 2: Pegar Power-ups ---
  for (const move of adjacentMoves) {
    const isPowerUp = room.powerUps.some(p => p.x === move.x && p.y === move.y);
    // ATUALIZADO: Checa se é um movimento seguro
    if (isPowerUp && isMoveValid(room, bot, move.x, move.y) && !dangerZones.has(`${move.x},${move.y}`)) {
      handlePlayerMove({ roomId: roomCode, playerId: botId }, move.dir);
      return; // Pegou o power-up, encerra o "pensamento"
    }
  }
  
  // --- 4. PRIORIDADE 3: Caçar outros jogadores (NOVO) ---
  if (bot.activeBombs < bot.maxBombs && allSafeMoves.length > 0) {
    let placedBombForKill = false;
    const otherPlayers = Object.values(room.players).filter(p => p.isAlive && p.id !== bot.id);

    for (const move of adjacentMoves) {
      if (move.x < 0 || move.x >= MAP_WIDTH || move.y < 0 || move.y >= MAP_HEIGHT) continue;
      
      // Checa se um jogador está adjacente
      const isPlayerAtPos = otherPlayers.some(p => p.x === move.x && p.y === move.y);
      
      if (isPlayerAtPos) {
        // Encontrou um alvo!
        handlePlaceBomb({ roomId: roomCode, playerId: botId });
        placedBombForKill = true;
        // A IA agora vai fugir no próximo tick
        break; 
      }
    }
    if (placedBombForKill) return; // Colocou bomba, encerra o "pensamento"
  }
  
  // --- 5. PRIORIDADE 4: Colocar Bomba (Estratégico - Paredes) ---
  if (bot.activeBombs < bot.maxBombs && allSafeMoves.length > 0) {
    let placedBombForWall = false;
    for (const move of adjacentMoves) {
      if (move.x < 0 || move.x >= MAP_WIDTH || move.y < 0 || move.y >= MAP_HEIGHT) continue;
      
      const tileType = room.gameMap[move.y][move.x];
      if (tileType === TILE_SOFT) {
        // Encontrou um alvo!
        handlePlaceBomb({ roomId: roomCode, playerId: botId });
        placedBombForWall = true;
        break; 
      }
    }
    if (placedBombForWall) return; // Colocou bomba, encerra o "pensamento"
  }

  // --- 6. PRIORIDADE 5: Mover (com segurança) ou Ficar Parado ---
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
  
  let possibleMoves = [
    { dir: 'up',    x: x,     y: y - 1 },
    { dir: 'down',  x: x,     y: y + 1 },
    { dir: 'left',  x: x - 1, y: y     },
    { dir: 'right', x: x + 1, y: y     }
  ];
  
  // Se estiver amaldiçoado com reverso, a IA precisa saber disso
  if (bot.curse === 'reverse') {
     possibleMoves = [
      { dir: 'down',  x: x,     y: y - 1 }, // Move para cima (ação 'down')
      { dir: 'up',    x: x,     y: y + 1 }, // Move para baixo (ação 'up')
      { dir: 'right', x: x - 1, y: y     },
      { dir: 'left',  x: x + 1, y: y     }
    ];
  }

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

