// Cargar variables de entorno
if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config();
  }
  
  const express = require('express');
  const http = require('http');
  const { Server } = require('socket.io');
  const cors = require('cors');
  const { v4: uuidv4 } = require('uuid');
  
  const app = express();
  
  // Configuración de CORS basada en entorno
  const corsOptions = {
    origin: process.env.NODE_ENV === 'production' 
      ? [process.env.CLIENT_URL || 'https://juego-memoria-cliente.onrender.com'] 
      : ['http://localhost:3000'],
    methods: ['GET', 'POST'],
    credentials: true
  };
  
  app.use(cors(corsOptions));
  
  const server = http.createServer(app);
  const io = new Server(server, {
      cors: corsOptions,
      pingTimeout: 60000,
      pingInterval: 25000
  });
  
  // Datos de usuario (en una aplicación real, esto estaría en una base de datos)
  const users = [
      { id: '1', username: 'jugador1', password: 'clave1', score: 0, isAdmin: false, isBlocked: false },
      { id: '2', username: 'jugador2', password: 'clave2', score: 0, isAdmin: false, isBlocked: false },
      { id: '3', username: 'jugador3', password: 'clave3', score: 0, isAdmin: false, isBlocked: false },
      { id: '4', username: 'jugador4', password: 'clave4', score: 0, isAdmin: false, isBlocked: false },
      { id: '5', username: 'jugador5', password: 'clave5', score: 0, isAdmin: false, isBlocked: false },
      { id: '6', username: 'jugador6', password: 'clave6', score: 0, isAdmin: false, isBlocked: false },
      { id: '7', username: 'jugador7', password: 'clave7', score: 0, isAdmin: false, isBlocked: false },
      { id: '8', username: 'jugador8', password: 'clave8', score: 0, isAdmin: false, isBlocked: false },
      { id: '9', username: 'jugador9', password: 'clave9', score: 0, isAdmin: false, isBlocked: false },
      { id: '10', username: 'jugador10', password: 'clave10', score: 0, isAdmin: false, isBlocked: false },
      { id: 'admin', username: 'admin', password: 'admin123', score: 0, isAdmin: true, isBlocked: false }
  ];
  
  // Mapa de Socket IDs a usuarios
  const connectedSockets = {};
  
  // Estado del juego
  let gameState = {
      board: generateBoard(),
      players: [],
      currentPlayerIndex: 0,
      currentPlayer: null,
      status: 'playing', // Inicializamos directamente como 'playing' en lugar de 'waiting'
      turnStartTime: null,
      rowSelections: [0, 0, 0, 0]  // Contador para cada hilera (4 hileras en total)
  };
  
  let turnTimer = null;
  
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
      return gameState.board.every(tile => tile.revealed);
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
  
  // Reiniciar el juego
  function resetGame() {
      gameState.board = generateBoard();
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
              isBlocked: getUserById(player.id).isBlocked
          })),
          status: 'playing',
          turnStartTime: gameState.turnStartTime,
          rowSelections: gameState.rowSelections
      });
  
      if (gameState.players.length > 0) {
          startPlayerTurn();
      }
  }
  
  // Función para iniciar el turno de un jugador
  function startPlayerTurn() {
      if (gameState.players.length === 0) return;
  
      // IMPORTANTE: Agregar este log para depuración
      console.log(`startPlayerTurn llamada con ${gameState.players.length} jugadores`);
  
      // Siempre forzar el estado a 'playing'
      gameState.status = 'playing';
      gameState.rowSelections = [0, 0, 0, 0];  // Reiniciar contador de cada hilera
  
      // Si solo hay un jugador, ese jugador siempre es el actual
      if (gameState.players.length === 1) {
          gameState.currentPlayerIndex = 0;
          gameState.currentPlayer = gameState.players[0];
  
          // Temporizador para un solo jugador (opcional, puede ser útil para mantener el ritmo del juego)
          clearTimeout(turnTimer);
          turnTimer = setTimeout(() => {
              console.log(`Tiempo agotado para ${gameState.currentPlayer.username}`);
              io.emit('turnTimeout', { playerId: gameState.currentPlayer.id });
              // Reiniciar el turno del mismo jugador
              setTimeout(() => {
                  startPlayerTurn();
              }, 500);
          }, 4000);
      } else {
          // Lógica para múltiples jugadores
          gameState.currentPlayerIndex = (gameState.currentPlayerIndex + 1) % gameState.players.length;
          let nextPlayerIndex = gameState.currentPlayerIndex;
  
          // Buscar el siguiente jugador no bloqueado
          let loopCount = 0;
          while (
              loopCount < gameState.players.length &&
              getUserById(gameState.players[nextPlayerIndex].id).isBlocked
          ) {
              nextPlayerIndex = (nextPlayerIndex + 1) % gameState.players.length;
              loopCount++;
              if (loopCount >= gameState.players.length) {
                  console.log("Todos los jugadores están bloqueados");
                  return; // Evita un bucle infinito
              }
          }
  
          // Asignar el nuevo jugador actual
          gameState.currentPlayerIndex = nextPlayerIndex;
          gameState.currentPlayer = gameState.players[gameState.currentPlayerIndex];
  
          console.log(`Turno de ${gameState.currentPlayer.username}, tiene 4 segundos`);
  
          // Establecer temporizador
          clearTimeout(turnTimer);
          turnTimer = setTimeout(() => {
              console.log(`Tiempo agotado para ${gameState.currentPlayer.username}`);
              io.emit('turnTimeout', { playerId: gameState.currentPlayer.id });
              // Pequeña pausa antes de pasar al siguiente jugador
              setTimeout(() => {
                  startPlayerTurn();
              }, 500);
          }, 4000);
      }
  
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
              isBlocked: getUserById(player.id).isBlocked
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
  
      // Login
      socket.on('login', (credentials, callback) => {
          const user = users.find(
              u => u.username === credentials.username && u.password === credentials.password
          );
  
          if (!user) {
              callback({ success: false, message: 'Credenciales incorrectas' });
              return;
          }
  
          if (gameState.players.some(p => p.id === user.id)) {
              callback({ success: false, message: 'Usuario ya está conectado' });
              return;
          }
  
          // Registrar usuario en el socket
          connectedSockets[socket.id] = user.id;
          console.log(`Usuario ${user.username} autenticado con socket ${socket.id}`);
  
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
  
          // Verificar si el jugador ya está en el juego
          if (!gameState.players.some(player => player.id === userId)) {
              gameState.players.push({
                  id: userId,
                  username: user.username,
                  socketId: socket.id
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
                      isBlocked: getUserById(player.id).isBlocked
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
                      isBlocked: getUserById(player.id).isBlocked
                  })),
                  status: 'playing',
                  rowSelections: gameState.rowSelections
              });
          } else {
              // Actualizar socketId para reconexión
              const playerIndex = gameState.players.findIndex(player => player.id === userId);
              if (playerIndex !== -1) {
                  gameState.players[playerIndex].socketId = socket.id;
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
                      isBlocked: getUserById(player.id).isBlocked
                  })),
                  status: 'playing',  // Forzar estado 'playing' explícitamente aquí también
                  rowSelections: gameState.rowSelections
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
          
          // Determinar a qué hilera pertenece esta ficha (4 fichas por hilera en un tablero 4x4)
          const row = Math.floor(tileIndex / 4);
          
          // Verificar si ya se seleccionaron 2 fichas de esta hilera
          if (gameState.rowSelections[row] >= 2) {
              console.log(`Jugador ${user.username} ya seleccionó 2 fichas de la hilera ${row + 1}`);
              socket.emit('message', `Ya has seleccionado 2 fichas de la hilera ${row + 1}`);
              return;
          }
          
          console.log(`Jugador ${user.username} seleccionó ficha ${tileIndex} de la hilera ${row + 1}`);
          
          // Incrementar contador para esta hilera
          gameState.rowSelections[row]++;
          
          console.log(`Fichas seleccionadas en hilera ${row + 1}: ${gameState.rowSelections[row]}/2`);
          
          // Revelar la ficha
          gameState.board[tileIndex].revealed = true;
          const tileValue = gameState.board[tileIndex].value;
          
          // Actualizar puntuación
          const oldScore = user.score;
          user.score += tileValue;
          const newScore = user.score;
          
          console.log(`PUNTUACIÓN ACTUALIZADA: ${user.username} ${oldScore} -> ${newScore} (${tileValue})`);
          
          // Emitir eventos
          io.emit('tileSelected', {
              tileIndex,
              tileValue,
              playerId: userId,
              newScore: newScore,
              rowSelections: gameState.rowSelections
          });
          
          socket.emit('forceScoreUpdate', newScore);
          
          // Verificar si el juego ha terminado
          if (checkGameOver()) {
              gameState.status = 'gameover';
              clearTimeout(turnTimer);
              
              io.emit('gameState', {
                  board: gameState.board,
                  currentPlayer: null,
                  players: gameState.players.map(player => ({
                      id: player.id,
                      username: player.username,
                      isBlocked: getUserById(player.id).isBlocked
                  })),
                  status: gameState.status,
                  rowSelections: gameState.rowSelections
              });
              
              setTimeout(() => {
                  resetGame();
              }, 5000);
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
                  isBlocked: getUserById(player.id).isBlocked
              })),
              status: 'playing',
              turnStartTime: gameState.turnStartTime,
              rowSelections: gameState.rowSelections
          });
  
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
  
      // Salir del juego
      socket.on('leaveGame', () => {
          const userId = connectedSockets[socket.id];
          if (!userId) return;
  
          // Eliminar jugador de la lista
          const playerIndex = gameState.players.findIndex(player => player.id === userId);
          if (playerIndex !== -1) {
              gameState.players.splice(playerIndex, 1);
  
              // Si era el turno de este jugador, pasar al siguiente
              if (gameState.currentPlayer && gameState.currentPlayer.id === userId) {
                  clearTimeout(turnTimer);
                  if (gameState.players.length > 0) {
                      startPlayerTurn();
                  }
              }
  
              // Si no quedan jugadores, mantener el estado en 'playing' pero sin jugador actual
              if (gameState.players.length === 0) {
                  gameState.currentPlayer = null;
                  clearTimeout(turnTimer);
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
                      isBlocked: getUserById(player.id).isBlocked
                  })),
                  status: 'playing', // Mantener el estado como 'playing' siempre
                  turnStartTime: gameState.turnStartTime,
                  rowSelections: gameState.rowSelections
              });
          }
      });
  
      // Desconexión
      socket.on('disconnect', () => {
          console.log(`Usuario desconectado: ${socket.id}`);
  
          const userId = connectedSockets[socket.id];
          if (userId) {
              // No eliminamos al jugador inmediatamente para permitir reconexiones
              delete connectedSockets[socket.id];
  
              // Si era el turno de este jugador, pasar al siguiente después de un tiempo
              if (gameState.currentPlayer && gameState.currentPlayer.id === userId) {
                  clearTimeout(turnTimer);
                  setTimeout(() => {
                      // Verificar si el jugador se reconectó
                      const reconnected = Object.values(connectedSockets).includes(userId);
                      if (!reconnected) {
                          startPlayerTurn();
                      }
                  }, 5000);
              }
          }
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