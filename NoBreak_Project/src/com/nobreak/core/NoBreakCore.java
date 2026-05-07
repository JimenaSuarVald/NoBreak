package com.nobreak.core;

import com.sun.net.httpserver.HttpServer;
import javax.swing.*;
import javax.swing.border.EmptyBorder;
import java.awt.*;
import java.io.*;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.sql.*;
import java.util.ArrayList;
import java.util.List;

public class NoBreakCore extends JFrame {
    private static final String URL_DB = "jdbc:sqlite:NoBreak.db";
    private static final int PUERTO_API = 8080;
    
    // Atributos del Reproductor
    private List<String[]> listaCanciones = new ArrayList<>();
    private int indiceActual = 0;
    private JLabel lblTitulo, lblArtista;
    private JButton btnPlay;
    private boolean estaReproduciendo = false;

    public NoBreakCore() {
        // 1. Configuración de la Ventana (Estilo Spotify/Dark)
        setTitle("NoBreak Player");
        setSize(400, 500);
        setDefaultCloseOperation(EXIT_ON_CLOSE);
        setLocationRelativeTo(null);
        getContentPane().setBackground(new Color(18, 18, 18)); // Fondo casi negro
        setLayout(new BorderLayout());

        // --- Panel Superior: Imagen/Icono ---
        JPanel panelImagen = new JPanel();
        panelImagen.setBackground(new Color(18, 18, 18));
        panelImagen.setBorder(new EmptyBorder(40, 0, 20, 0));
        JLabel icono = new JLabel("🎵", SwingConstants.CENTER);
        icono.setFont(new Font("Segoe UI Emoji", Font.PLAIN, 100));
        icono.setForeground(new Color(29, 185, 84)); // Verde Spotify
        panelImagen.add(icono);
        add(panelImagen, BorderLayout.NORTH);

        // --- Panel Central: Info de canción ---
        JPanel panelInfo = new JPanel(new GridLayout(2, 1));
        panelInfo.setBackground(new Color(18, 18, 18));
        lblTitulo = new JLabel("Sin canciones", SwingConstants.CENTER);
        lblTitulo.setForeground(Color.WHITE);
        lblTitulo.setFont(new Font("SansSerif", Font.BOLD, 22));
        
        lblArtista = new JLabel("Escanea tu música para empezar", SwingConstants.CENTER);
        lblArtista.setForeground(new Color(179, 179, 179));
        lblArtista.setFont(new Font("SansSerif", Font.PLAIN, 16));
        
        panelInfo.add(lblTitulo);
        panelInfo.add(lblArtista);
        add(panelInfo, BorderLayout.CENTER);

        // --- Panel Inferior: Controles ---
        JPanel panelControles = new JPanel(new FlowLayout(FlowLayout.CENTER, 30, 20));
        panelControles.setBackground(new Color(18, 18, 18));
        panelControles.setBorder(new EmptyBorder(0, 0, 40, 0));

        JButton btnPrev = crearBotonControl("⏮");
        btnPlay = crearBotonControl("▶");
        btnPlay.setFont(new Font("SansSerif", Font.BOLD, 40));
        JButton btnNext = crearBotonControl("⏭");

        panelControles.add(btnPrev);
        panelControles.add(btnPlay);
        panelControles.add(btnNext);
        add(panelControles, BorderLayout.SOUTH);

        // Lógica de botones
        btnPlay.addActionListener(e -> togglePlay());
        btnNext.addActionListener(e -> pasarCancion(1));
        btnPrev.addActionListener(e -> pasarCancion(-1));

        // 2. Inicializar lógica interna
        setupBaseDeDatos();
        escanearMusica(System.getProperty("user.home") + "/Music");
        cargarCancionesDesdeDB();
        actualizarInterfaz();
        iniciarServidorAPI();
    }

    private JButton crearBotonControl(String texto) {
        JButton btn = new JButton(texto);
        btn.setForeground(Color.WHITE);
        btn.setBackground(new Color(18, 18, 18));
        btn.setBorderPainted(false);
        btn.setFocusPainted(false);
        btn.setContentAreaFilled(false);
        btn.setFont(new Font("SansSerif", Font.PLAIN, 30));
        btn.setCursor(new Cursor(Cursor.HAND_CURSOR));
        return btn;
    }

    private void togglePlay() {
        if (listaCanciones.isEmpty()) return;
        estaReproduciendo = !estaReproduciendo;
        btnPlay.setText(estaReproduciendo ? "⏸" : "▶");
        btnPlay.setForeground(estaReproduciendo ? new Color(29, 185, 84) : Color.WHITE);
    }

    private void pasarCancion(int salto) {
        if (listaCanciones.isEmpty()) return;
        indiceActual = (indiceActual + salto + listaCanciones.size()) % listaCanciones.size();
        actualizarInterfaz();
    }

    private void actualizarInterfaz() {
        if (!listaCanciones.isEmpty()) {
            String[] cancion = listaCanciones.get(indiceActual);
            lblTitulo.setText(cancion[0]);
            lblArtista.setText("Local File • " + (cancion[1].equals("null") ? "Artista Desconocido" : cancion[1]));
        }
    }

    // --- MÉTODOS DE BASE DE DATOS Y RED ---

    private void cargarCancionesDesdeDB() {
        listaCanciones.clear();
        try (Connection conn = DriverManager.getConnection(URL_DB);
             ResultSet rs = conn.createStatement().executeQuery("SELECT titulo, artista FROM canciones")) {
            while (rs.next()) {
                listaCanciones.add(new String[]{rs.getString("titulo"), String.valueOf(rs.getString("artista"))});
            }
        } catch (SQLException e) { e.printStackTrace(); }
    }

    private void setupBaseDeDatos() {
        try (Connection conn = DriverManager.getConnection(URL_DB)) {
            Statement stmt = conn.createStatement();
            stmt.execute("CREATE TABLE IF NOT EXISTS canciones (id INTEGER PRIMARY KEY AUTOINCREMENT, titulo TEXT, artista TEXT, ruta TEXT)");
            stmt.execute("CREATE TABLE IF NOT EXISTS usuarios (id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT, correo TEXT UNIQUE, pass_hash TEXT)");
        } catch (SQLException e) { e.printStackTrace(); }
    }

    private void escanearMusica(String ruta) {
        File carpeta = new File(ruta);
        File[] archivos = carpeta.listFiles((dir, name) -> name.toLowerCase().endsWith(".mp3"));
        if (archivos != null) {
            try (Connection conn = DriverManager.getConnection(URL_DB)) {
                String sql = "INSERT OR IGNORE INTO canciones(titulo, ruta) VALUES(?, ?)";
                PreparedStatement pstmt = conn.prepareStatement(sql);
                for (File f : archivos) {
                    pstmt.setString(1, f.getName());
                    pstmt.setString(2, f.getAbsolutePath());
                    pstmt.executeUpdate();
                }
            } catch (SQLException e) { e.printStackTrace(); }
        }
    }

    private void iniciarServidorAPI() {
        try {
            HttpServer server = HttpServer.create(new InetSocketAddress(PUERTO_API), 0);
            server.createContext("/api/lista", (exchange) -> {
                StringBuilder json = new StringBuilder("[");
                for (String[] c : listaCanciones) {
                    json.append(String.format("{\"titulo\":\"%s\"},", c[0]));
                }
                if (json.length() > 1) json.setLength(json.length() - 1);
                json.append("]");
                
                byte[] response = json.toString().getBytes(StandardCharsets.UTF_8);
                exchange.getResponseHeaders().set("Content-Type", "application/json");
                exchange.getResponseHeaders().set("Access-Control-Allow-Origin", "*");
                exchange.sendResponseHeaders(200, response.length);
                exchange.getResponseBody().write(response);
                exchange.getResponseBody().close();
            });
            server.start();
            System.out.println("🌍 API activa en puerto 8080");
        } catch (IOException e) { e.printStackTrace(); }
    }

    public static void main(String[] args) {
        SwingUtilities.invokeLater(() -> new NoBreakCore().setVisible(true));
    }
}
