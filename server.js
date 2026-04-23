const express = require('express');
const cors = require('cors');
const app = express();
const PORT = 3001;

app.use(cors()); // Permite la comunicación con el puerto 3000
app.use(express.json());

// Datos de prueba que simulan tu base de datos musical
const musicDatabase = {
    albums: [
        { id: 1, title: "Replica", artist: "Oneohtrix Point Never", year: 2011, rating: 4.5 },
        { id: 2, title: "R Plus Seven", artist: "Oneohtrix Point Never", year: 2013, rating: 4.2 },
        { id: 3, title: "Age Of", artist: "Oneohtrix Point Never", year: 2018, rating: 4.0 }
    ],
    artists: [
        { id: 1, name: "Oneohtrix Point Never", genre: "Electronic", origin: "USA" }
    ]
};

// Esta es la definición de la ruta para álbumes
app.get('/api/albums', (req, res) => {
    res.json(musicDatabase.albums);
});

// Esta es la definición de la ruta para artistas
app.get('/api/artists', (req, res) => {
    res.json(musicDatabase.artists);
});

// Redirección de la raíz del servidor para evitar el "Cannot GET /"
app.get('/', (req, res) => {
    res.send('Servidor de NoBreak activo. Los datos están en /api/albums');
});

app.listen(PORT, () => {
    console.log(`Servidor backend en puerto ${PORT}`);
});