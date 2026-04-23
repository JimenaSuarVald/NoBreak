// src/App.js
import React, { useState } from 'react';
import './styles/App.css';
import TopNavBar from './components/TopNavBar';
import MainDisplay from './components/MainDisplay';
import BottomPlayer from './components/BottomPlayer';

function App() {
  // Aquí definimos las pestañas iniciales. Fíjate que 'Ajustes' no se puede borrar.
  const [tabs, setTabs] = useState([
    { id: 'settings', name: 'Ajustes', removable: false },
    { id: 'albums', name: 'Álbumes', removable: true },
    { id: 'artists', name: 'Artistas', removable: true }
  ]);

  // Guardamos qué pestaña está activa ahora mismo
  const [activeTabId, setActiveTabId] = useState('albums');

  // Función para crear una nueva pestaña (por ahora pide el nombre con un popup)
  const handleAddTab = () => {
    const newName = prompt("Nombre de la nueva pestaña (ej. Rock, Favoritos):");
    if (newName) {
      const newId = `tab-${Date.now()}`; // Creamos un ID único
      setTabs([...tabs, { id: newId, name: newName, removable: true }]);
      setActiveTabId(newId); // Vamos directamente a la nueva pestaña
    }
  };

  // Función para borrar una pestaña
  const handleRemoveTab = (tabId) => {
    setTabs(tabs.filter(tab => tab.id !== tabId));
    if (activeTabId === tabId) {
      setActiveTabId('settings'); // Si borras la que estás viendo, te manda a Ajustes
    }
  };

  return (
    <div className="app-layout">
      {/* 1. Le pasamos los datos a la barra superior */}
      <TopNavBar 
        tabs={tabs} 
        activeTabId={activeTabId} 
        onTabChange={setActiveTabId}
        onAddTab={handleAddTab}
        onRemoveTab={handleRemoveTab}
      />

      {/* 2. Le decimos al centro qué estamos viendo */}
      <div className="main-content">
        <MainDisplay activeTabId={activeTabId} />
      </div>

      {/* 3. Ponemos el reproductor abajo */}
      <BottomPlayer />
    </div>
  );
}

export default App;