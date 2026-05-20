'use client';

import { useState, useEffect, useRef } from 'react';
import {
  Skull, Mic, MicOff, Shield, Users, Play, Plus,
  Award, Eye, AlertTriangle, ArrowRight, Crosshair
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

  // New Action Menu State
  const [isActionMenuOpen, setIsActionMenuOpen] = useState(false);

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
          setIsActionMenuOpen(false); // Close action menu on phase change
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
    setRoom(null); setMyPlayer(null); setLogs([]); setVotesCastMap({}); setNightCheckResult(null); setIsActionMenuOpen(false);
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
    // Oval layout for better mobile space usage
    return {
      left: `${50 + 36 * Math.cos(angle)}%`,
      top: `${50 + 44 * Math.sin(angle)}%`,
      transform: 'translate(-50%, -50%)',
      position: 'absolute' as const
    };
  };

  const getVotesCount = (playerId: string) => Object.values(votesCastMap).filter(id => id === playerId).length;

  const hasAction = myPlayer?.isAlive && (
    room?.currentPhase === 'DAY_VOTING' ||
    (room?.currentPhase === 'NIGHT_MAFIA' && (myPlayer.role === 'MAFIA' || myPlayer.role === 'DON')) ||
    (room?.currentPhase === 'NIGHT_DON' && myPlayer.role === 'DON') ||
    (room?.currentPhase === 'NIGHT_SHERIFF' && myPlayer.role === 'SHERIFF')
  );

  const getActionMenuTitle = () => {
    if (room?.currentPhase === 'DAY_VOTING') return 'Кого выгнать днем?';
    if (room?.currentPhase === 'NIGHT_MAFIA') return 'Кого убить ночью?';
    if (room?.currentPhase === 'NIGHT_DON') return 'Проверить на Шерифа';
    if (room?.currentPhase === 'NIGHT_SHERIFF') return 'Проверить на Мафию';
    return 'Сделать выбор';
  };

  const getActionBtnLabel = () => {
    if (room?.currentPhase === 'DAY_VOTING') return 'ГОЛОСОВАТЬ';
    if (room?.currentPhase === 'NIGHT_MAFIA') return 'УБИТЬ';
    if (room?.currentPhase === 'NIGHT_DON') return 'ИСКАТЬ ШЕРИФА';
    if (room?.currentPhase === 'NIGHT_SHERIFF') return 'ПРОВЕРИТЬ';
    return 'ВЫБРАТЬ';
  };

  return (
    <main className="min-h-[100dvh] w-full flex flex-col px-4 py-6 sm:p-8 bg-[#0a0a0c] relative overflow-hidden text-zinc-200">

      {/* Persistent Role Header */}
      {myPlayer && room && room.currentPhase !== 'LOBBY' && (
        <div className="absolute top-0 left-0 right-0 py-3 bg-gradient-to-b from-black to-transparent flex justify-center z-30 pointer-events-none">
          <div className="px-5 py-1.5 rounded-full bg-zinc-900/80 border border-zinc-700/50 backdrop-blur-md flex items-center gap-2 shadow-[0_4px_20px_rgba(0,0,0,0.5)] pointer-events-auto">
            <span className="text-[10px] text-zinc-400 uppercase tracking-widest font-semibold">Ваша роль:</span>
            <span className={`text-xs font-black uppercase tracking-wider ${myPlayer.role === 'MAFIA' || myPlayer.role === 'DON' ? 'text-red-500' :
                myPlayer.role === 'SHERIFF' ? 'text-blue-400' : 'text-green-500'
              }`}>
              {myPlayer.role === 'MAFIA' ? 'Мафия 🔴' :
                myPlayer.role === 'DON' ? 'Дон Мафии 🎩' :
                  myPlayer.role === 'SHERIFF' ? 'Шериф 👮‍♂️' : 'Мирный 🟢'}
            </span>
          </div>
        </div>
      )}

      {/* 1. WELCOME SCREEN */}
      {!room && (
        <div className="w-full max-w-md mx-auto my-auto glass-panel p-8 text-center flex flex-col z-10 animate-in fade-in duration-700 border-zinc-800">
          <div className="w-24 h-24 mx-auto rounded-full bg-zinc-900 border border-yellow-600/30 flex items-center justify-center shadow-2xl mb-8 shadow-yellow-900/10">
            <Skull className="w-12 h-12 text-yellow-600/80" />
          </div>
          <h1 className="text-4xl font-black tracking-widest text-zinc-100 mb-2 uppercase">
            Мафия
          </h1>
          <p className="text-xs text-yellow-600/70 font-semibold tracking-widest uppercase mb-10">Закрытый клуб</p>

          {currentUser && (
            <div className="flex items-center gap-4 bg-zinc-900/60 border border-zinc-800 rounded-2xl p-4 mb-8">
              <img src={currentUser.photoUrl || `https://api.dicebear.com/7.x/bottts/svg?seed=${currentUser.username}`} className="w-12 h-12 rounded-full border border-zinc-700" />
              <div className="text-left">
                <span className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold block mb-1">Ваш профиль</span>
                <span className="text-base font-bold text-zinc-200">{currentUser.username}</span>
              </div>
            </div>
          )}

          {joinError && (
            <div className="bg-red-950/30 border border-red-900/50 rounded-xl p-3 mb-6 text-xs font-medium text-red-400 flex items-center justify-center gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" />
              <span>{joinError}</span>
            </div>
          )}

          <div className="flex flex-col gap-4 mt-2">
            <button onClick={createRoom} disabled={isLoading} className="w-full py-4 rounded-xl font-bold text-xs uppercase tracking-[0.2em] bg-zinc-100 hover:bg-white text-black shadow-lg shadow-zinc-100/10 active:scale-95 transition-all flex items-center justify-center gap-3">
              {isLoading ? 'Загрузка...' : <><Plus className="w-4 h-4" /> Создать стол</>}
            </button>
            <div className="flex items-center justify-center gap-2 max-w-[200px] mx-auto">
              <input type="text" placeholder="КОД" maxLength={4} value={roomCodeInput} onChange={(e) => setRoomCodeInput(e.target.value.toUpperCase())} className="flex-1 bg-zinc-900/80 border border-zinc-800 rounded-lg px-3 py-2 text-center tracking-widest font-bold uppercase text-zinc-200 text-sm focus:outline-none focus:border-yellow-600/50 transition-all placeholder:text-zinc-700" />
              <button onClick={joinRoom} disabled={isLoading || roomCodeInput.length < 4} className="h-[36px] w-[36px] rounded-lg font-bold bg-zinc-800 hover:bg-zinc-700 border border-zinc-700 text-zinc-300 active:scale-95 transition-all flex items-center justify-center disabled:opacity-50">
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 2. GAME ROOM */}
      {room && currentUser && (
        <div className="w-full max-w-[420px] mx-auto flex flex-col z-10 flex-1 animate-in fade-in duration-500 pt-8">

          {/* Header */}
          <div className="flex items-center justify-between mb-6 px-2">
            <div>
              <div className="text-[9px] text-zinc-500 font-bold uppercase tracking-widest mb-1">Стол</div>
              <div className="text-lg font-black text-yellow-500 tracking-widest">
                {room.code}
              </div>
            </div>
            <div className="text-right">
              <div className="text-[9px] text-zinc-500 font-bold uppercase tracking-widest mb-1">Фаза</div>
              <div className="text-xs font-bold text-zinc-200 uppercase tracking-wider">
                {getPhaseLabel(room.currentPhase)}
              </div>
            </div>
          </div>

          {/* Secret Role Assignment Overlay */}
          {room.currentPhase === 'ROLES_ASSIGNMENT' && myPlayer && (
            <div className="absolute inset-0 z-40 bg-black/90 backdrop-blur-md flex flex-col items-center justify-center p-6 animate-in zoom-in duration-700">
              <div className="w-full max-w-sm border border-zinc-800 bg-zinc-900/80 rounded-3xl p-8 text-center shadow-2xl">
                <span className="text-[10px] text-zinc-400 font-bold tracking-[0.3em] uppercase block mb-6">Ваша Роль</span>
                {myPlayer.role === 'MAFIA' && <div className="text-red-500 font-black text-3xl tracking-widest mb-4">МАФИЯ 🔴</div>}
                {myPlayer.role === 'DON' && <div className="text-red-500 font-black text-3xl tracking-widest mb-4">ДОН МАФИИ 🎩</div>}
                {myPlayer.role === 'SHERIFF' && <div className="text-blue-500 font-black text-3xl tracking-widest mb-4">ШЕРИФ 👮‍♂️</div>}
                {myPlayer.role === 'CIVILIAN' && <div className="text-green-500 font-black text-3xl tracking-widest mb-4">МИРНЫЙ 🟢</div>}
                <p className="text-xs text-zinc-500 leading-relaxed font-medium">Запомните свою роль.<br />Никому не показывайте экран.</p>
              </div>
            </div>
          )}

          {/* Elegant Table Layout */}
          <div className="w-full aspect-[4/5] max-w-[360px] mx-auto relative mb-6">
            <div className="absolute inset-[10%] rounded-[100px] border border-zinc-800/80 bg-zinc-900/40 shadow-[inset_0_0_60px_rgba(0,0,0,0.8)] flex flex-col items-center justify-center backdrop-blur-sm z-0">
              {room.currentPhase === 'LOBBY' ? (
                <>
                  <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-2">Ожидание</div>
                  <div className="text-3xl font-black text-zinc-200">{room.players.length}<span className="text-zinc-700">/10</span></div>
                  {room.hostId === currentUser.id && (
                    <button onClick={triggerGameStart} disabled={room.players.length < 3} className="mt-6 px-6 py-3 rounded-full bg-zinc-100 hover:bg-white text-black text-xs font-black uppercase tracking-widest transition-all shadow-[0_0_30px_rgba(255,255,255,0.1)] active:scale-95 disabled:opacity-50 z-20 relative">
                      Раздать карты
                    </button>
                  )}
                </>
              ) : (
                <>
                  {room.currentPhase === 'DAY_DISCUSSION' && activeSpeakerId ? (
                    <>
                      <div className="text-[10px] text-yellow-600/80 font-bold uppercase tracking-[0.2em] mb-2">Слово игроку</div>
                      <div className="text-4xl font-black text-zinc-100">{speechCountdown}</div>
                    </>
                  ) : (
                    <>
                      <div className="w-16 h-16 rounded-full border border-zinc-800 flex items-center justify-center opacity-50">
                        <Skull className="w-6 h-6 text-zinc-700" />
                      </div>
                    </>
                  )}
                </>
              )}
            </div>

            {/* Players */}
            {Array.from({ length: 10 }).map((_, i) => {
              const seatNum = i + 1;
              const player = room.players.find(p => p.seatNumber === seatNum);
              const isActiveSpeaker = player?.isAlive && player.id === activeSpeakerId;

              return (
                <div key={seatNum} style={getPositionStyles(seatNum)} className="flex flex-col items-center z-10">
                  {player ? (
                    <div className="relative flex flex-col items-center">
                      <div className={`w-14 h-14 sm:w-16 sm:h-16 rounded-full flex items-center justify-center p-0.5 transition-all duration-500 relative
                        ${!player.isAlive ? 'border border-zinc-900 bg-black opacity-30 grayscale' : 'border border-zinc-700 bg-zinc-900 shadow-xl'}
                        ${isActiveSpeaker ? 'scale-110 !border-2 !border-yellow-600 shadow-[0_0_25px_rgba(212,175,55,0.4)]' : ''}
                      `}>
                        <img src={player.user.photoUrl || `https://api.dicebear.com/7.x/bottts/svg?seed=${player.user.username}`} className="w-full h-full rounded-full object-cover relative z-10" />

                        {player.id !== myPlayer?.id && remoteStreams[player.id] && (
                          <AudioStream stream={remoteStreams[player.id]} isMuted={player.isMuted || !player.isAlive} />
                        )}

                        {!player.isAlive && (
                          <div className="absolute inset-0 rounded-full bg-black/70 flex items-center justify-center z-20">
                            <Skull className="w-6 h-6 text-red-700/80" />
                          </div>
                        )}

                        {isActiveSpeaker && !player.isMuted && (
                          <div className="absolute -top-1 -right-1 z-30 bg-yellow-600 rounded-full p-1 border border-black shadow-md">
                            <div className="voice-wave">
                              <div className="voice-wave-bar !bg-black !h-[6px]"></div>
                              <div className="voice-wave-bar !bg-black !h-[10px]"></div>
                              <div className="voice-wave-bar !bg-black !h-[6px]"></div>
                            </div>
                          </div>
                        )}

                        {player.isAlive && player.isMuted && (
                          <div className="absolute -bottom-1 -right-1 z-20 bg-zinc-900 border border-zinc-700 rounded-full p-1 shadow-lg">
                            <MicOff className="w-3 h-3 text-red-500" />
                          </div>
                        )}
                        {player.isAlive && !player.isMuted && (
                          <div className="absolute -bottom-1 -right-1 z-20 bg-zinc-900 border border-zinc-700 rounded-full p-1 shadow-lg">
                            <Mic className="w-3 h-3 text-green-500" />
                          </div>
                        )}
                      </div>

                      <div className={`absolute -top-1 -left-1 w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-black border z-30 
                        ${!player.isAlive ? 'bg-zinc-900 border-zinc-800 text-zinc-600' : 'bg-yellow-600 border-black text-black'}
                      `}>
                        {seatNum}
                      </div>

                      <span className="text-[10px] text-zinc-300 font-medium truncate w-[64px] text-center mt-2 drop-shadow-md tracking-wide">
                        {player.user.username}
                      </span>

                      {room.currentPhase === 'DAY_VOTING' && player.isAlive && getVotesCount(player.id) > 0 && (
                        <span className="absolute -bottom-5 bg-red-700 border border-red-900 rounded-md px-2 py-0.5 text-[10px] font-black text-white shadow-xl z-30">
                          {getVotesCount(player.id)}
                        </span>
                      )}
                    </div>
                  ) : (
                    <div className="w-14 h-14 sm:w-16 sm:h-16 rounded-full border border-dashed border-zinc-800 bg-black/20 flex items-center justify-center">
                      <span className="text-[10px] font-medium text-zinc-700">{seatNum}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Action Menu Trigger Button (Replaces hover menus) */}
          {hasAction && (
            <button
              onClick={() => setIsActionMenuOpen(true)}
              className="w-full py-4 mb-4 rounded-2xl font-black text-sm uppercase tracking-widest bg-red-700 hover:bg-red-600 text-white shadow-[0_0_20px_rgba(204,0,0,0.3)] border border-red-500/50 active:scale-95 transition-all flex items-center justify-center gap-2 animate-pulse"
            >
              <Crosshair className="w-5 h-5" />
              Сделать Выбор
            </button>
          )}

          {/* Bottom Action Menu Modal (Bottom Sheet) */}
          {isActionMenuOpen && (
            <div className="fixed inset-0 bg-black/80 backdrop-blur-sm z-50 flex items-end justify-center animate-in fade-in duration-300">
              <div className="bg-zinc-900 w-full max-w-md rounded-t-[32px] p-6 pb-12 border-t border-zinc-700 shadow-2xl animate-in slide-in-from-bottom-12 duration-300">
                <h3 className="text-zinc-400 font-bold text-center uppercase tracking-widest mb-6 text-xs">
                  {getActionMenuTitle()}
                </h3>
                <div className="flex flex-col gap-2 max-h-[50vh] overflow-y-auto no-scrollbar pb-4">
                  {room.players.filter(p => p.isAlive && p.id !== myPlayer?.id).map(p => (
                    <button
                      key={p.id}
                      onClick={() => {
                        if (room.currentPhase === 'DAY_VOTING') submitDayVote(p.id);
                        if (room.currentPhase === 'NIGHT_MAFIA') submitMafiaShoot(p.id);
                        if (room.currentPhase === 'NIGHT_DON') submitDonCheck(p.id);
                        if (room.currentPhase === 'NIGHT_SHERIFF') submitSheriffCheck(p.id);
                        setIsActionMenuOpen(false);
                      }}
                      className="flex items-center justify-between p-4 rounded-2xl bg-zinc-950 border border-zinc-800 hover:border-red-900/50 hover:bg-red-950/20 active:scale-95 transition-all"
                    >
                      <div className="flex items-center gap-4">
                        <span className="w-8 h-8 rounded-full bg-zinc-800 text-zinc-300 flex items-center justify-center text-xs font-bold border border-zinc-700">{p.seatNumber}</span>
                        <div className="flex flex-col items-start">
                          <span className="text-zinc-200 font-bold">{p.user.username}</span>
                        </div>
                      </div>
                      <span className="text-[10px] font-black text-red-500 uppercase tracking-widest bg-red-950/40 px-3 py-1.5 rounded-lg border border-red-900/50">
                        {getActionBtnLabel()}
                      </span>
                    </button>
                  ))}
                </div>
                <button onClick={() => setIsActionMenuOpen(false)} className="w-full mt-2 py-4 rounded-xl text-zinc-500 font-bold uppercase tracking-widest text-xs hover:text-zinc-300 hover:bg-zinc-800/50 transition-all">
                  Отмена
                </button>
              </div>
            </div>
          )}

          {/* User Controls */}
          {myPlayer && myPlayer.isAlive && room.currentPhase !== 'LOBBY' && (
            <div className="flex gap-3 mb-4 w-full">
              <button onClick={toggleMute} className={`flex-1 py-4 rounded-2xl font-bold text-[10px] uppercase tracking-widest flex items-center justify-center gap-2 border transition-all active:scale-95
                  ${myPlayer.isMuted ? 'bg-zinc-900 border-red-900/50 text-red-400' : 'bg-zinc-900 border-green-900/50 text-green-400'}
                `}>
                {myPlayer.isMuted ? <><MicOff className="w-4 h-4" /> Микрофон Выкл</> : <><Mic className="w-4 h-4" /> Микрофон Вкл</>}
              </button>
              {room.currentPhase === 'DAY_DISCUSSION' && myPlayer.id === activeSpeakerId && (
                <button onClick={endSpeechEarly} className="flex-1 py-4 rounded-2xl font-bold text-[10px] uppercase tracking-widest bg-zinc-800 border border-zinc-700 text-zinc-300 active:scale-95 transition-all">
                  Закончить речь
                </button>
              )}
            </div>
          )}

          {/* Night Check Results */}
          {nightCheckResult && (
            <div className="w-full bg-zinc-900 border border-yellow-600/30 rounded-2xl p-4 mb-4 text-xs font-bold text-zinc-200 flex items-center justify-center gap-3 shadow-[0_0_15px_rgba(212,175,55,0.1)]">
              <Eye className="w-5 h-5 text-yellow-600 shrink-0" />
              <span>{nightCheckResult}</span>
            </div>
          )}

          {/* Log panel */}
          <div className="bg-zinc-900/50 border border-zinc-800 p-4 flex flex-col h-[100px] rounded-3xl mt-auto backdrop-blur-md">
            <span className="text-[9px] text-zinc-500 tracking-widest font-bold uppercase mb-2">События за столом</span>
            <div className="flex-grow overflow-y-auto no-scrollbar flex flex-col gap-1.5">
              {logs.length === 0 ? <span className="text-[10px] text-zinc-600 italic">Тишина...</span> : logs.map((log, idx) => (
                <div key={idx} className="text-[10px] text-zinc-400 font-medium flex items-start gap-2 leading-relaxed">
                  <span className="text-yellow-700 mt-0.5">●</span><span>{log}</span>
                </div>
              ))}
            </div>
          </div>

          {room.status === 'LOBBY' && (
            <button onClick={leaveRoom} className="mt-6 text-[10px] font-bold uppercase tracking-widest text-zinc-600 hover:text-zinc-400 mx-auto block pb-4 transition-colors">
              Покинуть стол
            </button>
          )}
        </div>
      )}

      {/* 3. VICTORY SCREEN */}
      {room?.status === 'FINISHED' && myPlayer && (
        <div className="fixed inset-0 bg-black/95 backdrop-blur-xl flex flex-col items-center justify-center p-6 z-50 animate-in fade-in zoom-in duration-700">
          <div className="w-full max-w-sm bg-zinc-900 border border-zinc-800 p-8 text-center rounded-[32px] shadow-2xl">
            <Award className="w-20 h-20 text-yellow-600 mx-auto mb-6" />
            <h2 className="text-2xl font-black text-white tracking-widest uppercase mb-2">Конец Игры</h2>
            <p className="text-xs text-zinc-400 font-medium uppercase tracking-widest mb-8">
              Победили: <span className={`font-black text-sm ml-1 ${room.winner === 'MAFIA' ? 'text-red-500' : 'text-green-500'}`}>
                {room.winner === 'MAFIA' ? 'Мафия 🔴' : 'Мирные 🟢'}
              </span>
            </p>
            <button onClick={leaveRoom} className="w-full py-4 rounded-2xl font-black text-[10px] uppercase tracking-widest bg-zinc-100 hover:bg-white text-black transition-all active:scale-95">
              Вернуться в лобби
            </button>
          </div>
        </div>
      )}
    </main>
  );
}
