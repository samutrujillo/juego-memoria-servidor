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
const admin = require('firebase-admin');

// Inicializar Firebase Admin (asegúrate de tener el archivo de credenciales)
// Si estás en producción, puedes usar variables de entorno para las credenciales
let serviceAccount;
try {
    // Intentar cargar archivo de credenciales
    serviceAccount = require('./firebase-credentials.json');
} catch (error) {
    // Si no existe, crear desde variables de entorno
    if (process.env.FIREBASE_CREDENTIALS) {
        try {
            serviceAccount = JSON.parse(process.env.FIREBASE_CREDENTIALS);
        } catch (parseError) {
            console.error('Error al parsear credenciales de Firebase:', parseError);
        }
    } else {
        console.error('No se encontró el archivo de credenciales de Firebase ni la variable de entorno');
    }
}

// Inicializar Firebase solo si tenemos credenciales
let db = null;
if (serviceAccount) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: process.env.FIREBASE_DATABASE_URL || "https://tu-proyecto-firebase.firebaseio.com"
    });
    db = admin.database();
    console.log('Firebase inicializado correctamente');
} else {
    console.warn('No se pudo inicializar Firebase, se usará solo almacenamiento local');
}

const app = express();

// Rutas para archivos de estado con sistema de respaldo
const GAME_STATE_FILE = path.join(__dirname, 'game-state.json');
const GAME_STATE_BACKUP_1 = path.join(__dirname, 'game-state.backup1.json');
const GAME_STATE_BACKUP_2 = path.join(__dirname, 'game-state.backup2.json');
const ERROR_LOG_FILE = path.join(__dirname, 'error-log.txt');

// Añadir estas nuevas variables para el sistema de mesas
const MAX_TABLES_PER_DAY = 10;
const playerGameState = {}; // Para guardar el estado de juego de cada jugador
const playerTableCount = {}; // Contar mesas jugadas por cada jugador
let globalTableNumber = 1; // Mesa global que todos los jugadores verán

// Variables para optimización
const playerInactivityTimeouts = {};
const INACTIVITY_THRESHOLD = 60 * 60 * 1000; // 1 hora

// Variables para control de guardado diferencial en Firebase
let pendingChanges = {};
let saveTimeout = null;

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

// Función para desbloquear forzadamente a todos los jugadores
function forceUnblockAllPlayers() {
    console.log("⚠️ DESBLOQUEANDO FORZADAMENTE A TODOS LOS JUGADORES ⚠️");
    
    let unblockCount = 0;
    for (const user of users) {
        // Solo bloquear si puntaje ≤ 23000 y no es admin
        if (user.score <= 23000 && !user.isAdmin) {
            // Este bloqueo es válido, dejarlo como está
            if (!user.isLockedDueToScore) {
                user.isLockedDueToScore = true;
                unblockCount++;
                console.log(`Usuario ${user.username} bloqueado por tener puntaje ${user.score}`);
            }
        } else {
            // Para cualquier otra razón, desbloquear
            if (user.isLockedDueToScore) {
                user.isLockedDueToScore = false;
                unblockCount++;
                console.log(`Usuario ${user.username} desbloqueado forzadamente`);
                
                // Notificar al usuario si está conectado
                const player = gameState.players.find(p => p.id === user.id);
                if (player && player.socketId) {
                    io.to(player.socketId).emit('blockStatusChanged', {
                        isLockedDueToScore: false,
                        message: 'Tu cuenta ha sido desbloqueada.'
                    });
                }
            }
        }
    }
    
    if (unblockCount > 0) {
        console.log(`Se modificaron ${unblockCount} usuarios`);
        saveGameState();
    }
}

// Sistema de ping/heartbeat para verificar conexiones
setInterval(() => {
    // Verificar las conexiones activas
    const onlinePlayers = new Set();

    for (const socketId in connectedSockets) {
        const userId = connectedSockets[socketId];
        const socket = io.sockets.sockets.get(socketId);

        if (socket && socket.connected && userId) {
            onlinePlayers.add(userId);

            // Enviar ping para verificar que está realmente conectado
            socket.emit('ping', {}, (response) => {
                // Este callback solo se ejecutará si el cliente responde
                console.log(`Ping recibido de ${userId}`);
            });
        }
    }

    // Actualizar el estado de conexión en la lista de jugadores
    let connectionChanged = false;

    gameState.players.forEach(player => {
        const wasConnected = player.isConnected;
        player.isConnected = onlinePlayers.has(player.id);

        if (wasConnected !== player.isConnected) {
            connectionChanged = true;
        }
    });

    // Si hubo cambios, notificar a todos los clientes
    if (connectionChanged) {
        io.emit('connectionStatusUpdate', {
            players: gameState.players.map(player => ({
                id: player.id,
                isConnected: player.isConnected
            }))
        });

        // Guardar estado después de cambios de conexión
        saveGameState();
    }
    
    // Verificar y corregir bloqueos incorrectos regularmente
    forceUnblockAllPlayers();
    
}, 10000); // Verificar cada 10 segundos

// Datos de usuario (en una aplicación real, esto estaría en una base de datos)
const users = [
    { id: '1', username: 'Orion', password: '3498700', score: 60000, prevScore: 60000, isAdmin: false, isBlocked: false, isLockedDueToScore: false },
    { id: '2', username: 'Andy', password: '2587411', score: 60000, prevScore: 60000, isAdmin: false, isBlocked: false, isLockedDueToScore: false },
    { id: '3', username: 'Casio', password: '9632541', score: 60000, prevScore: 60000, isAdmin: false, isBlocked: false, isLockedDueToScore: false },
    { id: '4', username: 'Pega', password: '7412589', score: 60000, prevScore: 60000, isAdmin: false, isBlocked: false, isLockedDueToScore: false },
    { id: '5', username: 'Percy', password: '8523697', score: 60000, prevScore: 60000, isAdmin: false, isBlocked: false, isLockedDueToScore: false },
    { id: '6', username: 'Nova', password: '1234567', score: 60000, prevScore: 60000, isAdmin: false, isBlocked: false, isLockedDueToScore: false },
    { id: '7', username: 'Leo', password: '7654321', score: 60000, prevScore: 60000, isAdmin: false, isBlocked: false, isLockedDueToScore: false },
    { id: '8', username: 'Ara', password: '1122334', score: 60000, prevScore: 60000, isAdmin: false, isBlocked: false, isLockedDueToScore: false },
    { id: '9', username: 'Hydra', password: 'serpiente321', score: 60000, prevScore: 60000, isAdmin: false, isBlocked: false, isLockedDueToScore: false },
    { id: '10', username: 'Lyra', password: 'arpa987', score: 60000, prevScore: 60000, isAdmin: false, isBlocked: false, isLockedDueToScore: false },
    { id: 'admin', username: 'admin', password: 'admin1998', score: 60000, prevScore: 60000, isAdmin: true, isBlocked: false, isLockedDueToScore: false }
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

// Función para encolar cambios para guardado diferencial
function queueGameStateChange(path, value) {
    if (!db) return; // Si no está disponible Firebase, no hacer nada
    
    // No permitir valores undefined en Firebase
    if (value === undefined) {
        console.warn(`Advertencia: se intentó guardar un valor undefined en ${path}. Usando null en su lugar.`);
        value = null;
    }

    pendingChanges[path] = value;

    if (!saveTimeout) {
        saveTimeout = setTimeout(() => {
            const updates = { ...pendingChanges };
            pendingChanges = {};
            saveTimeout = null;

            // Guardar cambios acumulados
            db.ref().update(updates)
                .then(() => console.log('Cambios incrementales guardados en Firebase'))
                .catch(error => {
                    console.error('Error al guardar cambios incrementales:', error);
                    
                    // Intentar guardar los cambios uno por uno para identificar cuáles son problemáticos
                    Object.entries(updates).forEach(([path, value]) => {
                        db.ref(path).set(value)
                            .catch(err => console.error(`Error guardando ${path}:`, err));
                    });
                });
        }, 1000); // Guardar después de 1 segundo de inactividad
    }
}

// Función para validar la integridad del tablero
function validateBoardIntegrity() {
    // Verificar que haya 8 fichas positivas y 8 negativas
    let positiveCount = 0;
    let negativeCount = 0;

    for (const tile of gameState.board) {
        if (tile.value > 0) positiveCount++;
        if (tile.value < 0) negativeCount++;
    }

    if (positiveCount !== 8 || negativeCount !== 8) {
        console.error(`ERROR DE INTEGRIDAD DEL TABLERO: ${positiveCount} positivas, ${negativeCount} negativas`);
        // Regenerar el tablero para corregir
        gameState.board = generateBoard();
        // Guardar estado después de regenerar el tablero
        saveGameState();
        return false;
    }

    return true;
}

// Ejecutar esta validación periódicamente
setInterval(validateBoardIntegrity, 5 * 60 * 1000); // Cada 5 minutos

// Función para verificar si un usuario debe ser bloqueado por puntos exactos
// o por caer a 23,000 o menos
function checkScoreLimit(user) {
    // Sólo bloquear si es jugador y tiene 23,000 puntos o menos
    if (user.score <= 23000 && !user.isAdmin) {
        console.log(`Usuario ${user.username} bloqueado por alcanzar o caer a ${user.score} puntos`);
        
        // Solo modificar el estado si necesita cambiarse
        if (!user.isLockedDueToScore) {
            user.isLockedDueToScore = true;

            // Notificar inmediatamente al usuario a través de su socket si está conectado
            const playerSocketId = gameState.players.find(p => p.id === user.id)?.socketId;
            if (playerSocketId) {
                io.to(playerSocketId).emit('scoreLimitReached', {
                    message: 'Has alcanzado o caído a 23,000 puntos o menos. Tu cuenta ha sido bloqueada temporalmente.'
                });
                io.to(playerSocketId).emit('blockStatusChanged', {
                    isLockedDueToScore: true,
                    message: 'Has alcanzado o caído a 23,000 puntos o menos. Tu cuenta ha sido bloqueada temporalmente.'
                });
            }

            // Actualizar en Firebase si está disponible
            if (db) {
                queueGameStateChange(`gameState/userScores/${user.id}/isLockedDueToScore`, true);
            }

            // Guardar estado después del bloqueo
            saveGameState();
        }
        
        return true;
    } else if (user.isLockedDueToScore) {
        // Si está bloqueado pero su puntaje es mayor a 23000, desbloquearlo
        console.log(`Desbloqueando a ${user.username} porque su puntaje es ${user.score} > 23000`);
        user.isLockedDueToScore = false;
        
        // Notificar al usuario
        const playerSocketId = gameState.players.find(p => p.id === user.id)?.socketId;
        if (playerSocketId) {
            io.to(playerSocketId).emit('userUnlocked', {
                message: 'Tu puntaje ha superado los 23,000 puntos y tu cuenta ha sido desbloqueada.'
            });
            io.to(playerSocketId).emit('blockStatusChanged', {
                isLockedDueToScore: false,
                message: 'Tu puntaje ha superado los 23,000 puntos y tu cuenta ha sido desbloqueada.'
            });
        }
        
        // Actualizar en Firebase
        if (db) {
            queueGameStateChange(`gameState/userScores/${user.id}/isLockedDueToScore`, false);
        }
        
        // Guardar estado después del desbloqueo
        saveGameState();
        
        return false;
    }
    
    return false; // Por defecto, no bloquear
}

// Función para verificar la integridad de los estados de bloqueo
function verifyBlockingStates() {
    let inconsistenciasCorregidas = 0;
    
    // Verificar cada jugador en la lista de usuarios
    for (const user of users) {
        if (user.isAdmin) continue; // Ignorar administradores
        
        // La única condición válida para bloqueo automático es por puntaje <= 23000
        const shouldBeLockedDueToScore = user.score <= 23000;
        
        if (user.isLockedDueToScore !== shouldBeLockedDueToScore) {
            console.log(`Corrigiendo inconsistencia de bloqueo por puntaje para ${user.username}: ${user.isLockedDueToScore} -> ${shouldBeLockedDueToScore}`);
            user.isLockedDueToScore = shouldBeLockedDueToScore;
            inconsistenciasCorregidas++;
            
            // Notificar al usuario si está conectado
            const playerSocketId = gameState.players.find(p => p.id === user.id)?.socketId;
            if (playerSocketId) {
                if (shouldBeLockedDueToScore) {
                    io.to(playerSocketId).emit('scoreLimitReached', {
                        message: 'Has alcanzado o caído a 23,000 puntos o menos. Tu cuenta ha sido bloqueada temporalmente.'
                    });
                } else {
                    io.to(playerSocketId).emit('userUnlocked', {
                        message: 'Tu puntaje ha sido corregido y tu cuenta ha sido desbloqueada.'
                    });
                }
                
                io.to(playerSocketId).emit('blockStatusChanged', {
                    isLockedDueToScore: shouldBeLockedDueToScore,
                    message: shouldBeLockedDueToScore ? 
                        'Tu cuenta ha sido bloqueada por alcanzar o caer a 23,000 puntos o menos.' : 
                        'Tu cuenta ha sido desbloqueada.'
                });
            }
            
            // Actualizar en Firebase
            if (db) {
                queueGameStateChange(`gameState/userScores/${user.id}/isLockedDueToScore`, shouldBeLockedDueToScore);
            }
        }
    }
    
    if (inconsistenciasCorregidas > 0) {
        console.log(`Se corrigieron ${inconsistenciasCorregidas} inconsistencias de bloqueo por puntaje`);
        saveGameState(); // Guardar cambios
    }
    
    return inconsistenciasCorregidas;
}

// Verificar la integridad de los estados de bloqueo cada 2 minutos
setInterval(verifyBlockingStates, 2 * 60 * 1000);

// Esta función ahora solo hace monitoreo
function checkAndResetTableCounters() {
    // No realiza ningún reinicio automático, solo monitoreo
    console.log("Verificación de monitoreo - No se realiza reinicio automático");

    // Opcional: Log para verificar la cantidad de mesas por jugador
    for (const userId in playerTableCount) {
        const user = getUserById(userId);
        if (user) {
            console.log(`${user.username}: ${playerTableCount[userId]} mesas jugadas`);
        }
    }
}

// Función para limpiar datos de jugadores inactivos (optimización)
function cleanupInactivePlayersData() {
    const currentTime = Date.now();
    let cleanedCount = 0;

    // Limpiar datos de jugadores que llevan inactivos más de 1 hora
    for (const userId in playerGameState) {
        if (playerGameState[userId].timestamp &&
            (currentTime - playerGameState[userId].timestamp) > INACTIVITY_THRESHOLD) {
            delete playerGameState[userId];
            cleanedCount++;
        }
    }

    if (cleanedCount > 0) {
        console.log(`Limpieza de memoria: ${cleanedCount} jugadores inactivos eliminados`);
    }
}

// Mantener la verificación periódica pero ahora sin reinicio automático
setInterval(checkAndResetTableCounters, 60 * 60 * 1000); // Cada hora
setInterval(cleanupInactivePlayersData, 30 * 60 * 1000); // Cada 30 minutos

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

    // Actualizar en Firebase si está disponible
    if (db) {
        queueGameStateChange('gameState/lastTableResetDate', gameState.lastTableResetDate);
        queueGameStateChange('gameState/tableCount', 0);

        const updates = {};
        Object.keys(playerTableCount).forEach(userId => {
            updates[`gameState/userScores/${userId}/tablesPlayed`] = 0;
        });

        if (Object.keys(updates).length > 0) {
            db.ref().update(updates).catch(error =>
                console.error('Error al reiniciar contadores de mesa en Firebase:', error)
            );
        }
    }

    console.log('Contadores de mesas reiniciados por administrador');
    saveGameState();
}

// Función para verificar el límite de mesas
function checkTableLimit(userId) {
    // Seguir rastreando las mesas para visualización, pero NUNCA bloquear
    if (!playerTableCount[userId]) {
        playerTableCount[userId] = 0;
    }
    
    // Siempre retornar false para evitar bloqueos automáticos
    return false;
}

// Función para incrementar el contador de mesas
function incrementTableCount(userId) {
    if (!playerTableCount[userId]) {
        playerTableCount[userId] = 0;
    }

    // Incrementar contador (seguir rastreando pero no bloquear)
    playerTableCount[userId]++;
    gameState.tableCount++;

    // Actualizar en Firebase si está disponible
    if (db) {
        queueGameStateChange(`gameState/userScores/${userId}/tablesPlayed`, playerTableCount[userId]);
        queueGameStateChange('gameState/tableCount', gameState.tableCount);
    }

    // Guardar estado
    saveGameState();

    return playerTableCount[userId];
}

// Función mejorada para guardar el estado del juego con Firebase y respaldos locales
async function saveGameState() {
    // Crear una copia limpia de los jugadores para evitar valores undefined
    const cleanPlayers = gameState.players.map(player => ({
        id: player.id,
        username: player.username,
        socketId: player.socketId || null, // Convertir undefined a null para Firebase
        isConnected: player.isConnected === undefined ? false : player.isConnected // Asegurar que no sea undefined
    }));

    const stateToSave = {
        board: gameState.board,
        players: cleanPlayers,
        currentPlayerIndex: gameState.currentPlayerIndex,
        status: gameState.status,
        rowSelections: gameState.rowSelections,
        playerSelections: gameState.playerSelections,
        tableCount: gameState.tableCount,
        lastTableResetDate: gameState.lastTableResetDate,
        globalTableNumber: globalTableNumber,
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
        playerGameStates: playerGameState,
        timestamp: Date.now() // Añadir timestamp para verificación
    };

    const jsonData = JSON.stringify(stateToSave, null, 2);
    let savedSuccessfully = false;

    // Intentar guardar en Firebase primero si está disponible
    if (db) {
        try {
            await db.ref('gameState').set(stateToSave);
            console.log('Estado del juego guardado correctamente en Firebase');
            savedSuccessfully = true;
        } catch (firebaseError) {
            console.error('Error al guardar en Firebase, intentando respaldo local:', firebaseError);
            
            // Intentar con una versión más sencilla si falló el guardado completo
            try {
                // Eliminar posibles propiedades problemáticas
                const simplifiedState = {
                    ...stateToSave,
                    // Sanear los datos aún más
                    players: stateToSave.players.map(p => ({
                        id: p.id || 'unknown',
                        username: p.username || 'unknown',
                        socketId: null, // Usar null explícitamente
                        isConnected: Boolean(p.isConnected) // Forzar a boolean
                    }))
                };
                
                await db.ref('gameState').set(simplifiedState);
                console.log('Estado simplificado guardado en Firebase');
                savedSuccessfully = true;
            } catch (retryError) {
                console.error('Error al guardar versión simplificada en Firebase:', retryError);
            }
        }
    }

    // Siempre guardar en local como respaldo, incluso si Firebase tuvo éxito
    try {
        // Sistema de rotación de respaldos
        // 1. Si existe el archivo principal, copiarlo como backup1
        if (fs.existsSync(GAME_STATE_FILE)) {
            try {
                const mainFileContent = fs.readFileSync(GAME_STATE_FILE, 'utf8');
                fs.writeFileSync(GAME_STATE_BACKUP_1, mainFileContent);
            } catch (backupError) {
                console.error('Error al crear respaldo 1:', backupError);
            }
        }

        // 2. Si existe backup1, copiarlo como backup2
        if (fs.existsSync(GAME_STATE_BACKUP_1)) {
            try {
                const backup1Content = fs.readFileSync(GAME_STATE_BACKUP_1, 'utf8');
                fs.writeFileSync(GAME_STATE_BACKUP_2, backup1Content);
            } catch (backupError) {
                console.error('Error al crear respaldo 2:', backupError);
            }
        }

        // 3. Guardar el nuevo estado en el archivo principal
        fs.writeFileSync(GAME_STATE_FILE, jsonData);
        console.log('Estado del juego guardado correctamente en archivos locales');
        savedSuccessfully = true;
    } catch (error) {
        console.error('Error al guardar el estado del juego en archivos locales:', error);

        if (!savedSuccessfully) {
            try {
                // Intentar guardar directamente en los archivos de respaldo
                fs.writeFileSync(GAME_STATE_BACKUP_1, jsonData);
                console.log('Estado guardado en respaldo 1 tras error en archivo principal');
                savedSuccessfully = true;
            } catch (backup1Error) {
                console.error('Error al guardar en respaldo 1:', backup1Error);
                try {
                    fs.writeFileSync(GAME_STATE_BACKUP_2, jsonData);
                    console.log('Estado guardado en respaldo 2 tras errores previos');
                    savedSuccessfully = true;
                } catch (backup2Error) {
                    console.error('Error crítico: No se pudo guardar el estado en ninguna ubicación');
                }
            }
        }

        try {
            fs.appendFileSync(ERROR_LOG_FILE, `${new Date().toISOString()} - Error guardando estado: ${error.message}\n`);
        } catch (logError) {
            console.error('Error adicional al escribir en archivo de log');
        }
    }

    return savedSuccessfully;
}

// Función mejorada para cargar el estado con Firebase y múltiples respaldos
async function loadGameState() {
    let loadedState = null;
    let loadedSource = null;

    // 1. Intentar cargar desde Firebase primero
    if (db) {
        try {
            console.log('Intentando cargar estado desde Firebase...');
            const snapshot = await db.ref('gameState').once('value');
            const firebaseState = snapshot.val();

            if (firebaseState &&
                firebaseState.board &&
                Array.isArray(firebaseState.board) &&
                firebaseState.board.length === 16) {
                loadedState = firebaseState;
                loadedSource = 'Firebase';
                console.log('Estado cargado exitosamente desde Firebase');
            } else {
                console.warn('Firebase contiene datos pero estructura inválida o incompleta');
            }
        } catch (firebaseError) {
            console.error('Error al cargar desde Firebase:', firebaseError);
        }
    }

    // 2. Si no se pudo cargar desde Firebase, intentar desde archivos locales
    if (!loadedState) {
        const fileOptions = [GAME_STATE_FILE, GAME_STATE_BACKUP_1, GAME_STATE_BACKUP_2];

        // Intentar cargar desde cada archivo en orden
        for (const file of fileOptions) {
            try {
                if (fs.existsSync(file)) {
                    const fileContent = fs.readFileSync(file, 'utf8');
                    if (fileContent && fileContent.trim() !== '') {
                        const parsedState = JSON.parse(fileContent);

                        // Verificar que el estado tenga la estructura mínima necesaria
                        if (parsedState &&
                            parsedState.board &&
                            Array.isArray(parsedState.board) &&
                            parsedState.board.length === 16) {
                            loadedState = parsedState;
                            loadedSource = file;
                            console.log(`Estado cargado exitosamente desde: ${file}`);
                            break; // Salir del bucle si se cargó correctamente
                        } else {
                            console.warn(`Archivo ${file} existe pero tiene estructura inválida`);
                        }
                    } else {
                        console.warn(`Archivo ${file} está vacío`);
                    }
                }
            } catch (error) {
                console.error(`Error al cargar desde ${file}:`, error);
                try {
                    fs.appendFileSync(ERROR_LOG_FILE, `${new Date().toISOString()} - Error cargando desde ${file}: ${error.message}\n`);
                } catch (logError) { }
            }
        }
    }

    // 3. Aplicar el estado cargado si existe
    if (loadedState) {
        // Restaurar el estado del juego completo
        if (loadedState.board) {
            gameState.board = loadedState.board;
        }

        if (loadedState.tableCount !== undefined) {
            gameState.tableCount = loadedState.tableCount;
        }

        if (loadedState.lastTableResetDate) {
            gameState.lastTableResetDate = loadedState.lastTableResetDate;
        }

        if (loadedState.globalTableNumber !== undefined) {
            globalTableNumber = loadedState.globalTableNumber;
        }

        if (loadedState.rowSelections) {
            gameState.rowSelections = loadedState.rowSelections;
        }

        if (loadedState.playerSelections) {
            gameState.playerSelections = loadedState.playerSelections;
        }

        if (loadedState.playerGameStates) {
            Object.assign(playerGameState, loadedState.playerGameStates);
        }

        if (loadedState.userScores) {
            for (const userId in loadedState.userScores) {
                const user = users.find(u => u.id === userId);
                if (user) {
                    user.score = loadedState.userScores[userId].score;
                    user.prevScore = loadedState.userScores[userId].prevScore || user.score;
                    user.isBlocked = loadedState.userScores[userId].isBlocked;
                    
                    // IMPORTANTE: Solo mantener el bloqueo por puntaje si cumple la condición
                    if (loadedState.userScores[userId].isLockedDueToScore) {
                        // Verificar que realmente deba estar bloqueado por puntaje
                        user.isLockedDueToScore = user.score <= 23000;
                    } else {
                        user.isLockedDueToScore = false;
                    }

                    if (loadedState.userScores[userId].tablesPlayed !== undefined) {
                        playerTableCount[userId] = loadedState.userScores[userId].tablesPlayed;
                    }
                }
            }
        }

        if (loadedState.players) {
            gameState.players = loadedState.players.map(player => ({
                ...player,
                isConnected: false
            }));
        }

        // 4. Si se cargó desde archivo local pero tenemos Firebase, sincronizar con Firebase
        if (loadedSource !== 'Firebase' && db) {
            console.log('Sincronizando estado cargado con Firebase...');
            try {
                await db.ref('gameState').set(loadedState);
                console.log('Estado sincronizado correctamente con Firebase');
            } catch (syncError) {
                console.error('Error al sincronizar con Firebase:', syncError);
            }
        }

        // 5. Verificar la integridad del tablero
        validateBoardIntegrity();
        
        // 6. Verificar y corregir cualquier bloqueo incorrecto al cargar
        forceUnblockAllPlayers();

        console.log(`Estado del juego cargado correctamente desde ${loadedSource}. Mesa global actual: ${globalTableNumber}`);
        return true;
    }

    // Si no se pudo cargar ningún estado, inicializar con valores predeterminados
    console.warn('NO SE PUDO CARGAR NINGÚN ESTADO VÁLIDO - INICIALIZANDO CON VALORES PREDETERMINADOS');
    gameState.board = generateBoard();
    globalTableNumber = 1;

    // Si tenemos Firebase disponible, guardar el estado inicial
    if (db) {
        try {
            const initialState = {
                board: gameState.board,
                globalTableNumber: 1,
                tableCount: 0,
                lastTableResetDate: new Date().toDateString(),
                status: 'playing',
                timestamp: Date.now()
            };
            await db.ref('gameState').set(initialState);
            console.log('Estado inicial guardado en Firebase');
        } catch (initError) {
            console.error('Error al guardar estado inicial en Firebase:', initError);
        }
    }

    return false;
}

// Intentar cargar el estado guardado
(async function () {
    try {
        if (!await loadGameState()) {
            console.log('No se encontró estado guardado o hubo un error al cargarlo, usando valores predeterminados');
        }
        
        // Asegurar que ningún jugador esté bloqueado incorrectamente al inicio
        forceUnblockAllPlayers();
    } catch (err) {
        console.error('Error durante la carga inicial del estado:', err);
    }
})();

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

        // Verificar si debe ser bloqueado cuando llega a 23000 o menos
        checkScoreLimit(user);

        // Actualizar en Firebase si está disponible
        if (db) {
            queueGameStateChange(`gameState/userScores/${id}/score`, user.score);
            queueGameStateChange(`gameState/userScores/${id}/prevScore`, user.prevScore);
        }

        // Guardar el estado después de actualizar la puntuación
        saveGameState();

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

        // Actualizar en Firebase si está disponible
        if (db) {
            queueGameStateChange(`gameState/playerSelections/${userId}`, gameState.playerSelections[userId]);
        }
    }
    return gameState.playerSelections[userId];
}

// Función para reiniciar solo el tablero y asegurar el orden de mesas
async function resetBoardOnly() {
    console.log("Reiniciando el tablero y avanzando a la siguiente mesa");

    // IMPORTANTE: Desbloquear cualquier jugador que haya sido bloqueado incorrectamente
    forceUnblockAllPlayers();

    // Incrementar el número de mesa global de manera ordenada
    globalTableNumber++;
    if (globalTableNumber > 10) {
        globalTableNumber = 1; // Volver a la mesa 1 después de la 10
        console.log("Vuelta completa de mesas: reiniciando a mesa 1");
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

    // IMPORTANTE: Garantizar que no se modifique el estado de bloqueo
    // Verificar qué jugadores están realmente conectados sin modificar bloqueos
    const connectedPlayerIds = new Set();
    Object.keys(connectedSockets).forEach(socketId => {
        const userId = connectedSockets[socketId];
        if (userId) {
            connectedPlayerIds.add(userId);
        }
    });

    // Actualizar SOLO el estado de conexión de los jugadores, no modificar bloqueos
    for (const player of gameState.players) {
        // Solo actualizamos el estado de conexión, no modificamos el estado de bloqueo
        player.isConnected = connectedPlayerIds.has(player.id);
    }

    // Si solo hay un jugador conectado, establecerlo como el jugador actual
    // Verificar que no sea admin y que no esté bloqueado manualmente
    const eligiblePlayers = gameState.players.filter(player => {
        const userData = getUserById(player.id);
        return player.isConnected && userData && !userData.isBlocked && 
               (!userData.isLockedDueToScore || userData.score > 23000) && 
               !userData.isAdmin;
    });

    if (eligiblePlayers.length === 1) {
        gameState.currentPlayer = eligiblePlayers[0];
        gameState.currentPlayerIndex = gameState.players.findIndex(p => p.id === eligiblePlayers[0].id);
    }

    // Actualizar toda la información crítica en Firebase inmediatamente si está disponible
    if (db) {
        try {
            const criticalUpdates = {
                'gameState/board': gameState.board,
                'gameState/globalTableNumber': globalTableNumber,
                'gameState/rowSelections': gameState.rowSelections,
                'gameState/playerSelections': gameState.playerSelections,
                'gameState/players': gameState.players.map(p => ({
                    id: p.id,
                    username: p.username,
                    socketId: p.socketId || null,
                    isConnected: p.isConnected
                    // NO incluir estados de bloqueo aquí
                })),
                'gameState/currentPlayerIndex': gameState.currentPlayerIndex
            };

            await db.ref().update(criticalUpdates);
            console.log('Información de nuevo tablero actualizada en Firebase');
        } catch (firebaseError) {
            console.error('Error al actualizar nuevo tablero en Firebase:', firebaseError);
        }
    }

    // Notificar a todos los clientes del cambio de mesa con tablero nuevo
    // Asegurarse de no enviar información que pueda afectar estados de bloqueo
    io.emit('boardReset', {
        message: globalTableNumber === 1 
            ? "Todas las fichas fueron reveladas. ¡Volviendo a la mesa 1!" 
            : "Todas las fichas fueron reveladas. ¡Avanzando a la mesa " + globalTableNumber + "!",
        newTableNumber: globalTableNumber,
        newBoard: gameState.board, // Enviar el tablero nuevo completo
        connectedPlayers: gameState.players.filter(p => p.isConnected).map(p => p.id)
    });

    // Actualizar estado de contadores de mesa para cada jugador
    for (const player of gameState.players) {
        const playerId = player.id;
        const playerUser = getUserById(playerId);
        
        // Verificar que el usuario exista
        if (!playerUser) continue;

        // Inicializar contador si no existe
        if (!playerTableCount[playerId]) {
            playerTableCount[playerId] = 0;
        }

        // Incrementar contador (seguir rastreando pero no bloquear)
        playerTableCount[playerId]++;

        // Actualizar contador en Firebase
        if (db) {
            queueGameStateChange(`gameState/userScores/${playerId}/tablesPlayed`, playerTableCount[playerId]);
        }

        // Enviar actualización del contador de mesas
        const playerSocketId = player.socketId;
        if (playerSocketId && player.isConnected) {
            io.to(playerSocketId).emit('tablesUpdate', {
                tablesPlayed: playerTableCount[playerId],
                currentTable: globalTableNumber,
                maxReached: false, // NUNCA indicar como máximas las mesas
                lockReason: '' // No dar razón de bloqueo
            });
        }
    }

    // Emitir nuevo estado del juego sin modificar estados de bloqueo
    io.emit('gameState', {
        board: gameState.board,
        currentPlayer: gameState.currentPlayer,
        players: gameState.players.map(player => {
            const userData = getUserById(player.id);
            return {
                id: player.id,
                username: player.username,
                isBlocked: userData ? userData.isBlocked : false, // Usar el valor real de la lista de usuarios
                isLockedDueToScore: userData ? (userData.score <= 23000 && userData.isLockedDueToScore) : false, // Verificar puntaje
                isConnected: player.isConnected
            };
        }),
        status: 'playing',
        rowSelections: gameState.rowSelections
    });

    // Guardar estado actualizado
    await saveGameState();
    
    // Verificar y corregir bloqueos una vez más después de resetear el tablero
    forceUnblockAllPlayers();
}

// Modificar la función resetGame
async function resetGame() {
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
  
    // IMPORTANTE: Verificar qué jugadores están realmente conectados
    const reallyConnectedPlayers = new Set();
    
    // Recorrer las conexiones activas para determinar qué jugadores están realmente conectados
    for (const socketId in connectedSockets) {
      const userId = connectedSockets[socketId];
      if (userId) {
        // Verificar que el socket esté realmente conectado
        const socket = io.sockets.sockets.get(socketId);
        if (socket && socket.connected) {
          reallyConnectedPlayers.add(userId);
        }
      }
    }
    
    console.log("Jugadores realmente conectados:", Array.from(reallyConnectedPlayers));
  
    // Actualizar el estado de conexión en la lista de jugadores
    gameState.players.forEach(player => {
      player.isConnected = reallyConnectedPlayers.has(player.id);
      
      // IMPORTANTE: Garantizar que cada jugador en la lista realmente esté desbloqueado
      const userObject = getUserById(player.id);
      if (userObject && !userObject.isAdmin) {
        userObject.isBlocked = false;
        userObject.isLockedDueToScore = false;
      }
      
      // Actualizar el socketId si es necesario
      if (!player.isConnected) {
        player.socketId = null;
      }
    });
  
    // Seleccionar jugador conectado como jugador actual SÓLO si no es admin
    const eligiblePlayers = gameState.players.filter(player => {
      const userData = getUserById(player.id);
      return player.isConnected && userData && !userData.isAdmin;
    });
  
    if (eligiblePlayers.length > 0) {
      gameState.currentPlayer = eligiblePlayers[0];
      gameState.currentPlayerIndex = gameState.players.findIndex(p => p.id === eligiblePlayers[0].id);
    } else {
      gameState.currentPlayer = null;
      gameState.currentPlayerIndex = 0;
    }
  
    clearTimeout(turnTimer);
  
    // Notificar a todos los clientes con un evento explícito para el estado de conexión
    io.emit('connectionStatusUpdate', {
      players: gameState.players.map(player => ({
        id: player.id,
        isConnected: player.isConnected
      }))
    });
  
    // Actualizar en Firebase si está disponible
    if (db) {
      try {
        // Crear un objeto con todos los updates necesarios
        const resetUpdates = {
          'gameState/board': gameState.board,
          'gameState/status': 'resetCompleted', // Marcar específicamente como resetCompleted
          'gameState/globalTableNumber': 1,
          'gameState/rowSelections': [0, 0, 0, 0],
          'gameState/turnStartTime': Date.now()
        };
        
        // Añadir reset de puntajes de todos los usuarios
        users.forEach(user => {
          if (!user.isAdmin) {
            resetUpdates[`gameState/userScores/${user.id}/score`] = 60000;
            resetUpdates[`gameState/userScores/${user.id}/prevScore`] = 60000;
            resetUpdates[`gameState/userScores/${user.id}/isBlocked`] = false;
            resetUpdates[`gameState/userScores/${user.id}/isLockedDueToScore`] = false;
            resetUpdates[`gameState/userScores/${user.id}/tablesPlayed`] = 0;
          }
        });
        
        // Enviar todos los updates de una vez
        await db.ref().update(resetUpdates);
        console.log('Reinicio de juego actualizado en Firebase');
      } catch (firebaseError) {
        console.error('Error al actualizar reinicio en Firebase:', firebaseError);
      }
    }
  
    // Notificar el estado de resetCompleted a todos los clientes
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
      status: 'resetCompleted', // Usar este estado específico para que los clientes sepan que es un reinicio
      turnStartTime: gameState.turnStartTime,
      rowSelections: gameState.rowSelections
    });
  
    // Enviar evento específico para reinicio completo con conexión verificada
    io.emit('gameCompletelyReset', {
      message: "El juego ha sido reiniciado completamente",
      newBoard: gameState.board,
      status: 'playing',
      players: gameState.players.map(player => ({
        id: player.id,
        username: player.username,
        isConnected: player.isConnected // Estado de conexión verificado
      }))
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
  
        // Enviar actualización de mesas
        io.to(player.socketId).emit('tablesUpdate', {
          tablesPlayed: 0,
          currentTable: 1,
          maxReached: false,
          lockReason: ''
        });
      }
    });
  
    // Notificar a todos los jugadores del reinicio
    io.emit('boardReset', {
      message: "El administrador ha reiniciado el juego. Todos los puntajes han sido restablecidos a 60,000.",
      newTableNumber: 1,
      newBoard: gameState.board
    });
  
    // Cambiar el estado a 'playing' después de un pequeño retraso para dar tiempo a los clientes a procesar
    setTimeout(() => {
      gameState.status = 'playing';
      if (gameState.players.length > 0) {
        startPlayerTurn();
      }
      // Notificar que ahora estamos en modo de juego
      io.emit('gameState', {
        status: 'playing',
        currentPlayer: gameState.currentPlayer
      });
      
      // NUEVO: Forzar actualización de estado para todos
      io.emit('forceGameStateRefresh', {
        board: gameState.board,
        currentPlayer: gameState.currentPlayer,
        players: gameState.players.map(player => ({
          id: player.id,
          username: player.username,
          isBlocked: getUserById(player.id).isBlocked,
          isLockedDueToScore: getUserById(player.id).isLockedDueToScore,
          isConnected: player.isConnected
        })),
        status: 'playing'
      });
    }, 2000);
  
    // Guardar estado después del reset
    await saveGameState();
    
    // Verificar y corregir bloqueos una vez más
    forceUnblockAllPlayers();
}

// Función para sincronizar el estado del jugador - mejorada para consistencia
function syncPlayerState(userId, socketId) {
    const user = getUserById(userId);
    if (!user) return;
    
    // Verificar y corregir bloqueo (único lugar donde se verifica)
    if (!user.isAdmin && user.score > 23000 && user.isLockedDueToScore) {
        console.log(`Corrigiendo estado de bloqueo para ${user.username} en syncPlayerState`);
        user.isLockedDueToScore = false;
        
        // Actualizar en Firebase
        if (db) {
            queueGameStateChange(`gameState/userScores/${userId}/isLockedDueToScore`, false);
        }
    }

    // Enviar puntaje actualizado
    io.to(socketId).emit('forceScoreUpdate', user.score);

    // Enviar información de las mesas
    io.to(socketId).emit('tablesUpdate', {
        tablesPlayed: playerTableCount[userId] || 0,
        currentTable: globalTableNumber,
        maxReached: false, // NUNCA indicar como máximas las mesas
        lockReason: '' // No dar razón de bloqueo
    });

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
            isLockedDueToScore: getUserById(player.id).score <= 23000 ? getUserById(player.id).isLockedDueToScore : false,
            isConnected: player.isConnected
        })),
        status: 'playing',
        rowSelections: gameState.playerSelections[userId]?.rowSelections || [0, 0, 0, 0]
    });
    
    // Notificar si el usuario debería estar desbloqueado
    if (!user.isAdmin && user.score > 23000 && user.isLockedDueToScore) {
        io.to(socketId).emit('blockStatusChanged', {
            isLockedDueToScore: false,
            message: 'Tu cuenta ha sido desbloqueada automáticamente.'
        });
    }
}

// Función para iniciar el turno de un jugador, optimizada para evitar problemas
function startPlayerTurn() {
    if (gameState.players.length === 0) return;
    
    // Desbloquear jugadores forzadamente al inicio de cada turno
    forceUnblockAllPlayers();

    console.log(`startPlayerTurn llamada con ${gameState.players.length} jugadores`);
    gameState.status = 'playing';
    gameState.rowSelections = [0, 0, 0, 0];

    // MODIFICADO: Filtrar solo jugadores conectados y no bloqueados
    // Usar directamente la información de la lista de usuarios para mayor precisión
    let eligiblePlayers = gameState.players.filter(player => {
        const userData = getUserById(player.id);
        // Verificar que el jugador esté conectado, no bloqueado y no sea admin
        return player.isConnected && 
                userData && 
                !userData.isBlocked && 
                (!userData.isLockedDueToScore || userData.score > 23000) && 
                !userData.isAdmin;
    });

    if (eligiblePlayers.length === 0) {
        console.log("No hay jugadores elegibles, esperando reconexión o desbloqueo...");
        return;
    }

    if (eligiblePlayers.length === 1) {
        // Encontrar el índice del jugador elegible en la lista principal
        const eligiblePlayerIndex = gameState.players.findIndex(p => p.id === eligiblePlayers[0].id);
        gameState.currentPlayerIndex = eligiblePlayerIndex;
        
        // Asegurarse de que no haya propiedades undefined en el objeto jugador
        gameState.currentPlayer = {
            ...gameState.players[eligiblePlayerIndex],
            socketId: gameState.players[eligiblePlayerIndex].socketId || null,
            isConnected: Boolean(gameState.players[eligiblePlayerIndex].isConnected)
        };

        // IMPORTANTE: Si solo hay un jugador, hacerlo siempre el jugador actual
        clearTimeout(turnTimer);
        turnTimer = setTimeout(() => {
            console.log(`Tiempo agotado para ${gameState.currentPlayer.username}`);
            io.emit('turnTimeout', { playerId: gameState.currentPlayer.id });
            setTimeout(() => {
                startPlayerTurn();
            }, 500);
        }, 6000); // Cambiado a 6 segundos para coincidir con el frontend
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
                !nextUserData.isBlocked && 
                (!nextUserData.isLockedDueToScore || nextUserData.score > 23000) && 
                !nextUserData.isAdmin) {
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

        // Asegurarse de que no haya propiedades undefined en el objeto jugador actual
        gameState.currentPlayer = {
            ...gameState.players[gameState.currentPlayerIndex],
            socketId: gameState.players[gameState.currentPlayerIndex].socketId || null,
            isConnected: Boolean(gameState.players[gameState.currentPlayerIndex].isConnected)
        };
        
        console.log(`Turno de ${gameState.currentPlayer.username}, tiene 6 segundos`);

        clearTimeout(turnTimer);
        turnTimer = setTimeout(() => {
            console.log(`Tiempo agotado para ${gameState.currentPlayer.username}`);
            io.emit('turnTimeout', { playerId: gameState.currentPlayer.id });
            setTimeout(() => {
                startPlayerTurn();
            }, 500);
        }, 6000);
    }

    const playerSelections = initPlayerSelections(gameState.currentPlayer.id);
    gameState.rowSelections = [...playerSelections.rowSelections];
    gameState.status = 'playing';
    gameState.turnStartTime = Date.now();

    // Actualizar en Firebase si está disponible - MODIFICADO para evitar undefined
    if (db) {
        // Usar objeto de actualizaciones para evitar errores parciales
        const updates = {
            'gameState/currentPlayerIndex': gameState.currentPlayerIndex,
            'gameState/status': 'playing',
            'gameState/turnStartTime': gameState.turnStartTime,
            'gameState/rowSelections': gameState.rowSelections
        };
        
        // Añadir información del jugador actual de forma segura
        if (gameState.currentPlayer) {
            updates['gameState/currentPlayer'] = {
                id: gameState.currentPlayer.id,
                username: gameState.currentPlayer.username,
                socketId: gameState.currentPlayer.socketId || null, // Evitar undefined
                isConnected: Boolean(gameState.currentPlayer.isConnected) // Convertir a booleano explícito
            };
        }
        
        // Actualizar en Firebase con manejo de errores
        db.ref().update(updates)
            .then(() => console.log('Estado de turno actualizado en Firebase'))
            .catch(error => {
                console.error('Error al actualizar estado de turno en Firebase:', error);
                // Intentar actualizaciones individuales como respaldo
                Object.entries(updates).forEach(([path, value]) => {
                    db.ref(path).set(value)
                        .catch(err => console.log(`Error actualizando ${path}:`, err));
                });
            });
    }

    // Asegurarse de que los players emitidos a los clientes no tengan undefined
    const sanitizedPlayers = gameState.players.map(player => {
        const userData = getUserById(player.id);
        return {
            id: player.id,
            username: player.username,
            isBlocked: userData ? userData.isBlocked : false,
            // IMPORTANTE: Solo permitir bloqueo por score <= 23000
            isLockedDueToScore: userData ? (userData.score <= 23000 ? userData.isLockedDueToScore : false) : false,
            isConnected: Boolean(player.isConnected) // Convertir a booleano explícito
        };
    });

    io.emit('gameState', {
        board: gameState.board.map(tile => ({
            ...tile,
            value: tile.revealed ? tile.value : null
        })),
        currentPlayer: {
            id: gameState.currentPlayer.id,
            username: gameState.currentPlayer.username,
            // No enviar socketId a los clientes
        },
        players: sanitizedPlayers,
        status: 'playing',
        turnStartTime: gameState.turnStartTime,
        rowSelections: gameState.rowSelections
    });

    // Guardar estado después de cambiar de turno
    saveGameState();

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

    // Evento de desbloqueo de emergencia
    socket.on('emergencyUnblock', () => {
        console.log("¡SOLICITADO DESBLOQUEO DE EMERGENCIA!");
        forceUnblockAllPlayers();
        
        // Forzar una actualización del estado del juego a todos los clientes
        io.emit('gameState', {
            board: gameState.board,
            currentPlayer: gameState.currentPlayer,
            players: gameState.players.map(player => {
                const userData = getUserById(player.id);
                return {
                    id: player.id,
                    username: player.username,
                    isBlocked: userData ? userData.isBlocked : false,
                    isLockedDueToScore: userData ? (userData.score <= 23000 ? userData.isLockedDueToScore : false) : false,
                    isConnected: player.isConnected
                };
            }),
            status: 'playing',
            rowSelections: gameState.rowSelections
        });
        
        // Notificar a todos los jugadores
        io.emit('message', 'Desbloqueo de emergencia ejecutado');
    });

    // Reconexión de usuario
    socket.on('reconnectUser', ({ userId, username }) => {
        connectedSockets[socket.id] = userId;
        console.log(`Usuario ${username} reconectado con socket ${socket.id}`);
        
        // Verificar y corregir bloqueo (único lugar donde se verifica)
        const user = getUserById(userId);
        if (user && !user.isAdmin && user.score > 23000 && user.isLockedDueToScore) {
            console.log(`Corrigiendo estado de bloqueo para ${user.username} en reconnectUser`);
            user.isLockedDueToScore = false;
            
            // Actualizar en Firebase
            if (db) {
                queueGameStateChange(`gameState/userScores/${userId}/isLockedDueToScore`, false);
            }
            
            // Notificar al usuario
            socket.emit('blockStatusChanged', {
                isLockedDueToScore: false,
                message: 'Tu cuenta ha sido desbloqueada automáticamente.'
            });
        }

        // Actualizar el socket ID en la lista de jugadores
        const playerIndex = gameState.players.findIndex(player => player.id === userId);
        if (playerIndex !== -1) {
            gameState.players[playerIndex].socketId = socket.id;

            // Marcar al jugador como conectado
            const wasConnected = gameState.players[playerIndex].isConnected;
            gameState.players[playerIndex].isConnected = true;

            // Actualizar en Firebase si está disponible
            if (db) {
                queueGameStateChange(`gameState/players/${playerIndex}/isConnected`, true);
                queueGameStateChange(`gameState/players/${playerIndex}/socketId`, socket.id);
            }

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

        // Guardar estado después de la reconexión
        saveGameState();
    });

    // Sincronización completa del estado del juego
    socket.on('syncGameState', ({ userId }) => {
        const user = getUserById(userId);
        if (!user) return;
        
        // Verificar si el usuario debería estar desbloqueado
        if (!user.isAdmin && user.score > 23000 && user.isLockedDueToScore) {
            console.log(`Corrigiendo estado de bloqueo para ${user.username} en syncGameState`);
            user.isLockedDueToScore = false;
            
            // Actualizar en Firebase
            if (db) {
                queueGameStateChange(`gameState/userScores/${userId}/isLockedDueToScore`, false);
            }
            
            // Notificar al usuario
            socket.emit('blockStatusChanged', {
                isLockedDueToScore: false,
                message: 'Tu cuenta ha sido desbloqueada automáticamente.'
            });
        }

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
                players: gameState.players.map(player => {
                    const userData = getUserById(player.id);
                    return {
                        id: player.id,
                        username: player.username,
                        isBlocked: userData ? userData.isBlocked : false,
                        isLockedDueToScore: userData ? (userData.score <= 23000 ? userData.isLockedDueToScore : false) : false,
                        isConnected: player.isConnected
                    };
                }),
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
                players: gameState.players.map(player => {
                    const userData = getUserById(player.id);
                    return {
                        id: player.id,
                        username: player.username,
                        isBlocked: userData ? userData.isBlocked : false,
                        isLockedDueToScore: userData ? (userData.score <= 23000 ? userData.isLockedDueToScore : false) : false,
                        isConnected: player.isConnected
                    };
                }),
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
            maxReached: false, // NUNCA indicar como máximas las mesas
            lockReason: '' // No dar razón de bloqueo
        });

        // Verificar si el jugador está bloqueado por tener 23,000 puntos o menos
        if (user.isLockedDueToScore && user.score <= 23000) {
            socket.emit('scoreLimitReached', {
                message: 'Has alcanzado 23,000 puntos o menos. Tu cuenta ha sido bloqueada temporalmente.'
            });
        }

        // Enviar estado actual de bloqueo
        socket.emit('blockStatusChanged', {
            isBlocked: user.isBlocked,
            isLockedDueToScore: user.score <= 23000 ? user.isLockedDueToScore : false,
            message: 'Sincronizando estado del juego'
        });
    });

    // Guardar estado del juego al cerrar sesión - mejorado para garantizar persistencia
    socket.on('saveGameState', async ({ userId }) => {
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

        // Actualizar en Firebase si está disponible
        if (db) {
            try {
                await db.ref(`gameState/playerGameStates/${userId}`).set(playerGameState[userId]);
                console.log(`Estado específico de ${user.username} guardado en Firebase`);
            } catch (error) {
                console.error(`Error al guardar estado específico de ${user.username} en Firebase:`, error);
            }
        }

        console.log(`Estado de juego guardado para ${user.username}`);

        // Guardar el estado completo
        await saveGameState();
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
        
        // Verificar y corregir bloqueo incorrecto al iniciar sesión
        if (!user.isAdmin && user.score > 23000 && user.isLockedDueToScore) {
            console.log(`Corrigiendo bloqueo incorrecto para ${user.username} en login`);
            user.isLockedDueToScore = false;
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
            isLockedDueToScore: user.score <= 23000 ? user.isLockedDueToScore : false
        });
    });

    // Unirse al juego
    socket.on('joinGame', () => {
        const userId = connectedSockets[socket.id];
        if (!userId) return;

        const user = getUserById(userId);
        if (!user) return;
        
        // Asegurar que el jugador no esté bloqueado incorrectamente
        if (!user.isAdmin && user.score > 23000 && user.isLockedDueToScore) {
            console.log(`Corrigiendo bloqueo incorrecto para ${user.username} en joinGame`);
            user.isLockedDueToScore = false;
            
            socket.emit('blockStatusChanged', {
                isLockedDueToScore: false,
                message: 'Tu cuenta ha sido desbloqueada automáticamente.'
            });
            
            // Actualizar en Firebase
            if (db) {
                queueGameStateChange(`gameState/userScores/${userId}/isLockedDueToScore`, false);
            }
        }

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
                isConnected: true
            });

            // Actualizar en Firebase si está disponible
            if (db) {
                const newPlayerIndex = gameState.players.length - 1;
                queueGameStateChange(`gameState/players/${newPlayerIndex}`, {
                    id: userId,
                    username: user.username,
                    socketId: socket.id,
                    isConnected: true
                });
            }

            console.log(`Usuario ${user.username} añadido al juego con estado: conectado`);

            // Notificar a todos sobre el nuevo jugador
            io.emit('connectionStatusUpdate', {
                players: [{
                    id: userId,
                    isConnected: true,
                    username: user.username
                }]
            });

            // IMPORTANTE: Forzar el estado a playing explícitamente
            gameState.status = 'playing';

            // Si no hay jugador actual, establecer este jugador como el actual
            // (solo si no es admin y no está bloqueado)
            if (!gameState.currentPlayer && !user.isAdmin && !user.isBlocked && 
                !(user.score <= 23000 && user.isLockedDueToScore)) {
                gameState.currentPlayer = gameState.players[gameState.players.length - 1];
                gameState.currentPlayerIndex = gameState.players.length - 1;

                if (db) {
                    queueGameStateChange('gameState/currentPlayerIndex', gameState.currentPlayerIndex);
                    queueGameStateChange('gameState/status', 'playing');
                }
            }

            // Iniciar turno (saltará a los jugadores no elegibles)
            startPlayerTurn();

            // Validar explícitamente que el estado sea 'playing' después de startPlayerTurn
            console.log(`Estado del juego después de startPlayerTurn: ${gameState.status}`);
            if (gameState.status !== 'playing') {
                gameState.status = 'playing';

                if (db) {
                    queueGameStateChange('gameState/status', 'playing');
                }
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
                players: gameState.players.map(player => {
                    const userData = getUserById(player.id);
                    return {
                        id: player.id,
                        username: player.username,
                        isBlocked: userData ? userData.isBlocked : false,
                        isLockedDueToScore: userData ? (userData.score <= 23000 ? userData.isLockedDueToScore : false) : false,
                        isConnected: player.isConnected
                    };
                }),
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
                players: gameState.players.map(player => {
                    const userData = getUserById(player.id);
                    return {
                        id: player.id,
                        username: player.username,
                        isBlocked: userData ? userData.isBlocked : false,
                        isLockedDueToScore: userData ? (userData.score <= 23000 ? userData.isLockedDueToScore : false) : false,
                        isConnected: player.isConnected
                    };
                }),
                status: 'playing',
                rowSelections: gameState.rowSelections
            });

            // Guardar estado
            saveGameState();
        } else {
            // El jugador ya está en el juego, actualizar su estado de conexión
            gameState.players[existingPlayerIndex].socketId = socket.id;
            const wasConnected = gameState.players[existingPlayerIndex].isConnected;
            gameState.players[existingPlayerIndex].isConnected = true;

            // Actualizar en Firebase si está disponible
            if (db) {
                queueGameStateChange(`gameState/players/${existingPlayerIndex}/isConnected`, true);
                queueGameStateChange(`gameState/players/${existingPlayerIndex}/socketId`, socket.id);
            }

            console.log(`Usuario ${user.username} reconectado al juego`);

            // Notificar a todos sobre la reconexión, pero solo si cambió de estado
            if (!wasConnected) {
                io.emit('connectionStatusUpdate', {
                    players: [{
                        id: userId,
                        isConnected: true,
                        username: user.username
                    }]
                });

                // Enviar mensaje a todos los jugadores
                io.emit('message', `${user.username} se ha reconectado al juego`);

                // Si no hay jugador actual o el jugador actual está desconectado,
                // reiniciar los turnos
                if (!gameState.currentPlayer || !gameState.currentPlayer.isConnected) {
                    startPlayerTurn();
                }
            }

            // Asegurarse de que el juego esté en estado 'playing' y haya un jugador actual
            if (gameState.status !== 'playing') {
                gameState.status = 'playing';

                if (db) {
                    queueGameStateChange('gameState/status', 'playing');
                }

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
                players: gameState.players.map(player => {
                    const userData = getUserById(player.id);
                    return {
                        id: player.id,
                        username: player.username,
                        isBlocked: userData ? userData.isBlocked : false,
                        isLockedDueToScore: userData ? (userData.score <= 23000 ? userData.isLockedDueToScore : false) : false,
                        isConnected: player.isConnected
                    };
                }),
                status: 'playing',  // Forzar estado 'playing' explícitamente aquí también
                rowSelections: gameState.playerSelections[userId]?.rowSelections || [0, 0, 0, 0]
            });

            // Guardar estado después de la reconexión
            saveGameState();
        }
    });

    // Seleccionar una ficha - Actualizada para bloqueo por límite de puntos
    socket.on('selectTile', async ({ tileIndex, currentScore }) => {
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
        
        // Corregir estado de bloqueo si es incorrecto
        if (!user.isAdmin && user.score > 23000 && user.isLockedDueToScore) {
            console.log(`Corrigiendo bloqueo incorrecto para ${user.username} en selectTile`);
            user.isLockedDueToScore = false;
            
            socket.emit('blockStatusChanged', {
                isLockedDueToScore: false,
                message: 'Tu cuenta ha sido desbloqueada automáticamente.'
            });
            
            // Actualizar en Firebase
            if (db) {
                queueGameStateChange(`gameState/userScores/${userId}/isLockedDueToScore`, false);
            }
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
            socket.emit('message', 'Tu cuenta está bloqueada. Puedes ver el juego pero no jugar.');
            return;
        }

        // Verificar si el usuario está bloqueado por puntaje
        if (user.isLockedDueToScore && user.score <= 23000) {
            console.log(`Usuario ${user.username} bloqueado por puntaje, no puede seleccionar fichas`);
            socket.emit('scoreLimitReached', {
                message: 'Has alcanzado 23,000 puntos o menos. Contacta al administrador para recargar.'
            });
            return;
        }

        // ELIMINADO: Verificación de límite de mesas
        // Nunca bloquear por límite de mesas

        // Permitir seleccionar si es el único jugador o si es su turno
        if (gameState.players.length > 1 && gameState.currentPlayer && gameState.currentPlayer.id !== userId) {
            console.log(`No es el turno de ${user.username}, es el turno de ${gameState.currentPlayer?.username}`);
            return;
        }

        // Verificar si el tiempo se agotó
        const tiempoTranscurrido = Date.now() - gameState.turnStartTime;
        if (tiempoTranscurrido > 6000) {
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
            socket.emit('tileSelectError', { message: 'Esta ficha ya fue seleccionada' });
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

        // Marcar explícitamente la ficha como revelada ANTES de emitir el evento
        gameState.board[tileIndex].revealed = true;
        gameState.board[tileIndex].selectedBy = user.username;
        gameState.board[tileIndex].selectedAt = Date.now(); // Añadir timestamp

        // Actualizar en Firebase inmediatamente los valores críticos
        if (db) {
            try {
                const criticalUpdates = {
                    [`gameState/board/${tileIndex}/revealed`]: true,
                    [`gameState/board/${tileIndex}/selectedBy`]: user.username,
                    [`gameState/board/${tileIndex}/selectedAt`]: Date.now(),
                    [`gameState/playerSelections/${userId}/rowSelections/${row}`]: playerSelections.rowSelections[row],
                    [`gameState/playerSelections/${userId}/totalSelected`]: playerSelections.totalSelected,
                    [`gameState/rowSelections`]: gameState.rowSelections
                };

                await db.ref().update(criticalUpdates);
                console.log('Selección de ficha actualizada en Firebase');
            } catch (error) {
                console.error('Error al actualizar selección de ficha en Firebase:', error);
            }
        }

        // Guardar estado INMEDIATAMENTE después de la selección
        await saveGameState();

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

        // Actualizar en Firebase el puntaje inmediatamente
        if (db) {
            try {
                await db.ref(`gameState/userScores/${userId}`).update({
                    score: newScore,
                    prevScore: oldScore
                });
                console.log('Puntaje actualizado en Firebase');
            } catch (error) {
                console.error('Error al actualizar puntaje en Firebase:', error);
            }
        }

        console.log(`PUNTUACIÓN ACTUALIZADA: ${user.username} ${oldScore} -> ${newScore} (${tileValue})`);

        // IMPORTANTE: Verificar bloqueo por límite de puntos inmediatamente
        if (newScore <= 23000 && !user.isAdmin) {
            checkScoreLimit(user);
        }

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
            timestamp: Date.now(),
            isRevealed: true // Confirmar explícitamente que está revelada
        });

        socket.emit('forceScoreUpdate', newScore);

        // Verificar si el jugador completó todas sus selecciones permitidas
        const allRowsFull = playerSelections.rowSelections.every(count => count >= 2);

        if (checkGameOver()) {
            console.log("Todas las fichas han sido reveladas. Reiniciando tablero pero manteniendo puntuaciones");

            // Reiniciar solo el tablero
            await resetBoardOnly();

            return;
        }

        if (allRowsFull) {
            console.log(`${user.username} ha seleccionado todas sus fichas permitidas, pasando al siguiente jugador`);
            socket.emit('message', 'Has seleccionado todas tus fichas permitidas, pasando al siguiente jugador');

            // Pasar al siguiente jugador
            clearTimeout(turnTimer);
            setTimeout(() => {
                startPlayerTurn();
            }, 500);
        }

        // Para múltiples jugadores, verificar si se revelaron todas las fichas
        if (gameState.players.length > 1 && checkGameOver()) {
            console.log("Todas las fichas han sido reveladas. Reiniciando tablero pero manteniendo puntuaciones");

            // Reiniciar solo el tablero
            await resetBoardOnly();

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
    socket.on('syncScore', async ({ userId }) => {
        console.log(`Solicitada sincronización de puntaje para: ${userId}`);
        const user = getUserById(userId);
        if (user) {
            // Verificar y corregir bloqueo incorrecto
            if (!user.isAdmin && user.score > 23000 && user.isLockedDueToScore) {
                console.log(`Corrigiendo bloqueo incorrecto para ${user.username} en syncScore`);
                user.isLockedDueToScore = false;
                
                // Notificar al usuario
                socket.emit('blockStatusChanged', {
                    isLockedDueToScore: false,
                    message: 'Tu cuenta ha sido desbloqueada automáticamente.'
                });
                
                // Actualizar en Firebase
                if (db) {
                    queueGameStateChange(`gameState/userScores/${userId}/isLockedDueToScore`, false);
                }
            }
            
            console.log(`Enviando puntaje actualizado: ${user.score}`);
            socket.emit('directScoreUpdate', user.score);

            // Sincronizar estado completo del juego
            syncPlayerState(userId, socket.id);
        }
    });

    // Evento para recargar puntos (solo para administradores)
    socket.on('rechargePoints', async ({ userId }, callback) => {
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
        
        // Desbloquear también por puntaje (IMPORTANTE)
        targetUser.isLockedDueToScore = false;

        // Actualizar en Firebase
        if (db) {
            try {
                await db.ref(`gameState/userScores/${userId}`).update({
                    score: targetUser.score,
                    prevScore: targetUser.prevScore,
                    isBlocked: false,
                    isLockedDueToScore: false // Garantizar desbloqueo completo
                });
                console.log(`Recarga de puntos para ${targetUser.username} actualizada en Firebase`);
            } catch (error) {
                console.error(`Error al actualizar recarga de puntos en Firebase:`, error);
            }
        }

        // Notificar al usuario si está conectado
        const playerSocketId = gameState.players.find(p => p.id === userId)?.socketId;
        if (playerSocketId) {
            io.to(playerSocketId).emit('forceScoreUpdate', targetUser.score);
            io.to(playerSocketId).emit('message', 'Un administrador ha recargado 6,000 puntos a tu cuenta');
            io.to(playerSocketId).emit('blockStatusChanged', {
                isBlocked: false,
                isLockedDueToScore: false, // Notificar ambos desbloqueos
                message: 'Un administrador ha recargado puntos a tu cuenta.'
            });
        }

        // Guardar estado
        await saveGameState();

        callback({ success: true });
    });

    // Evento para reiniciar los contadores de mesas (solo para admin)
    socket.on('adminResetTables', async (callback) => {
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

        await adminResetTableCounters();
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
    socket.on('updatePoints', async ({ userId, points }, callback) => {
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

        // Actualizar en Firebase
        if (db) {
            try {
                await db.ref(`gameState/userScores/${userId}`).update({
                    score: newScore,
                    prevScore: targetUser.prevScore
                });
                console.log(`Actualización de puntos para ${targetUser.username} registrada en Firebase`);
            } catch (error) {
                console.error('Error al actualizar puntos en Firebase:', error);
            }
        }

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
        await saveGameState();

        callback({ success: true });
    });

    // Bloquear/desbloquear usuario (solo para admins)
    socket.on('toggleBlockUser', async ({ userId }, callback) => {
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

        // Actualizar en Firebase
        if (db) {
            try {
                await db.ref(`gameState/userScores/${userId}/isBlocked`).set(targetUser.isBlocked);
                console.log(`Estado de bloqueo para ${targetUser.username} actualizado en Firebase`);
            } catch (error) {
                console.error('Error al actualizar estado de bloqueo en Firebase:', error);
            }
        }

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
            players: gameState.players.map(player => {
                const userData = getUserById(player.id);
                return {
                    id: player.id,
                    username: player.username,
                    isBlocked: userData ? userData.isBlocked : false,
                    isLockedDueToScore: userData ? (userData.score <= 23000 ? userData.isLockedDueToScore : false) : false,
                    isConnected: player.isConnected
                };
            }),
            status: 'playing',
            turnStartTime: gameState.turnStartTime,
            rowSelections: gameState.rowSelections
        });

        // Guardar estado después de cambiar bloqueo
        await saveGameState();

        callback({ success: true });
    });

    // Evento para desbloquear usuario por puntaje (solo para admins)
    socket.on('unlockUserScore', async ({ userId }, callback) => {
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

        // Actualizar en Firebase
        if (db) {
            try {
                await db.ref(`gameState/userScores/${userId}/isLockedDueToScore`).set(false);
                console.log(`Desbloqueo por puntaje para ${targetUser.username} actualizado en Firebase`);
            } catch (error) {
                console.error('Error al actualizar desbloqueo por puntaje en Firebase:', error);
            }
        }

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
        await saveGameState();

        callback({ success: true });
    });

    // Reiniciar juego (solo para admins)
    socket.on('resetGame', async (callback) => {
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

        await resetGame();
        callback({ success: true });
    });

    // Actualización directa de puntos (para admin) - NUEVO
    socket.on('directSetPoints', async ({ userId, newPoints }, callback) => {
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

        // Actualizar en Firebase
        if (db) {
            try {
                await db.ref(`gameState/userScores/${userId}`).update({
                    score: targetUser.score,
                    prevScore: targetUser.prevScore
                });
                console.log(`Puntuación fijada directamente para ${targetUser.username} en Firebase`);
            } catch (error) {
                console.error('Error al fijar puntuación directamente en Firebase:', error);
            }
        }

        // Verificar si debe ser bloqueado
        checkScoreLimit(targetUser);

        // Guardar estado después de actualizar puntos
        await saveGameState();

        // Notificar al usuario, si está conectado
        const playerSocketId = gameState.players.find(p => p.id === userId)?.socketId;
        if (playerSocketId) {
            io.to(playerSocketId).emit('forceScoreUpdate', targetUser.score);

            // Notificar si quedó bloqueado por puntaje
            if (targetUser.isLockedDueToScore) {
                io.to(playerSocketId).emit('blockStatusChanged', {
                    isLockedDueToScore: true,
                    message: 'Has alcanzado 23,000 puntos o menos y has sido bloqueado temporalmente.'
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
    socket.on('unlockTables', async ({ userId }, callback) => {
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

        // Actualizar en Firebase
        if (db) {
            try {
                await db.ref(`gameState/userScores/${userId}/tablesPlayed`).set(0);
                console.log(`Contador de mesas para ${targetUser.username} reiniciado en Firebase`);
            } catch (error) {
                console.error('Error al reiniciar contador de mesas en Firebase:', error);
            }
        }

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
        await saveGameState();

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

            // Actualizar en Firebase
            if (db) {
                queueGameStateChange(`gameState/players/${playerIndex}/isConnected`, false);
            }

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

            // Guardar estado específico del jugador
            playerGameState[userId] = {
                board: gameState.board.map(tile => ({
                    ...tile,
                    value: tile.revealed ? tile.value : null
                })),
                score: getUserById(userId).score,
                prevScore: getUserById(userId).prevScore,
                rowSelections: gameState.playerSelections[userId]?.rowSelections || [0, 0, 0, 0],
                tablesPlayed: playerTableCount[userId] || 0,
                timestamp: Date.now()
            };

            // Actualizar en Firebase
            if (db) {
                queueGameStateChange(`gameState/playerGameStates/${userId}`, playerGameState[userId]);
            }

            // Actualizar estado para todos
            io.emit('gameState', {
                board: gameState.board.map(tile => ({
                    ...tile,
                    value: tile.revealed ? tile.value : null
                })),
                currentPlayer: gameState.currentPlayer,
                players: gameState.players.map(player => {
                    const userData = getUserById(player.id);
                    return {
                        id: player.id,
                        username: player.username,
                        isBlocked: userData ? userData.isBlocked : false,
                        isLockedDueToScore: userData ? (userData.score <= 23000 ? userData.isLockedDueToScore : false) : false,
                        isConnected: player.isConnected
                    };
                }),
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

            // Guardar estado específico del jugador antes de marcar como desconectado
            if (userId) {
                const user = getUserById(userId);
                if (user) {
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

                    // Actualizar en Firebase
                    if (db) {
                        queueGameStateChange(`gameState/playerGameStates/${userId}`, playerGameState[userId]);
                    }
                }
            }

            // Marcar al jugador como desconectado pero mantenerlo en la lista
            const playerIndex = gameState.players.findIndex(player => player.id === userId);
            if (playerIndex !== -1) {
                gameState.players[playerIndex].isConnected = false;

                // Actualizar en Firebase
                if (db) {
                    queueGameStateChange(`gameState/players/${playerIndex}/isConnected`, false);
                }

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

            // Guardar estado después de la desconexión
            saveGameState();
        }
    });

    socket.on('completeBoard', async ({ userId }) => {
        const user = getUserById(userId);
        if (!user) return;

        console.log(`Usuario ${user.username} completó su tablero, pero esperando a que se revelen todas las fichas`);
        
        // Verificar estados de bloqueo para detectar inconsistencias
        verifyBlockingStates();

        // Enviar mensaje al usuario
        socket.emit('message', 'Has completado tus selecciones. Esperando a que se revelen todas las fichas del tablero.');

        // Guardar estado
        await saveGameState();
    });

    // Ping/pong para detectar desconexiones
    socket.on('ping', (data, callback) => {
        if (typeof callback === 'function') {
            callback({
                status: 'active',
                timestamp: Date.now()
            });
        }
    });
});

// Configurar guardado periódico más frecuente
setInterval(async () => {
    try {
        await saveGameState();
    } catch (error) {
        console.error('Error en guardado periódico:', error);
    }
}, 30 * 1000); // Cada 30 segundos

// Función para verificar estado de Firebase y reconectar si es necesario
const checkFirebaseConnection = async () => {
    if (!db) return; // Si Firebase no está configurado, no hacer nada

    try {
        // Intento de escritura para verificar conexión
        const testRef = db.ref('connection_test');
        await testRef.set({
            timestamp: Date.now(),
            serverTime: admin.database.ServerValue.TIMESTAMP
        });
        console.log('Conexión a Firebase verificada correctamente');
    } catch (error) {
        console.error('Error en la conexión a Firebase, intentando reconectar:', error);

        // Intentar reconectar
        try {
            // En un entorno real, aquí iría código para reinicializar la conexión
            // Pero en Firebase Admin SDK no es necesario ya que maneja reconexiones automáticamente
            console.log('Firebase maneja reconexiones automáticamente');

            // Forzar sincronización después de reconectar
            await saveGameState();
            console.log('Estado sincronizado después de verificar conexión');
        } catch (reconnectError) {
            console.error('Error al reconectar con Firebase:', reconnectError);
        }
    }
};

// Verificar la conexión a Firebase cada 5 minutos
setInterval(checkFirebaseConnection, 5 * 60 * 1000);

// Limpieza de memoria en desuso - cada 30 minutos
setInterval(() => {
    // Limpiar datos de conexiones inactivas
    let disconnectedCount = 0;

    // Verificar y limpiar conexiones inactivas
    for (const socketId in connectedSockets) {
        const userId = connectedSockets[socketId];
        const playerIndex = gameState.players.findIndex(player => player.id === userId);

        if (playerIndex !== -1 && !gameState.players[playerIndex].isConnected) {
            // Si el jugador lleva más de 1 hora desconectado, eliminarlo de la lista
            const lastActivity = playerGameState[userId]?.timestamp || 0;
            if (Date.now() - lastActivity > 60 * 60 * 1000) {
                delete connectedSockets[socketId];
                disconnectedCount++;
            }
        }
    }

    if (disconnectedCount > 0) {
        console.log(`Limpieza periódica: ${disconnectedCount} conexiones inactivas eliminadas`);
    }

    // Verificar bloqueos incorrectos periódicamente
    forceUnblockAllPlayers();

    // Siempre guardar después de la limpieza
    saveGameState();
}, 30 * 60 * 1000);

// Endpoint para verificar la configuración de CORS (para depuración)
app.get('/cors-config', (req, res) => {
    res.json({
        corsOrigins: Array.isArray(corsOptions.origin) ? corsOptions.origin : [corsOptions.origin],
        environment: process.env.NODE_ENV,
        clientUrl: process.env.CLIENT_URL
    });
});

// Endpoint para verificar estado de Firebase
app.get('/firebase-status', async (req, res) => {
    if (!db) {
        return res.json({
            status: 'not_configured',
            message: 'Firebase no está configurado en este servidor'
        });
    }

    try {
        // Intento de escritura para verificar conexión
        const testRef = db.ref('health_check');
        const result = await testRef.set({
            timestamp: Date.now(),
            serverTime: admin.database.ServerValue.TIMESTAMP
        });

        res.json({
            status: 'connected',
            message: 'Conexión a Firebase funcionando correctamente',
            timestamp: Date.now()
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            message: 'Error en la conexión a Firebase',
            error: error.message
        });
    }
});

// Endpoint para verificar el estado del juego actual
app.get('/game-state-summary', (req, res) => {
    // Proporcionar un resumen del estado actual sin datos sensibles
    const summary = {
        totalPlayers: gameState.players.length,
        connectedPlayers: gameState.players.filter(p => p.isConnected).length,
        revealedTiles: gameState.board.filter(t => t.revealed).length,
        tableNumber: globalTableNumber,
        lastSaved: new Date().toISOString()
    };

    res.json(summary);
});

// Endpoint para forzar el desbloqueo de todos los jugadores (para emergencias)
app.get('/force-unblock-players', (req, res) => {
    try {
        const unblocked = forceUnblockAllPlayers();
        res.json({
            status: 'success',
            message: `Desbloqueo forzado ejecutado. ${unblocked} jugadores afectados.`,
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            message: 'Error durante el desbloqueo forzado',
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Logs de inicio
console.log('Entorno:', process.env.NODE_ENV);
console.log('URL del cliente:', process.env.CLIENT_URL);
console.log('Firebase:', db ? 'Configurado' : 'No configurado');

// Iniciar servidor
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
    console.log(`Servidor ejecutándose en el puerto ${PORT}`);

    // Verificar Firebase al inicio
    if (db) {
        checkFirebaseConnection()
            .then(() => console.log('Verificación inicial de Firebase completada'))
            .catch(err => console.error('Error en verificación inicial de Firebase:', err));
    }
    
    // Forzar desbloqueo de todos los jugadores al iniciar el servidor
    forceUnblockAllPlayers();
});

// Ruta básica para comprobar que el servidor está funcionando
app.get('/', (req, res) => {
    res.send('Servidor del juego de memoria funcionando');
});