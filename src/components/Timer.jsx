'use client';

import React from 'react';
import '@/styles/Timer.css';

const Timer = ({ timeLeft }) => {
  // Calcular el color basado en el tiempo restante
  const getTimerColor = () => {
    if (timeLeft <= 1) {
      return '#dc3545'; // rojo para cuando queda poco tiempo
    } else if (timeLeft <= 2) {
      return '#ffc107'; // amarillo para tiempo medio
    }
    return '#28a745'; // verde para tiempo suficiente
  };

  return (
    <div className="timer">
      <div 
        className="timer-circle"
        style={{ borderColor: getTimerColor() }}
      >
        <span 
          className="timer-text"
          style={{ color: getTimerColor() }}
        >
          {timeLeft}
        </span>
      </div>
      <div className="timer-label">segundos</div>
    </div>
  );
};

export default Timer;