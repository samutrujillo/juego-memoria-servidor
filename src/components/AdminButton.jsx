import { useState } from 'react';
import '@/styles/AdminButton.css';

const AdminModal = ({ onClose, socket }) => {
  const [players, setPlayers] = useState([]);
  const [pointsValues, setPointsValues] = useState({});
  const [status, setStatus] = useState('');
  const [loading, setLoading] = useState(false);

  const openModal = () => {
    setLoading(true);
    // Solicitar la lista de jugadores al servidor
    socket.emit('getPlayers', (response) => {
      setLoading(false);
      if (response.success) {
        setPlayers(response.players);
        
        // Inicializar los valores de puntos para cada jugador
        const initialValues = {};
        response.players.forEach(player => {
          initialValues[player.id] = 0;
        });
        setPointsValues(initialValues);
      } else {
        setStatus('Error al obtener jugadores');
        setTimeout(() => setStatus(''), 3000);
      }
    });
  };

  // Llamar a openModal cuando el componente se monta
  useState(() => {
    openModal();
  }, []);

  const handlePointsChange = (playerId, value) => {
    setPointsValues(prev => ({
      ...prev,
      [playerId]: parseInt(value) || 0
    }));
  };

  const addPoints = (playerId, points) => {
    if (points === 0) return;
    
    setStatus('Actualizando puntos...');
    socket.emit('updatePoints', { userId: playerId, points }, (response) => {
      if (response.success) {
        // Actualizar la lista de jugadores localmente
        setPlayers(prev => 
          prev.map(player => 
            player.id === playerId 
              ? { ...player, score: player.score + points } 
              : player
          )
        );
        setStatus(`Puntos actualizados para ${players.find(p => p.id === playerId)?.username}`);
        
        // Reiniciar el valor a 0 después de añadir
        setPointsValues(prev => ({
          ...prev,
          [playerId]: 0
        }));
        
        setTimeout(() => setStatus(''), 2000);
      } else {
        setStatus('Error al actualizar puntos');
        setTimeout(() => setStatus(''), 2000);
      }
    });
  };

  const toggleBlockUser = (playerId) => {
    setStatus('Cambiando estado del jugador...');
    socket.emit('toggleBlockUser', { userId: playerId }, (response) => {
      if (response.success) {
        // Actualizar la lista de jugadores localmente
        setPlayers(prev => 
          prev.map(player => 
            player.id === playerId 
              ? { ...player, isBlocked: !player.isBlocked } 
              : player
          )
        );
        
        const player = players.find(p => p.id === playerId);
        setStatus(`Jugador ${player?.username} ${player?.isBlocked ? 'desbloqueado' : 'bloqueado'}`);
        setTimeout(() => setStatus(''), 2000);
      } else {
        setStatus('Error al cambiar estado de bloqueo');
        setTimeout(() => setStatus(''), 2000);
      }
    });
  };

  const unlockTables = (playerId) => {
    setStatus('Desbloqueando mesas para el jugador...');
    socket.emit('unlockTables', { userId: playerId }, (response) => {
      if (response.success) {
        setStatus(`Mesas desbloqueadas para ${players.find(p => p.id === playerId)?.username}`);
        setTimeout(() => setStatus(''), 2000);
      } else {
        setStatus('Error al desbloquear mesas');
        setTimeout(() => setStatus(''), 2000);
      }
    });
  };

  const unlockUserScore = (playerId) => {
    setStatus('Desbloqueando jugador por puntaje...');
    socket.emit('unlockUserScore', { userId: playerId }, (response) => {
      if (response.success) {
        setStatus(`Jugador desbloqueado correctamente`);
        
        // Actualizar la lista de jugadores localmente
        setPlayers(prev => 
          prev.map(player => 
            player.id === playerId 
              ? { ...player, isLockedDueToScore: false } 
              : player
          )
        );
        
        setTimeout(() => setStatus(''), 2000);
      } else {
        setStatus('Error al desbloquear jugador');
        setTimeout(() => setStatus(''), 2000);
      }
    });
  };

  const resetGame = () => {
    if (window.confirm('¿Estás seguro de que quieres reiniciar el juego?')) {
      setStatus('Reiniciando juego...');
      socket.emit('resetGame', (response) => {
        if (response.success) {
          setStatus('Juego reiniciado');
          setTimeout(() => setStatus(''), 2000);
        } else {
          setStatus('Error al reiniciar el juego');
          setTimeout(() => setStatus(''), 2000);
        }
      });
    }
  };

  const resetAllTables = () => {
    if (window.confirm('¿Estás seguro de que quieres reiniciar los contadores de mesas para todos los jugadores?')) {
      setStatus('Reiniciando contadores de mesas...');
      socket.emit('adminResetTables', (response) => {
        if (response.success) {
          setStatus('Contadores de mesas reiniciados correctamente');
          setTimeout(() => setStatus(''), 2000);
        } else {
          setStatus('Error al reiniciar los contadores de mesas');
          setTimeout(() => setStatus(''), 2000);
        }
      });
    }
  };

  return (
    <div className="admin-modal-overlay">
      <div className="admin-modal">
        <div className="admin-modal-header">
          <h2>Panel de Administración</h2>
          <button className="close-button" onClick={onClose}>×</button>
        </div>
        
        {status && <div className="admin-status">{status}</div>}
        
        <div className="admin-modal-content">
          <div className="admin-players-list">
            {loading ? (
              <div className="admin-loading">Cargando jugadores...</div>
            ) : players.length === 0 ? (
              <p>No hay jugadores registrados</p>
            ) : (
              players.map(player => (
                <div key={player.id} className="admin-player-item">
                  <div className="player-info">
                    <span className="player-name">{player.username}</span>
                    <span className="player-score">Puntos: {player.score}</span>
                    <span className={`player-status ${player.isBlocked ? 'blocked' : ''}`}>
                      {player.isBlocked ? 'Bloqueado' : 'Activo'}
                    </span>
                    {player.isLockedDueToScore && (
                      <span className="player-status score-locked">
                        Bloqueado por puntaje
                      </span>
                    )}
                  </div>
                  <div className="player-controls">
                    <div className="points-control">
                      <label className="points-label">Puntos a modificar:</label>
                      <input
                        type="number"
                        value={pointsValues[player.id] || 0}
                        onChange={(e) => handlePointsChange(player.id, e.target.value)}
                        className="points-input"
                      />
                      <div className="points-buttons">
                        <button 
                          onClick={() => addPoints(player.id, pointsValues[player.id])}
                          className="add-points-btn"
                          disabled={!pointsValues[player.id]}
                        >
                          Añadir
                        </button>
                        <button 
                          onClick={() => addPoints(player.id, -pointsValues[player.id])}
                          className="remove-points-btn"
                          disabled={!pointsValues[player.id]}
                        >
                          Restar
                        </button>
                      </div>
                    </div>
                    <button 
                      onClick={() => toggleBlockUser(player.id)}
                      className={`toggle-block-btn ${player.isBlocked ? 'unblock' : 'block'}`}
                    >
                      {player.isBlocked ? 'Desbloquear' : 'Bloquear'}
                    </button>
                    <button 
                      onClick={() => unlockTables(player.id)}
                      className="unlock-tables-btn"
                    >
                      Desbloquear Mesas
                    </button>
                    {player.isLockedDueToScore && (
                      <button 
                        onClick={() => unlockUserScore(player.id)}
                        className="unlock-score-btn"
                      >
                        Desbloquear Puntaje
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
          
          <div className="admin-actions">
            <button onClick={resetGame} className="reset-game-btn">
              Reiniciar Juego
            </button>
            <button onClick={resetAllTables} className="reset-tables-btn">
              Reiniciar Contadores de Mesas
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

// Componente principal AdminButton
const AdminButton = ({ onClose, socket }) => {
  return <AdminModal onClose={onClose} socket={socket} />;
};

export default AdminButton;