// src/components/TopNavBar.js
import React from 'react';

function TopNavBar({ tabs, activeTabId, onTabChange, onAddTab, onRemoveTab }) {
  return (
    <div className="top-nav">
      {tabs.map((tab) => (
        <button 
          key={tab.id} 
          className={`tab ${activeTabId === tab.id ? 'active' : ''}`}
          onClick={() => onTabChange(tab.id)}
        >
          {tab.name}
          
          {/* Si la pestaña es 'removable', mostramos la X */}
          {tab.removable && (
            <span 
              className="close-btn" 
              onClick={(e) => {
                e.stopPropagation(); // Evita que al dar a la X también se haga click en la pestaña
                onRemoveTab(tab.id);
              }}
            >
              x
            </span>
          )}
        </button>
      ))}
      
      {/* Botón para añadir nuevas pestañas */}
      <button className="tab" onClick={onAddTab}>
        Nueva
      </button>
    </div>
  );
}

export default TopNavBar;