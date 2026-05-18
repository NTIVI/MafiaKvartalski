import { Role, GamePhase, RoomStatus } from '@prisma/client';

export interface WSMessage {
  type: string;
  payload: any;
}

export interface WebRTCClientSignal {
  targetId: string; // The player ID to send signal to
  signal: any;      // WebRTC signal data (offer/answer/candidate)
}

export interface SpeechEndPayload {
  playerId: string;
}

export interface VotePayload {
  targetPlayerId: string;
}

export interface ActionPayload {
  targetPlayerId: string;
}

export interface ChatMessagePayload {
  text: string;
}

export interface JoinRoomPayload {
  roomCode: string;
  userId: string;
  username: string;
  photoUrl?: string;
}
