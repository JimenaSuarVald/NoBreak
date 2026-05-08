// src/components/BottomPlayer.js
import React from 'react';

function BottomPlayer() {
  return (
    <div className="bottom-player">
      <div className="track-info">
        <strong style={{fontSize: '18px'}}>Título de la Canción</strong>
        <div style={{color: '#a0a0a0', fontSize: '14px'}}>Nombre del Artista</div>
      </div>

      <div className="playback-controls">
        <button style={btnStyle} aria-label="Anterior">Ant</button>
        <button style={{...btnStyle, fontSize: '24px', margin: '0 15px'}} aria-label="Reproducir/Pausar">Play</button>
        <button style={btnStyle} aria-label="Siguiente">Sig</button>
      </div>

      <div className="volume-control">
        Vol <input type="range" min="0" max="100" aria-label="Control de Volumen" />
      </div>
    </div>
  );
}

// Un pequeño estilo rápido para los botones del reproductor
const btnStyle = {
  background: 'none',
  border: 'none',
  color: 'white',
  fontSize: '20px',
  cursor: 'pointer'
};

export default BottomPlayer;