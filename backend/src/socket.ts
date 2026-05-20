import { Server as HTTPServer } from 'http';
import WebSocket, { Server as WSServer } from 'ws';
import { prisma } from './db';
import { WSMessage } from './types';
import {
  startGame,
  endSpeechEarly,
  castVote,
  castMafiaVote,
  checkDonTarget,
  checkSheriffTarget
} from './game';

// Map of playerId -> WebSocket instance for target signals
const activePlayers = new Map<string, { socket: WebSocket; roomId: string; userId: string }>();

// Helper to broadcast room state updates to all active players in a room
export async function broadcastToRoom(roomId: string, message: WSMessage) {
  const players = await prisma.player.findMany({
    where: { roomId },
    select: { id: true }
  });

  const rawMessage = JSON.stringify(message);

  players.forEach((player) => {
    const connection = activePlayers.get(player.id);
    if (connection && connection.socket.readyState === WebSocket.OPEN) {
      connection.socket.send(rawMessage);
    }
  });
}

// Send standard error to a socket
function sendError(socket: WebSocket, message: string) {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify({
      type: 'error',
      payload: { message }
    }));
  }
}

export function setupWebSocket(server: HTTPServer) {
  const wss = new WSServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  });

  wss.on('connection', (ws: WebSocket & { isAlive?: boolean }) => {
    ws.isAlive = true;
    let currentPlayerId: string | null = null;

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', async (data: string) => {
      try {
        const message: WSMessage = JSON.parse(data);
        const { type, payload } = message;

        switch (type) {
          case 'ping':
            ws.send(JSON.stringify({ type: 'pong' }));
            break;

          case 'join_game': {
            const { userId, roomCode, username, photoUrl } = payload;
            if (!userId || !roomCode) {
              sendError(ws, 'Missing userId or roomCode');
              return;
            }

            let room = await prisma.room.findUnique({
              where: { code: roomCode.toUpperCase() },
              include: { players: true }
            });

            if (!room) {
              sendError(ws, 'Room not found');
              return;
            }

            await prisma.user.upsert({
              where: { id: userId },
              update: { username, photoUrl },
              create: { id: userId, username, photoUrl }
            });

            let player = room.players.find(p => p.userId === userId);

            if (!player) {
              if (room.players.length >= 10) {
                sendError(ws, 'Room is full (max 10 players)');
                return;
              }

              if (room.status !== 'LOBBY') {
                sendError(ws, 'Game has already started in this room');
                return;
              }

              const occupiedSeats = room.players.map(p => p.seatNumber);
              let seatNumber = 1;
              while (occupiedSeats.includes(seatNumber)) {
                seatNumber++;
              }

              player = await prisma.player.create({
                data: {
                  userId,
                  roomId: room.id,
                  seatNumber,
                  role: 'NONE',
                  isAlive: true
                }
              });
            }

            currentPlayerId = player.id;
            activePlayers.set(player.id, { socket: ws, roomId: room.id, userId });

            const updatedRoom = await prisma.room.findUnique({
              where: { id: room.id },
              include: {
                players: {
                  include: {
                    user: true
                  }
                }
              }
            });

            if (updatedRoom) {
              broadcastToRoom(room.id, {
                type: 'room_state_updated',
                payload: { room: updatedRoom }
              });
            }
            break;
          }

          case 'start_game': {
            if (!currentPlayerId) return;
            const connection = activePlayers.get(currentPlayerId);
            if (!connection) return;

            try {
              await startGame(connection.roomId);
            } catch (err: any) {
              sendError(ws, err.message || 'Failed to start game');
            }
            break;
          }

          case 'speech_ended': {
            if (!currentPlayerId) return;
            const connection = activePlayers.get(currentPlayerId);
            if (!connection) return;

            endSpeechEarly(connection.roomId);
            break;
          }

          case 'cast_vote': {
            const { targetPlayerId } = payload;
            if (!currentPlayerId || !targetPlayerId) return;
            const connection = activePlayers.get(currentPlayerId);
            if (!connection) return;

            await castVote(connection.roomId, currentPlayerId, targetPlayerId);
            break;
          }

          case 'mafia_shoot': {
            const { targetPlayerId } = payload;
            if (!currentPlayerId || !targetPlayerId) return;
            const connection = activePlayers.get(currentPlayerId);
            if (!connection) return;

            await castMafiaVote(connection.roomId, currentPlayerId, targetPlayerId);
            break;
          }

          case 'don_check': {
            const { targetPlayerId } = payload;
            if (!currentPlayerId || !targetPlayerId) return;
            const connection = activePlayers.get(currentPlayerId);
            if (!connection) return;

            const checkResult = await checkDonTarget(connection.roomId, currentPlayerId, targetPlayerId);
            if (checkResult) {
              ws.send(JSON.stringify({
                type: 'don_check_result',
                payload: {
                  targetPlayerId,
                  isSheriff: checkResult.isSheriff
                }
              }));
            }
            break;
          }

          case 'sheriff_check': {
            const { targetPlayerId } = payload;
            if (!currentPlayerId || !targetPlayerId) return;
            const connection = activePlayers.get(currentPlayerId);
            if (!connection) return;

            const checkResult = await checkSheriffTarget(connection.roomId, currentPlayerId, targetPlayerId);
            if (checkResult) {
              ws.send(JSON.stringify({
                type: 'sheriff_check_result',
                payload: {
                  targetPlayerId,
                  isMafia: checkResult.isMafia
                }
              }));
            }
            break;
          }

          case 'toggle_mute': {
            const { isMuted } = payload;
            if (!currentPlayerId) return;
            const connection = activePlayers.get(currentPlayerId);
            if (!connection) return;

            // Only allow toggling mute during lobby or day discussion when permitted
            const updatedPlayer = await prisma.player.update({
              where: { id: currentPlayerId },
              data: { isMuted }
            });

            const updatedRoom = await prisma.room.findUnique({
              where: { id: connection.roomId },
              include: {
                players: {
                  include: {
                    user: true
                  }
                }
              }
            });

            if (updatedRoom) {
              broadcastToRoom(connection.roomId, {
                type: 'room_state_updated',
                payload: { room: updatedRoom }
              });
            }
            break;
          }

          case 'webrtc_signal': {
            const { targetPlayerId, signal } = payload;
            if (!currentPlayerId || !targetPlayerId || !signal) return;

            const targetConnection = activePlayers.get(targetPlayerId);
            if (targetConnection && targetConnection.socket.readyState === WebSocket.OPEN) {
              targetConnection.socket.send(JSON.stringify({
                type: 'webrtc_signal',
                payload: {
                  senderPlayerId: currentPlayerId,
                  signal
                }
              }));
            }
            break;
          }

          default:
            console.warn(`Unhandled message type: ${type}`);
            break;
        }
      } catch (err) {
        console.error('Error handling WebSocket message:', err);
        sendError(ws, 'Invalid message payload');
      }
    });

    ws.on('close', async () => {
      if (currentPlayerId) {
        const connection = activePlayers.get(currentPlayerId);
        activePlayers.delete(currentPlayerId);

        if (connection) {
          const { roomId, userId } = connection;

          const room = await prisma.room.findUnique({
            where: { id: roomId },
            include: { players: true }
          });

          if (room) {
            if (room.status === 'LOBBY') {
              await prisma.player.delete({
                where: { id: currentPlayerId }
              }).catch(() => { });

              const remainingPlayers = room.players.filter(p => p.id !== currentPlayerId);
              if (remainingPlayers.length === 0) {
                await prisma.room.delete({
                  where: { id: roomId }
                }).catch(() => { });
              } else {
                if (room.hostId === userId) {
                  await prisma.room.update({
                    where: { id: roomId },
                    data: { hostId: remainingPlayers[0].userId }
                  }).catch(() => { });
                }

                const updatedRoom = await prisma.room.findUnique({
                  where: { id: roomId },
                  include: {
                    players: {
                      include: {
                        user: true
                      }
                    }
                  }
                });

                if (updatedRoom) {
                  broadcastToRoom(roomId, {
                    type: 'room_state_updated',
                    payload: { room: updatedRoom }
                  });
                }
              }
            } else {
              console.log(`Player ${currentPlayerId} disconnected during active game`);
            }
          }
        }
      }
    });
  });

  const heartbeatInterval = setInterval(() => {
    wss.clients.forEach((ws: WebSocket & { isAlive?: boolean }) => {
      if (ws.isAlive === false) {
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, 30000);

  wss.on('close', () => {
    clearInterval(heartbeatInterval);
  });
}
