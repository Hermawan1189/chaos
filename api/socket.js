import { Server } from 'socket.io';
import { createServer } from 'http';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

// Serve static files dari public folder
app.use(express.static(join(__dirname, '../public')));

// Route untuk halaman utama
app.get('/', (req, res) => {
  res.sendFile(join(__dirname, '../public/index.html'));
});

app.get('/game', (req, res) => {
  res.sendFile(join(__dirname, '../public/game.html'));
});

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling']
});

// Data game state (gunakan Redis di production)
const rooms = new Map();
const players = new Map();
const ROLES = ['Captain', 'Technician', 'Spy', 'AI', 'Saboteur'];
const SHIP_SYSTEMS = ['Engine', 'Oxygen', 'Navigation', 'Shield', 'Communication'];

// Fungsi helper
function generateRoomId() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function assignRoles(playerCount) {
  const roles = [...ROLES];
  const assigned = ['Captain', 'Technician'];
  
  if (playerCount >= 3) assigned.push('Spy');
  if (playerCount >= 4) assigned.push('AI');
  if (playerCount >= 5) assigned.push('Saboteur');
  
  while (assigned.length < playerCount) {
    const randomRole = ROLES[Math.floor(Math.random() * ROLES.length)];
    if (!assigned.includes(randomRole)) {
      assigned.push(randomRole);
    }
  }
  
  return assigned.sort(() => Math.random() - 0.5);
}

function getObjective(role) {
  const objectives = {
    'Captain': 'Bawa kapal sampai tujuan dengan sistem ≥60%',
    'Technician': 'Jaga semua sistem di atas 70%',
    'Spy': 'Kumpulkan 3 data rahasia tanpa ketahuan',
    'AI': 'Ikuti semua perintah Captain tapi jaga sistem oksigen <50%',
    'Saboteur': 'Cegah kapal sampai tujuan tanpa ketahuan'
  };
  return objectives[role] || 'Selesaikan misi rahasiamu!';
}

function getRandomEvent() {
  const events = [
    { type: 'meteor', message: 'Serangan meteor! Sistem rusak.' },
    { type: 'radiation', message: 'Gelombang radiasi! Perbaiki shield.' },
    { type: 'alien', message: 'Sinyal alien terdeteksi.' },
    { type: 'system_failure', message: 'Kegagalan sistem! Periksa semua panel.' }
  ];
  return events[Math.floor(Math.random() * events.length)];
}

function calculateShipHealth(systems) {
  const values = Object.values(systems);
  const total = values.reduce((sum, health) => sum + health, 0);
  return Math.floor(total / values.length);
}

// Socket.io event handlers
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  
  socket.on('createRoom', (username) => {
    const roomId = generateRoomId();
    const room = {
      id: roomId,
      players: [],
      gameStarted: false,
      shipHealth: 100,
      systems: SHIP_SYSTEMS.reduce((acc, system) => {
        acc[system] = 100;
        return acc;
      }, {}),
      distance: 0,
      totalDistance: 100,
      timeLeft: 15 * 60,
      events: [],
      votes: {},
      gameInterval: null
    };
    
    rooms.set(roomId, room);
    
    const player = {
      id: socket.id,
      username: username || `Player_${socket.id.substring(0, 4)}`,
      roomId,
      role: null,
      secretButtonUses: 3,
      voted: false,
      objectiveCompleted: false
    };
    
    players.set(socket.id, player);
    room.players.push(socket.id);
    socket.join(roomId);
    
    socket.emit('roomCreated', { 
      roomId, 
      player: player.username,
      room: room 
    });
    
    io.to(roomId).emit('roomUpdated', {
      players: room.players.map(id => players.get(id)),
      roomId,
      gameStarted: room.gameStarted
    });
    
    socket.emit('chatMessage', {
      sender: 'System',
      message: `Room ${roomId} berhasil dibuat! Bagikan kode ini ke temanmu.`,
      timestamp: new Date().toISOString()
    });
  });
  
  socket.on('joinRoom', ({ roomId, username }) => {
    const room = rooms.get(roomId);
    
    if (!room) {
      socket.emit('error', { message: 'Room tidak ditemukan' });
      return;
    }
    
    if (room.gameStarted) {
      socket.emit('error', { message: 'Game sudah dimulai' });
      return;
    }
    
    if (room.players.length >= 10) {
      socket.emit('error', { message: 'Room penuh (max 10 pemain)' });
      return;
    }
    
    const player = {
      id: socket.id,
      username: username || `Player_${socket.id.substring(0, 4)}`,
      roomId,
      role: null,
      secretButtonUses: 3,
      voted: false,
      objectiveCompleted: false
    };
    
    players.set(socket.id, player);
    room.players.push(socket.id);
    socket.join(roomId);
    
    socket.emit('joinedRoom', { 
      roomId, 
      player: player.username,
      room: room 
    });
    
    io.to(roomId).emit('roomUpdated', {
      players: room.players.map(id => players.get(id)),
      roomId,
      gameStarted: room.gameStarted
    });
    
    io.to(roomId).emit('chatMessage', {
      sender: 'System',
      message: `${player.username} bergabung ke game!`,
      timestamp: new Date().toISOString()
    });
  });
  
  socket.on('startGame', () => {
    const player = players.get(socket.id);
    if (!player) return;
    
    const room = rooms.get(player.roomId);
    if (!room || room.gameStarted) return;
    
    // Minimal 2 pemain untuk mulai
    if (room.players.length < 2) {
      socket.emit('error', { message: 'Minimal 2 pemain untuk memulai game' });
      return;
    }
    
    // Assign roles
    const roles = assignRoles(room.players.length);
    room.players.forEach((playerId, index) => {
      const p = players.get(playerId);
      p.role = roles[index];
      p.objective = getObjective(roles[index]);
      
      // Kirim role rahasia ke masing-masing pemain
      io.to(playerId).emit('roleAssigned', {
        role: roles[index],
        objective: p.objective,
        secret: `Tombol rahasia: ${p.secretButtonUses} kali penggunaan`
      });
    });
    
    room.gameStarted = true;
    room.startTime = Date.now();
    
    // Start game loop
    room.gameInterval = setInterval(() => updateGame(room.id), 1000);
    
    io.to(room.id).emit('gameStarted', room);
    io.to(room.id).emit('chatMessage', {
      sender: 'System',
      message: 'GAME DIMULAI! Peran rahasia telah dibagikan. Periksa objective Anda!',
      timestamp: new Date().toISOString()
    });
  });
  
  socket.on('useSecretButton', ({ action, target }) => {
    const player = players.get(socket.id);
    if (!player) return;
    
    const room = rooms.get(player.roomId);
    if (!room || !room.gameStarted) return;
    
    if (player.secretButtonUses <= 0) {
      socket.emit('error', { message: 'Tombol rahasia sudah habis!' });
      return;
    }
    
    player.secretButtonUses--;
    
    const effects = {
      lights: { system: null, healthChange: 0, message: '⚡ Lampu mati 30 detik!' },
      engine: { system: 'Engine', healthChange: -20, message: '🚀 Mesin terganggu!' },
      door: { system: 'Oxygen', healthChange: -15, message: '🚪 Pintu darurat terbuka!' },
      hack: { system: 'Navigation', healthChange: -25, message: '💻 Sistem navigasi di-hack!' }
    };
    
    const effect = effects[action] || effects.lights;
    
    if (effect.system) {
      room.systems[effect.system] = Math.max(0, room.systems[effect.system] + effect.healthChange);
    }
    
    room.events.push({
      type: 'secret_action',
      player: player.username,
      action,
      message: effect.message,
      timestamp: Date.now()
    });
    
    io.to(room.id).emit('secretButtonUsed', {
      player: player.username,
      action,
      message: effect.message,
      remainingUses: player.secretButtonUses
    });
    
    io.to(room.id).emit('chatMessage', {
      sender: 'System',
      message: `${player.username} menggunakan tombol rahasia! ${effect.message}`,
      timestamp: new Date().toISOString()
    });
  });
  
  socket.on('repairSystem', (system) => {
    const player = players.get(socket.id);
    if (!player) return;
    
    const room = rooms.get(player.roomId);
    if (!room || !room.gameStarted) return;
    
    if (!SHIP_SYSTEMS.includes(system)) {
      socket.emit('error', { message: 'Sistem tidak valid' });
      return;
    }
    
    // Technician repair lebih efektif
    const repairAmount = player.role === 'Technician' ? 35 : 15;
    room.systems[system] = Math.min(100, room.systems[system] + repairAmount);
    
    io.to(room.id).emit('systemRepaired', {
      system,
      newHealth: room.systems[system],
      repairedBy: player.username,
      isTechnician: player.role === 'Technician'
    });
    
    io.to(room.id).emit('chatMessage', {
      sender: 'System',
      message: `🔧 ${player.username} memperbaiki sistem ${system} ke ${room.systems[system]}%`,
      timestamp: new Date().toISOString()
    });
  });
  
  socket.on('castVote', ({ targetPlayerId }) => {
    const player = players.get(socket.id);
    if (!player || player.voted) return;
    
    const room = rooms.get(player.roomId);
    if (!room || !room.gameStarted) return;
    
    const targetPlayer = players.get(targetPlayerId);
    if (!targetPlayer || targetPlayer.roomId !== room.id) {
      socket.emit('error', { message: 'Pemain target tidak valid' });
      return;
    }
    
    player.voted = true;
    room.votes[player.id] = targetPlayerId;
    
    io.to(room.id).emit('voteCasted', {
      voter: player.username,
      target: targetPlayer.username,
      votes: Object.keys(room.votes).length,
      totalPlayers: room.players.length
    });
    
    // Cek jika semua sudah voting
    if (Object.keys(room.votes).length === room.players.length) {
      processVotes(room.id);
    }
  });
  
  socket.on('sendChat', (message) => {
    const player = players.get(socket.id);
    if (!player) return;
    
    const room = rooms.get(player.roomId);
    if (!room) return;
    
    io.to(room.id).emit('chatMessage', {
      sender: player.username,
      message,
      timestamp: new Date().toISOString(),
      role: room.gameStarted ? player.role : null
    });
  });
  
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    
    const player = players.get(socket.id);
    if (player) {
      const room = rooms.get(player.roomId);
      if (room) {
        // Remove player from room
        room.players = room.players.filter(id => id !== socket.id);
        
        if (room.players.length === 0) {
          // Clean up room jika kosong
          if (room.gameInterval) clearInterval(room.gameInterval);
          rooms.delete(room.id);
        } else {
          // Update room
          io.to(room.id).emit('roomUpdated', {
            players: room.players.map(id => players.get(id)),
            roomId: room.id,
            gameStarted: room.gameStarted
          });
          
          io.to(room.id).emit('chatMessage', {
            sender: 'System',
            message: `${player.username} meninggalkan game`,
            timestamp: new Date().toISOString()
          });
          
          // End game jika kurang dari 2 pemain
          if (room.gameStarted && room.players.length < 2) {
            endGame(room.id, 'Game berakhir: Terlalu sedikit pemain');
          }
        }
      }
      players.delete(socket.id);
    }
  });
});

function updateGame(roomId) {
  const room = rooms.get(roomId);
  if (!room || !room.gameStarted) return;
  
  room.timeLeft--;
  
  // Update distance berdasarkan engine health
  const engineEfficiency = room.systems.Engine / 100;
  room.distance += engineEfficiency * 0.5;
  
  // Random system degradation
  SHIP_SYSTEMS.forEach(system => {
    if (Math.random() < 0.02) {
      room.systems[system] = Math.max(0, room.systems[system] - 2);
    }
  });
  
  // Random events (5% chance)
  if (Math.random() < 0.05 && room.events.length < 10) {
    const event = getRandomEvent();
    room.events.push({
      ...event,
      timestamp: Date.now()
    });
    
    // Apply event damage
    if (event.type === 'meteor') {
      const randomSystem = SHIP_SYSTEMS[Math.floor(Math.random() * SHIP_SYSTEMS.length)];
      room.systems[randomSystem] = Math.max(0, room.systems[randomSystem] - 25);
    }
    
    io.to(roomId).emit('randomEvent', event);
  }
  
  // Calculate ship health
  room.shipHealth = calculateShipHealth(room.systems);
  
  // Send update to all players
  io.to(roomId).emit('gameUpdate', {
    timeLeft: room.timeLeft,
    distance: Math.min(room.distance, room.totalDistance),
    totalDistance: room.totalDistance,
    systems: room.systems,
    shipHealth: room.shipHealth,
    events: room.events.slice(-5) // Last 5 events
  });
  
  // Check win/lose conditions
  if (room.timeLeft <= 0) {
    endGame(roomId, '⏰ Waktu habis! Kapal tidak sampai tujuan.');
  } else if (room.distance >= room.totalDistance) {
    endGame(roomId, '🎉 KAPAL SAMPAI TUJUAN!');
  } else if (room.shipHealth <= 0) {
    endGame(roomId, '💥 KAPAL HANCUR! Semua sistem gagal.');
  }
}

function processVotes(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  // Count votes
  const voteCount = {};
  Object.values(room.votes).forEach(targetId => {
    voteCount[targetId] = (voteCount[targetId] || 0) + 1;
  });
  
  // Find player with most votes
  let maxVotes = 0;
  let ejectedPlayerId = null;
  
  Object.entries(voteCount).forEach(([playerId, votes]) => {
    if (votes > maxVotes) {
      maxVotes = votes;
      ejectedPlayerId = playerId;
    }
  });
  
  // Reset votes
  room.votes = {};
  room.players.forEach(playerId => {
    const player = players.get(playerId);
    if (player) player.voted = false;
  });
  
  if (ejectedPlayerId && maxVotes > 1) {
    const ejectedPlayer = players.get(ejectedPlayerId);
    
    // Remove ejected player
    room.players = room.players.filter(id => id !== ejectedPlayerId);
    
    io.to(roomId).emit('playerEjected', {
      player: ejectedPlayer.username,
      votes: maxVotes
    });
    
    io.to(roomId).emit('chatMessage', {
      sender: 'System',
      message: `👢 ${ejectedPlayer.username} dikeluarkan dari kapal!`,
      timestamp: new Date().toISOString()
    });
    
    // Kick player socket
    const ejectedSocket = io.sockets.sockets.get(ejectedPlayerId);
    if (ejectedSocket) {
      ejectedSocket.emit('ejected', { reason: 'Dikeluarkan oleh voting' });
      ejectedSocket.disconnect();
    }
    
    players.delete(ejectedPlayerId);
  }
}

function endGame(roomId, message) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  // Clear game interval
  if (room.gameInterval) {
    clearInterval(room.gameInterval);
    room.gameInterval = null;
  }
  
  room.gameStarted = false;
  
  // Calculate winners based on objectives
  const winners = [];
  room.players.forEach(playerId => {
    const player = players.get(playerId);
    if (player) {
      // Simple win condition logic (bisa dikembangkan)
      const isWinner = checkObjectiveCompletion(player, room);
      if (isWinner) {
        winners.push(player.username);
        player.objectiveCompleted = true;
      }
    }
  });
  
  io.to(roomId).emit('gameEnded', {
    message,
    winners,
    finalStats: {
      shipHealth: room.shipHealth,
      distance: room.distance,
      systems: room.systems,
      timeLeft: room.timeLeft
    }
  });
  
  io.to(roomId).emit('chatMessage', {
    sender: 'System',
    message: `GAME BERAKHIR! ${message} Pemenang: ${winners.join(', ') || 'Tidak ada'}`,
    timestamp: new Date().toISOString()
  });
  
  // Reset room for new game
  setTimeout(() => {
    room.players.forEach(playerId => {
      const player = players.get(playerId);
      if (player) {
        player.role = null;
        player.voted = false;
        player.secretButtonUses = 3;
      }
    });
    
    room.gameStarted = false;
    room.shipHealth = 100;
    room.distance = 0;
    room.timeLeft = 15 * 60;
    room.events = [];
    room.votes = {};
    
    SHIP_SYSTEMS.forEach(system => {
      room.systems[system] = 100;
    });
  }, 30000); // Reset setelah 30 detik
}

function checkObjectiveCompletion(player, room) {
  // Basic objective checking - bisa dikembangkan lebih kompleks
  switch(player.role) {
    case 'Captain':
      return room.distance >= room.totalDistance && room.shipHealth >= 60;
    case 'Technician':
      return Object.values(room.systems).every(health => health >= 70);
    case 'Saboteur':
      return room.distance < room.totalDistance || room.shipHealth <= 0;
    default:
      return Math.random() > 0.5; // 50% chance untuk role lain
  }
}

// Export handler untuk Vercel
export default function handler(req, res) {
  // Vercel memerlukan handler function
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Socket.io server running');
}

// Listen pada port untuk development lokal
if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  httpServer.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}