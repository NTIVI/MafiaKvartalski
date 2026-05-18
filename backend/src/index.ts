import express from 'express';
import cors from 'cors';
import { createServer } from 'http';
import dotenv from 'dotenv';
import http from 'http';
import { prisma } from './db';
import { setupWebSocket } from './socket';

dotenv.config();

const app = express();
const port = process.env.PORT || 4000;

// Configure CORS for local development and Vercel domains
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  ...(process.env.FRONTEND_URL ? [process.env.FRONTEND_URL] : [])
];

app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.some(o => origin.startsWith(o)) || allowedOrigins.includes('*')) {
      callback(null, true);
    } else {
      // Allow staging/preview deployments of Vercel as well
      if (origin.endsWith('.vercel.app')) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    }
  },
  credentials: true
}));

app.use(express.json());

// 1. Ping endpoint for healthcheck & self-ping mechanism
app.get('/ping', (req, res) => {
  res.status(200).send('pong');
});

// Create a new room with a unique 4-character code
app.post('/api/rooms', async (req, res) => {
  const { hostId, username, photoUrl } = req.body;
  if (!hostId) {
    return res.status(400).json({ error: 'Missing hostId' });
  }

  try {
    // Upsert User
    await prisma.user.upsert({
      where: { id: hostId },
      update: { username, photoUrl },
      create: { id: hostId, username, photoUrl }
    });

    let code = '';
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let isUnique = false;

    // Generate unique 4 letter code
    while (!isUnique) {
      code = '';
      for (let i = 0; i < 4; i++) {
        code += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      const existing = await prisma.room.findUnique({
        where: { code }
      });
      if (!existing) {
        isUnique = true;
      }
    }

    const room = await prisma.room.create({
      data: {
        code,
        hostId,
        status: 'LOBBY',
        currentPhase: 'LOBBY',
        roundNumber: 1
      }
    });

    return res.status(201).json(room);
  } catch (error) {
    console.error('Error creating room:', error);
    return res.status(500).json({ error: 'Failed to create room' });
  }
});

// Fetch room details by join code (checks room existence before WS connect)
app.get('/api/rooms/:code', async (req, res) => {
  const { code } = req.params;
  try {
    const room = await prisma.room.findUnique({
      where: { code: code.toUpperCase() },
      include: {
        players: {
          include: {
            user: true
          }
        }
      }
    });

    if (!room) {
      return res.status(404).json({ error: 'Room not found' });
    }

    return res.status(200).json(room);
  } catch (error) {
    console.error('Error fetching room details:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

const server = createServer(app);

// Setup WebSockets
setupWebSocket(server);

// Render self-ping mechanism to prevent service from falling asleep (free tier sleep prevention)
const selfUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;
if (process.env.NODE_ENV === 'production' || process.env.RENDER_EXTERNAL_URL) {
  console.log(`Starting self-ping service targeting ${selfUrl}`);
  setInterval(() => {
    http.get(`${selfUrl}/ping`, (res) => {
      if (res.statusCode === 200) {
        console.log('Self-ping success - server kept awake');
      } else {
        console.warn(`Self-ping returned status code: ${res.statusCode}`);
      }
    }).on('error', (err) => {
      console.error('Self-ping failed:', err.message);
    });
  }, 10 * 60 * 1000); // Ping every 10 minutes
}

server.listen(port, () => {
  console.log(`Backend server listening at http://localhost:${port}`);
});
