'use client';

import React from 'react';
import '@/styles/PlayerList.css';

const PlayerList = ({ players, currentPlayerId }) => {
  if (!players || !Array.isArray(players)) {
    return <div className="player-list">No hay jugadores conectados</div>;
  }

  return (
    <div className="player-list">
      {players.length === 0 ? (
        <div className="no-players">No hay jugadores conectados</div>
      ) : (
        players.map((player) => (
          <div 
            key={player.id} 
            className={`player-item 
              ${player.id === currentPlayerId ? 'active' : ''} 
              ${player.isBlocked ? 'blocked' : ''} 
              ${player.isConnected === false ? 'disconnected' : ''}`}
          >
            <span>{player.username}</span>
            {player.isBlocked && <span className="blocked-badge">Bloqueado</span>}
            {player.isConnected === false && <span className="disconnected-badge">Desconectado</span>}
          </div>
        ))
      )}
    </div>
  );
};

export default PlayerList;