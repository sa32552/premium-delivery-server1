const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// Base de données SQLite (FICHIER - Railway gère le stockage)
const db = new sqlite3.Database(':memory:'); // Mémoire ou fichier .db

// Initialisation de la base de données
db.serialize(() => {
  // Table utilisateurs
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT UNIQUE,
    password TEXT,
    name TEXT,
    type TEXT,
    boutiqueName TEXT,
    phone TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Table formulaires
  db.run(`CREATE TABLE IF NOT EXISTS formulaires (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    boutiqueId INTEGER,
    boutiqueName TEXT,
    clientName TEXT,
    produit TEXT,
    prix TEXT,
    heureLivraison TEXT,
    localisation TEXT,
    status TEXT DEFAULT 'en_attente',
    livreurId INTEGER,
    livreurName TEXT,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Table messages
  db.run(`CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fromId INTEGER,
    toId INTEGER,
    content TEXT,
    type TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  // Créer l'admin et livreurs par défaut
  const initUsers = () => {
    const users = [
      { email: 'admin@premium.com', password: bcrypt.hashSync('admin123', 10), name: 'Admin Principal', type: 'admin' },
      { email: 'livreur1@premium.com', password: bcrypt.hashSync('livreur123', 10), name: 'Jean Dupont', type: 'livreur' },
      { email: 'livreur2@premium.com', password: bcrypt.hashSync('livreur123', 10), name: 'Marie Martin', type: 'livreur' }
    ];

    users.forEach(user => {
      db.get("SELECT id FROM users WHERE email = ?", [user.email], (err, row) => {
        if (!row) {
          db.run("INSERT INTO users (email, password, name, type) VALUES (?, ?, ?, ?)", 
            [user.email, user.password, user.name, user.type]);
        }
      });
    });
  };

  initUsers();
});

// ==================== ROUTES ====================

// Test serveur
app.get('/', (req, res) => {
  res.json({ 
    message: '🚀 Serveur Premium Delivery ACTIF!',
    status: 'En ligne',
    database: 'SQLite intégrée',
    timestamp: new Date().toISOString()
  });
});

// Connexion
app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  
  db.get("SELECT * FROM users WHERE email = ?", [email], (err, user) => {
    if (err || !user) {
      return res.status(400).json({ error: 'Utilisateur non trouvé' });
    }

    const validPassword = bcrypt.compareSync(password, user.password);
    if (!validPassword) {
      return res.status(400).json({ error: 'Mot de passe incorrect' });
    }

    const token = jwt.sign({ 
      userId: user.id, 
      type: user.type 
    }, 'votre_secret');

    res.json({
      message: 'Connexion réussie',
      token,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        type: user.type,
        boutiqueName: user.boutiqueName
      }
    });
  });
});

// Inscription boutique
app.post('/api/register-boutique', (req, res) => {
  const { email, password, name, boutiqueName, phone } = req.body;
  
  db.get("SELECT id FROM users WHERE email = ?", [email], (err, row) => {
    if (row) {
      return res.status(400).json({ error: 'Email déjà utilisé' });
    }

    const hashedPassword = bcrypt.hashSync(password, 10);
    
    db.run("INSERT INTO users (email, password, name, boutiqueName, phone, type) VALUES (?, ?, ?, ?, ?, 'boutique')",
      [email, hashedPassword, name, boutiqueName, phone],
      function(err) {
        if (err) {
          return res.status(500).json({ error: err.message });
        }

        const token = jwt.sign({ userId: this.lastID, type: 'boutique' }, 'votre_secret');
        
        res.json({
          message: 'Boutique inscrite avec succès',
          token,
          user: {
            id: this.lastID,
            email: email,
            name: name,
            boutiqueName: boutiqueName,
            type: 'boutique'
          }
        });
      }
    );
  });
});

// Nouveau formulaire
app.post('/api/formulaire', (req, res) => {
  const { boutiqueId, clientName, produit, prix, heureLivraison, localisation } = req.body;
  
  db.get("SELECT boutiqueName FROM users WHERE id = ?", [boutiqueId], (err, boutique) => {
    if (err || !boutique) {
      return res.status(400).json({ error: 'Boutique non trouvée' });
    }

    db.run(`INSERT INTO formulaires 
      (boutiqueId, boutiqueName, clientName, produit, prix, heureLivraison, localisation) 
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [boutiqueId, boutique.boutiqueName, clientName, produit, prix, heureLivraison, localisation],
      function(err) {
        if (err) {
          return res.status(500).json({ error: err.message });
        }

        const formulaire = {
          id: this.lastID,
          boutiqueId,
          boutiqueName: boutique.boutiqueName,
          clientName,
          produit,
          prix,
          heureLivraison,
          localisation,
          status: 'en_attente',
          createdAt: new Date()
        };

        io.emit('new_formulaire', formulaire);
        res.json({ message: 'Formulaire envoyé avec succès', formulaire });
      }
    );
  });
});

// Assigner livreur
app.post('/api/assign-livreur', (req, res) => {
  const { formulaireId, livreurId } = req.body;
  
  db.get("SELECT name FROM users WHERE id = ?", [livreurId], (err, livreur) => {
    if (err || !livreur) {
      return res.status(400).json({ error: 'Livreur non trouvé' });
    }

    db.run("UPDATE formulaires SET livreurId = ?, livreurName = ?, status = 'assigné' WHERE id = ?",
      [livreurId, livreur.name, formulaireId],
      function(err) {
        if (err) {
          return res.status(500).json({ error: err.message });
        }

        db.get("SELECT * FROM formulaires WHERE id = ?", [formulaireId], (err, formulaire) => {
          io.emit('formulaire_assigné', formulaire);
          res.json({ message: 'Livreur assigné avec succès', formulaire });
        });
      }
    );
  });
});

// Récupérer les boutiques
app.get('/api/boutiques', (req, res) => {
  db.all("SELECT * FROM users WHERE type = 'boutique'", (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// Récupérer les livreurs
app.get('/api/livreurs', (req, res) => {
  db.all("SELECT * FROM users WHERE type = 'livreur'", (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// Formulaires par boutique
app.get('/api/formulaires/boutique/:boutiqueId', (req, res) => {
  db.all("SELECT * FROM formulaires WHERE boutiqueId = ? ORDER BY createdAt DESC", 
    [req.params.boutiqueId], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// Tous les formulaires (admin)
app.get('/api/formulaires/admin', (req, res) => {
  db.all("SELECT * FROM formulaires ORDER BY createdAt DESC", (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// Formulaires par livreur
app.get('/api/formulaires/livreur/:livreurId', (req, res) => {
  db.all("SELECT * FROM formulaires WHERE livreurId = ? ORDER BY createdAt DESC", 
    [req.params.livreurId], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// Mettre à jour statut
app.post('/api/update-status', (req, res) => {
  const { formulaireId, status } = req.body;
  
  db.run("UPDATE formulaires SET status = ? WHERE id = ?", [status, formulaireId], function(err) {
    if (err) {
      return res.status(500).json({ error: err.message });
    }

    db.get("SELECT * FROM formulaires WHERE id = ?", [formulaireId], (err, formulaire) => {
      io.emit('status_updated', formulaire);
      res.json({ message: 'Statut mis à jour', formulaire });
    });
  });
});

// Envoyer message
app.post('/api/messages', (req, res) => {
  const { from, to, content, type } = req.body;
  
  db.run("INSERT INTO messages (fromId, toId, content, type) VALUES (?, ?, ?, ?)",
    [from, to, content, type],
    function(err) {
      if (err) {
        return res.status(500).json({ error: err.message });
      }

      const message = {
        id: this.lastID,
        from,
        to,
        content,
        type,
        timestamp: new Date()
      };

      io.emit('new_message', message);
      res.json({ message: 'Message envoyé', data: message });
    }
  );
});

// Récupérer messages
app.get('/api/messages/:user1/:user2', (req, res) => {
  const { user1, user2 } = req.params;
  
  db.all(`SELECT * FROM messages 
    WHERE (fromId = ? AND toId = ?) OR (fromId = ? AND toId = ?) 
    ORDER BY timestamp ASC`,
    [user1, user2, user2, user1], (err, rows) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// ==================== WEBSOCKET ====================
io.on('connection', (socket) => {
  console.log('👤 Client connecté:', socket.id);
  
  socket.on('join_user', (userId) => {
    socket.join(userId);
  });
  
  socket.on('send_message', (data) => {
    const { from, to, content, type } = data;
    
    db.run("INSERT INTO messages (fromId, toId, content, type) VALUES (?, ?, ?, ?)",
      [from, to, content, type],
      function(err) {
        if (!err) {
          const message = {
            id: this.lastID,
            from,
            to,
            content,
            type,
            timestamp: new Date()
          };
          io.emit('new_message', message);
        }
      }
    );
  });
  
  socket.on('disconnect', () => {
    console.log('❌ Client déconnecté:', socket.id);
  });
});

// ==================== DÉMARRAGE ====================
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`🚀 Serveur Premium Delivery DÉMARRÉ!`);
  console.log(`📍 Port: ${PORT}`);
  console.log(`🗄️ Base de données: SQLite intégrée`);
  console.log(`🔗 Test: http://localhost:${PORT}`);
});