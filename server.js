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
const UNLOCK_HOUR = 6; // 6 AM
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
    { id: '1', username: 'jugador1', password: 'clave1', score: 60000, isAdmin: false, isBlocked: false },
    { id: '2', username: 'jugador2', password: 'clave2', score: 60000, isAdmin: false, isBlocked: false },
    { id: '3', username: 'jugador3', password: 'clave3', score: 60000, isAdmin: false, isBlocked: false },
    { id: '4', username: 'jugador4', password: 'clave4', score: 60000, isAdmin: false, isBlocked: false },
    { id: '5', username: 'jugador5', password: 'clave5', score: 60000, isAdmin: false, isBlocked: false },
    { id: '6', username: 'jugador6', password: 'clave6', score: 60000, isAdmin: false, isBlocked: false },
    { id: '7', username: 'jugador7', password: 'clave7', score: 60000, isAdmin: false, isBlocked: false },
    { id: '8', username: 'jugador8', password: 'clave8', score: 60000, isAdmin: false, isBlocked: false },
    { id: '9', username: 'jugador9', password: 'clave9', score: 60000, isAdmin: false, isBlocked: false },
    { id: '10', username: 'jugador10', password: 'clave10', score: 60000, isAdmin: false, isBlocked: false },
    { id: 'admin', username: 'admin', password: 'admin123', score: 60000, isAdmin: true, isBlocked: false }
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

// Nueva función para verificar y reiniciar el contador de mesas
function checkAndResetTableCounters() {
    const now = new Date();
    const currentDate = now.toDateString();
    
    if (gameState.lastTableResetDate !== currentDate && now.getHours() >= UNLOCK_HOUR) {
        // Reiniciar contadores diarios
        Object.keys(playerTableCount).forEach(userId => {
            playerTableCount[userId] = 0;
        });
        gameState.lastTableResetDate = currentDate;
        gameState.tableCount = 0;
        
        // Notificar a todos los clientes
        io.emit('tablesUnlocked', { message: 'Mesas desbloqueadas para un nuevo día' });
        
        console.log('Contadores de mesas reiniciados para un nuevo día');
    }
}

// Configurar comprobación periódica cada minuto
setInterval(checkAndResetTableCounters, 60 * 1000);

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
                isBlocked: user.isBlocked,
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
                        user.isBlocked = savedState.userScores[userId].isBlocked;
                        
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
        user.score += points;
        console.log(`Nueva puntuación: ${user.score}`);
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
                    message: 'Has alcanzado el límite diario de mesas.',
                    unlockTime: `${UNLOCK_HOUR}:00 AM`
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
    // Crear un nuevo tablero pero mantener el estado de las fichas reveladas
    const newBoard = generateBoard();
    
    // Actualizar solo las fichas no reveladas
    for (let i = 0; i < gameState.board.length; i++) {
        if (gameState.board[i].revealed) {
            newBoard[i].revealed = true;
        }
    }
    
    gameState.board = newBoard;
    gameState.status = 'playing';
    gameState.currentPlayerIndex = 0;
    gameState.turnStartTime = Date.now();
    gameState.rowSelections = [0, 0, 0, 0];

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
            isConnected: player.isConnected
        })),
        status: 'playing',
        turnStartTime: gameState.turnStartTime,
        rowSelections: gameState.rowSelections
    });

    if (gameState.players.length > 0) {
        startPlayerTurn();
    }
    
    // Guardar estado después del reset
    saveGameState();
}
  
// Función para iniciar el turno de un jugador
function startPlayerTurn() {
    if (gameState.players.length === 0) return;

    // IMPORTANTE: Agregar este log para depuración
    console.log(`startPlayerTurn llamada con ${gameState.players.length} jugadores`);

    // Siempre forzar el estado a 'playing'
    gameState.status = 'playing';
    
    // Reiniciar contador global de hileras
    gameState.rowSelections = [0, 0, 0, 0];

    // Si solo hay un jugador, ese jugador siempre es el actual
    if (gameState.players.length === 1) {
        gameState.currentPlayerIndex = 0;
        gameState.currentPlayer = gameState.players[0];

        // Solo establecer temporizador si está conectado
        if (gameState.currentPlayer.isConnected) {
            clearTimeout(turnTimer);
            turnTimer = setTimeout(() => {
                console.log(`Tiempo agotado para ${gameState.currentPlayer.username}`);
                io.emit('turnTimeout', { playerId: gameState.currentPlayer.id });
                setTimeout(() => {
                    startPlayerTurn();
                }, 500);
            }, 4000);
        } else {
            // Si el único jugador está desconectado, reiniciar su turno brevemente
            setTimeout(() => {
                startPlayerTurn();
            }, 1000);
        }
    } else {
        // Lógica para múltiples jugadores, necesitamos encontrar el siguiente jugador conectado
        let nextPlayerFound = false;
        let loopCount = 0;
        
        // Comenzar desde el siguiente jugador
        gameState.currentPlayerIndex = (gameState.currentPlayerIndex + 1) % gameState.players.length;
        
        // Buscar al siguiente jugador conectado y no bloqueado
        while (!nextPlayerFound && loopCount < gameState.players.length) {
            const nextPlayer = gameState.players[gameState.currentPlayerIndex];
            const nextUserData = getUserById(nextPlayer.id);
            
            // Si el jugador está conectado y no bloqueado, es su turno
            if (nextPlayer.isConnected && nextUserData && !nextUserData.isBlocked) {
                nextPlayerFound = true;
            } else {
                // Si no, pasar al siguiente
                gameState.currentPlayerIndex = (gameState.currentPlayerIndex + 1) % gameState.players.length;
                loopCount++;
            }
        }
        
        // Si hemos recorrido todos los jugadores y ninguno está disponible
        if (!nextPlayerFound) {
            console.log("No hay jugadores conectados y no bloqueados disponibles");
            return;
        }
        
        // Establecer el jugador actual
        gameState.currentPlayer = gameState.players[gameState.currentPlayerIndex];
        console.log(`Turno de ${gameState.currentPlayer.username}, tiene 4 segundos`);
        
        // Establecer temporizador
        clearTimeout(turnTimer);
        turnTimer = setTimeout(() => {
            console.log(`Tiempo agotado para ${gameState.currentPlayer.username}`);
            io.emit('turnTimeout', { playerId: gameState.currentPlayer.id });
            setTimeout(() => {
                startPlayerTurn();
            }, 500);
        }, 4000);
    }

    // Obtener selecciones del jugador actual
    const playerSelections = initPlayerSelections(gameState.currentPlayer.id);
    
    // Usar selecciones específicas del jugador
    gameState.rowSelections = [...playerSelections.rowSelections];

    // Forzar estado 'playing'
    gameState.status = 'playing';
    gameState.turnStartTime = Date.now();

    // Emitir el estado actualizado del juego
    io.emit('gameState', {
        board: gameState.board.map(tile => ({
            ...tile,
            value: tile.revealed ? tile.value : null // Solo enviamos el valor si ya fue revelado
        })),
        currentPlayer: gameState.currentPlayer,
        players: gameState.players.map(player => ({
            id: player.id,
            username: player.username,
            isBlocked: getUserById(player.id).isBlocked,
            isConnected: player.isConnected
        })),
        status: 'playing',
        turnStartTime: gameState.turnStartTime,
        rowSelections: gameState.rowSelections
    });

    // Log para confirmar el estado final
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
            isBlocked: user.isBlocked
        });
    });

    // Unirse al juego
    socket.on('joinGame', () => {
        const userId = connectedSockets[socket.id];
        if (!userId) return;

        const user = getUserById(userId);
        if (!user || user.isAdmin || user.isBlocked) return;

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
            if (!gameState.currentPlayer) {
                gameState.currentPlayer = gameState.players[gameState.players.length - 1];
                gameState.currentPlayerIndex = gameState.players.length - 1;
            }

            // IMPORTANTE: Forzar una llamada directa a startPlayerTurn sin condiciones
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
            }

            // Asegurarse de que el juego esté en estado 'playing' y haya un jugador actual
            if (gameState.status !== 'playing') {
                gameState.status = 'playing';
                startPlayerTurn(); // Reiniciar el turno si el juego estaba en espera
            }

            if (!gameState.currentPlayer && gameState.players.length > 0) {
                gameState.currentPlayer = gameState.players[0];
                gameState.currentPlayerIndex = 0;
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
                    isConnected: player.isConnected
                })),
                status: 'playing',  // Forzar estado 'playing' explícitamente aquí también
                rowSelections: gameState.playerSelections[userId]?.rowSelections || [0, 0, 0, 0]
            });
        }
    });

    // Seleccionar una ficha
    socket.on('selectTile', ({ tileIndex }) => {
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
        
        if (user.isBlocked) {
            console.log('Usuario bloqueado, evento ignorado');
            return;
        }
        
        // Verificar límite de mesas
        if (checkTableLimit(userId)) {
            console.log(`Usuario ${user.username} ha alcanzado el límite diario de mesas`);
            socket.emit('tableLimitReached', {
                message: 'Has alcanzado el límite diario de mesas.',
                unlockTime: `${UNLOCK_HOUR}:00 AM`
            });
            return;
        }
        
        // Permitir seleccionar si es el único jugador o si es su turno
        if (gameState.players.length > 1 && gameState.currentPlayer.id !== userId) {
            console.log(`No es el turno de ${user.username}, es el turno de ${gameState.currentPlayer.username}`);
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
        
        if (gameState.board[tileIndex].revealed) {
            console.log(`Ficha ${tileIndex} ya revelada`);
            return;
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
        
        // Actualizar puntuación con el valor correcto
        const oldScore = user.score;
        user.score += tileValue;
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
        
        // Guardar estado después de cada selección
        saveGameState();
        
        // Verificar si se revelaron todas las fichas
        if (checkGameOver()) {
            console.log("Todas las fichas han sido reveladas. Reiniciando tablero pero manteniendo puntuaciones");
            
            // Incrementar contador de mesas para este jugador
            incrementTableCount(userId);
            
            // Reiniciar solo el tablero
            resetBoardOnly();
        }
        
        // Si el jugador ya seleccionó sus 8 fichas (2 por hilera), pasar al siguiente
        const allRowsFull = playerSelections.rowSelections.every(count => count >= 2);
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
        }
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
                isBlocked: u.isBlocked
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
            isBlocked: u.isBlocked
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
                io.to(playerSocketId).emit('blocked');
            }
        }

        // Actualizar lista de jugadores para todos los admins
        io.emit('playersUpdate', users.filter(u => !u.isAdmin).map(u => ({
            id: u.id,
            username: u.username,
            score: u.score,
            isBlocked: u.isBlocked
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
        targetUser.score = parseInt(newPoints, 10);
        
        // Guardar estado después de actualizar puntos
        saveGameState();

        // Notificar al usuario, si está conectado
        const playerSocketId = gameState.players.find(p => p.id === userId)?.socketId;
        if (playerSocketId) {
            io.to(playerSocketId).emit('forceScoreUpdate', targetUser.score);
        }

        // Actualizar lista de jugadores para todos los admins
        io.emit('playersUpdate', users.filter(u => !u.isAdmin).map(u => ({
            id: u.id,
            username: u.username,
            score: u.score,
            isBlocked: u.isBlocked
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