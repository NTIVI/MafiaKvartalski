import { prisma } from './db';
import { Role, GamePhase, RoomStatus, Player } from '@prisma/client';
import { broadcastToRoom } from './socket';

// Distribute roles dynamically based on player count
function distributeRoles(playerCount: number): Role[] {
  const roles: Role[] = [];
  
  if (playerCount <= 4) {
    roles.push(Role.MAFIA);
    roles.push(Role.SHERIFF);
    while (roles.length < playerCount) roles.push(Role.CIVILIAN);
  } else if (playerCount <= 6) {
    roles.push(Role.MAFIA);
    roles.push(Role.DON);
    roles.push(Role.SHERIFF);
    while (roles.length < playerCount) roles.push(Role.CIVILIAN);
  } else {
    // 7 to 10 players
    roles.push(Role.MAFIA);
    roles.push(Role.MAFIA);
    roles.push(Role.DON);
    roles.push(Role.SHERIFF);
    while (roles.length < playerCount) roles.push(Role.CIVILIAN);
  }

  // Shuffle roles using Fisher-Yates
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }

  return roles;
}

export async function checkVictoryConditions(roomId: string): Promise<boolean> {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: { players: true }
  });

  if (!room || room.status !== RoomStatus.PLAYING) return false;

  const alivePlayers = room.players.filter(p => p.isAlive);
  
  const mafias = alivePlayers.filter(p => p.role === Role.MAFIA || p.role === Role.DON);
  const civilians = alivePlayers.filter(p => p.role === Role.CIVILIAN || p.role === Role.SHERIFF);

  const numMafia = mafias.length;
  const numCivilian = civilians.length;

  console.log(`Checking victory for Room ${roomId}: Mafias: ${numMafia}, Civilians: ${numCivilian}`);

  if (numMafia === 0) {
    // Civilian Victory
    await finishGame(roomId, 'CIVILIANS');
    return true;
  } else if (numMafia >= numCivilian) {
    // Mafia Victory
    await finishGame(roomId, 'MAFIA');
    return true;
  }

  return false;
}

async function finishGame(roomId: string, winner: 'CIVILIANS' | 'MAFIA') {
  const room = await prisma.room.update({
    where: { id: roomId },
    data: {
      status: RoomStatus.FINISHED,
      currentPhase: GamePhase.GAME_OVER,
      winner
    },
    include: {
      players: {
        include: {
          user: true
        }
      }
    }
  });

  // Log game result
  await prisma.gameLog.create({
    data: {
      roomId,
      round: room.roundNumber,
      phase: GamePhase.GAME_OVER,
      action: 'GAME_OVER',
      details: JSON.stringify({ winner })
    }
  });

  // Broadcast victory states
  // Civilians win: payload tells everyone.
  // Mafia wins: different alerts will be rendered client-side based on user's role.
  broadcastToRoom(roomId, {
    type: 'game_ended',
    payload: {
      winner,
      room
    }
  });
}

export async function startGame(roomId: string) {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: { players: true }
  });

  if (!room) return;
  if (room.players.length < 3) {
    throw new Error('Need at least 3 players to start');
  }

  const roles = distributeRoles(room.players.length);

  // Assign roles, reset seat numbers, alive status
  const updatePromises = room.players.map((player, index) => {
    return prisma.player.update({
      where: { id: player.id },
      data: {
        role: roles[index],
        isAlive: true,
        isMuted: false,
        seatNumber: index + 1
      }
    });
  });

  await Promise.all(updatePromises);

  const updatedRoom = await prisma.room.update({
    where: { id: roomId },
    data: {
      status: RoomStatus.PLAYING,
      currentPhase: GamePhase.ROLES_ASSIGNMENT,
      roundNumber: 1
    },
    include: {
      players: {
        include: {
          user: true
        }
      }
    }
  });

  await prisma.gameLog.create({
    data: {
      roomId,
      round: 1,
      phase: GamePhase.ROLES_ASSIGNMENT,
      action: 'GAME_START',
      details: 'Game has started, roles assigned.'
    }
  });

  broadcastToRoom(roomId, {
    type: 'game_started',
    payload: { room: updatedRoom }
  });

  // Transition from roles assignment to Day Discussion after 5 seconds
  setTimeout(async () => {
    await startDayDiscussion(roomId);
  }, 5000);
}

export async function startDayDiscussion(roomId: string) {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: { players: true }
  });

  if (!room || room.status !== RoomStatus.PLAYING) return;

  // Clear previous round votes
  await prisma.vote.deleteMany({
    where: { roomId }
  });

  const updatedRoom = await prisma.room.update({
    where: { id: roomId },
    data: {
      currentPhase: GamePhase.DAY_DISCUSSION
    },
    include: {
      players: {
        include: {
          user: true
        }
      }
    }
  });

  await prisma.gameLog.create({
    data: {
      roomId,
      round: room.roundNumber,
      phase: GamePhase.DAY_DISCUSSION,
      action: 'PHASE_CHANGE',
      details: `Day discussion for round ${room.roundNumber} started.`
    }
  });

  broadcastToRoom(roomId, {
    type: 'phase_changed',
    payload: { room: updatedRoom }
  });

  // Start sequential speech: each player gets speech time
  const alivePlayers = updatedRoom.players
    .filter(p => p.isAlive)
    .sort((a, b) => a.seatNumber - b.seatNumber);

  runSpeechSequence(roomId, alivePlayers, 0);
}

async function runSpeechSequence(roomId: string, players: Player[], currentIndex: number) {
  const room = await prisma.room.findUnique({
    where: { id: roomId }
  });

  if (!room || room.currentPhase !== GamePhase.DAY_DISCUSSION || room.status !== RoomStatus.PLAYING) return;

  if (currentIndex >= players.length) {
    // All alive players spoke, transition to voting
    await startDayVoting(roomId);
    return;
  }

  const activeSpeaker = players[currentIndex];

  // Set all players to muted except the speaker
  await prisma.player.updateMany({
    where: { roomId },
    data: { isMuted: true }
  });

  await prisma.player.update({
    where: { id: activeSpeaker.id },
    data: { isMuted: false }
  });

  const roomWithSpeaker = await prisma.room.findUnique({
    where: { id: roomId },
    include: {
      players: {
        include: {
          user: true
        }
      }
    }
  });

  broadcastToRoom(roomId, {
    type: 'speaker_changed',
    payload: {
      speakerId: activeSpeaker.id,
      room: roomWithSpeaker
    }
  });

  // Give them 60 seconds or listen for an early "speech_ended"
  const speechTimeout = setTimeout(async () => {
    // Move to next speaker
    await runSpeechSequence(roomId, players, currentIndex + 1);
  }, 60000);

  // Store timeout on a global or memory-based map to cancel if they end early
  activeSpeechTimeouts.set(roomId, {
    timeout: speechTimeout,
    next: () => runSpeechSequence(roomId, players, currentIndex + 1)
  });
}

// Memory cache for speech timeouts
const activeSpeechTimeouts = new Map<string, { timeout: NodeJS.Timeout; next: () => void }>();

export function endSpeechEarly(roomId: string) {
  const active = activeSpeechTimeouts.get(roomId);
  if (active) {
    clearTimeout(active.timeout);
    activeSpeechTimeouts.delete(roomId);
    active.next(); // Proceed to next speaker
  }
}

export async function startDayVoting(roomId: string) {
  const room = await prisma.room.findUnique({
    where: { id: roomId }
  });

  if (!room || room.status !== RoomStatus.PLAYING) return;

  // Unmute all players for voting discussion/voting session
  await prisma.player.updateMany({
    where: { roomId },
    data: { isMuted: false }
  });

  const updatedRoom = await prisma.room.update({
    where: { id: roomId },
    data: {
      currentPhase: GamePhase.DAY_VOTING
    },
    include: {
      players: {
        include: {
          user: true
        }
      }
    }
  });

  await prisma.gameLog.create({
    data: {
      roomId,
      round: room.roundNumber,
      phase: GamePhase.DAY_VOTING,
      action: 'PHASE_CHANGE',
      details: 'Day voting started.'
    }
  });

  broadcastToRoom(roomId, {
    type: 'phase_changed',
    payload: { room: updatedRoom }
  });

  // Set voting timer (e.g., 30 seconds to vote)
  const votingTimeout = setTimeout(async () => {
    await resolveDayVoting(roomId);
  }, 30000);

  activeVotingTimeouts.set(roomId, votingTimeout);
}

const activeVotingTimeouts = new Map<string, NodeJS.Timeout>();

export async function castVote(roomId: string, voterPlayerId: string, targetPlayerId: string) {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: { players: true }
  });

  if (!room || room.currentPhase !== GamePhase.DAY_VOTING) return;

  // Ensure voter is alive
  const voter = room.players.find(p => p.id === voterPlayerId);
  if (!voter || !voter.isAlive) return;

  // Ensure target is alive
  const target = room.players.find(p => p.id === targetPlayerId);
  if (!target || !target.isAlive) return;

  // Upsert vote for this round
  await prisma.vote.upsert({
    where: {
      id: `${voterPlayerId}-${room.roundNumber}` // Unique vote ID for voter per round
    },
    update: {
      targetId: targetPlayerId
    },
    create: {
      id: `${voterPlayerId}-${room.roundNumber}`,
      roomId,
      voterId: voterPlayerId,
      targetId: targetPlayerId,
      round: room.roundNumber,
      phase: GamePhase.DAY_VOTING
    }
  });

  // Broadcast the vote event
  const votes = await prisma.vote.findMany({
    where: { roomId, round: room.roundNumber, phase: GamePhase.DAY_VOTING }
  });

  broadcastToRoom(roomId, {
    type: 'vote_cast',
    payload: { votes }
  });

  // If everyone has voted, resolve early
  const alivePlayers = room.players.filter(p => p.isAlive);
  if (votes.length === alivePlayers.length) {
    const timeout = activeVotingTimeouts.get(roomId);
    if (timeout) {
      clearTimeout(timeout);
      activeVotingTimeouts.delete(roomId);
    }
    await resolveDayVoting(roomId);
  }
}

async function resolveDayVoting(roomId: string) {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: { players: true }
  });

  if (!room) return;

  const votes = await prisma.vote.findMany({
    where: { roomId, round: room.roundNumber, phase: GamePhase.DAY_VOTING }
  });

  // Tally votes
  const voteTally: { [key: string]: number } = {};
  votes.forEach(v => {
    voteTally[v.targetId] = (voteTally[v.targetId] || 0) + 1;
  });

  let maxVotes = 0;
  let playersToEliminate: string[] = [];

  Object.entries(voteTally).forEach(([targetId, count]) => {
    if (count > maxVotes) {
      maxVotes = count;
      playersToEliminate = [targetId];
    } else if (count === maxVotes) {
      playersToEliminate.push(targetId);
    }
  });

  let eliminatedPlayerName = 'Никто';
  let details = 'Никто не выбыл (ничья или отсутствие голосов).';

  if (playersToEliminate.length === 1 && maxVotes > 0) {
    const targetId = playersToEliminate[0];
    const playerToKill = room.players.find(p => p.id === targetId);

    if (playerToKill) {
      await prisma.player.update({
        where: { id: targetId },
        data: { isAlive: false }
      });
      eliminatedPlayerName = playerToKill.id;
      details = `Игрок на стуле ${playerToKill.seatNumber} был исключен большинством голосов (${maxVotes} голосов).`;
    }
  }

  await prisma.gameLog.create({
    data: {
      roomId,
      round: room.roundNumber,
      phase: GamePhase.DAY_VOTING,
      action: 'ELIMINATION',
      targetId: eliminatedPlayerName !== 'Никто' ? eliminatedPlayerName : null,
      details
    }
  });

  // Clear votes
  await prisma.vote.deleteMany({
    where: { roomId }
  });

  // Broadcast elimination
  broadcastToRoom(roomId, {
    type: 'player_eliminated',
    payload: {
      eliminatedPlayerId: eliminatedPlayerName !== 'Никто' ? eliminatedPlayerName : null,
      message: details
    }
  });

  // Check victory conditions
  const isFinished = await checkVictoryConditions(roomId);
  if (isFinished) return;

  // Transition to Night
  setTimeout(async () => {
    await startNight(roomId);
  }, 5000);
}

export async function startNight(roomId: string) {
  const room = await prisma.room.findUnique({
    where: { id: roomId }
  });

  if (!room || room.status !== RoomStatus.PLAYING) return;

  // Mute all players during night
  await prisma.player.updateMany({
    where: { roomId },
    data: { isMuted: true }
  });

  const updatedRoom = await prisma.room.update({
    where: { id: roomId },
    data: {
      currentPhase: GamePhase.NIGHT_MAFIA
    },
    include: {
      players: {
        include: {
          user: true
        }
      }
    }
  });

  await prisma.gameLog.create({
    data: {
      roomId,
      round: room.roundNumber,
      phase: GamePhase.NIGHT_MAFIA,
      action: 'PHASE_CHANGE',
      details: 'Night begins. Mafia phase.'
    }
  });

  broadcastToRoom(roomId, {
    type: 'phase_changed',
    payload: { room: updatedRoom }
  });

  // 25 seconds for Mafia to choose target
  const nightTimeout = setTimeout(async () => {
    await resolveNightMafia(roomId);
  }, 25000);

  activeNightTimeouts.set(roomId, nightTimeout);
}

const activeNightTimeouts = new Map<string, NodeJS.Timeout>();

export async function castMafiaVote(roomId: string, mafiaPlayerId: string, targetPlayerId: string) {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: { players: true }
  });

  if (!room || room.currentPhase !== GamePhase.NIGHT_MAFIA) return;

  // Check if voter is Mafia/Don
  const voter = room.players.find(p => p.id === mafiaPlayerId);
  if (!voter || !voter.isAlive || (voter.role !== Role.MAFIA && voter.role !== Role.DON)) return;

  // Ensure target is alive
  const target = room.players.find(p => p.id === targetPlayerId);
  if (!target || !target.isAlive) return;

  await prisma.vote.upsert({
    where: {
      id: `${mafiaPlayerId}-${room.roundNumber}`
    },
    update: {
      targetId: targetPlayerId
    },
    create: {
      id: `${mafiaPlayerId}-${room.roundNumber}`,
      roomId,
      voterId: mafiaPlayerId,
      targetId: targetPlayerId,
      round: room.roundNumber,
      phase: GamePhase.NIGHT_MAFIA
    }
  });

  // Broadcast to other mafia members only
  const mafiaPlayers = room.players.filter(p => p.isAlive && (p.role === Role.MAFIA || p.role === Role.DON));
  const votes = await prisma.vote.findMany({
    where: { roomId, round: room.roundNumber, phase: GamePhase.NIGHT_MAFIA }
  });

  mafiaPlayers.forEach(mafia => {
    // Send privately
    const connection = activeSpeechTimeouts.get(roomId); // reuse mapping logic or direct send
    // We will do direct broadcast to everyone, but clients mask other roles.
    // To preserve mafia secrecy, we'll only send 'mafia_vote_cast' to mafia players.
  });

  // Actually, we can broadcast `mafia_vote_updated` payload, but ONLY to mafia players.
  // In `socket.ts`, we'll manage private dispatching.
  // For simplicity, we can broadcast the vote tally counts to everyone, but hide who voted,
  // or only broadcast to Mafia. Let's do broadcast to Mafia. We'll handle this in socket.ts
}

async function resolveNightMafia(roomId: string) {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: { players: true }
  });

  if (!room) return;

  const mafiaVotes = await prisma.vote.findMany({
    where: { roomId, round: room.roundNumber, phase: GamePhase.NIGHT_MAFIA }
  });

  const mafias = room.players.filter(p => p.isAlive && (p.role === Role.MAFIA || p.role === Role.DON));
  
  // Mafia must agree unanimously to kill, or we take the majority.
  // Let's implement agreement: if at least 1 shoot is registered, and they agree.
  // For a unified experience: player with maximum mafia votes gets shot.
  const voteTally: { [key: string]: number } = {};
  mafiaVotes.forEach(v => {
    voteTally[v.targetId] = (voteTally[v.targetId] || 0) + 1;
  });

  let shotPlayerId: string | null = null;
  let maxVotes = 0;
  
  Object.entries(voteTally).forEach(([targetId, count]) => {
    if (count > maxVotes) {
      maxVotes = count;
      shotPlayerId = targetId;
    }
  });

  // Store shot player in GameLog for this night
  if (shotPlayerId) {
    await prisma.gameLog.create({
      data: {
        roomId,
        round: room.roundNumber,
        phase: GamePhase.NIGHT_MAFIA,
        action: 'SHOOT',
        targetId: shotPlayerId,
        details: `Mafia shot player on seat ${room.players.find(p => p.id === shotPlayerId)?.seatNumber}.`
      }
    });
  }

  // Transition to Don phase (if Don is alive)
  const don = room.players.find(p => p.isAlive && p.role === Role.DON);
  if (don) {
    await prisma.room.update({
      where: { id: roomId },
      data: { currentPhase: GamePhase.NIGHT_DON }
    });
    broadcastToRoom(roomId, {
      type: 'phase_changed',
      payload: { room: await getRoomWithPlayers(roomId) }
    });

    const donTimeout = setTimeout(async () => {
      await resolveNightDon(roomId, shotPlayerId);
    }, 15000);
    activeNightTimeouts.set(roomId, donTimeout);
  } else {
    // Skip to Sheriff phase
    await resolveNightDon(roomId, shotPlayerId);
  }
}

export async function checkDonTarget(roomId: string, donPlayerId: string, targetPlayerId: string): Promise<{ isSheriff: boolean } | null> {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: { players: true }
  });

  if (!room || room.currentPhase !== GamePhase.NIGHT_DON) return null;

  const target = room.players.find(p => p.id === targetPlayerId);
  if (!target) return null;

  const isSheriff = target.role === Role.SHERIFF;

  await prisma.gameLog.create({
    data: {
      roomId,
      round: room.roundNumber,
      phase: GamePhase.NIGHT_DON,
      action: 'CHECK_DON',
      actorId: donPlayerId,
      targetId: targetPlayerId,
      details: `Don checked player ${target.seatNumber}. Result: ${isSheriff ? 'Sheriff' : 'Not Sheriff'}.`
    }
  });

  return { isSheriff };
}

async function resolveNightDon(roomId: string, shotPlayerId: string | null) {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: { players: true }
  });

  if (!room) return;

  // Transition to Sheriff phase if alive
  const sheriff = room.players.find(p => p.isAlive && p.role === Role.SHERIFF);
  if (sheriff) {
    await prisma.room.update({
      where: { id: roomId },
      data: { currentPhase: GamePhase.NIGHT_SHERIFF }
    });
    broadcastToRoom(roomId, {
      type: 'phase_changed',
      payload: { room: await getRoomWithPlayers(roomId) }
    });

    const sheriffTimeout = setTimeout(async () => {
      await resolveNightSheriff(roomId, shotPlayerId);
    }, 15000);
    activeNightTimeouts.set(roomId, sheriffTimeout);
  } else {
    // Conclude night
    await concludeNight(roomId, shotPlayerId);
  }
}

export async function checkSheriffTarget(roomId: string, sheriffPlayerId: string, targetPlayerId: string): Promise<{ isMafia: boolean } | null> {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: { players: true }
  });

  if (!room || room.currentPhase !== GamePhase.NIGHT_SHERIFF) return null;

  const target = room.players.find(p => p.id === targetPlayerId);
  if (!target) return null;

  const isMafia = target.role === Role.MAFIA || target.role === Role.DON;

  await prisma.gameLog.create({
    data: {
      roomId,
      round: room.roundNumber,
      phase: GamePhase.NIGHT_SHERIFF,
      action: 'CHECK_SHERIFF',
      actorId: sheriffPlayerId,
      targetId: targetPlayerId,
      details: `Sheriff checked player ${target.seatNumber}. Result: ${isMafia ? 'Mafia' : 'Citizen'}.`
    }
  });

  return { isMafia };
}

async function resolveNightSheriff(roomId: string, shotPlayerId: string | null) {
  await concludeNight(roomId, shotPlayerId);
}

async function concludeNight(roomId: string, shotPlayerId: string | null) {
  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: { players: true }
  });

  if (!room) return;

  let killedSeat: number | null = null;
  let logDetails = 'Никто не погиб этой ночью.';

  if (shotPlayerId) {
    const target = room.players.find(p => p.id === shotPlayerId);
    if (target && target.isAlive) {
      await prisma.player.update({
        where: { id: shotPlayerId },
        data: { isAlive: false }
      });
      killedSeat = target.seatNumber;
      logDetails = `Игрок на стуле ${target.seatNumber} был убит мафией.`;
    }
  }

  // Clear night votes
  await prisma.vote.deleteMany({
    where: { roomId }
  });

  await prisma.gameLog.create({
    data: {
      roomId,
      round: room.roundNumber,
      phase: GamePhase.NIGHT_SHERIFF,
      action: 'NIGHT_KILL',
      targetId: shotPlayerId,
      details: logDetails
    }
  });

  broadcastToRoom(roomId, {
    type: 'night_ended',
    payload: {
      killedPlayerId: shotPlayerId,
      message: logDetails
    }
  });

  // Check victory conditions
  const isFinished = await checkVictoryConditions(roomId);
  if (isFinished) return;

  // Increment round and start day
  await prisma.room.update({
    where: { id: roomId },
    data: {
      roundNumber: room.roundNumber + 1
    }
  });

  setTimeout(async () => {
    await startDayDiscussion(roomId);
  }, 5000);
}

async function getRoomWithPlayers(roomId: string) {
  return prisma.room.findUnique({
    where: { id: roomId },
    include: {
      players: {
        include: {
          user: true
        }
      }
    }
  });
}
