'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import io from 'socket.io-client';
import PlayerList from '@/components/PlayerList';
import Tile from '@/components/Tile';
import AdminButton from '@/components/AdminButton';
import '@/styles/GameBoard.css';
import config from '@/config';

let socket;

// Componente para ocultar el logo programáticamente
const HideLogoEffect = () => {
  useEffect(() => {
    // Ocultar el logo al montar el componente
    const logoElement = document.querySelector('.app-title');
    if (logoElement) {
      logoElement.style.display = 'none';
    }
    
    // Restaurar visibilidad al desmontar (si es necesario)
    return () => {
      const logoElement = document.querySelector('.app-title');
      if (logoElement) {
        logoElement.style.display = 'block';
      }
    };
  }, []);
  
  return null;
};

export default function Game() {
  // Función para generar un tablero local con distribución perfecta
  const generateLocalBoard = () => {
    const localBoard = [];
    
    // Para cada hilera
    for (let row = 0; row < 4; row++) {
      const rowTiles = [];
      
      // Crear 2 fichas ganadoras (+15000) y 2 perdedoras (-15000) para esta hilera
      for (let i = 0; i < 2; i++) {
        rowTiles.push({ value: 15000, revealed: false });  // Asegurarse que es positivo
      }
      for (let i = 0; i < 2; i++) {
        rowTiles.push({ value: -15000, revealed: false }); // Asegurarse que es negativo
      }
      
      // Mezclarlas
      for (let i = rowTiles.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [rowTiles[i], rowTiles[j]] = [rowTiles[j], rowTiles[i]];
      }
      
      // Añadirlas al tablero
      localBoard.push(...rowTiles);
    }
    
    // Validación adicional para verificar los valores
    console.log('Tablero local generado:', localBoard.map(tile => tile.value));
    
    return localBoard;
  };

  const [board, setBoard] = useState([]);
  const [currentPlayer, setCurrentPlayer] = useState(null);
  const [players, setPlayers] = useState([]);
  const [isYourTurn, setIsYourTurn] = useState(false);
  const [score, setScore] = useState(6000);
  const [localScore, setLocalScore] = useState(6000);
  const [message, setMessage] = useState('');
  const [timeLeft, setTimeLeft] = useState(4);
  const [gameStatus, setGameStatus] = useState('playing');
  const [user, setUser] = useState(null);
  const [rowSelections, setRowSelections] = useState([0, 0, 0, 0]);
  const [canSelectTiles, setCanSelectTiles] = useState(true);
  const [isConnected, setIsConnected] = useState(false);
  const [lastSelectedTile, setLastSelectedTile] = useState(null);
  const [turnNotification, setTurnNotification] = useState('');
  
  // Nuevos estados para el sistema de mesas
  const [tablesPlayed, setTablesPlayed] = useState(0);
  const [currentTableNumber, setCurrentTableNumber] = useState(1); // Iniciar en mesa 1
  const [maxTablesReached, setMaxTablesReached] = useState(false);
  const [tableLockReason, setTableLockReason] = useState('');
  
  // Estado para alertas
  const [showAlert, setShowAlert] = useState(false);
  const [alertType, setAlertType] = useState('');
  const [alertMessage, setAlertMessage] = useState('');
  
  // Estado para modal de administrador
  const [showAdminModal, setShowAdminModal] = useState(false);
  
  // Nuevo estado para el bloqueo por puntaje
  const [isScoreLocked, setIsScoreLocked] = useState(false);
  
  const router = useRouter();
  
  // Referencias para los sonidos
  const winSoundRef = useRef(null);
  const loseSoundRef = useRef(null);
  const turnSoundRef = useRef(null);
  
  // Referencia para seguimiento de cambios en puntuación
  const prevScoreRef = useRef();

  // Función segura para reproducir sonidos (ignora errores)
  const playSoundSafely = (audioRef, volume = 1.0) => {
    if (audioRef && audioRef.current) {
      audioRef.current.volume = volume;
      audioRef.current.currentTime = 0;
      
      // Usar Promise.catch para manejar errores silenciosamente
      const playPromise = audioRef.current.play();
      if (playPromise !== undefined) {
        playPromise.catch(error => {
          console.log('Error reproduciendo sonido (ignorado):', error);
        });
      }
    }
  };

  // Función para cerrar sesión y guardar el estado actual
  const handleLogout = () => {
    if (socket) {
      socket.emit('saveGameState', { userId: user.id });
      socket.disconnect();
    }
    sessionStorage.removeItem('user');
    router.push('/');
  };

  // Función para mostrar la alerta
  const showPointsAlert = (points) => {
    const isPositive = points > 0;
    setAlertType(isPositive ? 'success' : 'error');
    setAlertMessage(isPositive 
      ? `¡Ganaste ${points} puntos!` 
      : `¡Perdiste ${Math.abs(points)} puntos!`);
    setShowAlert(true);
    
    // Reproducir el sonido correspondiente
    if (isPositive) {
      playSoundSafely(winSoundRef);
    } else {
      playSoundSafely(loseSoundRef);
    }
    
    setTimeout(() => {
      setShowAlert(false);
    }, 2000);
  };

  // Función para mostrar notificaciones de acciones de otros jugadores
  const showPlayerActionNotification = (username, value) => {
    const isPositive = value > 0;
    const message = isPositive 
      ? `${username} ganó ${value} puntos` 
      : `${username} perdió ${Math.abs(value)} puntos`;
    
    setMessage(message);
    setTimeout(() => setMessage(''), 2000);
  };

  // Función para mostrar notificación de cambio de turno
  const showTurnNotification = (player, isYourTurnNow) => {
    if (isYourTurnNow) {
      setTurnNotification('¡Es tu turno ahora!');
      playSoundSafely(turnSoundRef);
    } else {
      setTurnNotification(`Turno de ${player.username}`);
    }
    
    // Reducido a 1.5 segundos como solicitado
    setTimeout(() => {
      setTurnNotification('');
    }, 1500);
  };

  // Función para actualizar el puntaje local con persistencia
  const updateLocalScore = (newScore) => {
    setLocalScore(newScore);
    
    try {
      const userData = sessionStorage.getItem('user');
      if (userData) {
        const userObj = JSON.parse(userData);
        userObj.score = newScore;
        sessionStorage.setItem('user', JSON.stringify(userObj));
        console.log('Puntaje actualizado en sessionStorage:', newScore);
      }
    } catch (error) {
      console.error('Error actualizando sessionStorage:', error);
    }
  };

  // Función para abrir el modal de administrador
  const handleAdminPanel = () => {
    setShowAdminModal(true);
  };

  // Efecto adicional para verificar y registrar el estado del usuario administrador
  useEffect(() => {
    if (user) {
      console.log("Estado de usuario:", {
        username: user.username,
        isAdmin: user.isAdmin,
        id: user.id,
        isLockedDueToScore: user.isLockedDueToScore,
        isBlocked: user.isBlocked
      });
      
      // Inicializar el estado de bloqueo por puntaje
      setIsScoreLocked(user.isLockedDueToScore || false);
    }
  }, [user]);

  useEffect(() => {
    // Recuperar datos de usuario de sessionStorage
    const userData = sessionStorage.getItem('user');
    if (!userData) {
      router.push('/');
      return;
    }

    try {
      const parsedUser = JSON.parse(userData);
      setUser(parsedUser);
      setScore(parsedUser.score || 6000);
      setLocalScore(parsedUser.score || 6000);
      setIsScoreLocked(parsedUser.isLockedDueToScore || false);
      
      // Inicializar referencia de puntuación
      prevScoreRef.current = parsedUser.score || 6000;

      // Establecer un tablero local
      const initialBoard = generateLocalBoard();
      setBoard(initialBoard);

      // Inicializar socket con opciones mejoradas para compatibilidad móvil
      socket = io(config.socketServerUrl, {
        ...config.socketOptions,
        reconnection: true,
        reconnectionAttempts: 10,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        timeout: 20000, // Aumentar timeout para conexiones móviles lentas
        forceNew: false,
        transports: ['websocket', 'polling'] // Asegurar compatibilidad con todos los dispositivos
      });

      socket.on('connect', () => {
        setIsConnected(true);
        
        // Enviar evento para reconectar al usuario
        socket.emit('reconnectUser', {
          userId: parsedUser.id,
          username: parsedUser.username
        });
        
        // Solicitar sincronización de estado del juego para obtener la mesa actual
        socket.emit('syncGameState', { userId: parsedUser.id });
        
        // Unirse al juego
        socket.emit('joinGame');
        
        setGameStatus('playing');
        
        if (players.length <= 1) {
          setIsYourTurn(true);
        }
      });

      socket.on('connect_error', (err) => {
        setIsConnected(false);
        setMessage('Error de conexión con el servidor. Reintentando...');
        
        setTimeout(() => {
          if (!socket.connected) {
            socket.connect();
          }
        }, 2000);
      });

      // Manejo específico para reconexiones en dispositivos móviles
      socket.on('reconnect_attempt', (attemptNumber) => {
        console.log(`Intento de reconexión #${attemptNumber}`);
        // Si estamos en un dispositivo móvil, cambiar a polling que funciona mejor con conexiones inestables
        if (window.innerWidth <= 768 && attemptNumber > 2) {
          socket.io.opts.transports = ['polling', 'websocket'];
        }
      });

      socket.on('sessionClosed', (message) => {
        alert(message);
        router.push('/');
      });

      socket.on('reconnect', (attemptNumber) => {
        setIsConnected(true);
        
        socket.emit('syncGameState', { userId: parsedUser.id });
        socket.emit('joinGame');
      });

      // Añadir manejo para el evento de límite de puntaje
      socket.on('scoreLimitReached', ({ message }) => {
        setIsScoreLocked(true);
        setMessage(message);
        setTimeout(() => {
          setMessage('Tu cuenta está bloqueada por alcanzar o llegar a 23000 puntos');
        }, 5000);
      });
      
      socket.on('userUnlocked', ({ message }) => {
        setIsScoreLocked(false);
        setMessage(message);
        setTimeout(() => setMessage(''), 3000);
      });

      // Nuevo evento para cambios de estado de bloqueo en tiempo real
      socket.on('blockStatusChanged', ({ isBlocked, isLockedDueToScore, message }) => {
        if (isBlocked !== undefined) {
          setUser(prev => ({ ...prev, isBlocked }));
          
          // Actualizar los datos del usuario en sessionStorage
          try {
            const userData = sessionStorage.getItem('user');
            if (userData) {
              const userObj = JSON.parse(userData);
              userObj.isBlocked = isBlocked;
              sessionStorage.setItem('user', JSON.stringify(userObj));
            }
          } catch (error) {
            console.error('Error actualizando sessionStorage:', error);
          }
        }
        
        if (isLockedDueToScore !== undefined) {
          setIsScoreLocked(isLockedDueToScore);
          setUser(prev => ({ ...prev, isLockedDueToScore }));
          
          // Actualizar los datos del usuario en sessionStorage
          try {
            const userData = sessionStorage.getItem('user');
            if (userData) {
              const userObj = JSON.parse(userData);
              userObj.isLockedDueToScore = isLockedDueToScore;
              sessionStorage.setItem('user', JSON.stringify(userObj));
            }
          } catch (error) {
            console.error('Error actualizando sessionStorage:', error);
          }
        }
        
        if (message) {
          setMessage(message);
          setTimeout(() => setMessage(''), 3000);
        }
      });

      // Nuevo evento para manejar cambios en la conexión de jugadores
      socket.on('playerConnectionChanged', ({ playerId, isConnected, username }) => {
        // Actualizar la lista de jugadores localmente
        setPlayers(prevPlayers => 
          prevPlayers.map(player => 
            player.id === playerId 
              ? { ...player, isConnected } 
              : player
          )
        );
        
        // Mostrar mensaje informativo
        const message = isConnected 
          ? `${username} se ha reconectado al juego` 
          : `${username} se ha desconectado del juego`;
        
        setMessage(message);
        setTimeout(() => setMessage(''), 3000);
      });

      // Recibir actualización del estado de las mesas
      socket.on('tablesUpdate', ({ tablesPlayed, currentTable, maxReached, lockReason }) => {
        if (tablesPlayed !== undefined) {
          setTablesPlayed(tablesPlayed);
        }
        
        if (currentTable !== undefined) {
          setCurrentTableNumber(currentTable);
        }
        
        setMaxTablesReached(maxReached || false);
        
        if (lockReason) {
          setTableLockReason(lockReason);
        }
      });

      // Actualizar el manejo del evento boardReset
      socket.on('boardReset', ({ message, newTableNumber, newBoard }) => {
        setMessage(message);
        setTimeout(() => setMessage(''), 3000);
        
        // Actualizar número de mesa
        if (newTableNumber !== undefined) {
          setCurrentTableNumber(newTableNumber);
        }
        
        // Reiniciar completamente el tablero con el tablero nuevo
        if (newBoard) {
          setBoard(prevBoard => {
            // Crear un nuevo tablero basado en el recibido, pero sin revelar ninguna ficha
            return newBoard.map(tile => ({
              ...tile,
              revealed: false // Asegurarse de que ninguna ficha esté revelada
            }));
          });
        } else {
          // Si no se recibe un tablero nuevo, generar uno localmente
          setBoard(generateLocalBoard());
        }
        
        // Reiniciar selecciones por hilera
        setRowSelections([0, 0, 0, 0]);
      });

      socket.on('gameState', (gameState) => {
        if (gameState.players && gameState.players.length <= 1) {
          gameState.status = 'playing';
        }
        
        // Mantener el estado actual del tablero sin reiniciar
        setBoard(prev => {
          const updatedBoard = [...prev];
          // Solo actualizar las fichas que están reveladas en el estado del juego
          for (let i = 0; i < Math.min(updatedBoard.length, gameState.board.length); i++) {
            if (gameState.board[i].revealed) {
              updatedBoard[i] = {
                ...updatedBoard[i],
                revealed: true,
                selectedBy: gameState.board[i].selectedBy,
                value: gameState.board[i].value || updatedBoard[i].value
              };
            }
          }
          return updatedBoard;
        });
        
        // Verificar si ha cambiado el jugador actual
        const prevPlayerId = currentPlayer?.id;
        const newPlayerId = gameState.currentPlayer?.id;
        
        setCurrentPlayer(gameState.currentPlayer);
        setPlayers(gameState.players || []);
        setGameStatus(gameState.status || 'playing');
        
        const isCurrentUserTurn = (gameState.players && gameState.players.length <= 1) || 
          (gameState.currentPlayer && gameState.currentPlayer.id === parsedUser.id);
        
        if (prevPlayerId !== newPlayerId && gameState.currentPlayer) {
          showTurnNotification(gameState.currentPlayer, isCurrentUserTurn);
        }
        
        setIsYourTurn(isCurrentUserTurn);
        
        if (isCurrentUserTurn) {
          setTimeLeft(4);
          setCanSelectTiles(true);
        }
        
        if (gameState.rowSelections) {
          setRowSelections(gameState.rowSelections);
        }
      });

      // Evento para actualización de puntuaje
      socket.on('directScoreUpdate', (newScore) => {
        setScore(newScore);
        updateLocalScore(newScore);
      });

      socket.on('forceScoreUpdate', (newScore) => {
        setScore(newScore);
        updateLocalScore(newScore);
      });

      socket.on('scoreUpdate', (data) => {
        if (typeof data === 'object' && data.userId) {
          if (data.userId === parsedUser.id) {
            setScore(data.newScore);
            updateLocalScore(data.newScore);
          }
        } else {
          setScore(data);
          updateLocalScore(data);
        }
      });

      socket.on('tileSelected', ({ tileIndex, tileValue, playerId, newScore, rowSelections, soundType, playerUsername, timestamp }) => {
        // Actualizar el tablero para todos los jugadores
        setBoard(prevBoard => {
          const newBoard = [...prevBoard];
          if (newBoard[tileIndex]) {
            newBoard[tileIndex] = { 
              ...newBoard[tileIndex], 
              revealed: true, 
              // Usar el valor que viene del servidor, no el local
              value: tileValue,
              lastSelected: true,
              selectedBy: playerUsername
            };
          }
          return newBoard;
        });
        
        setLastSelectedTile({
          index: tileIndex,
          playerId: playerId,
          playerUsername: playerUsername,
          timestamp: timestamp
        });
        
        const isCurrentPlayer = playerId === parsedUser.id;
        
        // Determinar el tipo de sonido basado en el valor real
        const isPositiveValue = tileValue > 0;
        if (isPositiveValue) {
          playSoundSafely(winSoundRef, isCurrentPlayer ? 1.0 : 0.3);
        } else {
          playSoundSafely(loseSoundRef, isCurrentPlayer ? 1.0 : 0.3);
        }
        
        if (isCurrentPlayer) {
          // Usar el valor que viene del servidor
          showPointsAlert(tileValue);
          updateLocalScore(newScore);
        } else {
          showPlayerActionNotification(playerUsername, tileValue);
        }
        
        if (rowSelections) {
          setRowSelections(rowSelections);
        }
      });

      socket.on('turnTimeout', ({ playerId }) => {
        if (playerId === parsedUser.id) {
          setTimeLeft(0);
          setCanSelectTiles(false);
          
          if (players.length > 1) {
            setIsYourTurn(false);
          } else {
            setIsYourTurn(true);
          }
          
          setMessage('¡Tu tiempo se agotó!');
          setTimeout(() => setMessage(''), 2000);
        }
      });

      socket.on('tableLimitReached', ({ message }) => {
        setMaxTablesReached(true);
        setTableLockReason(message);
      });

      socket.on('tablesUnlocked', () => {
        setMaxTablesReached(false);
        setTableLockReason('');
        setMessage('¡Las mesas han sido desbloqueadas!');
        setTimeout(() => setMessage(''), 3000);
      });

      // Modificado: El evento blocked ya no redirecciona
      socket.on('blocked', () => {
        setMessage('Tu cuenta ha sido bloqueada por el administrador. Puedes ver el juego pero no jugar.');
      });

      socket.on('message', (newMessage) => {
        setMessage(newMessage);
        setTimeout(() => setMessage(''), 3000);
      });

      socket.on('disconnect', () => {
        setIsConnected(false);
      });

      return () => {
        if (socket) {
          socket.off('connect');
          socket.off('connect_error');
          socket.off('reconnect_attempt');
          socket.off('gameState');
          socket.off('tileSelected');
          socket.off('turnTimeout');
          socket.off('scoreUpdate');
          socket.off('forceScoreUpdate');
          socket.off('directScoreUpdate');
          socket.off('boardReset');
          socket.off('tableLimitReached');
          socket.off('tablesUnlocked');
          socket.off('blocked');
          socket.off('message');
          socket.off('sessionClosed');
          socket.off('tablesUpdate');
          socket.off('playerConnectionChanged');
          socket.off('scoreLimitReached');
          socket.off('userUnlocked');
          socket.off('blockStatusChanged');
          socket.emit('leaveGame');
          socket.disconnect();
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
    
    if (isYourTurn) {
      setTimeLeft(4);
      setCanSelectTiles(true);
      
      timer = setInterval(() => {
        setTimeLeft((prevTime) => {
          if (prevTime <= 1) {
            clearInterval(timer);
            setCanSelectTiles(false);
            return 0;
          }
          return prevTime - 1;
        });
      }, 1000);
    } else {
      clearInterval(timer);
    }
    
    return () => {
      if (timer) {
        clearInterval(timer);
      }
    };
  }, [isYourTurn]);

  // Efecto para limpiar la marca de última ficha seleccionada
  useEffect(() => {
    if (lastSelectedTile) {
      const timer = setTimeout(() => {
        setBoard(prevBoard => {
          const newBoard = [...prevBoard];
          if (newBoard[lastSelectedTile.index] && newBoard[lastSelectedTile.index].lastSelected) {
            newBoard[lastSelectedTile.index] = {
              ...newBoard[lastSelectedTile.index],
              lastSelected: false
            };
          }
          return newBoard;
        });
      }, 2000);
      
      return () => clearTimeout(timer);
    }
  }, [lastSelectedTile]);

  // Efecto para verificar cambios sospechosos en la puntuación
  useEffect(() => {
    // Verificar cambios grandes en la puntuación (más de 15000 puntos)
    if (prevScoreRef.current && Math.abs(localScore - prevScoreRef.current) > 15000) {
      console.warn(`Cambio sospechoso en puntuación: ${prevScoreRef.current} -> ${localScore}`);
      
      // Solicitar sincronización de puntuación con el servidor
      if (socket && socket.connected && user?.id) {
        console.log('Solicitando sincronización de puntaje debido a cambio sospechoso');
        socket.emit('syncScore', { userId: user.id });
      }
    }
    
    // Actualizar la referencia para la próxima comparación
    prevScoreRef.current = localScore;
  }, [localScore, socket, user]);

  // Función para manejar clics en fichas
  const handleTileClick = useCallback((index) => {
    // No permitir seleccionar fichas si es administrador
    if (user?.isAdmin) {
      setMessage("Los administradores solo pueden observar el juego");
      setTimeout(() => setMessage(''), 3000);
      return;
    }
    
    // No permitir seleccionar fichas si está bloqueado por puntaje
    if (isScoreLocked) {
      setMessage("Tu cuenta está bloqueada por alcanzar 23000 puntos. Contacta al administrador.");
      setTimeout(() => setMessage(''), 3000);
      return;
    }
    
    // No permitir seleccionar fichas si el usuario está bloqueado por el administrador
    if (user?.isBlocked) {
      setMessage("Tu cuenta está bloqueada. Puedes ver el juego pero no jugar.");
      setTimeout(() => setMessage(''), 3000);
      return;
    }
    
    // No permitir seleccionar fichas si se alcanzó el límite de mesas
    if (maxTablesReached) {
      setMessage(`Límite de mesas alcanzado. ${tableLockReason}`);
      setTimeout(() => setMessage(''), 3000);
      return;
    }
    
    if (board[index]?.revealed) {
      return;
    }
    
    if (!canSelectTiles) {
      setMessage("¡No puedes seleccionar más fichas en este turno!");
      setTimeout(() => setMessage(''), 2000);
      return;
    }
    
    if (!isYourTurn && players.length > 1) {
      setMessage("¡Espera tu turno!");
      setTimeout(() => setMessage(''), 2000);
      return;
    }
    
    if (timeLeft <= 0) {
      setMessage("¡Tiempo agotado para este turno!");
      setTimeout(() => setMessage(''), 2000);
      return;
    }
    
    const row = Math.floor(index / 4);
    
    if (rowSelections[row] >= 2) {
      setMessage(`¡Límite de 2 fichas por hilera alcanzado en hilera ${row + 1}!`);
      setTimeout(() => setMessage(''), 2000);
      return;
    }
    
    const tileValue = board[index]?.value || 0;
    if (!board[index]?.revealed) {
      // IMPORTANTE: Usar setState con callback para asegurar que se base en el valor actual
      setLocalScore(prevScore => {
        const newScore = prevScore + tileValue;
        
        // Guardar en sessionStorage de manera segura
        try {
          const userData = sessionStorage.getItem('user');
          if (userData) {
            const userObj = JSON.parse(userData);
            userObj.score = newScore;
            sessionStorage.setItem('user', JSON.stringify(userObj));
            console.log('Puntaje local actualizado en sessionStorage:', newScore);
          }
        } catch (error) {
          console.error('Error actualizando sessionStorage:', error);
        }
        
        return newScore;
      });
      
      // Determinar el tipo de sonido basado en el valor real
      const isPositiveValue = tileValue > 0;
      if (isPositiveValue) {
        playSoundSafely(winSoundRef);
      } else {
        playSoundSafely(loseSoundRef);
      }
      
      // Mostrar alerta con el valor correcto
      showPointsAlert(tileValue);
      
      setBoard(prevBoard => {
        const newBoard = [...prevBoard];
        if (newBoard[index]) {
          newBoard[index] = { 
            ...newBoard[index], 
            revealed: true,
            lastSelected: true
          };
        }
        return newBoard;
      });
      
      setRowSelections(prev => {
        const updated = [...prev];
        updated[row]++;
        return updated;
      });
    }
    
    // Emisión al servidor con información completa
    socket.emit('selectTile', { 
      tileIndex: index,
      currentScore: localScore // Enviar el puntaje actual para verificación
    });
  }, [board, canSelectTiles, isYourTurn, timeLeft, rowSelections, localScore, maxTablesReached, tableLockReason, socket, showPointsAlert, isScoreLocked, user]);

  // Memoizar el tablero para evitar re-renderizados innecesarios
  const memoizedBoard = useMemo(() => (
    Array.isArray(board) && board.length > 0 ? (
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
            rowSelections[Math.floor(index / 4)] >= 2 ||
            maxTablesReached ||
            isScoreLocked ||
            user?.isBlocked ||
            user?.isAdmin
          }
          lastSelected={lastSelectedTile?.index === index}
          selectedBy={tile?.selectedBy}
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
    )
  ), [board, canSelectTiles, timeLeft, rowSelections, lastSelectedTile, maxTablesReached, isScoreLocked, user, handleTileClick]);

  if (!user) {
    return <div className="loading">Cargando...</div>;
  }

  // Estilo para la notificación de turno (verde)
  const turnNotificationStyle = {
    position: 'fixed',
    top: '40%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    backgroundColor: 'rgba(39, 174, 96, 0.9)', // Color verde
    color: 'white',
    padding: '15px 30px',
    borderRadius: '8px',
    fontWeight: 'bold',
    zIndex: 1000,
    boxShadow: '0 4px 8px rgba(0, 0, 0, 0.3)',
    animation: 'fadeInOut 3s ease'
  };

  return (
    <>
      {/* Componente para ocultar el logo programáticamente */}
      <HideLogoEffect />
      
      {(user?.isAdmin || user?.username?.toLowerCase() === "admin") && (
        <button 
        style={{
          position: 'fixed',
          top: '20px',
          right: '20px',
          backgroundColor: '#ff4081',
          color: 'white',
          padding: '10px 20px',
          borderRadius: '4px',
          fontWeight: 'bold',
          zIndex: 10000,
          cursor: 'pointer',
          boxShadow: '0 2px 10px rgba(0,0,0,0.3)',
          border: 'none',
          fontSize: '14px'
        }}
        onClick={handleAdminPanel}
      >
        Panel de Admin
      </button>
    )}
  
    <div className="game-container game-page">
      <audio ref={winSoundRef} src="/sounds/win.mp3" preload="auto"></audio>
      <audio ref={loseSoundRef} src="/sounds/lose.mp3" preload="auto"></audio>
      <audio ref={turnSoundRef} src="/sounds/turn.mp3" preload="auto"></audio>
      
      {turnNotification && (
        <div style={turnNotificationStyle}>
          {turnNotification}
        </div>
      )}
      
      {showAlert && (
        <div className={`points-alert ${alertType}`}>
          {alertMessage}
        </div>
      )}
      
      <div className="game-info">
        <div className="game-header">
          <h2>Jugador: {user?.username}</h2>
          <button className="logout-button" onClick={handleLogout}>
            Cerrar Sesión
          </button>
        </div>
        
        {isConnected ? (
          <div className="connection-status connected">Conectado al servidor</div>
        ) : (
          <div className="connection-status disconnected">Desconectado del servidor</div>
        )}
        
        {/* Nueva barra de información reorganizada */}
        <div className="game-status-bar">
          <div className="table-info">
            Mesa {currentTableNumber} de 10
          </div>
          <div className="game-score">
            Puntaje: {localScore}
          </div>
          <div className={`turn-status ${isYourTurn ? 'your-turn-indicator' : 'wait-turn-indicator'}`}>
            {isYourTurn ? "Tu turno" : "Espere su turno"}
          </div>
        </div>

        {/* Mensajes de bloqueo */}
        {isScoreLocked && (
          <div className="score-lock-banner">
            Tu cuenta está bloqueada por alcanzar 23000 puntos. Contacta al administrador.
          </div>
        )}

        {user?.isBlocked && (
          <div className="score-lock-banner">
            Tu cuenta está bloqueada por el administrador. Puedes ver el juego pero no jugar.
          </div>
        )}

        {user?.isAdmin && (
          <div className="admin-info-banner">
            Modo administrador: Solo puedes observar el juego.
          </div>
        )}

        {/* Información del jugador actual en blanco */}
        {currentPlayer && (
          <div className="current-player">
            Jugador actual: <span className="current-player-name">{currentPlayer.username}</span>
          </div>
        )}

        {/* Contador de tiempo visible siempre */}
        <div className="time-display">
          Tiempo: <span className={`timer-value ${timeLeft === 0 ? 'time-up' : ''}`}>{timeLeft}</span> segundos
        </div>
        
        {message && <div className="message">{message}</div>}
      </div>

      {/* El tablero siempre se muestra, independientemente del estado de bloqueo */}
      <div className="game-board">
        {memoizedBoard}
      </div>

      <div className="players-section">
        <h3>Jugadores conectados</h3>
        <PlayerList players={players} currentPlayerId={currentPlayer?.id} />
      </div>
      
      {showAdminModal && (
        <AdminButton 
          onClose={() => setShowAdminModal(false)} 
          socket={socket}
        />
      )}
    </div>
  </>
);
}