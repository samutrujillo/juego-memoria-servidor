'use client';

import { useState, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import io from 'socket.io-client';
import PlayerList from '@/components/PlayerList';
import Tile from '@/components/Tile';
import '@/styles/GameBoard.css';
import config from '@/config';

let socket;

export default function Game() {
  // Función para generar un tablero local con distribución perfecta
  const generateLocalBoard = () => {
    const localBoard = [];
    
    // Para cada hilera
    for (let row = 0; row < 4; row++) {
      const rowTiles = [];
      
      // Crear 2 fichas ganadoras y 2 perdedoras para esta hilera
      for (let i = 0; i < 2; i++) {
        rowTiles.push({ value: 15000, revealed: false });
      }
      for (let i = 0; i < 2; i++) {
        rowTiles.push({ value: -15000, revealed: false });
      }
      
      // Mezclarlas
      for (let i = rowTiles.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [rowTiles[i], rowTiles[j]] = [rowTiles[j], rowTiles[i]];
      }
      
      // Añadirlas al tablero
      localBoard.push(...rowTiles);
    }
    
    return localBoard;
  };

  const [board, setBoard] = useState([]);
  const [currentPlayer, setCurrentPlayer] = useState(null);
  const [players, setPlayers] = useState([]);
  const [isYourTurn, setIsYourTurn] = useState(false);
  const [score, setScore] = useState(0);
  const [localScore, setLocalScore] = useState(0); // Nuevo estado para manejo de puntaje local
  const [message, setMessage] = useState('');
  const [timeLeft, setTimeLeft] = useState(4);
  const [gameStatus, setGameStatus] = useState('playing'); // Cambiado de 'waiting' a 'playing'
  const [user, setUser] = useState(null);
  const [rowSelections, setRowSelections] = useState([0, 0, 0, 0]);
  const [canSelectTiles, setCanSelectTiles] = useState(true);
  const [isConnected, setIsConnected] = useState(false);
  // Estados para las alertas
  const [showAlert, setShowAlert] = useState(false);
  const [alertType, setAlertType] = useState('');
  const [alertMessage, setAlertMessage] = useState('');
  const router = useRouter();
  
  // Referencia para el audio
  const selectSoundRef = useRef(null);

  // Función para mostrar la alerta
  const showPointsAlert = (points) => {
    const isPositive = points > 0;
    setAlertType(isPositive ? 'success' : 'error');
    setAlertMessage(isPositive ? `¡Ganaste ${points} puntos!` : `¡Perdiste ${Math.abs(points)} puntos!`);
    setShowAlert(true);
    
    // Ocultar la alerta después de 2 segundos sin detener el juego
    setTimeout(() => {
      setShowAlert(false);
    }, 2000);
  };

  // Función para reiniciar el tablero local
  const resetLocalBoard = () => {
    console.log("Reiniciando tablero local...");
    const newBoard = generateLocalBoard();
    setBoard(newBoard);
    setRowSelections([0, 0, 0, 0]);
  };

  useEffect(() => {
    // Recuperar datos de usuario de sessionStorage
    const userData = sessionStorage.getItem('user');
    if (!userData) {
      console.log('No hay datos de usuario en sessionStorage');
      router.push('/');
      return;
    }

    try {
      const parsedUser = JSON.parse(userData);
      console.log('Usuario recuperado de sessionStorage:', parsedUser);
      console.log('Estado inicial del usuario:', { 
        id: parsedUser.id, 
        username: parsedUser.username,
        score: parsedUser.score
      });
      
      setUser(parsedUser);
      setScore(parsedUser.score || 0);
      setLocalScore(parsedUser.score || 0); // Inicializar el puntaje local

      if (parsedUser.isBlocked) {
        setMessage('Tu cuenta está bloqueada. Contacta al administrador.');
        return;
      }

      // Establecer un tablero local con distribución perfecta
      const initialBoard = generateLocalBoard();
      setBoard(initialBoard);
      console.log("Tablero local generado:", initialBoard);

      // Inicializar socket con la configuración centralizada
      console.log('Iniciando conexión con Socket.io a:', config.socketServerUrl);
      socket = io(config.socketServerUrl, config.socketOptions);

      // Añadir manejo específico de errores
      socket.on('error', (error) => {
        console.error('Error de socket:', error);
      });

      socket.io.on('error', (error) => {
        console.error('Error de conexión:', error);
      });

      socket.on('connect', () => {
        setIsConnected(true);
        console.log('Conectado al servidor Socket.io con ID:', socket.id);
        
        // Enviar un evento de prueba para verificar la conexión
        socket.emit('test', { message: 'Prueba de conexión desde juego' });
        
        // Al conectarse, solicitar una sincronización de puntaje
        if (parsedUser && parsedUser.id) {
          socket.emit('syncScore', { userId: parsedUser.id });
          console.log('Solicitando sincronización de puntaje para usuario:', parsedUser.id);
        }
        
        // Una vez conectado, unirse al juego
        socket.emit('joinGame');
        console.log('Evento joinGame enviado');
        
        // Forzar el estado local a 'playing'
        setGameStatus('playing');
        
        // Si hay un solo jugador, establecer isYourTurn a true
        if (players.length <= 1) {
          setIsYourTurn(true);
        }
      });

      socket.on('testResponse', (data) => {
        console.log('Respuesta de prueba recibida:', data);
      });

      // Evento específico para debuggear selección de fichas
      socket.on('tileSelectResponse', (data) => {
        console.log('Respuesta a selección de ficha:', data);
      });

      socket.on('connect_error', (err) => {
        console.error('Error de conexión Socket.io:', err);
        console.error('Detalles adicionales:', {
          message: err.message,
          description: err.description,
          context: err.context
        });
        setIsConnected(false);
        setMessage('Error de conexión con el servidor: ' + err.message);
      });

      socket.on('reconnect_attempt', (attemptNumber) => {
        console.log(`Intento de reconexión #${attemptNumber}`);
      });

      socket.on('reconnect', (attemptNumber) => {
        console.log(`Reconectado después de ${attemptNumber} intentos`);
        setIsConnected(true);
        setMessage('Reconectado al servidor');
        
        // Al reconectar, volver a unirse al juego
        socket.emit('joinGame');
      });

      socket.on('gameState', (gameState) => {
        console.log('Recibido gameState:', gameState);
        
        // Forzar gameState.status a 'playing' si solo hay un jugador
        if (gameState.players && gameState.players.length <= 1) {
          gameState.status = 'playing';
        }
        
        // Si el tablero está vacío o todos los valores están revelados, generar uno nuevo
        let needsNewBoard = false;
        
        if (!gameState.board || gameState.board.length === 0) {
          needsNewBoard = true;
        } else {
          // Verificar si todas las fichas ya están reveladas
          const allRevealed = gameState.board.every(tile => tile.revealed);
          if (allRevealed) {
            needsNewBoard = true;
          }
          
          // Verificar distribución de valores por fila
          const distribution = [0, 0, 0, 0];
          for (let i = 0; i < gameState.board.length; i++) {
            const rowIndex = Math.floor(i / 4);
            if (gameState.board[i].value > 0) {
              distribution[rowIndex]++;
            }
          }
          
          // Si alguna fila no tiene exactamente 2 fichas positivas, necesitamos un nuevo tablero
          for (let i = 0; i < 4; i++) {
            if (distribution[i] !== 2) {
              needsNewBoard = true;
              break;
            }
          }
        }
        
        if (needsNewBoard) {
          console.log("Generando nuevo tablero local...");
          // Generar un nuevo tablero con distribución perfecta
          const newBoard = generateLocalBoard();
          setBoard(newBoard);
          
          // Copiar estados de revelación si existen
          if (gameState.board && gameState.board.length > 0) {
            setBoard(prev => {
              const updatedBoard = [...prev];
              for (let i = 0; i < Math.min(updatedBoard.length, gameState.board.length); i++) {
                if (gameState.board[i].revealed) {
                  updatedBoard[i] = {
                    ...updatedBoard[i],
                    revealed: true
                  };
                }
              }
              return updatedBoard;
            });
          }
        } else {
          // Si la distribución ya es correcta, actualizar solo el estado de revelación
          setBoard(prev => {
            const updatedBoard = [...prev];
            for (let i = 0; i < Math.min(updatedBoard.length, gameState.board.length); i++) {
              if (gameState.board[i].revealed) {
                updatedBoard[i] = {
                  ...updatedBoard[i],
                  revealed: true
                };
              }
            }
            return updatedBoard;
          });
        }
        
        setCurrentPlayer(gameState.currentPlayer);
        setPlayers(gameState.players || []);
        setGameStatus(gameState.status || 'playing'); // Usar 'playing' como valor predeterminado
        
        // Si solo hay un jugador, siempre es su turno mientras el juego esté en progreso
        const isCurrentUserTurn = (gameState.players && gameState.players.length <= 1) || 
          (gameState.currentPlayer && gameState.currentPlayer.id === parsedUser.id);
        
        setIsYourTurn(isCurrentUserTurn);
        
        // Reset timer when it becomes user's turn
        if (isCurrentUserTurn) {
          console.log('Es mi turno ahora');
          setTimeLeft(4);
          setCanSelectTiles(true); // Permitir selección al iniciar nuevo turno
        }
        
        // Actualizar contador de selecciones por hilera
        if (gameState.rowSelections) {
          setRowSelections(gameState.rowSelections);
        }
      });

      // Nuevo evento para actualización directa del puntaje
      socket.on('directScoreUpdate', (newScore) => {
        console.log(`Actualización directa de puntaje: ${newScore}`);
        // Este evento ahora actualiza ambos puntajes - local y remoto
        setScore(newScore);
        setLocalScore(newScore);
      });

      socket.on('forceScoreUpdate', (newScore) => {
        console.log(`FORZANDO actualización de puntaje a: ${newScore}`);
        // Actualizar ambos puntajes
        setScore(newScore);
        setLocalScore(newScore);
        
        // También almacenar en sessionStorage para persistencia
        const userData = sessionStorage.getItem('user');
        if (userData) {
          const parsedUser = JSON.parse(userData);
          parsedUser.score = newScore;
          sessionStorage.setItem('user', JSON.stringify(parsedUser));
          console.log('Puntaje actualizado en sessionStorage:', parsedUser.score);
        }
      });

      socket.on('scoreUpdate', (data) => {
        console.log('Actualización de puntaje recibida:', data);
        
        // Si es un objeto con userId, verificar que sea para este usuario
        if (typeof data === 'object' && data.userId) {
          if (data.userId === parsedUser.id) {
            console.log(`Actualizando mi puntaje a ${data.newScore}`);
            setScore(data.newScore);
            setLocalScore(data.newScore);
          }
        } else {
          // Si es solo un número, actualizar directamente (compatibilidad hacia atrás)
          console.log(`Actualizando mi puntaje a ${data}`);
          setScore(data);
          setLocalScore(data);
        }
      });

      socket.on('tileSelected', ({ tileIndex, tileValue, playerId, newScore, rowSelections }) => {
        console.log(`Recibido evento tileSelected: ficha ${tileIndex}, valor ${tileValue}, jugador ${playerId}, nuevo puntaje ${newScore}`);
        
        // Actualizar el tablero para todos los jugadores
        setBoard(prevBoard => {
          const newBoard = [...prevBoard];
          if (newBoard[tileIndex]) {
            newBoard[tileIndex] = { 
              ...newBoard[tileIndex], 
              revealed: true, 
              value: newBoard[tileIndex].value // Mantener el valor local
            };
          }
          return newBoard;
        });
        
        // Reproducir sonido y mostrar alerta si es mi ficha seleccionada
        if (playerId === parsedUser.id) {
          // Reproducir sonido
          if (selectSoundRef.current) {
            selectSoundRef.current.currentTime = 0;
            selectSoundRef.current.play().catch(e => console.log('Error reproduciendo sonido:', e));
          }
          
          // Usar el valor de nuestro tablero local
          const localTileValue = board[tileIndex]?.value || 0;
          
          // Mostrar alerta con el valor local
          showPointsAlert(localTileValue);
          
          console.log(`Actualizando mi puntaje local desde tileSelected a ${newScore}`);
          setLocalScore(newScore);
        }
        
        // Actualizar contador de selecciones por hilera
        if (rowSelections) {
          setRowSelections(rowSelections);
        }
      });

      socket.on('turnTimeout', ({ playerId }) => {
        console.log(`Tiempo agotado para jugador ${playerId}`);
        
        // Si era mi turno, mostrar mensaje y bloquear selección
        if (playerId === parsedUser.id) {
          console.log('Mi tiempo se agotó');
          setTimeLeft(0);
          setCanSelectTiles(false);
          
          // No establecer isYourTurn a false si eres el único jugador
          if (players.length > 1) {
            setIsYourTurn(false);
          } else {
            setIsYourTurn(true); // Mantener el turno si eres el único jugador
          }
          
          setMessage('¡Tu tiempo se agotó!');
          setTimeout(() => setMessage(''), 2000);
        }
      });

      socket.on('blocked', () => {
        setMessage('Tu cuenta ha sido bloqueada por el administrador.');
        setTimeout(() => {
          router.push('/');
        }, 3000);
      });

      socket.on('message', (newMessage) => {
        setMessage(newMessage);
      });

      socket.on('disconnect', () => {
        setIsConnected(false);
        console.log('Desconectado del servidor');
      });

      // Cleanup on unmount
      return () => {
        console.log('Desconectando Socket.io...');
        if (socket) {
          socket.off('connect');
          socket.off('connect_error');
          socket.off('gameState');
          socket.off('tileSelected');
          socket.off('turnTimeout');
          socket.off('scoreUpdate');
          socket.off('forceScoreUpdate');
          socket.off('directScoreUpdate');
          socket.off('blocked');
          socket.off('message');
          socket.off('tileSelectResponse');
          socket.emit('leaveGame');
          socket.disconnect();
          console.log('Socket desconectado');
        }
      };
    } catch (error) {
      console.error('Error al procesar datos de usuario:', error);
      router.push('/');
    }
  }, [router]);

  // Efecto para el temporizador
  useEffect(() => {
    let timer;
    
    if (isYourTurn) { // Simplificado: siempre que sea tu turno, independientemente del estado
      console.log('Iniciando temporizador de 4 segundos para mi turno');
      // Iniciar con 4 segundos
      setTimeLeft(4);
      setCanSelectTiles(true);
      
      // Actualizar cada segundo
      timer = setInterval(() => {
        setTimeLeft((prevTime) => {
          console.log(`Temporizador: ${prevTime} segundos`);
          if (prevTime <= 1) {
            console.log('Mi tiempo se agotó');
            clearInterval(timer);
            setCanSelectTiles(false);
            return 0;
          }
          return prevTime - 1;
        });
      }, 1000);
    } else {
      // Si no es mi turno, asegurar que el contador esté limpio
      clearInterval(timer);
    }
    
    return () => {
      if (timer) {
        clearInterval(timer);
      }
    };
  }, [isYourTurn]);

  // Función modificada para manejar clics en fichas con puntaje local
  const handleTileClick = (index) => {
    console.log(`Intentando seleccionar ficha ${index}`);
    
    // Verificar si ya está revelada
    if (board[index]?.revealed) {
      console.log("Esta ficha ya está revelada");
      return;
    }
    
    // Verificar si puede seleccionar fichas (tiempo no agotado)
    if (!canSelectTiles) {
      console.log("No puedes seleccionar más fichas en este turno");
      setMessage("¡No puedes seleccionar más fichas en este turno!");
      setTimeout(() => setMessage(''), 2000);
      return;
    }
    
    // Verificar si es mi turno (solo importa si hay más de un jugador)
    if (!isYourTurn && players.length > 1) {
      console.log("No es tu turno para seleccionar una ficha");
      setMessage("¡Espera tu turno!");
      setTimeout(() => setMessage(''), 2000);
      return;
    }
    
    // Verificar si el tiempo está agotado
    if (timeLeft <= 0) {
      console.log("Tiempo agotado para seleccionar fichas");
      setMessage("¡Tiempo agotado para este turno!");
      setTimeout(() => setMessage(''), 2000);
      return;
    }
    
    // Determinar a qué hilera pertenece esta ficha
    const row = Math.floor(index / 4);
    
    // Verificar si ya se seleccionaron 2 fichas de esta hilera
    if (rowSelections[row] >= 2) {
      console.log(`Ya has seleccionado 2 fichas de la hilera ${row + 1}`);
      setMessage(`¡Límite de 2 fichas por hilera alcanzado en hilera ${row + 1}!`);
      setTimeout(() => setMessage(''), 2000);
      return;
    }
    
    // Lógica adicional para manejar puntaje localmente
    const tileValue = board[index]?.value || 0;
    if (!board[index]?.revealed) {
      // Calcular nuevo puntaje localmente
      const newScore = localScore + tileValue;
      setLocalScore(newScore);
      
      // Mostrar alerta de puntos ganados/perdidos
      showPointsAlert(tileValue);
      
      // Guardar en sessionStorage
      try {
        const userData = sessionStorage.getItem('user');
        if (userData) {
          const user = JSON.parse(userData);
          user.score = newScore;
          sessionStorage.setItem('user', JSON.stringify(user));
          console.log('Puntaje local actualizado en sessionStorage:', newScore);
        }
      } catch (error) {
        console.error('Error actualizando sessionStorage:', error);
      }
      
      // Mostrar mensaje de puntos ganados/perdidos
      const messageText = tileValue > 0 
        ? `¡Ganaste ${tileValue} puntos!` 
        : `Perdiste ${Math.abs(tileValue)} puntos`;
      setMessage(messageText);
      setTimeout(() => setMessage(''), 2000);
      
      // Actualizar el tablero localmente
      setBoard(prevBoard => {
        const newBoard = [...prevBoard];
        if (newBoard[index]) {
          newBoard[index] = { 
            ...newBoard[index], 
            revealed: true
          };
        }
        return newBoard;
      });
      
      // Actualizar contador de selecciones por hilera
      setRowSelections(prev => {
        const updated = [...prev];
        updated[row]++;
        return updated;
      });
    }
    
    // Enviar el evento al servidor para actualizar otros jugadores
    console.log(`Enviando selección de ficha al servidor. Estado: ${gameStatus}, isYourTurn: ${isYourTurn}`);
    socket.emit('selectTile', { tileIndex: index });
  };

  console.log('Renderizando con puntaje local:', localScore);

  if (!user) {
    return <div className="loading">Cargando...</div>;
  }

  return (
    <div className="game-container">
      {/* Audio para el sonido de selección de ficha */}
      <audio ref={selectSoundRef} src="/sounds/tile-select.mp3" preload="auto"></audio>
      
      {/* Alerta para puntos ganados/perdidos */}
      {showAlert && (
        <div className={`points-alert ${alertType}`}>
          {alertMessage}
        </div>
      )}
      
      <div className="game-info">
        <h2>Jugador: {user?.username}</h2>
        
        {isConnected ? (
          <div className="connection-status connected">Conectado al servidor</div>
        ) : (
          <div className="connection-status disconnected">Desconectado del servidor</div>
        )}

        <div className="game-score">
          Puntaje: {localScore}
        </div>

        {currentPlayer && (
          <div className="current-player">
            Jugador actual: {currentPlayer.username}
            {isYourTurn && <span className="your-turn"> (¡Tu turno!)</span>}
          </div>
        )}

        <div className="time-display">
          {isYourTurn ? (
            <>Tiempo restante: <span className={`timer-value ${timeLeft === 0 ? 'time-up' : ''}`}>{timeLeft}</span> segundos</>
          ) : (
            players.length <= 1 ? "¡Tu turno!" : "Esperando turno..."
          )}
        </div>
        
        <div className="rows-info">
          Límites por hilera: 
          {rowSelections.map((count, index) => (
            <span key={index} className={count >= 2 ? 'row-limit-reached' : ''}>
              Hilera {index + 1}: {count}/2
            </span>
          ))}
        </div>

        {message && <div className="message">{message}</div>}
        
        {/* Botón oculto para reiniciar el tablero (solo para depuración) */}
        <button 
          onClick={resetLocalBoard} 
          style={{ display: 'none' }}
        >
          Reiniciar Tablero
        </button>
      </div>

      <div className="game-board">
        {Array.isArray(board) && board.length > 0 ? (
          board.map((tile, index) => (
            <Tile
              key={index}
              index={index}
              revealed={tile?.revealed || false}
              value={tile?.value || 0}
              onClick={() => handleTileClick(index)}
              disabled={
                tile?.revealed || 
                !canSelectTiles || 
                timeLeft <= 0 || 
                rowSelections[Math.floor(index / 4)] >= 2
              }
            />
          ))
        ) : (
          <div className="loading-message">
            Cargando tablero...
            <button
              onClick={() => {
                if (socket) {
                  socket.emit('joinGame');
                }
              }}
              className="retry-button"
            >
              Reintentar
            </button>
          </div>
        )}
      </div>

      <div className="players-section">
        <h3>Jugadores conectados</h3>
        <PlayerList players={players} currentPlayerId={currentPlayer?.id} />
      </div>
      
      <button 
        onClick={() => {
          console.log('Estado de la conexión:', socket.connected ? 'Conectado' : 'Desconectado');
          socket.emit('test', { message: 'Prueba manual' });
        }}
        style={{
          marginTop: '20px',
          padding: '10px',
          background: '#333',
          color: 'white',
          border: 'none',
          borderRadius: '4px',
          cursor: 'pointer'
        }}
      >
        Verificar Conexión
      </button>
    </div>
  );
}