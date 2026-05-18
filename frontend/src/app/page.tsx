'use client';

import { useState, useEffect, useRef } from 'react';
import { 
  Skull, Mic, MicOff, Shield, Users, Radio, Play, Plus, 
  LogIn, Award, Volume2, VolumeX, Eye, CheckCircle2, AlertTriangle, ArrowRight 
} from 'lucide-react';

interface User {
  id: string;
  username: string;
  photoUrl?: string;
}

interface Player {
  id: string;
  userId: string;
  role: 'CIVILIAN' | 'MAFIA' | 'DON' | 'SHERIFF' | 'NONE';
  isAlive: boolean;
  isMuted: boolean;
  seatNumber: number;
  speechTime: number;
  user: User;
}

interface Room {
  id: string;
  code: string;
  hostId: string;
  status: 'LOBBY' | 'PLAYING' | 'FINISHED';
  currentPhase: 'LOBBY' | 'ROLES_ASSIGNMENT' | 'DAY_DISCUSSION' | 'DAY_VOTING' | 'NIGHT_MAFIA' | 'NIGHT_DON' | 'NIGHT_SHERIFF' | 'GAME_OVER';
  roundNumber: number;
  winner?: 'CIVILIANS' | 'MAFIA' | 'NONE';
  players: Player[];
}

export default function GamePage() {
  // Telegram User Information & Local Fallback
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [roomCodeInput, setRoomCodeInput] = useState('');
  const [joinError, setJoinError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  // Active Game State
  const [room, setRoom] = useState<Room | null>(null);
  const [myPlayer, setMyPlayer] = useState<Player | null>(null);
  const [activeSpeakerId, setActiveSpeakerId] = useState<string | null>(null);
  const [speechCountdown, setSpeechCountdown] = useState(60);
  const [logs, setLogs] = useState<string[]>([]);
  const [nightCheckResult, setNightCheckResult] = useState<string | null>(null);
  const [votesCastMap, setVotesCastMap] = useState<Record<string, string>>({}); // VoterId -> TargetId

  // WebSocket reference
  const socketRef = useRef<WebSocket | null>(null);
  const countdownIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Fetch or mock Telegram Web App user
  useEffect(() => {
    // Check if Telegram Web App SDK is loaded
    const tg = (window as any).Telegram?.WebApp;
    if (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) {
      tg.expand();
      setCurrentUser({
        id: String(tg.initDataUnsafe.user.id),
        username: tg.initDataUnsafe.user.username || tg.initDataUnsafe.user.first_name || `Игрок ${tg.initDataUnsafe.user.id}`,
        photoUrl: tg.initDataUnsafe.user.photo_url || ''
      });
    } else {
      // Browser Mock Session for Testing
      const randomId = Math.floor(Math.random() * 900000) + 100000;
      setCurrentUser({
        id: String(randomId),
        username: `Игрок_${randomId}`,
        photoUrl: `https://api.dicebear.com/7.x/bottts/svg?seed=user-${randomId}`
      });
    }
  }, []);

  // Sync current client player state from updated room data
  useEffect(() => {
    if (room && currentUser) {
      const p = room.players.find(x => x.userId === currentUser.id);
      if (p) setMyPlayer(p);
    }
  }, [room, currentUser]);

  // Handle speaker countdown timer
  useEffect(() => {
    if (room?.currentPhase === 'DAY_DISCUSSION' && activeSpeakerId) {
      setSpeechCountdown(60);
      
      if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
      
      countdownIntervalRef.current = setInterval(() => {
        setSpeechCountdown((prev) => {
          if (prev <= 1) {
            clearInterval(countdownIntervalRef.current!);
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    } else {
      if (countdownIntervalRef.current) {
        clearInterval(countdownIntervalRef.current);
        countdownIntervalRef.current = null;
      }
    }

    return () => {
      if (countdownIntervalRef.current) clearInterval(countdownIntervalRef.current);
    };
  }, [room?.currentPhase, activeSpeakerId]);

  // API Server URL configuration
  const apiBaseUrl = process.env.NEXT_PUBLIC_API_SERVER_URL || 'http://localhost:4000';
  const wsServerUrl = process.env.NEXT_PUBLIC_WS_SERVER_URL || 'ws://localhost:4000';

  const connectWebSocket = (roomCode: string) => {
    if (!currentUser) return;
    
    // Close existing socket if alive
    if (socketRef.current) socketRef.current.close();

    const socket = new WebSocket(wsServerUrl);
    socketRef.current = socket;

    socket.onopen = () => {
      console.log('WebSocket Connected!');
      // Join Room Message
      socket.send(JSON.stringify({
        type: 'join_game',
        payload: {
          userId: currentUser.id,
          roomCode: roomCode.toUpperCase(),
          username: currentUser.username,
          photoUrl: currentUser.photoUrl
        }
      }));
    };

    socket.onmessage = (event) => {
      const message = JSON.parse(event.data);
      const { type, payload } = message;

      console.log('WS Event Received:', type, payload);

      switch (type) {
        case 'room_state_updated':
        case 'game_started':
        case 'phase_changed':
          setRoom(payload.room);
          setVotesCastMap({}); // Clear votes when phase shifts
          setNightCheckResult(null); // Clear Sheriff/Don inspections
          addLog(`Фаза игры изменилась на: ${getPhaseLabel(payload.room.currentPhase)}`);
          break;

        case 'speaker_changed':
          setActiveSpeakerId(payload.speakerId);
          setRoom(payload.room);
          const speaker = payload.room.players.find((p: Player) => p.id === payload.speakerId);
          if (speaker) {
            addLog(`Слово передано игроку на стуле ${speaker.seatNumber} (${speaker.user.username})`);
          }
          break;

        case 'vote_cast':
          // Update voting status
          const votesMap: Record<string, string> = {};
          payload.votes.forEach((v: any) => {
            votesMap[v.voterId] = v.targetId;
          });
          setVotesCastMap(votesMap);
          break;

        case 'player_eliminated':
          const eliminatedPlayer = room?.players.find(p => p.id === payload.eliminatedPlayerId);
          if (eliminatedPlayer) {
            addLog(`Игрок на стуле ${eliminatedPlayer.seatNumber} (${eliminatedPlayer.user.username}) покинул стол.`);
          } else {
            addLog(payload.message);
          }
          break;

        case 'night_ended':
          const deadPlayer = room?.players.find(p => p.id === payload.killedPlayerId);
          if (deadPlayer) {
            addLog(`Утро настало. Игрок на стуле ${deadPlayer.seatNumber} (${deadPlayer.user.username}) был убит мафией.`);
          } else {
            addLog(`Утро настало. ${payload.message}`);
          }
          break;

        case 'don_check_result':
          const donTarget = room?.players.find(p => p.id === payload.targetPlayerId);
          setNightCheckResult(
            payload.isSheriff 
              ? `Проверка Don: Игрок на стуле ${donTarget?.seatNumber} — ШЕРИФ! 🕵️‍♂️`
              : `Проверка Don: Игрок на стуле ${donTarget?.seatNumber} — не Шериф.`
          );
          break;

        case 'sheriff_check_result':
          const sheriffTarget = room?.players.find(p => p.id === payload.targetPlayerId);
          setNightCheckResult(
            payload.isMafia
              ? `Проверка Шерифа: Игрок на стуле ${sheriffTarget?.seatNumber} — МАФИЯ! 🔴`
              : `Проверка Шерифа: Игрок на стуле ${sheriffTarget?.seatNumber} — Мирный гражданин 🟢`
          );
          break;

        case 'game_ended':
          setRoom(payload.room);
          addLog(`Игра завершена! Победители: ${payload.winner === 'MAFIA' ? 'Мафия 🔴' : 'Мирные жители 🟢'}`);
          break;

        case 'error':
          setJoinError(payload.message);
          setIsLoading(false);
          break;

        default:
          break;
      }
    };

    socket.onclose = () => {
      console.log('WebSocket connection closed.');
    };
  };

  const createRoom = async () => {
    if (!currentUser) return;
    setIsLoading(true);
    setJoinError('');

    try {
      const response = await fetch(`${apiBaseUrl}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          hostId: currentUser.id,
          username: currentUser.username,
          photoUrl: currentUser.photoUrl
        })
      });

      if (!response.ok) throw new Error('Ошибка создания комнаты');
      
      const data = await response.json();
      connectWebSocket(data.code);
      setIsLoading(false);
    } catch (err) {
      console.error(err);
      setJoinError('Не удалось подключиться к серверу.');
      setIsLoading(false);
    }
  };

  const joinRoom = async () => {
    if (!roomCodeInput || !currentUser) return;
    setIsLoading(true);
    setJoinError('');

    try {
      const response = await fetch(`${apiBaseUrl}/api/rooms/${roomCodeInput.toUpperCase()}`);
      if (!response.ok) throw new Error('Комната не найдена');

      connectWebSocket(roomCodeInput);
      setIsLoading(false);
    } catch (err) {
      console.error(err);
      setJoinError('Комната с таким кодом не найдена.');
      setIsLoading(false);
    }
  };

  // Trigger Host Game Start
  const triggerGameStart = () => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({
        type: 'start_game'
      }));
    }
  };

  // Toggle my mute status
  const toggleMute = () => {
    if (!myPlayer) return;
    const nextMuted = !myPlayer.isMuted;
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({
        type: 'toggle_mute',
        payload: { isMuted: nextMuted }
      }));
    }
  };

  // Complete Speech early
  const endSpeechEarly = () => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({
        type: 'speech_ended'
      }));
    }
  };

  // Cast Day Vote on Player
  const submitDayVote = (targetPlayerId: string) => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({
        type: 'cast_vote',
        payload: { targetPlayerId }
      }));
    }
  };

  // Mafia Shooting Action
  const submitMafiaShoot = (targetPlayerId: string) => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({
        type: 'mafia_shoot',
        payload: { targetPlayerId }
      }));
    }
  };

  // Don Sheriff Investigation actions
  const submitDonCheck = (targetPlayerId: string) => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({
        type: 'don_check',
        payload: { targetPlayerId }
      }));
    }
  };

  const submitSheriffCheck = (targetPlayerId: string) => {
    if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
      socketRef.current.send(JSON.stringify({
        type: 'sheriff_check',
        payload: { targetPlayerId }
      }));
    }
  };

  // Reset local state to exit back to Lobby
  const leaveRoom = () => {
    if (socketRef.current) {
      socketRef.current.close();
      socketRef.current = null;
    }
    setRoom(null);
    setMyPlayer(null);
    setLogs([]);
    setVotesCastMap({});
    setNightCheckResult(null);
  };

  const addLog = (message: string) => {
    setLogs(prev => [message, ...prev.slice(0, 19)]);
  };

  const getPhaseLabel = (phase: string) => {
    switch (phase) {
      case 'LOBBY': return 'Ожидание игроков (Лобби)';
      case 'ROLES_ASSIGNMENT': return 'Раздача секретных ролей';
      case 'DAY_DISCUSSION': return 'Дневное обсуждение';
      case 'DAY_VOTING': return 'Дневное голосование';
      case 'NIGHT_MAFIA': return 'Город засыпает. Ход Мафии';
      case 'NIGHT_DON': return 'Ход Дона Мафии';
      case 'NIGHT_SHERIFF': return 'Ход Шерифа';
      case 'GAME_OVER': return 'Игра окончена!';
      default: return phase;
    }
  };

  // Return trigonometric positions for 10-player table arrangement
  const getPositionStyles = (seatNum: number) => {
    const totalSeats = 10;
    // Offset by -90 degrees so seat 1 is at the top
    const angle = ((seatNum - 1) / totalSeats) * 2 * Math.PI - Math.PI / 2;
    const radius = 145; // Positioning radius from circle center (px)
    const x = Math.round(radius * Math.cos(angle));
    const y = Math.round(radius * Math.sin(angle));
    
    return {
      transform: `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`,
      left: '50%',
      top: '50%',
      position: 'absolute' as const
    };
  };

  // Helper check to identify if a player voted for a target
  const getVotesReceivedCount = (playerId: string) => {
    return Object.values(votesCastMap).filter(id => id === playerId).length;
  };

  return (
    <main className="min-h-screen px-4 py-6 md:p-8 flex flex-col justify-center items-center">
      {/* 1. SETUP STAGE (WELCOME SCREEN) */}
      {!room && (
        <div className="w-full max-w-md glass-panel p-8 text-center animate-in fade-in zoom-in duration-300">
          <div className="flex justify-center mb-6">
            <div className="w-20 h-20 rounded-2xl bg-purple-900/40 border border-purple-500/50 flex items-center justify-center shadow-lg shadow-purple-500/10">
              <Skull className="w-12 h-12 text-purple-400 animate-pulse" />
            </div>
          </div>
          <h1 className="text-3xl font-extrabold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-purple-400 via-pink-400 to-red-400 mb-2">
            MafiaKvartalski
          </h1>
          <p className="text-sm text-purple-300/80 mb-8 font-light">
            Интерактивный голосовой стол мафии прямо в вашем Telegram
          </p>

          {/* User Preview */}
          {currentUser && (
            <div className="flex items-center gap-3 bg-purple-950/40 border border-purple-900/60 rounded-xl p-3 mb-6 justify-center">
              <img 
                src={currentUser.photoUrl || `https://api.dicebear.com/7.x/bottts/svg?seed=${currentUser.username}`} 
                alt="Avatar" 
                className="w-10 h-10 rounded-full border border-purple-500/30"
              />
              <div className="text-left">
                <span className="text-xs text-purple-400 block font-light">Авторизован как</span>
                <span className="text-sm font-semibold">{currentUser.username}</span>
              </div>
            </div>
          )}

          {joinError && (
            <div className="bg-red-950/40 border border-red-500/30 rounded-xl p-3 mb-6 text-sm text-red-300 flex items-center gap-2">
              <AlertTriangle className="w-4  h-4 shrink-0" />
              <span>{joinError}</span>
            </div>
          )}

          {/* Action buttons */}
          <div className="flex flex-col gap-3">
            <button
              onClick={createRoom}
              disabled={isLoading}
              className="w-full py-4 rounded-xl font-bold bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white shadow-lg shadow-indigo-600/20 active:scale-98 transition flex items-center justify-center gap-2"
            >
              {isLoading ? 'Загрузка...' : (
                <>
                  <Plus className="w-5 h-5" /> Создать новую игру
                </>
              )}
            </button>

            <div className="flex items-center my-4">
              <div className="flex-grow border-t border-purple-900/40"></div>
              <span className="mx-4 text-xs text-purple-400/60 uppercase tracking-widest">или</span>
              <div className="flex-grow border-t border-purple-900/40"></div>
            </div>

            <div className="flex gap-2">
              <input
                type="text"
                placeholder="КОД КОМНАТЫ"
                maxLength={4}
                value={roomCodeInput}
                onChange={(e) => setRoomCodeInput(e.target.value.toUpperCase())}
                className="bg-purple-950/20 border border-purple-900/60 rounded-xl px-4 py-3 text-center tracking-widest font-black uppercase text-purple-300 focus:outline-none focus:border-purple-500 w-full"
              />
              <button
                onClick={joinRoom}
                disabled={isLoading || roomCodeInput.length < 4}
                className="px-6 rounded-xl font-bold bg-purple-950/60 hover:bg-purple-900/80 border border-purple-700/40 text-purple-300 active:scale-98 transition flex items-center justify-center"
              >
                <ArrowRight className="w-5 h-5" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 2. MAIN ACTIVE ROOM STATE */}
      {room && currentUser && (
        <div className="w-full max-w-lg flex flex-col items-center animate-in fade-in zoom-in duration-300">
          
          {/* Header Info Panel */}
          <div className="w-full glass-panel p-4 mb-4 flex items-center justify-between border border-purple-900/40">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-purple-400 font-light">КОД КОМНАТЫ:</span>
                <span className="bg-purple-900/40 border border-purple-700/50 px-2 py-0.5 rounded text-sm font-black text-purple-300 tracking-wider">
                  {room.code}
                </span>
              </div>
              <div className="text-xs text-purple-400/80 font-light mt-1">
                Игроков: {room.players.length}/10 • Раунд {room.roundNumber}
              </div>
            </div>
            
            <div className="text-right">
              <span className="text-xs text-purple-400 font-light block">СТАТУС ИГРЫ:</span>
              <span className="text-xs font-semibold text-purple-300 bg-purple-950/60 border border-purple-900/60 px-2.5 py-1 rounded-full inline-block mt-0.5">
                {getPhaseLabel(room.currentPhase)}
              </span>
            </div>
          </div>

          {/* Secret Role Cinema card (Only shown on ROLES_ASSIGNMENT stage) */}
          {room.currentPhase === 'ROLES_ASSIGNMENT' && myPlayer && (
            <div className="w-full glass-panel-glow p-6 mb-6 text-center animate-pulse border border-purple-500/30">
              <span className="text-xs text-purple-400 block tracking-widest font-light mb-1">ВАША СЕКРЕТНАЯ РОЛЬ</span>
              {myPlayer.role === 'MAFIA' && (
                <div className="text-red-500 font-black text-2xl tracking-widest animate-bounce flex items-center justify-center gap-2">
                  <Skull className="w-6 h-6" /> ВЫ МАФИЯ 🔴
                </div>
              )}
              {myPlayer.role === 'DON' && (
                <div className="text-red-500 font-black text-2xl tracking-widest animate-bounce flex items-center justify-center gap-2">
                  <Skull className="w-6 h-6" /> ВЫ ДОН МАФИИ 🎩
                </div>
              )}
              {myPlayer.role === 'SHERIFF' && (
                <div className="text-blue-500 font-black text-2xl tracking-widest animate-bounce flex items-center justify-center gap-2">
                  <Shield className="w-6 h-6" /> ВЫ ШЕРИФ 🕵️‍♂️
                </div>
              )}
              {myPlayer.role === 'CIVILIAN' && (
                <div className="text-green-500 font-black text-2xl tracking-widest animate-bounce flex items-center justify-center gap-2">
                  <Users className="w-6 h-6" /> МИРНЫЙ ЖИТЕЛЬ 🟢
                </div>
              )}
              <p className="text-xs text-purple-300/60 mt-2 font-light">
                Никому не показывайте свой экран. Город засыпает...
              </p>
            </div>
          )}

          {/* Interactive circular game table */}
          <div className="w-full relative h-[380px] flex items-center justify-center mb-6">
            
            {/* The circular table */}
            <div className="mafia-table">
              {room.currentPhase === 'LOBBY' ? (
                <div className="text-center p-4">
                  <span className="text-xs text-purple-400/80 block font-light">Ожидание...</span>
                  <span className="text-sm font-bold text-purple-300">{room.players.length} / 10</span>
                  {room.hostId === currentUser.id && (
                    <button
                      onClick={triggerGameStart}
                      disabled={room.players.length < 3}
                      className="mt-3 px-4 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-xs font-bold transition-all shadow-md active:scale-95 flex items-center gap-1.5"
                    >
                      <Play className="w-3.5 h-3.5" /> Начать игру
                    </button>
                  )}
                </div>
              ) : (
                <div className="text-center p-4">
                  {room.currentPhase === 'DAY_DISCUSSION' && activeSpeakerId ? (
                    <div>
                      <span className="text-xs text-purple-400 block font-light">ГОВОРИТ ИГРОК</span>
                      <span className="text-lg font-black text-purple-300 animate-pulse">
                        {room.players.find(p => p.id === activeSpeakerId)?.seatNumber} СТУЛ
                      </span>
                      <span className="text-2xl font-black block text-pink-400 mt-1">
                        {speechCountdown}s
                      </span>
                    </div>
                  ) : (
                    <div>
                      <span className="text-xs text-purple-400/60 block font-light">Рун {room.roundNumber}</span>
                      <span className="table-logo">МАФИЯ</span>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Render 10 players geometrically positioned around the table */}
            {Array.from({ length: 10 }).map((_, i) => {
              const seatNum = i + 1;
              const player = room.players.find(p => p.seatNumber === seatNum);

              return (
                <div
                  key={seatNum}
                  style={getPositionStyles(seatNum)}
                  className="flex flex-col items-center z-10"
                >
                  {player ? (
                    <div className="relative group flex flex-col items-center">
                      
                      {/* Speaker / Death / Action active glow outline */}
                      <div 
                        className={`w-14 h-14 rounded-full flex items-center justify-center p-0.5 transition-all duration-300 
                          ${!player.isAlive ? 'border border-gray-800 bg-gray-950/40 opacity-40' : ''}
                          ${player.isAlive && player.id === activeSpeakerId ? 'speaker-active-glow border-2 border-purple-500 bg-purple-950/60' : ''}
                          ${player.isAlive && player.id !== activeSpeakerId ? 'border border-purple-900/60 bg-purple-950/40' : ''}
                          ${player.isAlive && room.currentPhase === 'NIGHT_MAFIA' && myPlayer && (myPlayer.role === 'MAFIA' || myPlayer.role === 'DON') && (player.role === 'MAFIA' || player.role === 'DON') ? 'border-2 border-red-500/60' : ''}
                        `}
                      >
                        <img 
                          src={player.user.photoUrl || `https://api.dicebear.com/7.x/bottts/svg?seed=${player.user.username}`} 
                          alt="Avatar" 
                          className="w-full h-full rounded-full object-cover"
                        />
                        
                        {/* Status Icon Badges */}
                        {!player.isAlive && (
                          <div className="absolute inset-0 rounded-full bg-black/60 flex items-center justify-center">
                            <Skull className="w-6 h-6 text-red-500/80 animate-pulse" />
                          </div>
                        )}

                        {/* Speech active voice meter wave animation overlay */}
                        {player.isAlive && player.id === activeSpeakerId && !player.isMuted && (
                          <div className="absolute -top-1 -right-1 bg-purple-500 rounded-full p-1 border border-purple-300">
                            <span className="flex gap-0.5">
                              <span className="w-1 h-2 bg-white rounded-full animate-bounce"></span>
                              <span className="w-1 h-3 bg-white rounded-full animate-bounce delay-100"></span>
                              <span className="w-1 h-2 bg-white rounded-full animate-bounce delay-200"></span>
                            </span>
                          </div>
                        )}

                        {/* Mute state icons */}
                        {player.isAlive && player.isMuted && (
                          <div className="absolute -bottom-1 -right-1 bg-red-950 border border-red-500/50 rounded-full p-1">
                            <MicOff className="w-2.5 h-2.5 text-red-400" />
                          </div>
                        )}
                        {player.isAlive && !player.isMuted && (
                          <div className="absolute -bottom-1 -right-1 bg-green-950 border border-green-500/50 rounded-full p-1">
                            <Mic className="w-2.5 h-2.5 text-green-400" />
                          </div>
                        )}
                      </div>

                      {/* Seat number bubble */}
                      <div className={`absolute -top-2 -left-2 w-5 h-5 rounded-full flex items-center justify-center text-3xs font-black border text-white 
                        ${!player.isAlive ? 'bg-gray-800 border-gray-600' : 'bg-purple-600 border-purple-300 shadow-md'}
                      `}>
                        {seatNum}
                      </div>

                      {/* Player Username overlay */}
                      <span className="text-[10px] text-purple-300/80 font-medium truncate w-16 text-center mt-1.5 block">
                        {player.user.username}
                      </span>

                      {/* Vote Count indicator in Day Voting phase */}
                      {room.currentPhase === 'DAY_VOTING' && player.isAlive && getVotesReceivedCount(player.id) > 0 && (
                        <span className="absolute -bottom-5 bg-pink-600 border border-pink-400 rounded px-1.5 py-0.5 text-[10px] font-black text-white">
                          Голоса: {getVotesReceivedCount(player.id)}
                        </span>
                      )}

                      {/* Action buttons (Shown contextually during Day Voting or Night actions) */}
                      {player.isAlive && player.id !== myPlayer?.id && (
                        <div className="absolute -top-12 z-20 hidden group-hover:flex flex-col gap-1 bg-purple-950/90 border border-purple-700/80 p-1.5 rounded-lg shadow-xl">
                          {/* 1. Day Voting */}
                          {room.currentPhase === 'DAY_VOTING' && myPlayer?.isAlive && (
                            <button 
                              onClick={() => submitDayVote(player.id)}
                              className="px-2 py-0.5 bg-purple-600 hover:bg-purple-500 text-[10px] font-bold rounded text-white whitespace-nowrap"
                            >
                              Голосовать
                            </button>
                          )}
                          
                          {/* 2. Night Mafia Shoot */}
                          {room.currentPhase === 'NIGHT_MAFIA' && myPlayer?.isAlive && (myPlayer.role === 'MAFIA' || myPlayer.role === 'DON') && (
                            <button 
                              onClick={() => submitMafiaShoot(player.id)}
                              className="px-2 py-0.5 bg-red-600 hover:bg-red-500 text-[10px] font-bold rounded text-white whitespace-nowrap"
                            >
                              Выстрелить
                            </button>
                          )}

                          {/* 3. Night Don Check */}
                          {room.currentPhase === 'NIGHT_DON' && myPlayer?.isAlive && myPlayer.role === 'DON' && (
                            <button 
                              onClick={() => submitDonCheck(player.id)}
                              className="px-2 py-0.5 bg-orange-600 hover:bg-orange-500 text-[10px] font-bold rounded text-white whitespace-nowrap"
                            >
                              Проверить Шерифа
                            </button>
                          )}

                          {/* 4. Night Sheriff Check */}
                          {room.currentPhase === 'NIGHT_SHERIFF' && myPlayer?.isAlive && myPlayer.role === 'SHERIFF' && (
                            <button 
                              onClick={() => submitSheriffCheck(player.id)}
                              className="px-2 py-0.5 bg-blue-600 hover:bg-blue-500 text-[10px] font-bold rounded text-white whitespace-nowrap"
                            >
                              Проверить Мафию
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    // Empty chair representation
                    <div className="w-12 h-12 rounded-full border border-dashed border-purple-900/30 flex items-center justify-center opacity-30">
                      <span className="text-[10px] font-light text-purple-400/50">{seatNum}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Mute and speech action triggers */}
          {myPlayer && myPlayer.isAlive && room.currentPhase !== 'LOBBY' && (
            <div className="w-full flex gap-3 mb-6">
              <button
                onClick={toggleMute}
                className={`flex-grow py-3 rounded-xl font-bold flex items-center justify-center gap-2 border shadow-lg transition active:scale-98
                  ${myPlayer.isMuted 
                    ? 'bg-red-950/40 border-red-500/40 text-red-400 hover:bg-red-900/40 shadow-red-500/5' 
                    : 'bg-green-950/40 border-green-500/40 text-green-400 hover:bg-green-900/40 shadow-green-500/5'
                  }
                `}
              >
                {myPlayer.isMuted ? (
                  <>
                    <MicOff className="w-5 h-5" /> Микрофон Выключен
                  </>
                ) : (
                  <>
                    <Mic className="w-5 h-5" /> Микрофон Включен
                  </>
                )}
              </button>

              {/* End speech button */}
              {room.currentPhase === 'DAY_DISCUSSION' && myPlayer.id === activeSpeakerId && (
                <button
                  onClick={endSpeechEarly}
                  className="px-6 py-3 rounded-xl font-bold bg-pink-600 hover:bg-pink-500 border border-pink-400 text-white shadow-lg shadow-pink-600/20 active:scale-98 transition"
                >
                  Завершить досрочно
                </button>
              )}
            </div>
          )}

          {/* Check results alerts for Sheriff/Don */}
          {nightCheckResult && (
            <div className="w-full bg-purple-950/60 border border-purple-500/30 rounded-xl p-3 mb-6 text-sm text-purple-200 flex items-center gap-2 shadow-md">
              <Eye className="w-5 h-5 text-purple-400 shrink-0 animate-bounce" />
              <span>{nightCheckResult}</span>
            </div>
          )}

          {/* Action Log Panel */}
          <div className="w-full glass-panel p-4 border border-purple-900/30 flex flex-col h-[150px]">
            <span className="text-3xs text-purple-400 tracking-widest font-black uppercase mb-2">ХРОНИКА СОБЫТИЙ</span>
            <div className="flex-grow overflow-y-auto no-scrollbar flex flex-col gap-1.5">
              {logs.length === 0 ? (
                <span className="text-xs text-purple-400/30 italic">Журнал событий пуст...</span>
              ) : (
                logs.map((log, idx) => (
                  <div key={idx} className="text-xs text-purple-300/80 font-light flex items-start gap-1.5">
                    <span className="text-purple-500">•</span>
                    <span>{log}</span>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Back to lobby or exit */}
          {room.status === 'LOBBY' && (
            <button
              onClick={leaveRoom}
              className="mt-6 text-xs text-purple-400/60 hover:text-purple-300 underline underline-offset-4"
            >
              Покинуть комнату
            </button>
          )}
        </div>
      )}

      {/* 3. VICTORY / DEFEAT Cinematic Fullscreen overlay */}
      {room && room.status === 'FINISHED' && myPlayer && (
        <div className="fixed inset-0 bg-black/90 backdrop-blur-md flex flex-col items-center justify-center p-8 z-50 animate-in fade-in duration-500">
          
          <div className="w-full max-w-md glass-panel p-8 text-center border-2 border-purple-500/30 shadow-2xl relative overflow-hidden">
            
            {/* Background elements */}
            <div className="absolute -top-10 -left-10 w-40 h-40 bg-purple-600/10 rounded-full blur-3xl"></div>
            <div className="absolute -bottom-10 -right-10 w-40 h-40 bg-pink-600/10 rounded-full blur-3xl"></div>

            <Award className="w-20 h-20 text-purple-400 mx-auto mb-6 animate-bounce" />

            {/* Victory of Civilians */}
            {room.winner === 'CIVILIANS' && (
              <div>
                <h2 className="text-4xl font-extrabold text-green-400 tracking-tight mb-2 uppercase drop-shadow-md">
                  Вы победили! 🟢
                </h2>
                <p className="text-sm text-purple-200 mb-8 font-light">
                  Квартальные Мирные Жители очистили город от преступности! Все мафии устранены.
                </p>
              </div>
            )}

            {/* Victory of Mafia */}
            {room.winner === 'MAFIA' && (
              <div>
                {/* My Role decides whether I won or lost */}
                {(myPlayer.role === 'MAFIA' || myPlayer.role === 'DON') ? (
                  <div>
                    <h2 className="text-4xl font-extrabold text-red-500 tracking-tight mb-2 uppercase drop-shadow-md">
                      Вы выиграли! 🔴
                    </h2>
                    <p className="text-sm text-purple-200 mb-8 font-light">
                      Мафиозный клан взял под контроль все улицы города. Победа за вами!
                    </p>
                  </div>
                ) : (
                  <div>
                    <h2 className="text-4xl font-extrabold text-red-600 tracking-tight mb-2 uppercase drop-shadow-md">
                      Вы проиграли! 💀
                    </h2>
                    <p className="text-sm text-purple-200 mb-8 font-light">
                      Мафия оказалась сильнее. Город полностью погрузился в преступный мрак.
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Room stats inside victory screen */}
            <div className="bg-purple-950/40 border border-purple-900/60 rounded-xl p-4 mb-8 text-left">
              <span className="text-3xs text-purple-400 tracking-widest font-black uppercase mb-3 block">ИТОГОВЫЙ СТОЛ РОЛЕЙ:</span>
              <div className="grid grid-cols-2 gap-2 text-xs">
                {room.players.map((p) => (
                  <div key={p.id} className="flex items-center gap-1.5 text-purple-300">
                    <span className="text-purple-500 font-bold">{p.seatNumber}.</span>
                    <span className="truncate w-24 block">{p.user.username}</span>
                    <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full 
                      ${p.role === 'MAFIA' || p.role === 'DON' ? 'bg-red-950 border border-red-500/30 text-red-400' : ''}
                      ${p.role === 'SHERIFF' ? 'bg-blue-950 border border-blue-500/30 text-blue-400' : ''}
                      ${p.role === 'CIVILIAN' ? 'bg-green-950 border border-green-500/30 text-green-400' : ''}
                    `}>
                      {p.role}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Lobby button */}
            <button
              onClick={leaveRoom}
              className="w-full py-4 rounded-xl font-bold bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white shadow-lg active:scale-98 transition flex items-center justify-center gap-2"
            >
              Вернуться в лобби
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
