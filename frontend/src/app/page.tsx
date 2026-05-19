'use client';

import { useState, useEffect, useRef } from 'react';
import { 
  Skull, Mic, MicOff, Shield, Users, Play, Plus, 
  Award, Eye, AlertTriangle, ArrowRight 
} from 'lucide-react';
import { useWebRTC } from '../hooks/useWebRTC';
import { AudioStream } from '../components/AudioStream';

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
  const [currentUser, setCurrentUser] = useState<User | null>(null);
  const [roomCodeInput, setRoomCodeInput] = useState('');
  const [joinError, setJoinError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const [room, setRoom] = useState<Room | null>(null);
  const [myPlayer, setMyPlayer] = useState<Player | null>(null);
  const [activeSpeakerId, setActiveSpeakerId] = useState<string | null>(null);
  const [speechCountdown, setSpeechCountdown] = useState(60);
  const [logs, setLogs] = useState<string[]>([]);
  const [nightCheckResult, setNightCheckResult] = useState<string | null>(null);
  const [votesCastMap, setVotesCastMap] = useState<Record<string, string>>({});

  const socketRef = useRef<WebSocket | null>(null);
  const countdownIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const handleSignalRef = useRef<any>(null);

  const { remoteStreams, handleSignal } = useWebRTC(
    socketRef.current,
    currentUser?.id || null,
    room?.players.map(p => p.id) || [],
    myPlayer?.isMuted ?? true
  );

  useEffect(() => {
    handleSignalRef.current = handleSignal;
  }, [handleSignal]);

  useEffect(() => {
    const tg = (window as any).Telegram?.WebApp;
    if (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) {
      tg.expand();
      setCurrentUser({
        id: String(tg.initDataUnsafe.user.id),
        username: tg.initDataUnsafe.user.username || tg.initDataUnsafe.user.first_name || `Игрок ${tg.initDataUnsafe.user.id}`,
        photoUrl: tg.initDataUnsafe.user.photo_url || ''
      });
    } else {
      const randomId = Math.floor(Math.random() * 900000) + 100000;
      setCurrentUser({
        id: String(randomId),
        username: `Игрок_${randomId}`,
        photoUrl: `https://api.dicebear.com/7.x/bottts/svg?seed=user-${randomId}`
      });
    }
  }, []);

  useEffect(() => {
    if (room && currentUser) {
      const p = room.players.find(x => x.userId === currentUser.id);
      if (p) setMyPlayer(p);
    }
  }, [room, currentUser]);

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

  const apiBaseUrl = process.env.NEXT_PUBLIC_API_SERVER_URL || 'http://localhost:4000';
  const wsServerUrl = process.env.NEXT_PUBLIC_WS_SERVER_URL || 'ws://localhost:4000';

  const connectWebSocket = (roomCode: string) => {
    if (!currentUser) return;
    if (socketRef.current) socketRef.current.close();

    const socket = new WebSocket(wsServerUrl);
    socketRef.current = socket;

    socket.onopen = () => {
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

      switch (type) {
        case 'room_state_updated':
        case 'game_started':
        case 'phase_changed':
          setRoom(payload.room);
          setVotesCastMap({});
          setNightCheckResult(null);
          addLog(`Фаза: ${getPhaseLabel(payload.room.currentPhase)}`);
          break;
        case 'speaker_changed':
          setActiveSpeakerId(payload.speakerId);
          setRoom(payload.room);
          const speaker = payload.room.players.find((p: Player) => p.id === payload.speakerId);
          if (speaker) addLog(`Говорит ${speaker.user.username}`);
          break;
        case 'vote_cast':
          const votesMap: Record<string, string> = {};
          payload.votes.forEach((v: any) => { votesMap[v.voterId] = v.targetId; });
          setVotesCastMap(votesMap);
          break;
        case 'player_eliminated':
          const eliminatedPlayer = room?.players.find(p => p.id === payload.eliminatedPlayerId);
          if (eliminatedPlayer) addLog(`Игрок ${eliminatedPlayer.user.username} выбыл.`);
          else addLog(payload.message);
          break;
        case 'night_ended':
          const deadPlayer = room?.players.find(p => p.id === payload.killedPlayerId);
          if (deadPlayer) addLog(`Утро. ${deadPlayer.user.username} убит.`);
          else addLog(`Утро. ${payload.message}`);
          break;
        case 'don_check_result':
          const donTarget = room?.players.find(p => p.id === payload.targetPlayerId);
          setNightCheckResult(payload.isSheriff ? `Проверка: Игрок ${donTarget?.seatNumber} — ШЕРИФ 🕵️‍♂️` : `Проверка: Игрок ${donTarget?.seatNumber} — не Шериф.`);
          break;
        case 'sheriff_check_result':
          const sheriffTarget = room?.players.find(p => p.id === payload.targetPlayerId);
          setNightCheckResult(payload.isMafia ? `Проверка: Игрок ${sheriffTarget?.seatNumber} — МАФИЯ 🔴` : `Проверка: Игрок ${sheriffTarget?.seatNumber} — Мирный 🟢`);
          break;
        case 'game_ended':
          setRoom(payload.room);
          addLog(`Игра завершена! Победители: ${payload.winner === 'MAFIA' ? 'Мафия' : 'Мирные'}`);
          break;
        case 'webrtc_signal':
          if (handleSignalRef.current) handleSignalRef.current(payload.senderPlayerId, payload.signal);
          break;
        case 'error':
          setJoinError(payload.message);
          setIsLoading(false);
          break;
      }
    };
  };

  const createRoom = async () => {
    if (!currentUser) return;
    setIsLoading(true); setJoinError('');
    try {
      const response = await fetch(`${apiBaseUrl}/api/rooms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hostId: currentUser.id, username: currentUser.username, photoUrl: currentUser.photoUrl })
      });
      if (!response.ok) throw new Error('Ошибка создания');
      const data = await response.json();
      connectWebSocket(data.code);
      setIsLoading(false);
    } catch (err) {
      setJoinError('Не удалось подключиться к серверу.');
      setIsLoading(false);
    }
  };

  const joinRoom = async () => {
    if (!roomCodeInput || !currentUser) return;
    setIsLoading(true); setJoinError('');
    try {
      const response = await fetch(`${apiBaseUrl}/api/rooms/${roomCodeInput.toUpperCase()}`);
      if (!response.ok) throw new Error('Комната не найдена');
      connectWebSocket(roomCodeInput);
      setIsLoading(false);
    } catch (err) {
      setJoinError('Комната не найдена.');
      setIsLoading(false);
    }
  };

  const triggerGameStart = () => { socketRef.current?.send(JSON.stringify({ type: 'start_game' })); };
  const toggleMute = () => { socketRef.current?.send(JSON.stringify({ type: 'toggle_mute', payload: { isMuted: !myPlayer?.isMuted } })); };
  const endSpeechEarly = () => { socketRef.current?.send(JSON.stringify({ type: 'speech_ended' })); };
  const submitDayVote = (targetPlayerId: string) => { socketRef.current?.send(JSON.stringify({ type: 'cast_vote', payload: { targetPlayerId } })); };
  const submitMafiaShoot = (targetPlayerId: string) => { socketRef.current?.send(JSON.stringify({ type: 'mafia_shoot', payload: { targetPlayerId } })); };
  const submitDonCheck = (targetPlayerId: string) => { socketRef.current?.send(JSON.stringify({ type: 'don_check', payload: { targetPlayerId } })); };
  const submitSheriffCheck = (targetPlayerId: string) => { socketRef.current?.send(JSON.stringify({ type: 'sheriff_check', payload: { targetPlayerId } })); };

  const leaveRoom = () => {
    if (socketRef.current) { socketRef.current.close(); socketRef.current = null; }
    setRoom(null); setMyPlayer(null); setLogs([]); setVotesCastMap({}); setNightCheckResult(null);
  };

  const addLog = (message: string) => setLogs(prev => [message, ...prev.slice(0, 19)]);

  const getPhaseLabel = (phase: string) => {
    switch (phase) {
      case 'LOBBY': return 'Лобби';
      case 'ROLES_ASSIGNMENT': return 'Раздача ролей';
      case 'DAY_DISCUSSION': return 'Обсуждение';
      case 'DAY_VOTING': return 'Голосование';
      case 'NIGHT_MAFIA': return 'Ход Мафии';
      case 'NIGHT_DON': return 'Ход Дона';
      case 'NIGHT_SHERIFF': return 'Ход Шерифа';
      case 'GAME_OVER': return 'Игра окончена';
      default: return phase;
    }
  };

  const getPositionStyles = (seatNum: number) => {
    const angle = ((seatNum - 1) / 10) * 2 * Math.PI - Math.PI / 2;
    return {
      left: `${50 + 42 * Math.cos(angle)}%`,
      top: `${50 + 42 * Math.sin(angle)}%`,
      transform: 'translate(-50%, -50%)',
      position: 'absolute' as const
    };
  };

  const getVotesCount = (playerId: string) => Object.values(votesCastMap).filter(id => id === playerId).length;

  return (
    <main className="min-h-[100dvh] w-full flex flex-col px-4 py-4 sm:p-8 bg-[var(--bg-gradient)] relative overflow-hidden">
      {/* Background Ambience */}
      <div className="absolute -top-[20%] -left-[10%] w-[50%] h-[50%] rounded-full bg-purple-900/10 blur-[100px] pointer-events-none" />
      <div className="absolute -bottom-[20%] -right-[10%] w-[60%] h-[50%] rounded-full bg-pink-900/10 blur-[120px] pointer-events-none" />

      {/* 1. WELCOME SCREEN */}
      {!room && (
        <div className="w-full max-w-md mx-auto my-auto glass-panel p-6 sm:p-8 text-center flex flex-col z-10 animate-in slide-in-from-bottom-4 fade-in duration-500">
          <div className="w-20 h-20 mx-auto rounded-3xl bg-gradient-to-br from-purple-900/60 to-pink-900/60 border border-purple-500/40 flex items-center justify-center shadow-xl mb-6 shadow-purple-900/20">
            <Skull className="w-10 h-10 text-purple-300 animate-pulse" />
          </div>
          <h1 className="text-3xl font-black tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-purple-300 via-fuchsia-300 to-pink-300 mb-2">
            Мафия
          </h1>
          <p className="text-sm text-purple-300/60 font-medium mb-8">Голосовой стол в Telegram</p>

          {currentUser && (
            <div className="flex items-center gap-4 bg-black/30 border border-purple-900/40 rounded-2xl p-4 mb-6 backdrop-blur-sm">
              <img src={currentUser.photoUrl || `https://api.dicebear.com/7.x/bottts/svg?seed=${currentUser.username}`} className="w-12 h-12 rounded-full border border-purple-500/50" />
              <div className="text-left">
                <span className="text-[10px] uppercase tracking-wider text-purple-400 font-bold block mb-0.5">Твой Профиль</span>
                <span className="text-base font-bold text-white">{currentUser.username}</span>
              </div>
            </div>
          )}

          {joinError && (
            <div className="bg-red-950/50 border border-red-500/50 rounded-xl p-3 mb-6 text-xs font-medium text-red-200 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{joinError}</span>
            </div>
          )}

          <div className="flex flex-col gap-4 mt-2">
            <button onClick={createRoom} disabled={isLoading} className="w-full py-4 rounded-2xl font-black text-sm uppercase tracking-wide bg-gradient-to-r from-purple-600 to-pink-600 hover:from-purple-500 hover:to-pink-500 text-white shadow-lg shadow-purple-600/30 active:scale-95 transition-all flex items-center justify-center gap-2">
              {isLoading ? 'Загрузка...' : <><Plus className="w-5 h-5" /> Создать комнату</>}
            </button>
            <div className="flex items-center gap-3">
              <input type="text" placeholder="КОД КОМНАТЫ" maxLength={4} value={roomCodeInput} onChange={(e) => setRoomCodeInput(e.target.value.toUpperCase())} className="flex-1 bg-black/40 border border-purple-800/50 rounded-2xl px-4 py-4 text-center tracking-[0.3em] font-black uppercase text-purple-100 focus:outline-none focus:border-purple-500 transition-all placeholder:text-purple-900/60" />
              <button onClick={joinRoom} disabled={isLoading || roomCodeInput.length < 4} className="h-full aspect-square rounded-2xl font-bold bg-purple-900/40 hover:bg-purple-800/60 border border-purple-700/50 text-purple-300 active:scale-95 transition-all flex items-center justify-center disabled:opacity-50">
                <ArrowRight className="w-6 h-6" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 2. GAME ROOM */}
      {room && currentUser && (
        <div className="w-full max-w-[420px] mx-auto flex flex-col z-10 flex-1 animate-in fade-in duration-500">
          
          {/* Header */}
          <div className="glass-panel p-3 mb-4 flex items-center justify-between border-t-0 border-l-0 border-r-0 rounded-none bg-black/20 pb-4">
            <div>
              <div className="text-[10px] text-purple-400 font-bold uppercase tracking-widest mb-1">Комната</div>
              <div className="bg-purple-900/40 border border-purple-500/40 px-3 py-1 rounded-lg text-base font-black text-white tracking-widest">
                {room.code}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] text-purple-400 font-bold uppercase tracking-widest mb-1">Статус</div>
              <div className="text-xs font-bold text-white bg-gradient-to-r from-purple-600/80 to-pink-600/80 px-3 py-1.5 rounded-lg border border-pink-500/30">
                {getPhaseLabel(room.currentPhase)}
              </div>
            </div>
          </div>

          {/* Secret Role Alert */}
          {room.currentPhase === 'ROLES_ASSIGNMENT' && myPlayer && (
            <div className="glass-panel-glow p-5 mb-4 text-center animate-pulse border-purple-500/50 relative overflow-hidden rounded-2xl">
              <div className="absolute inset-0 bg-gradient-to-r from-purple-600/20 to-pink-600/20 blur-xl"></div>
              <span className="text-[10px] text-purple-300 font-bold tracking-[0.2em] uppercase block mb-2 relative z-10">Твоя Роль</span>
              {myPlayer.role === 'MAFIA' && <div className="text-red-400 font-black text-2xl tracking-widest flex items-center justify-center gap-2 relative z-10"><Skull className="w-6 h-6" /> МАФИЯ 🔴</div>}
              {myPlayer.role === 'DON' && <div className="text-red-400 font-black text-2xl tracking-widest flex items-center justify-center gap-2 relative z-10"><Skull className="w-6 h-6" /> ДОН МАФИИ 🎩</div>}
              {myPlayer.role === 'SHERIFF' && <div className="text-blue-400 font-black text-2xl tracking-widest flex items-center justify-center gap-2 relative z-10"><Shield className="w-6 h-6" /> ШЕРИФ 👮‍♂️</div>}
              {myPlayer.role === 'CIVILIAN' && <div className="text-green-400 font-black text-2xl tracking-widest flex items-center justify-center gap-2 relative z-10"><Users className="w-6 h-6" /> МИРНЫЙ 🟢</div>}
            </div>
          )}

          {/* Responsive Circular Table */}
          <div className="w-full aspect-square max-w-[360px] mx-auto relative mb-6">
            <div className="absolute inset-[15%] rounded-full border-[1px] border-purple-700/30 bg-purple-950/20 shadow-[0_0_50px_rgba(168,85,247,0.1)_inset] flex flex-col items-center justify-center backdrop-blur-sm z-0">
              {room.currentPhase === 'LOBBY' ? (
                <>
                  <div className="text-[10px] font-bold text-purple-400/80 uppercase tracking-widest mb-1">Игроки</div>
                  <div className="text-2xl font-black text-white">{room.players.length}/10</div>
                  {room.hostId === currentUser.id && (
                    <button onClick={triggerGameStart} disabled={room.players.length < 3} className="mt-4 px-5 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-xs font-black uppercase tracking-wider transition-all shadow-[0_0_20px_rgba(147,51,234,0.4)] active:scale-95 disabled:opacity-50 disabled:shadow-none z-20 relative">
                      Начать
                    </button>
                  )}
                </>
              ) : (
                <>
                  {room.currentPhase === 'DAY_DISCUSSION' && activeSpeakerId ? (
                    <>
                      <div className="text-[10px] text-purple-400 font-bold uppercase tracking-widest mb-1">Говорит</div>
                      <div className="text-3xl font-black text-white">{speechCountdown}s</div>
                    </>
                  ) : (
                    <>
                      <div className="text-xs font-bold text-purple-500 uppercase tracking-[0.3em]">МАФИЯ</div>
                    </>
                  )}
                </>
              )}
            </div>

            {/* Players around table */}
            {Array.from({ length: 10 }).map((_, i) => {
              const seatNum = i + 1;
              const player = room.players.find(p => p.seatNumber === seatNum);
              const isActiveSpeaker = player?.isAlive && player.id === activeSpeakerId;

              return (
                <div key={seatNum} style={getPositionStyles(seatNum)} className="flex flex-col items-center z-10">
                  {player ? (
                    <div className="relative group flex flex-col items-center">
                      <div className={`w-[13vw] h-[13vw] max-w-[56px] max-h-[56px] rounded-full flex items-center justify-center p-0.5 transition-all duration-300 relative
                        ${!player.isAlive ? 'border border-gray-800 bg-gray-950/40 opacity-40 grayscale' : 'border border-purple-700/50 bg-black/60 shadow-lg backdrop-blur-md'}
                        ${isActiveSpeaker ? 'scale-110 !border-2 !border-purple-400 !bg-purple-900/50 shadow-[0_0_20px_rgba(168,85,247,0.6)]' : ''}
                      `}>
                        <img src={player.user.photoUrl || `https://api.dicebear.com/7.x/bottts/svg?seed=${player.user.username}`} className="w-full h-full rounded-full object-cover relative z-10" />
                        
                        {/* Audio streams rendering (invisibly attached to active players) */}
                        {player.id !== myPlayer?.id && remoteStreams[player.id] && (
                          <AudioStream stream={remoteStreams[player.id]} isMuted={player.isMuted || !player.isAlive} />
                        )}

                        {!player.isAlive && (
                          <div className="absolute inset-0 rounded-full bg-black/60 flex items-center justify-center z-20">
                            <Skull className="w-5 h-5 text-red-500/80" />
                          </div>
                        )}

                        {isActiveSpeaker && !player.isMuted && (
                          <div className="absolute -top-1 -right-1 z-30 bg-purple-500 rounded-full p-1 border border-purple-300">
                            <div className="voice-wave">
                              <div className="voice-wave-bar !h-[8px]"></div>
                              <div className="voice-wave-bar !h-[12px]"></div>
                              <div className="voice-wave-bar !h-[8px]"></div>
                            </div>
                          </div>
                        )}

                        {player.isAlive && player.isMuted && (
                          <div className="absolute -bottom-1 -right-1 z-20 bg-black border border-red-500/50 rounded-full p-1 shadow-lg">
                            <MicOff className="w-2.5 h-2.5 text-red-400" />
                          </div>
                        )}
                        {player.isAlive && !player.isMuted && (
                          <div className="absolute -bottom-1 -right-1 z-20 bg-black border border-green-500/50 rounded-full p-1 shadow-lg">
                            <Mic className="w-2.5 h-2.5 text-green-400" />
                          </div>
                        )}
                      </div>

                      <div className={`absolute -top-1 -left-1 w-4 h-4 rounded-full flex items-center justify-center text-[9px] font-black border text-white z-30 
                        ${!player.isAlive ? 'bg-gray-800 border-gray-600' : 'bg-purple-600 border-purple-400'}
                      `}>
                        {seatNum}
                      </div>

                      <span className="text-[9px] text-white/90 font-medium truncate w-[60px] text-center mt-1.5 drop-shadow-md">
                        {player.user.username}
                      </span>

                      {room.currentPhase === 'DAY_VOTING' && player.isAlive && getVotesCount(player.id) > 0 && (
                        <span className="absolute -bottom-4 bg-pink-600 border border-pink-400 rounded-md px-1.5 py-0.5 text-[9px] font-black text-white shadow-lg z-30">
                          {getVotesCount(player.id)}
                        </span>
                      )}

                      {/* Action buttons Contextual */}
                      {player.isAlive && player.id !== myPlayer?.id && (
                        <div className="absolute top-[100%] mt-2 z-40 hidden group-hover:flex flex-col gap-1.5 bg-black/90 backdrop-blur-md border border-purple-500/40 p-2 rounded-xl shadow-2xl">
                          {room.currentPhase === 'DAY_VOTING' && myPlayer?.isAlive && (
                            <button onClick={() => submitDayVote(player.id)} className="px-3 py-1.5 bg-purple-600 hover:bg-purple-500 text-[10px] font-bold rounded-lg text-white">Голосовать</button>
                          )}
                          {room.currentPhase === 'NIGHT_MAFIA' && myPlayer?.isAlive && (myPlayer.role === 'MAFIA' || myPlayer.role === 'DON') && (
                            <button onClick={() => submitMafiaShoot(player.id)} className="px-3 py-1.5 bg-red-600 hover:bg-red-500 text-[10px] font-bold rounded-lg text-white">Убить</button>
                          )}
                          {room.currentPhase === 'NIGHT_DON' && myPlayer?.isAlive && myPlayer.role === 'DON' && (
                            <button onClick={() => submitDonCheck(player.id)} className="px-3 py-1.5 bg-orange-600 hover:bg-orange-500 text-[10px] font-bold rounded-lg text-white">Искать Шерифа</button>
                          )}
                          {room.currentPhase === 'NIGHT_SHERIFF' && myPlayer?.isAlive && myPlayer.role === 'SHERIFF' && (
                            <button onClick={() => submitSheriffCheck(player.id)} className="px-3 py-1.5 bg-blue-600 hover:bg-blue-500 text-[10px] font-bold rounded-lg text-white">Проверить</button>
                          )}
                        </div>
                      )}
                    </div>
                  ) : (
                    <div className="w-[13vw] h-[13vw] max-w-[56px] max-h-[56px] rounded-full border border-dashed border-purple-700/30 bg-purple-950/10 flex items-center justify-center">
                      <span className="text-[10px] font-medium text-purple-400/40">{seatNum}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Controls */}
          {myPlayer && myPlayer.isAlive && room.currentPhase !== 'LOBBY' && (
            <div className="flex gap-3 mb-4 w-full">
              <button onClick={toggleMute} className={`flex-1 py-4 rounded-2xl font-black text-xs uppercase tracking-wider flex items-center justify-center gap-2 border shadow-lg transition-all active:scale-95
                  ${myPlayer.isMuted ? 'bg-red-950/40 border-red-500/40 text-red-300' : 'bg-green-950/40 border-green-500/40 text-green-300'}
                `}>
                {myPlayer.isMuted ? <><MicOff className="w-5 h-5" /> Микрофон Выкл</> : <><Mic className="w-5 h-5" /> Микрофон Вкл</>}
              </button>
              {room.currentPhase === 'DAY_DISCUSSION' && myPlayer.id === activeSpeakerId && (
                <button onClick={endSpeechEarly} className="flex-1 py-4 rounded-2xl font-black text-xs uppercase tracking-wider bg-pink-600 border border-pink-400 text-white shadow-lg shadow-pink-600/30 active:scale-95 transition-all">
                  Завершить речь
                </button>
              )}
            </div>
          )}

          {/* Night Check Results */}
          {nightCheckResult && (
            <div className="w-full bg-purple-900/40 border border-purple-500/50 rounded-2xl p-4 mb-4 text-xs font-bold text-white flex items-center justify-center gap-3 shadow-lg">
              <Eye className="w-5 h-5 text-purple-300 shrink-0" />
              <span>{nightCheckResult}</span>
            </div>
          )}

          {/* Log panel */}
          <div className="glass-panel p-4 flex flex-col h-[120px] rounded-2xl bg-black/40 border-purple-900/50 mt-auto">
            <span className="text-[9px] text-purple-400/80 tracking-[0.2em] font-black uppercase mb-2">События</span>
            <div className="flex-grow overflow-y-auto no-scrollbar flex flex-col gap-1.5">
              {logs.length === 0 ? <span className="text-[10px] text-purple-500/50 italic">Пусто...</span> : logs.map((log, idx) => (
                <div key={idx} className="text-[10px] text-purple-200 font-medium flex items-start gap-2">
                  <span className="text-purple-500 mt-0.5">•</span><span>{log}</span>
                </div>
              ))}
            </div>
          </div>

          {room.status === 'LOBBY' && (
            <button onClick={leaveRoom} className="mt-4 text-[10px] font-bold uppercase tracking-widest text-purple-500/60 hover:text-purple-400 mx-auto block pb-4">
              Выйти из комнаты
            </button>
          )}
        </div>
      )}

      {/* 3. VICTORY SCREEN */}
      {room?.status === 'FINISHED' && myPlayer && (
        <div className="fixed inset-0 bg-black/95 backdrop-blur-lg flex flex-col items-center justify-center p-6 z-50 animate-in fade-in zoom-in duration-500">
          <div className="w-full max-w-sm glass-panel p-8 text-center border-2 border-purple-500/40 rounded-3xl relative overflow-hidden shadow-[0_0_50px_rgba(168,85,247,0.2)]">
            <Award className="w-24 h-24 text-purple-400 mx-auto mb-6 animate-bounce" />
            <h2 className="text-3xl font-black text-white tracking-widest uppercase mb-2">Игра Окончена</h2>
            <p className="text-lg text-purple-300 font-medium mb-8">Победители: <span className="font-black text-white">{room.winner === 'MAFIA' ? 'Мафия 🔴' : 'Мирные 🟢'}</span></p>
            <button onClick={leaveRoom} className="w-full py-4 rounded-2xl font-black text-sm uppercase tracking-wide bg-gradient-to-r from-purple-600 to-pink-600 text-white shadow-lg active:scale-95 transition-all">
              Вернуться в меню
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
