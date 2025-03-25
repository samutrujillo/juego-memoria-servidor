// Cargar variables de entorno
if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config();
}
  
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
  
const app = express();

// Ruta para el archivo de estado del juego
const GAME_STATE_FILE = path.join(__dirname, 'game-state.json');

// Añadir estas nuevas variables para el sistema de mesas
const MAX_TABLES_PER_DAY = 10;
const UNLOCK_HOUR = 6; // 6 AM (ya no se usará para reseteo automático)
const playerGameState = {}; // Para guardar el estado de juego de cada jugador
const playerTableCount = {}; // Contar mesas jugadas por cada jugador
let globalTableNumber = 1; // Mesa global que todos los jugadores verán

// Configuración de CORS actualizada para permitir múltiples orígenes
const corsOptions = {
    origin: process.env.NODE_ENV === 'production' 
        ? [
            process.env.CLIENT_URL || 'https://juego-memoria-cliente.onrender.com',
            'https://juego-memoria-cliente-ug3h.onrender.com' // Añadido el nuevo dominio
        ] 
        : ['http://localhost:3000'],
    methods: ['GET', 'POST'],
    credentials: true
};
  
app.use(cors(corsOptions));
  
const server = http.createServer(app);
const io = new Server(server, {
    cors: corsOptions,
    pingTimeout: 60000,
    pingInterval: 25000,
    connectTimeout: 45000,
    reconnection: true,
    reconnectionAttempts: 10,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000
});
  
// Datos de usuario (en una aplicación real, esto estaría en una base de datos)
const users = [
    { id: '1', username: 'jugador1', password: 'clave1', score: 60000, prevScore: 60000, isAdmin: false, isBlocked: false, isLockedDueToScore: false },
    { id: '2', username: 'jugador2', password: 'clave2', score: 60000, prevScore: 60000, isAdmin: false, isBlocked: false, isLockedDueToScore: false },
    { id: '3', username: 'jugador3', password: 'clave3', score: 60000, prevScore: 60000, isAdmin: false, isBlocked: false, isLockedDueToScore: false },
    { id: '4', username: 'jugador4', password: 'clave4', score: 60000, prevScore: 60000, isAdmin: false, isBlocked: false, isLockedDueToScore: false },
    { id: '5', username: 'jugador5', password: 'clave5', score: 60000, prevScore: 60000, isAdmin: false, isBlocked: false, isLockedDueToScore: false },
    { id: '6', username: 'jugador6', password: 'clave6', score: 60000, prevScore: 60000, isAdmin: false, isBlocked: false, isLockedDueToScore: false },
    { id: '7', username: 'jugador7', password: 'clave7', score: 60000, prevScore: 60000, isAdmin: false, isBlocked: false, isLockedDueToScore: false },
    { id: '8', username: 'jugador8', password: 'clave8', score: 60000, prevScore: 60000, isAdmin: false, isBlocked: false, isLockedDueToScore: false },
    { id: '9', username: 'jugador9', password: 'clave9', score: 60000, prevScore: 60000, isAdmin: false, isBlocked: false, isLockedDueToScore: false },
    { id: '10', username: 'jugador10', password: 'clave10', score: 60000, prevScore: 60000, isAdmin: false, isBlocked: false, isLockedDueToScore: false },
    { id: 'admin', username: 'admin', password: 'admin123', score: 60000, prevScore: 60000, isAdmin: true, isBlocked: false, isLockedDueToScore: false }
];
  
// Mapa de Socket IDs a usuarios
const connectedSockets = {};
  
// Estado del juego - Persistente incluso cuando no hay jugadores conectados
let gameState = {
    board: generateBoard(),
    players: [],
    currentPlayerIndex: 0,
    currentPlayer: null,
    status: 'playing', // Inicializamos directamente como 'playing' en lugar de 'waiting'
    turnStartTime: null,
    rowSelections: [0, 0, 0, 0],  // Contador para cada hilera (4 hileras en total)
    tableCount: 0,
    lastTableResetDate: new Date().toDateString(),
    playerSelections: {} // Mapa para rastrear selecciones de cada jugador
};
  
let turnTimer = null;

// Función para verificar si un usuario debe ser bloqueado por puntos exactos
// o por caer desde 60,000 a 23,000 o menos
function checkScoreLimit(user) {
    if ((user.score === 23000 || (user.score <= 23000 && user.prevScore >= 60000)) && !user.isAdmin) {
        console.log(`Usuario ${user.username} bloqueado por alcanzar 23,000 puntos o bajar desde 60,000`);
        user.isLockedDueToScore = true;
        return true;
    }
    return false;
}

// Esta función ya no realiza un reseteo automático
function checkAndResetTableCounters() {
    // Esta función ya no hace ningún reinicio automático
    // Solo se mantiene para posible uso futuro o para eventos programados específicos
    console.log("Verificación programada de contadores de mesa (no se realiza reinicio automático)");
}

// Mantener la verificación periódica por posibles usos futuros
setInterval(checkAndResetTableCounters, 60 * 60 * 1000); // Cada hora en vez de cada minuto

// Función para reinicio manual por admin
function adminResetTableCounters() {
    // Reiniciar contadores para todos los jugadores
    Object.keys(playerTableCount).forEach(userId => {
        playerTableCount[userId] = 0;
    });
    
    gameState.lastTableResetDate = new Date().toDateString();
    gameState.tableCount = 0;
    
    // Notificar a todos los clientes
    io.emit('tablesUnlocked', { message: 'El administrador ha reiniciado los contadores de mesas.' });
    
    console.log('Contadores de mesas reiniciados por administrador');
    saveGameState();
}

// Función para verificar el límite de mesas
function checkTableLimit(userId) {
    if (!playerTableCount[userId]) {
        playerTableCount[userId] = 0;
    }
    
    return playerTableCount[userId] >= MAX_TABLES_PER_DAY;
}

// Función para incrementar el contador de mesas
function incrementTableCount(userId) {
    if (!playerTableCount[userId]) {
        playerTableCount[userId] = 0;
    }
    
    playerTableCount[userId]++;
    gameState.tableCount++;
    
    // Guardar estado
    saveGameState();
    
    return playerTableCount[userId];
}

// Función para guardar el estado del juego
function saveGameState() {
    const stateToSave = {
        board: gameState.board,
        players: gameState.players.map(player => ({
            id: player.id,
            username: player.username,
            socketId: player.socketId,
            isConnected: player.isConnected
        })),
        currentPlayerIndex: gameState.currentPlayerIndex,
        status: gameState.status,
        rowSelections: gameState.rowSelections,
        playerSelections: gameState.playerSelections,
        tableCount: gameState.tableCount,
        lastTableResetDate: gameState.lastTableResetDate,
        globalTableNumber: globalTableNumber, // Guardar el número de mesa global
        // Guardar también los datos de los usuarios y contadores de mesa
        userScores: users.reduce((obj, user) => {
            obj[user.id] = {
                score: user.score,
                prevScore: user.prevScore,
                isBlocked: user.isBlocked,
                isLockedDueToScore: user.isLockedDueToScore,
                tablesPlayed: playerTableCount[user.id] || 0
            };
            return obj;
        }, {}),
        // Guardar estado individual de cada jugador
        playerGameStates: playerGameState
    };
  
    try {
        fs.writeFileSync(GAME_STATE_FILE, JSON.stringify(stateToSave, null, 2));
        console.log('Estado del juego guardado correctamente');
    } catch (error) {
        console.error('Error al guardar el estado del juego:', error);
    }
}

// Función para cargar el estado del juego
function loadGameState() {
    try {
        if (fs.existsSync(GAME_STATE_FILE)) {
            const savedState = JSON.parse(fs.readFileSync(GAME_STATE_FILE, 'utf8'));
            
            // Restaurar el tablero
            if (savedState.board && savedState.board.length > 0) {
                gameState.board = savedState.board;
            }
            
            // Restaurar contador de mesas y fecha de último reinicio
            if (savedState.tableCount !== undefined) {
                gameState.tableCount = savedState.tableCount;
            }
            
            if (savedState.lastTableResetDate) {
                gameState.lastTableResetDate = savedState.lastTableResetDate;
            }
            
            // Cargar el número de mesa global si existe
            if (savedState.globalTableNumber !== undefined) {
                globalTableNumber = savedState.globalTableNumber;
            } else {
                globalTableNumber = 1; // Iniciar desde la mesa 1 si no hay datos guardados
            }
            
            // Restaurar las selecciones por fila
            if (savedState.rowSelections) {
                gameState.rowSelections = savedState.rowSelections;
            }
            
            // Restaurar selecciones de jugadores
            if (savedState.playerSelections) {
                gameState.playerSelections = savedState.playerSelections;
            }
            
            // Restaurar estados guardados de cada jugador
            if (savedState.playerGameStates) {
                Object.assign(playerGameState, savedState.playerGameStates);
            }
            
            // Restaurar las puntuaciones y contadores de los usuarios
            if (savedState.userScores) {
                for (const userId in savedState.userScores) {
                    const user = users.find(u => u.id === userId);
                    if (user) {
                        user.score = savedState.userScores[userId].score;
                        user.prevScore = savedState.userScores[userId].prevScore || user.score;
                        user.isBlocked = savedState.userScores[userId].isBlocked;
                        user.isLockedDueToScore = savedState.userScores[userId].isLockedDueToScore || false;
                        
                        // Restaurar contador de mesas por jugador
                        if (savedState.userScores[userId].tablesPlayed !== undefined) {
                            playerTableCount[userId] = savedState.userScores[userId].tablesPlayed;
                        }
                    }
                }
            }
            
            // Restaurar jugadores si existen en el estado guardado
            if (savedState.players) {
                gameState.players = savedState.players.map(player => ({
                    ...player,
                    isConnected: false // Inicialmente marcar todos como desconectados
                }));
            }
            
            console.log(`Estado del juego cargado correctamente. Mesa global actual: ${globalTableNumber}`);
            return true;
        }
    } catch (error) {
        console.error('Error al cargar el estado del juego:', error);
    }
    
    // Si no hay datos guardados, iniciar desde la mesa 1
    globalTableNumber = 1;
    return false;
}

// Intentar cargar el estado guardado
if (!loadGameState()) {
    console.log('No se encontró estado guardado, usando valores predeterminados');
}

// Generar el tablero con distribución aleatoria de fichas ganadoras y perdedoras en cada hilera
function generateBoard() {
    const tiles = [];
    
    // Para cada hilera (4 hileras en total, con 4 fichas cada una)
    for (let row = 0; row < 4; row++) {
        const rowTiles = [];
        
        // Crear 2 fichas ganadoras y 2 perdedoras para esta hilera
        for (let i = 0; i < 2; i++) {
            rowTiles.push({ value: 15000, revealed: false });  // Ganadora
        }
        for (let i = 0; i < 2; i++) {
            rowTiles.push({ value: -15000, revealed: false }); // Perdedora
        }
        
        // Mezclar las fichas dentro de esta hilera
        const shuffledRowTiles = shuffleArray(rowTiles);
        
        // Añadir las fichas mezcladas de esta hilera al tablero
        tiles.push(...shuffledRowTiles);
    }
    
    // Log para verificar la distribución
    let gainTiles = 0;
    let lossTiles = 0;
    const distribution = [0, 0, 0, 0]; // Contar fichas ganadoras por fila
    
    for (let i = 0; i < tiles.length; i++) {
        if (tiles[i].value > 0) {
            gainTiles++;
            distribution[Math.floor(i / 4)]++;
        } else {
            lossTiles++;
        }
    }
    
    console.log(`Distribución de tablero: ${gainTiles} ganadoras, ${lossTiles} perdedoras`);
    console.log(`Fichas ganadoras por fila: Fila 1: ${distribution[0]}, Fila 2: ${distribution[1]}, Fila 3: ${distribution[2]}, Fila 4: ${distribution[3]}`);
    
    return tiles;
}
  
// Función para mezclar un array (algoritmo Fisher-Yates)
function shuffleArray(array) {
    const newArray = [...array];
    for (let i = newArray.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
    }
    return newArray;
}
  
// Comprueba si todas las fichas han sido reveladas
function checkGameOver() {
    // Contar fichas reveladas
    const revealedCount = gameState.board.filter(tile => tile.revealed).length;
    
    // Si se revelaron 16 fichas (todas), considerar el juego terminado
    return revealedCount >= 16;
}
  
// Obtener usuario por ID
function getUserById(id) {
    return users.find(user => user.id === id);
}
  
// Actualizar la puntuación de un usuario
function updateUserScore(id, points) {
    const user = getUserById(id);
    if (user) {
        console.log(`Actualizando puntuación de ${user.username}: ${user.score} + ${points}`);
        // Guardar puntuación anterior
        user.prevScore = user.score;
        user.score += points;
        console.log(`Nueva puntuación: ${user.score}`);
        
        // Verificar si debe ser bloqueado (incluye caer desde 60,000 a 23,000)
        const shouldBlock = checkScoreLimit(user);
        if (shouldBlock && !user.isLockedDueToScore) {
            user.isLockedDueToScore = true;
            
            const playerSocketId = gameState.players.find(p => p.id === id)?.socketId;
            if (playerSocketId) {
                io.to(playerSocketId).emit('message', 'Has sido bloqueado por alcanzar o llegar a 23,000 puntos. Contacta al administrador para recargar.');
                io.to(playerSocketId).emit('scoreLimitReached', { 
                    message: 'Has alcanzado o llegado a 23,000 puntos y has sido bloqueado temporalmente.' 
                });
                io.to(playerSocketId).emit('blockStatusChanged', { 
                    isLockedDueToScore: true,
                    message: 'Has alcanzado o llegado a 23,000 puntos y has sido bloqueado temporalmente.' 
                });
            }
        }
        
        return user.score;
    }
    console.error(`Usuario con ID ${id} no encontrado para actualizar puntuación`);
    return null;
}
  
// Función para inicializar selecciones de un jugador
function initPlayerSelections(userId) {
    if (!gameState.playerSelections[userId]) {
        gameState.playerSelections[userId] = {
            rowSelections: [0, 0, 0, 0],
            totalSelected: 0
        };
    }
    return gameState.playerSelections[userId];
}

// Función para reiniciar solo el tablero
function resetBoardOnly() {
    console.log("Reiniciando el tablero y avanzando a la siguiente mesa");
    
    // Incrementar el número de mesa global
    globalTableNumber++;
    if (globalTableNumber > 10) {
        globalTableNumber = 1; // Volver a la mesa 1 después de la 10
    }
    
    // Crear nuevo tablero sin fichas reveladas
    gameState.board = generateBoard();
    
    // Reiniciar selecciones por hilera
    gameState.rowSelections = [0, 0, 0, 0];
    
    // Reiniciar selecciones de cada jugador
    for (const userId in gameState.playerSelections) {
        gameState.playerSelections[userId].rowSelections = [0, 0, 0, 0];
        gameState.playerSelections[userId].totalSelected = 0;
    }
    
    // Notificar a todos los clientes del cambio de mesa con tablero nuevo
    io.emit('boardReset', {
        message: "Todas las fichas fueron reveladas. ¡Avanzando a la mesa " + globalTableNumber + "!",
        newTableNumber: globalTableNumber,
        newBoard: gameState.board // Enviar el tablero nuevo completo
    });
    
    // Actualizar estado de contadores de mesa para cada jugador
    for (const player of gameState.players) {
        const playerId = player.id;
        
        if (!playerTableCount[playerId]) {
            playerTableCount[playerId] = 0;
        }
        
        playerTableCount[playerId]++;
        
        // Enviar actualización del contador de mesas
        const playerSocketId = player.socketId;
        if (playerSocketId && player.isConnected) {
            io.to(playerSocketId).emit('tablesUpdate', {
                tablesPlayed: playerTableCount[playerId],
                currentTable: globalTableNumber,
                maxReached: playerTableCount[playerId] >= MAX_TABLES_PER_DAY,
                lockReason: playerTableCount[playerId] >= MAX_TABLES_PER_DAY ? 
                    'Has alcanzado el límite diario de mesas.' : ''
            });
            
            // Si alcanzó el límite, notificar
            if (playerTableCount[playerId] >= MAX_TABLES_PER_DAY) {
                io.to(playerSocketId).emit('tableLimitReached', {
                    message: 'Has alcanzado el límite diario de mesas.'
                });
            }
        }
    }
    
    // Emitir nuevo estado del juego
    io.emit('gameState', {
        board: gameState.board,
        currentPlayer: gameState.currentPlayer,
        players: gameState.players.map(player => ({
            id: player.id,
            username: player.username,
            isBlocked: getUserById(player.id).isBlocked,
            isLockedDueToScore: getUserById(player.id).isLockedDueToScore,
            isConnected: player.isConnected
        })),
        status: 'playing',
        rowSelections: gameState.rowSelections
    });
    
    // Guardar estado actualizado
    saveGameState();
}

// Reiniciar el juego sin borrar el progreso
function resetGame() {
    // Crear un nuevo tablero
    const newBoard = generateBoard();
    
    // Inicializar tablero
    gameState.board = newBoard;
    gameState.status = 'playing';
    gameState.currentPlayerIndex = 0;
    gameState.turnStartTime = Date.now();
    gameState.rowSelections = [0, 0, 0, 0];
    
    // Reiniciar el número de mesa global
    globalTableNumber = 1;
    
    // Reiniciar el puntaje de todos los jugadores a 60,000
    users.forEach(user => {
        if (!user.isAdmin) {
            user.prevScore = 60000;
            user.score = 60000;
            user.isBlocked = false;
            user.isLockedDueToScore = false; // Desbloquear por puntaje también
        }
    });

    // Reiniciar contadores de mesas
    for (const userId in playerTableCount) {
        playerTableCount[userId] = 0;
    }

    if (gameState.players.length > 0) {
        gameState.currentPlayer = gameState.players[0];
    }

    clearTimeout(turnTimer);
    io.emit('gameState', {
        board: gameState.board.map(tile => ({
            ...tile,
            value: tile.revealed ? tile.value : null
        })),
        currentPlayer: gameState.currentPlayer,
        players: gameState.players.map(player => ({
            id: player.id,
            username: player.username,
            isBlocked: getUserById(player.id).isBlocked,
            isLockedDueToScore: getUserById(player.id).isLockedDueToScore,
            isConnected: player.isConnected
        })),
        status: 'playing',
        turnStartTime: gameState.turnStartTime,
        rowSelections: gameState.rowSelections
    });

    // Enviar puntajes actualizados a todos los jugadores
    gameState.players.forEach(player => {
        const user = getUserById(player.id);
        if (user && player.socketId) {
            io.to(player.socketId).emit('forceScoreUpdate', user.score);
            // Notificar el cambio de estado de bloqueo
            io.to(player.socketId).emit('blockStatusChanged', {
                isLockedDueToScore: false,
                isBlocked: false,
                message: 'El administrador ha reiniciado el juego. Tu puntaje ha sido restablecido a 60,000.'
            });
        }
    });

    // Notificar a todos los jugadores
    io.emit('message', 'El administrador ha reiniciado el juego. Todos los puntajes han sido restablecidos a 60,000.');

    if (gameState.players.length > 0) {
        startPlayerTurn();
    }
    
    // Guardar estado después del reset
    saveGameState();
}

// Función para sincronizar el estado del jugador
function syncPlayerState(userId, socketId) {
  const user = getUserById(userId);
  if (!user) return;
  
  // Enviar puntaje actualizado
  io.to(socketId).emit('forceScoreUpdate', user.score);
  
  // Enviar estado completo del juego
  io.to(socketId).emit('gameState', {
    board: gameState.board.map(tile => ({
      ...tile,
      value: tile.revealed ? tile.value : null
    })),
    currentPlayer: gameState.currentPlayer,
    players: gameState.players.map(player => ({
      id: player.id,
      username: player.username,
      isBlocked: getUserById(player.id).isBlocked,
      isLockedDueToScore: getUserById(player.id).isLockedDueToScore,
      isConnected: player.isConnected
    })),
    status: 'playing',
    rowSelections: gameState.playerSelections[userId]?.rowSelections || [0, 0, 0, 0]
  });
}
  
// Función para iniciar el turno de un jugador, modificada para saltar jugadores desconectados
function startPlayerTurn() {
    if (gameState.players.length === 0) return;

    console.log(`startPlayerTurn llamada con ${gameState.players.length} jugadores`);
    gameState.status = 'playing';
    gameState.rowSelections = [0, 0, 0, 0];

    // Filtrar jugadores conectados y no bloqueados
    let eligiblePlayers = gameState.players.filter(player => {
        const userData = getUserById(player.id);
        return player.isConnected && userData && !userData.isBlocked && !userData.isLockedDueToScore && !userData.isAdmin;
    });
    
    if (eligiblePlayers.length === 0) {
        console.log("No hay jugadores elegibles, esperando reconexión o desbloqueo...");
        return;
    }
    
    if (eligiblePlayers.length === 1) {
        // Encontrar el índice del jugador elegible en la lista principal
        const eligiblePlayerIndex = gameState.players.findIndex(p => p.id === eligiblePlayers[0].id);
        gameState.currentPlayerIndex = eligiblePlayerIndex;
        gameState.currentPlayer = gameState.players[eligiblePlayerIndex];
        
        clearTimeout(turnTimer);
        turnTimer = setTimeout(() => {
            console.log(`Tiempo agotado para ${gameState.currentPlayer.username}`);
            io.emit('turnTimeout', { playerId: gameState.currentPlayer.id });
            setTimeout(() => {
                startPlayerTurn();
            }, 500);
        }, 4000);
    } else {
        // Para múltiples jugadores, buscar el siguiente jugador elegible
        let nextPlayerFound = false;
        let loopCount = 0;
        let originalIndex = gameState.currentPlayerIndex;
        
        // Comenzar desde el siguiente jugador
        gameState.currentPlayerIndex = (gameState.currentPlayerIndex + 1) % gameState.players.length;
        
        while (!nextPlayerFound && loopCount < gameState.players.length) {
            const nextPlayer = gameState.players[gameState.currentPlayerIndex];
            const nextUserData = getUserById(nextPlayer.id);
            
            // Solo considerar jugadores conectados, no bloqueados y que no sean admin
            if (nextPlayer.isConnected && nextUserData && 
                !nextUserData.isBlocked && !nextUserData.isLockedDueToScore && !nextUserData.isAdmin) {
                nextPlayerFound = true;
            } else {
                gameState.currentPlayerIndex = (gameState.currentPlayerIndex + 1) % gameState.players.length;
                loopCount++;
            }
        }
        
        // Si no encontramos un jugador válido, mantener el índice original
        if (!nextPlayerFound) {
            console.log("No hay jugadores elegibles para el siguiente turno");
            gameState.currentPlayerIndex = originalIndex;
            // Intentar nuevamente en unos segundos
            setTimeout(() => {
                startPlayerTurn();
            }, 5000);
            return;
        }
        
        gameState.currentPlayer = gameState.players[gameState.currentPlayerIndex];
        console.log(`Turno de ${gameState.currentPlayer.username}, tiene 4 segundos`);
        
        clearTimeout(turnTimer);
        turnTimer = setTimeout(() => {
            console.log(`Tiempo agotado para ${gameState.currentPlayer.username}`);
            io.emit('turnTimeout', { playerId: gameState.currentPlayer.id });
            setTimeout(() => {
                startPlayerTurn();
            }, 500);
        }, 4000);
    }

    const playerSelections = initPlayerSelections(gameState.currentPlayer.id);
    gameState.rowSelections = [...playerSelections.rowSelections];
    gameState.status = 'playing';
    gameState.turnStartTime = Date.now();

    io.emit('gameState', {
        board: gameState.board.map(tile => ({
            ...tile,
            value: tile.revealed ? tile.value : null
        })),
        currentPlayer: gameState.currentPlayer,
        players: gameState.players.map(player => ({
            id: player.id,
            username: player.username,
            isBlocked: getUserById(player.id).isBlocked,
            isLockedDueToScore: getUserById(player.id).isLockedDueToScore,
            isConnected: player.isConnected
        })),
        status: 'playing',
        turnStartTime: gameState.turnStartTime,
        rowSelections: gameState.rowSelections
    });

    console.log(`Fin de startPlayerTurn: estado=${gameState.status}, jugador actual=${gameState.currentPlayer?.username}`);
}
  
// Configuración de Socket.io
io.on('connection', (socket) => {
    console.log(`Usuario conectado: ${socket.id}`);

    // Evento de prueba para verificar conexión
    socket.on('test', (data) => {
        console.log(`Prueba recibida del cliente ${socket.id}:`, data);
        // Enviar respuesta al cliente
        socket.emit('testResponse', { message: 'Prueba exitosa' });
    });

    // Reconexión de usuario
    socket.on('reconnectUser', ({ userId, username }) => {
        connectedSockets[socket.id] = userId;
        console.log(`Usuario ${username} reconectado con socket ${socket.id}`);
        
        // Actualizar el socket ID en la lista de jugadores
        const playerIndex = gameState.players.findIndex(player => player.id === userId);
        if (playerIndex !== -1) {
            gameState.players[playerIndex].socketId = socket.id;
            
            // Marcar al jugador como conectado
            const wasConnected = gameState.players[playerIndex].isConnected;
            gameState.players[playerIndex].isConnected = true;
            
            // Notificar a otros jugadores sobre la reconexión
            if (!wasConnected) {
                io.emit('playerConnectionChanged', {
                    playerId: userId,
                    isConnected: true,
                    username
                });
            }
            
            // Si no hay jugador actual o el jugador actual está desconectado, 
            // considerar iniciar un nuevo turno
            if (!gameState.currentPlayer || !gameState.currentPlayer.isConnected) {
                startPlayerTurn();
            }
        }
    });

    // Sincronización completa del estado del juego
    socket.on('syncGameState', ({ userId }) => {
        const user = getUserById(userId);
        if (!user) return;
        
        // Inicializar contadores si no existen
        if (playerTableCount[userId] === undefined) {
            playerTableCount[userId] = 0;
        }
        
        // Inicializar selecciones del jugador si no existen
        initPlayerSelections(userId);
        
        // Restaurar estado guardado del jugador si existe
        if (playerGameState[userId]) {
            console.log(`Restaurando estado guardado para ${user.username}`);
            
            // Enviar estado guardado del tablero
            socket.emit('gameState', {
                board: playerGameState[userId].board,
                currentPlayer: gameState.currentPlayer,
                players: gameState.players.map(player => ({
                    id: player.id,
                    username: player.username,
                    isBlocked: getUserById(player.id).isBlocked,
                    isLockedDueToScore: getUserById(player.id).isLockedDueToScore,
                    isConnected: player.isConnected
                })),
                status: 'playing',
                rowSelections: playerGameState[userId].rowSelections
            });
        } else {
            // Si no hay estado guardado, enviar el estado actual
            socket.emit('gameState', {
                board: gameState.board.map(tile => ({
                    ...tile,
                    value: tile.revealed ? tile.value : null
                })),
                currentPlayer: gameState.currentPlayer,
                players: gameState.players.map(player => ({
                    id: player.id,
                    username: player.username,
                    isBlocked: getUserById(player.id).isBlocked,
                    isLockedDueToScore: getUserById(player.id).isLockedDueToScore,
                    isConnected: player.isConnected
                })),
                status: 'playing',
                rowSelections: gameState.playerSelections[userId]?.rowSelections || [0, 0, 0, 0]
            });
        }
        
        // Enviar puntuación actualizada
        socket.emit('forceScoreUpdate', user.score);
        
        // Enviar información de la mesa actual
        socket.emit('tablesUpdate', {
            tablesPlayed: playerTableCount[userId] || 0,
            currentTable: globalTableNumber, // Enviar número de mesa global
            maxReached: (playerTableCount[userId] || 0) >= MAX_TABLES_PER_DAY,
            lockReason: (playerTableCount[userId] || 0) >= MAX_TABLES_PER_DAY ? 
                'Has alcanzado el límite diario de mesas.' : ''
        });

        // Verificar si el jugador está bloqueado por tener 23,000 puntos
        if (user.isLockedDueToScore) {
            socket.emit('scoreLimitReached', {
                message: 'Has alcanzado 23,000 puntos exactos y has sido bloqueado temporalmente.'
            });
        }

        // Enviar estado actual de bloqueo
        socket.emit('blockStatusChanged', {
            isBlocked: user.isBlocked,
            isLockedDueToScore: user.isLockedDueToScore,
            message: 'Sincronizando estado del juego'
        });
    });

    // Guardar estado del juego al cerrar sesión
    socket.on('saveGameState', ({ userId }) => {
        if (!userId) return;
        
        const user = getUserById(userId);
        if (!user) return;
        
        // Guardar estado específico del jugador
        playerGameState[userId] = {
            board: gameState.board.map(tile => ({
                ...tile,
                value: tile.revealed ? tile.value : null
            })),
            score: user.score,
            prevScore: user.prevScore,
            rowSelections: gameState.playerSelections[userId]?.rowSelections || [0, 0, 0, 0],
            tablesPlayed: playerTableCount[userId] || 0,
            timestamp: Date.now()
        };
        
        console.log(`Estado de juego guardado para ${user.username}`);
        
        // Guardar el estado completo
        saveGameState();
    });

    // Login
    socket.on('login', (credentials, callback) => {
        const user = users.find(
            u => u.username === credentials.username && u.password === credentials.password
        );

        if (!user) {
            callback({ success: false, message: 'Credenciales incorrectas' });
            return;
        }

        // Comprobar si hay una sesión activa para este usuario
        const existingSocketId = Object.entries(connectedSockets)
            .find(([_, userId]) => userId === user.id)?.[0];
        
        if (existingSocketId && existingSocketId !== socket.id) {
            // Desconectar la sesión anterior
            io.to(existingSocketId).emit('sessionClosed', 'Se ha iniciado sesión en otro dispositivo');
            // No rechazamos la nueva conexión, sino que reemplazamos la anterior
        }

        // Registrar usuario en el socket
        connectedSockets[socket.id] = user.id;
        console.log(`Usuario ${user.username} autenticado con socket ${socket.id}`);
        
        // Inicializar las selecciones del jugador si es necesario
        initPlayerSelections(user.id);

        // Responder al cliente
        callback({
            success: true,
            userId: user.id,
            username: user.username,
            score: user.score,
            isAdmin: user.isAdmin,
            isBlocked: user.isBlocked,
            isLockedDueToScore: user.isLockedDueToScore
        });
    });

    // Unirse al juego
    socket.on('joinGame', () => {
        const userId = connectedSockets[socket.id];
        if (!userId) return;

        const user = getUserById(userId);
        if (!user) return;

        // Inicializar selecciones del jugador si no existen
        initPlayerSelections(userId);

        // Verificar si el jugador ya está en el juego
        const existingPlayerIndex = gameState.players.findIndex(player => player.id === userId);
        
        if (existingPlayerIndex === -1) {
            // El jugador no está en el juego, añadirlo
            gameState.players.push({
                id: userId,
                username: user.username,
                socketId: socket.id,
                isConnected: true // Añadir esta propiedad
            });

            console.log(`Usuario ${user.username} añadido al juego`);

            // IMPORTANTE: Forzar el estado a playing explícitamente
            gameState.status = 'playing';

            // Si no hay jugador actual, establecer este jugador como el actual
            // (solo si no es admin y no está bloqueado)
            if (!gameState.currentPlayer && !user.isAdmin && !user.isBlocked && !user.isLockedDueToScore) {
                gameState.currentPlayer = gameState.players[gameState.players.length - 1];
                gameState.currentPlayerIndex = gameState.players.length - 1;
            }

            // Iniciar turno (saltará a los jugadores no elegibles)
            startPlayerTurn();

            // Validar explícitamente que el estado sea 'playing' después de startPlayerTurn
            console.log(`Estado del juego después de startPlayerTurn: ${gameState.status}`);
            if (gameState.status !== 'playing') {
                gameState.status = 'playing';
            }

            // IMPORTANTE: Agregar log para depuración
            console.log(`Emitiendo estado: ${gameState.status}, jugador actual: ${gameState.currentPlayer?.username}`);

            // Emitir estado actualizado inmediatamente
            io.emit('gameState', {
                board: gameState.board.map(tile => ({
                    ...tile,
                    value: tile.revealed ? tile.value : null
                })),
                currentPlayer: gameState.currentPlayer,
                players: gameState.players.map(player => ({
                    id: player.id,
                    username: player.username,
                    isBlocked: getUserById(player.id).isBlocked,
                    isLockedDueToScore: getUserById(player.id).isLockedDueToScore,
                    isConnected: player.isConnected
                })),
                status: 'playing',  // Forzar estado 'playing' explícitamente aquí también
                rowSelections: gameState.rowSelections
            });

            // Anunciar a todos los demás clientes
            socket.broadcast.emit('gameState', {
                board: gameState.board.map(tile => ({
                    ...tile,
                    value: tile.revealed ? tile.value : null
                })),
                currentPlayer: gameState.currentPlayer,
                players: gameState.players.map(player => ({
                    id: player.id,
                    username: player.username,
                    isBlocked: getUserById(player.id).isBlocked,
                    isLockedDueToScore: getUserById(player.id).isLockedDueToScore,
                    isConnected: player.isConnected
                })),
                status: 'playing',
                rowSelections: gameState.rowSelections
            });
            
            // Guardar estado
            saveGameState();
        } else {
            // El jugador ya está en el juego, actualizar su estado de conexión
            gameState.players[existingPlayerIndex].socketId = socket.id;
            
            // Marcar al jugador como conectado
            const wasConnected = gameState.players[existingPlayerIndex].isConnected;
            gameState.players[existingPlayerIndex].isConnected = true;
            
            // Notificar a otros jugadores sobre la reconexión
            if (!wasConnected) {
                io.emit('playerConnectionChanged', {
                    playerId: userId,
                    isConnected: true,
                    username: user.username
                });
                console.log(`Usuario ${user.username} reconectado al juego`);

                // Si no hay jugador actual o el jugador actual está desconectado,
                // reiniciar los turnos
                if (!gameState.currentPlayer || !gameState.currentPlayer.isConnected) {
                    startPlayerTurn();
                }
            }

            // Asegurarse de que el juego esté en estado 'playing' y haya un jugador actual
            if (gameState.status !== 'playing') {
                gameState.status = 'playing';
                startPlayerTurn(); // Reiniciar el turno si el juego estaba en espera
            }

            if (!gameState.currentPlayer && gameState.players.length > 0) {
                startPlayerTurn(); // Asegurar que haya un turno activo
            }

            // Enviar estado actual al jugador reconectado
            socket.emit('gameState', {
                board: gameState.board.map(tile => ({
                    ...tile,
                    value: tile.revealed ? tile.value : null
                })),
                currentPlayer: gameState.currentPlayer,
                players: gameState.players.map(player => ({
                    id: player.id,
                    username: player.username,
                    isBlocked: getUserById(player.id).isBlocked,
                    isLockedDueToScore: getUserById(player.id).isLockedDueToScore,
                    isConnected: player.isConnected
                })),
                status: 'playing',  // Forzar estado 'playing' explícitamente aquí también
                rowSelections: gameState.playerSelections[userId]?.rowSelections || [0, 0, 0, 0]
            });
        }
    });

    // Seleccionar una ficha
    socket.on('selectTile', ({ tileIndex, currentScore }) => {
        console.log(`Recibido evento selectTile para ficha ${tileIndex} de socket ${socket.id}`);
        
        socket.emit('tileSelectResponse', { received: true, tileIndex });
        
        const userId = connectedSockets[socket.id];
        if (!userId) {
            console.log('Usuario no autenticado, evento ignorado');
            return;
        }
        
        const user = getUserById(userId);
        if (!user) {
            console.log('Usuario no encontrado, evento ignorado');
            return;
        }
        
        // No permitir que los administradores jueguen
        if (user.isAdmin) {
            console.log(`El administrador ${user.username} intentó jugar, solo puede observar`);
            socket.emit('message', 'Los administradores solo pueden observar el juego');
            return;
        }
        
        // Permitir que usuarios bloqueados vean el tablero pero no seleccionen fichas
        if (user.isBlocked) {
            console.log(`Usuario ${user.username} bloqueado, no puede seleccionar fichas`);
            socket.emit('message', 'Tu cuenta está bloqueada. Puedes ver el juego pero no seleccionar fichas.');
            return;
        }
        
        // Verificar si el usuario está bloqueado por puntaje
        if (user.isLockedDueToScore) {
            console.log(`Usuario ${user.username} bloqueado por puntaje, no puede seleccionar fichas`);
            socket.emit('scoreLimitReached', { 
                message: 'Has alcanzado 23,000 puntos exactos. Contacta al administrador para recargar.'
            });
            return;
        }
        
        // Verificar límite de mesas
        if (checkTableLimit(userId)) {
            console.log(`Usuario ${user.username} ha alcanzado el límite diario de mesas`);
            socket.emit('tableLimitReached', {
                message: 'Has alcanzado el límite diario de mesas.'
            });
            return;
        }
        
        // Permitir seleccionar si es el único jugador o si es su turno
        if (gameState.players.length > 1 && gameState.currentPlayer && gameState.currentPlayer.id !== userId) {
            console.log(`No es el turno de ${user.username}, es el turno de ${gameState.currentPlayer?.username}`);
            return;
        }
        
        // Verificar si el tiempo se agotó
        const tiempoTranscurrido = Date.now() - gameState.turnStartTime;
        if (tiempoTranscurrido > 4000) {
            console.log(`Tiempo agotado para ${user.username}, han pasado ${tiempoTranscurrido}ms`);
            socket.emit('message', 'Tiempo agotado para este turno');
            return;
        }
        
        if (tileIndex < 0 || tileIndex >= gameState.board.length) {
            console.log(`Índice de ficha ${tileIndex} fuera de rango`);
            return;
        }
        
        // VERIFICACIÓN CRÍTICA: Asegurarse de que no se pueda seleccionar la misma ficha dos veces
        if (gameState.board[tileIndex].revealed) {
            console.log(`IGNORANDO selección repetida para ficha ${tileIndex}`);
            return;
        }
        
        // Asegurarse de que los valores de punto son precisamente los esperados
        if (gameState.board[tileIndex].value !== 15000 && gameState.board[tileIndex].value !== -15000) {
            console.error(`VALOR DE FICHA INCORRECTO: ${gameState.board[tileIndex].value}`);
            // Corregir el valor
            gameState.board[tileIndex].value = Math.sign(gameState.board[tileIndex].value) * 15000;
        }
        
        // Obtener o inicializar selecciones del jugador
        const playerSelections = initPlayerSelections(userId);
        
        // Determinar a qué hilera pertenece esta ficha (4 fichas por hilera en un tablero 4x4)
        const row = Math.floor(tileIndex / 4);
        
        // Verificar si ya se seleccionaron 2 fichas de esta hilera
        if (playerSelections.rowSelections[row] >= 2) {
            console.log(`Jugador ${user.username} ya seleccionó 2 fichas de la hilera ${row + 1}`);
            socket.emit('message', `Ya has seleccionado 2 fichas de la hilera ${row + 1}`);
            return;
        }
        
        console.log(`Jugador ${user.username} seleccionó ficha ${tileIndex} de la hilera ${row + 1}`);
        
        // Incrementar contador para esta hilera específica del jugador
        playerSelections.rowSelections[row]++;
        playerSelections.totalSelected++;
        
        // Actualizar contador global con las selecciones de este jugador
        gameState.rowSelections = [...playerSelections.rowSelections];
        
        console.log(`Fichas seleccionadas en hilera ${row + 1}: ${playerSelections.rowSelections[row]}/2`);
        
        // Revelar la ficha
        gameState.board[tileIndex].revealed = true;
        gameState.board[tileIndex].selectedBy = user.username;
        
        // Acceder al valor real de la ficha en el tablero del servidor
        const tileValue = gameState.board[tileIndex].value;
        
        // Verificar si hay una discrepancia grande entre el puntaje del cliente y del servidor
        if (currentScore !== undefined && Math.abs(currentScore - user.score) > 15000) {
            console.warn(`ADVERTENCIA: Posible inconsistencia en puntaje del cliente ${currentScore} vs servidor ${user.score}`);
        }
        
        // Actualizar puntuación con el valor correcto
        const oldScore = user.score;
        user.prevScore = user.score; // Guardar la puntuación anterior
        user.score += tileValue; // Sumar exactamente el valor de la ficha
        const newScore = user.score;
        
        console.log(`PUNTUACIÓN ACTUALIZADA: ${user.username} ${oldScore} -> ${newScore} (${tileValue})`);
        
        // Añadir información de tipo de sonido correcta
        const soundType = tileValue > 0 ? 'win' : 'lose';
        
        // Emitir eventos con el valor correcto
        io.emit('tileSelected', {
            tileIndex,
            tileValue, // Este valor debe ser correcto desde el servidor
            playerId: userId,
            playerUsername: user.username,
            newScore: newScore,
            rowSelections: playerSelections.rowSelections,
            soundType: soundType,
            timestamp: Date.now()
        });
        
        socket.emit('forceScoreUpdate', newScore);
        
        // Verificar si debe ser bloqueado (ahora incluye caer desde 60,000 a 23,000)
        if (checkScoreLimit(user)) {
            socket.emit('scoreLimitReached', {
                message: 'Has alcanzado o caído a 23,000 puntos y has sido bloqueado temporalmente.'
            });
            socket.emit('blockStatusChanged', {
                isLockedDueToScore: true,
                message: 'Has alcanzado o caído a 23,000 puntos y has sido bloqueado temporalmente.'
            });
            
            // Si era el jugador actual, pasar al siguiente
            if (gameState.currentPlayer && gameState.currentPlayer.id === userId) {
                setTimeout(() => {
                    startPlayerTurn();
                }, 1000);
            }
        }
        
        // Guardar estado después de cada selección
        saveGameState();
        
        // Verificar si el jugador completó todas sus selecciones permitidas
        const allRowsFull = playerSelections.rowSelections.every(count => count >= 2);
        
        // Si es el único jugador y ha seleccionado sus 8 fichas, avanzar al siguiente tablero
        if (gameState.players.length === 1 && allRowsFull) {
            console.log(`Único jugador ${user.username} completó sus 8 fichas, avanzando al siguiente tablero`);
            
            // Incrementar contador de mesas
            incrementTableCount(userId);
            
            // Reiniciar tablero y avanzar a la siguiente mesa
            resetBoardOnly();
            
            return; // Terminar aquí para evitar la lógica de verificar si todas las fichas están reveladas
        }
        
        // Para múltiples jugadores, verificar si se revelaron todas las fichas
        if (gameState.players.length > 1 && checkGameOver()) {
            console.log("Todas las fichas han sido reveladas. Reiniciando tablero pero manteniendo puntuaciones");
            
            // Incrementar contador de mesas para todos los jugadores activos
            gameState.players.forEach(player => {
                if (player.isConnected && 
                    !getUserById(player.id)?.isBlocked && 
                    !getUserById(player.id)?.isLockedDueToScore && 
                    !getUserById(player.id)?.isAdmin) {
                    incrementTableCount(player.id);
                }
            });
            
            // Reiniciar solo el tablero
            resetBoardOnly();
            
            return;
        }
        
        // Si el jugador ya seleccionó sus 8 fichas, pasar al siguiente
        if (allRowsFull) {
            console.log(`${user.username} ha seleccionado todas sus fichas permitidas, pasando al siguiente jugador`);
            socket.emit('message', 'Has seleccionado todas tus fichas permitidas, pasando al siguiente jugador');
            
            // Pasar al siguiente jugador
            clearTimeout(turnTimer);
            setTimeout(() => {
                startPlayerTurn();
            }, 500);
        }
    });

    // Agregar este nuevo manejador para sincronización forzada
    socket.on('syncScore', ({ userId }) => {
        console.log(`Solicitada sincronización de puntaje para: ${userId}`);
        const user = getUserById(userId);
        if (user) {
            console.log(`Enviando puntaje actualizado: ${user.score}`);
            socket.emit('directScoreUpdate', user.score);
            
            // Sincronizar estado completo del juego
            syncPlayerState(userId, socket.id);
        }
    });

    // Evento para recargar puntos (solo para administradores)
    socket.on('rechargePoints', ({ userId }, callback) => {
        const adminId = connectedSockets[socket.id];
        if (!adminId) {
            callback({ success: false, message: 'No autorizado' });
            return;
        }

        const admin = getUserById(adminId);
        if (!admin || !admin.isAdmin) {
            callback({ success: false, message: 'No autorizado' });
            return;
        }

        const targetUser = getUserById(userId);
        if (!targetUser) {
            callback({ success: false, message: 'Usuario no encontrado' });
            return;
        }

        // Incrementar puntuación en 6,000
        targetUser.score += 6000;
        targetUser.prevScore = targetUser.score;
        
        // Desbloquear al usuario
        targetUser.isBlocked = false;
        
        // Notificar al usuario si está conectado
        const playerSocketId = gameState.players.find(p => p.id === userId)?.socketId;
        if (playerSocketId) {
            io.to(playerSocketId).emit('forceScoreUpdate', targetUser.score);
            io.to(playerSocketId).emit('message', 'Un administrador ha recargado 6,000 puntos a tu cuenta');
            io.to(playerSocketId).emit('blockStatusChanged', {
                isBlocked: false,
                message: 'Un administrador ha recargado puntos a tu cuenta.'
            });
        }
        
        // Guardar estado
        saveGameState();

        callback({ success: true });
    });

    // Evento para reiniciar los contadores de mesas (solo para admin)
    socket.on('adminResetTables', (callback) => {
        const adminId = connectedSockets[socket.id];
        if (!adminId) {
            callback({ success: false, message: 'No autorizado' });
            return;
        }

        const admin = getUserById(adminId);
        if (!admin || !admin.isAdmin) {
            callback({ success: false, message: 'No autorizado' });
            return;
        }

        adminResetTableCounters();
        callback({ success: true, message: 'Contadores de mesas reiniciados correctamente' });
    });

    // Obtener lista de jugadores (solo para admins)
    socket.on('getPlayers', (callback) => {
        const userId = connectedSockets[socket.id];
        if (!userId) {
            callback({ success: false, message: 'No autorizado' });
            return;
        }

        const user = getUserById(userId);
        if (!user || !user.isAdmin) {
            callback({ success: false, message: 'No autorizado' });
            return;
        }

        callback({
            success: true,
            players: users.filter(u => !u.isAdmin).map(u => ({
                id: u.id,
                username: u.username,
                score: u.score,
                isBlocked: u.isBlocked,
                isLockedDueToScore: u.isLockedDueToScore
            }))
        });
    });

    // Actualizar puntos (solo para admins)
    socket.on('updatePoints', ({ userId, points }, callback) => {
        const adminId = connectedSockets[socket.id];
        if (!adminId) {
            callback({ success: false, message: 'No autorizado' });
            return;
        }

        const admin = getUserById(adminId);
        if (!admin || !admin.isAdmin) {
            callback({ success: false, message: 'No autorizado' });
            return;
        }

        const targetUser = getUserById(userId);
        if (!targetUser) {
            callback({ success: false, message: 'Usuario no encontrado' });
            return;
        }

        // Actualizar puntuación
        const newScore = updateUserScore(userId, points);

        // Notificar al usuario, si está conectado
        const playerSocketId = gameState.players.find(p => p.id === userId)?.socketId;
        if (playerSocketId) {
            io.to(playerSocketId).emit('scoreUpdate', newScore);
        }

        // Actualizar lista de jugadores para todos los admins
        io.emit('playersUpdate', users.filter(u => !u.isAdmin).map(u => ({
            id: u.id,
            username: u.username,
            score: u.score,
            isBlocked: u.isBlocked,
            isLockedDueToScore: u.isLockedDueToScore
        })));
        
        // Guardar estado después de actualizar puntos
        saveGameState();

        callback({ success: true });
    });

    // Bloquear/desbloquear usuario (solo para admins)
    socket.on('toggleBlockUser', ({ userId }, callback) => {
        const adminId = connectedSockets[socket.id];
        if (!adminId) {
            callback({ success: false, message: 'No autorizado' });
            return;
        }

        const admin = getUserById(adminId);
        if (!admin || !admin.isAdmin) {
            callback({ success: false, message: 'No autorizado' });
            return;
        }

        const targetUser = getUserById(userId);
        if (!targetUser) {
            callback({ success: false, message: 'Usuario no encontrado' });
            return;
        }

        // Cambiar estado de bloqueo
        targetUser.isBlocked = !targetUser.isBlocked;

        // Notificar al usuario, si está conectado
        const playerSocketId = gameState.players.find(p => p.id === userId)?.socketId;
        if (playerSocketId) {
            if (targetUser.isBlocked) {
                io.to(playerSocketId).emit('blockStatusChanged', { 
                    isBlocked: true,
                    message: 'Tu cuenta ha sido bloqueada por el administrador. Puedes seguir viendo el juego pero no jugar.' 
                });
                io.to(playerSocketId).emit('message', 'Tu cuenta ha sido bloqueada por el administrador. Puedes seguir viendo el juego pero no jugar.');
            } else {
                io.to(playerSocketId).emit('blockStatusChanged', { 
                    isBlocked: false,
                    message: 'Tu cuenta ha sido desbloqueada por el administrador.' 
                });
                io.to(playerSocketId).emit('message', 'Tu cuenta ha sido desbloqueada por el administrador.');
            }
        }

        // Si el jugador bloqueado era el jugador actual, pasar al siguiente
        if (targetUser.isBlocked && gameState.currentPlayer && gameState.currentPlayer.id === userId) {
            clearTimeout(turnTimer);
            setTimeout(() => {
                startPlayerTurn();
            }, 500);
        }

        // Actualizar lista de jugadores para todos los admins
        io.emit('playersUpdate', users.filter(u => !u.isAdmin).map(u => ({
            id: u.id,
            username: u.username,
            score: u.score,
            isBlocked: u.isBlocked,
            isLockedDueToScore: u.isLockedDueToScore
        })));

        // Actualizar el estado del juego para todos
        io.emit('gameState', {
            board: gameState.board.map(tile => ({
                ...tile,
                value: tile.revealed ? tile.value : null
            })),
            currentPlayer: gameState.currentPlayer,
            players: gameState.players.map(player => ({
                id: player.id,
                username: player.username,
                isBlocked: getUserById(player.id).isBlocked,
                isLockedDueToScore: getUserById(player.id).isLockedDueToScore,
                isConnected: player.isConnected
            })),
            status: 'playing',
            turnStartTime: gameState.turnStartTime,
            rowSelections: gameState.rowSelections
        });
        
        // Guardar estado después de cambiar bloqueo
        saveGameState();

        callback({ success: true });
    });

    // Evento para desbloquear usuario por puntaje (solo para admins)
    socket.on('unlockUserScore', ({ userId }, callback) => {
        const adminId = connectedSockets[socket.id];
        if (!adminId) {
            callback({ success: false, message: 'No autorizado' });
            return;
        }

        const admin = getUserById(adminId);
        if (!admin || !admin.isAdmin) {
            callback({ success: false, message: 'No autorizado' });
            return;
        }

        const targetUser = getUserById(userId);
        if (!targetUser) {
            callback({ success: false, message: 'Usuario no encontrado' });
            return;
        }

        // Desbloquear al usuario
        targetUser.isLockedDueToScore = false;
        
        // Notificar al usuario en tiempo real
        const playerSocketId = gameState.players.find(p => p.id === userId)?.socketId;
        if (playerSocketId) {
            io.to(playerSocketId).emit('blockStatusChanged', { 
                isLockedDueToScore: false,
                message: 'Un administrador ha desbloqueado tu cuenta por puntaje.' 
            });
            io.to(playerSocketId).emit('userUnlocked', { 
                message: 'Un administrador ha desbloqueado tu cuenta por puntaje.'
            });
        }
        
        // Guardar estado
        saveGameState();

        callback({ success: true });
    });

    // Reiniciar juego (solo para admins)
    socket.on('resetGame', (callback) => {
        const adminId = connectedSockets[socket.id];
        if (!adminId) {
            callback({ success: false, message: 'No autorizado' });
            return;
        }

        const admin = getUserById(adminId);
        if (!admin || !admin.isAdmin) {
            callback({ success: false, message: 'No autorizado' });
            return;
        }

        resetGame();
        callback({ success: true });
    });

    // Actualización directa de puntos (para admin) - NUEVO
    socket.on('directSetPoints', ({ userId, newPoints }, callback) => {
        const adminId = connectedSockets[socket.id];
        if (!adminId) {
            callback({ success: false, message: 'No autorizado' });
            return;
        }

        const admin = getUserById(adminId);
        if (!admin || !admin.isAdmin) {
            callback({ success: false, message: 'No autorizado' });
            return;
        }

        const targetUser = getUserById(userId);
        if (!targetUser) {
            callback({ success: false, message: 'Usuario no encontrado' });
            return;
        }

        // Establecer puntuación directamente
        targetUser.prevScore = targetUser.score;
        targetUser.score = parseInt(newPoints, 10);
        
        // Verificar si debe ser bloqueado
        checkScoreLimit(targetUser);
        
        // Guardar estado después de actualizar puntos
        saveGameState();

        // Notificar al usuario, si está conectado
        const playerSocketId = gameState.players.find(p => p.id === userId)?.socketId;
        if (playerSocketId) {
            io.to(playerSocketId).emit('forceScoreUpdate', targetUser.score);
            
            // Notificar si quedó bloqueado por puntaje
            if (targetUser.isLockedDueToScore) {
                io.to(playerSocketId).emit('blockStatusChanged', {
                    isLockedDueToScore: true,
                    message: 'Has alcanzado 23,000 puntos exactos y has sido bloqueado temporalmente.'
                });
            }
        }

        // Actualizar lista de jugadores para todos los admins
        io.emit('playersUpdate', users.filter(u => !u.isAdmin).map(u => ({
            id: u.id,
            username: u.username,
            score: u.score,
            isBlocked: u.isBlocked,
            isLockedDueToScore: u.isLockedDueToScore
        })));

        callback({ success: true });
    });

    // Evento para desbloquear mesas (solo para admins)
    socket.on('unlockTables', ({ userId }, callback) => {
        const adminId = connectedSockets[socket.id];
        if (!adminId) {
            callback({ success: false, message: 'No autorizado' });
            return;
        }

        const admin = getUserById(adminId);
        if (!admin || !admin.isAdmin) {
            callback({ success: false, message: 'No autorizado' });
            return;
        }

        const targetUser = getUserById(userId);
        if (!targetUser) {
            callback({ success: false, message: 'Usuario no encontrado' });
            return;
        }

        // Reiniciar contador de mesas para este usuario
        playerTableCount[userId] = 0;
        
        // Notificar al usuario
        const playerSocketId = gameState.players.find(p => p.id === userId)?.socketId;
        if (playerSocketId) {
            io.to(playerSocketId).emit('tablesUnlocked');
            io.to(playerSocketId).emit('tablesUpdate', {
                tablesPlayed: 0,
                currentTable: globalTableNumber,
                maxReached: false,
                lockReason: ''
            });
        }
        
        // Guardar estado
        saveGameState();

        callback({ success: true });
    });

    // Salir del juego
    socket.on('leaveGame', () => {
        const userId = connectedSockets[socket.id];
        if (!userId) return;

        // Marcar al jugador como desconectado
        const playerIndex = gameState.players.findIndex(player => player.id === userId);
        if (playerIndex !== -1) {
            const player = gameState.players[playerIndex];
            player.isConnected = false;
            
            // Notificar a todos los clientes sobre la desconexión
            io.emit('playerConnectionChanged', {
                playerId: userId,
                isConnected: false,
                username: player.username
            });
            
            console.log(`Jugador ${player.username} marcado como desconectado al abandonar el juego`);

            // Si era el turno de este jugador, pasar al siguiente inmediatamente
            if (gameState.currentPlayer && gameState.currentPlayer.id === userId) {
                clearTimeout(turnTimer);
                
                // Pasar al siguiente jugador después de un momento
                setTimeout(() => {
                    startPlayerTurn();
                }, 1000);
            }

            // Actualizar estado para todos
            io.emit('gameState', {
                board: gameState.board.map(tile => ({
                    ...tile,
                    value: tile.revealed ? tile.value : null
                })),
                currentPlayer: gameState.currentPlayer,
                players: gameState.players.map(player => ({
                    id: player.id,
                    username: player.username,
                    isBlocked: getUserById(player.id).isBlocked,
                    isLockedDueToScore: getUserById(player.id).isLockedDueToScore,
                    isConnected: player.isConnected
                })),
                status: 'playing', // Mantener el estado como 'playing' siempre
                turnStartTime: gameState.turnStartTime,
                rowSelections: gameState.rowSelections
            });
            
            // Guardar estado después de salir del juego
            saveGameState();
        }
    });

    // Desconexión
    socket.on('disconnect', () => {
        console.log(`Usuario desconectado: ${socket.id}`);

        const userId = connectedSockets[socket.id];
        if (userId) {
            delete connectedSockets[socket.id];

            // Marcar al jugador como desconectado pero mantenerlo en la lista
            const playerIndex = gameState.players.findIndex(player => player.id === userId);
            if (playerIndex !== -1) {
                gameState.players[playerIndex].isConnected = false;
                console.log(`Jugador ${gameState.players[playerIndex].username} marcado como desconectado`);
                
                // Si era el turno de este jugador, pasar al siguiente inmediatamente
                if (gameState.currentPlayer && gameState.currentPlayer.id === userId) {
                    clearTimeout(turnTimer);
                    console.log(`Saltando el turno del jugador desconectado ${gameState.players[playerIndex].username}`);
                    setTimeout(() => {
                        startPlayerTurn();
                    }, 1000);
                }
                
                // Notificar a todos los clientes sobre la desconexión
                io.emit('playerConnectionChanged', {
                    playerId: userId,
                    isConnected: false,
                    username: gameState.players[playerIndex].username
                });
            }
        }
    });

    socket.on('completeBoard', ({ userId }) => {
        const user = getUserById(userId);
        if (!user) return;
        
        console.log(`Usuario ${user.username} completó su tablero, avanzando al siguiente`);
        
        // Incrementar contador de mesas
        incrementTableCount(userId);
        
        // Reiniciar tablero y avanzar a la siguiente mesa
        resetBoardOnly();
      });
});

// Configurar guardado periódico cada 5 minutos
setInterval(saveGameState, 5 * 60 * 1000);

// Endpoint para verificar la configuración de CORS (para depuración)
app.get('/cors-config', (req, res) => {
 res.json({
   corsOrigins: Array.isArray(corsOptions.origin) ? corsOptions.origin : [corsOptions.origin],
   environment: process.env.NODE_ENV,
   clientUrl: process.env.CLIENT_URL
 });
});

// Logs de inicio
console.log('Entorno:', process.env.NODE_ENV);
console.log('URL del cliente:', process.env.CLIENT_URL);

// Iniciar servidor
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
   console.log(`Servidor ejecutándose en el puerto ${PORT}`);
});

// Ruta básica para comprobar que el servidor está funcionando
app.get('/', (req, res) => {
   res.send('Servidor del juego de memoria funcionando');
});