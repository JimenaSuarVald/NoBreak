import React, { useState, useEffect } from 'react';
import '../styles/AlbumDisplay.css';

function AlbumDisplay({ activeTabId }) {
    const [data, setData] = useState([]);

    useEffect(() => {
        // Determinamos a qué "apartamento" del servidor llamar
        const endpoint = activeTabId === 'artists' ? 'artists' : 'albums';
        
        fetch(`http://localhost:3001/api/${endpoint}`)
            .then(response => response.json())
            .then(jsonData => setData(jsonData))
            .catch(error => console.error("Error al obtener datos:", error));
    }, [activeTabId]);

    return (
        <div className="display-container">
            <div className="grid">
                {data.map(item => (
                    <div key={item.id} className="card">
                        <div className="cover-placeholder">
                            <span>PORTADA</span>
                        </div>
                        <div className="info">
                            <h3>{item.title || item.name}</h3>
                            <p>{item.artist || item.genre}</p>
                            {item.rating && <span className="rating">RYM: {item.rating}</span>}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
}

export default AlbumDisplay;