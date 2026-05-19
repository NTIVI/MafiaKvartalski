import { useEffect, useRef, useState, useCallback } from 'react';

export function useWebRTC(
  socket: WebSocket | null,
  currentUserId: string | null,
  activePlayersIds: string[],
  isMuted: boolean
) {
  const localStreamRef = useRef<MediaStream | null>(null);
  const peersRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  const [remoteStreams, setRemoteStreams] = useState<Record<string, MediaStream>>({});
  const [isMicReady, setIsMicReady] = useState(false);
  const signalQueueRef = useRef<Array<{ senderId: string, signal: any }>>([]);

  // 1. Initialize local microphone
  useEffect(() => {
    let stream: MediaStream | null = null;
    const initMic = async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        localStreamRef.current = stream;
        
        // Mute by default based on initial state
        stream.getAudioTracks().forEach(track => {
          track.enabled = !isMuted;
        });
        setIsMicReady(true);
      } catch (err) {
        console.error('Error accessing microphone', err);
      }
    };
    initMic();

    return () => {
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
    };
  }, []);

  // 2. Update mute status dynamically
  useEffect(() => {
    if (localStreamRef.current) {
      localStreamRef.current.getAudioTracks().forEach(track => {
        track.enabled = !isMuted;
      });
    }
  }, [isMuted]);

  // Handle incoming signaling messages
  const handleSignal = useCallback(async (senderId: string, signal: any) => {
    if (!currentUserId) return;
    
    // If mic is not ready yet, queue the signal
    if (!isMicReady) {
      signalQueueRef.current.push({ senderId, signal });
      return;
    }
    
    let peer = peersRef.current.get(senderId);
    
    // If we receive an offer and don't have a peer, create one
    if (!peer) {
      peer = createPeerConnection(senderId);
      peersRef.current.set(senderId, peer);
    }

    try {
      if (signal.type === 'offer') {
        await peer.setRemoteDescription(new RTCSessionDescription(signal));
        const answer = await peer.createAnswer();
        await peer.setLocalDescription(answer);
        socket?.send(JSON.stringify({
          type: 'webrtc_signal',
          payload: { targetPlayerId: senderId, signal: peer.localDescription }
        }));
      } else if (signal.type === 'answer') {
        await peer.setRemoteDescription(new RTCSessionDescription(signal));
      } else if (signal.candidate) {
        await peer.addIceCandidate(new RTCIceCandidate(signal));
      }
    } catch (err) {
      console.error('WebRTC Signaling Error:', err);
    }
  }, [socket, currentUserId]);

  const createPeerConnection = useCallback((targetPlayerId: string) => {
    const peer = new RTCPeerConnection({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' }
      ]
    });

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach(track => {
        peer.addTrack(track, localStreamRef.current!);
      });
    }

    peer.onicecandidate = (event) => {
      if (event.candidate && socket) {
        socket.send(JSON.stringify({
          type: 'webrtc_signal',
          payload: { targetPlayerId, signal: event.candidate }
        }));
      }
    };

    peer.ontrack = (event) => {
      setRemoteStreams(prev => ({
        ...prev,
        [targetPlayerId]: event.streams[0]
      }));
    };

    peer.oniceconnectionstatechange = () => {
      if (peer.iceConnectionState === 'disconnected' || peer.iceConnectionState === 'failed') {
        peer.close();
        peersRef.current.delete(targetPlayerId);
        setRemoteStreams(prev => {
          const next = { ...prev };
          delete next[targetPlayerId];
          return next;
        });
      }
    };

    return peer;
  }, [socket]);

  // Process queued signals when mic becomes ready
  useEffect(() => {
    if (isMicReady && signalQueueRef.current.length > 0) {
      const queue = [...signalQueueRef.current];
      signalQueueRef.current = [];
      queue.forEach(({ senderId, signal }) => {
        handleSignal(senderId, signal);
      });
    }
  }, [isMicReady, handleSignal]);

  // Connect to new players (the ones we don't have connections with yet)
  useEffect(() => {
    if (!socket || !currentUserId || !isMicReady) return;

    // We only initiate connections to peers with ID > our ID to prevent duplicate offers
    activePlayersIds.forEach(async (playerId) => {
      if (playerId !== currentUserId && !peersRef.current.has(playerId)) {
        if (currentUserId > playerId) {
          const peer = createPeerConnection(playerId);
          peersRef.current.set(playerId, peer);

          try {
            const offer = await peer.createOffer();
            await peer.setLocalDescription(offer);
            socket.send(JSON.stringify({
              type: 'webrtc_signal',
              payload: { targetPlayerId: playerId, signal: peer.localDescription }
            }));
          } catch (err) {
            console.error('Error creating WebRTC offer:', err);
          }
        }
      }
    });
  }, [activePlayersIds, socket, currentUserId, createPeerConnection, isMicReady]);

  // Clean up removed players
  useEffect(() => {
    const currentIds = new Set(activePlayersIds);
    peersRef.current.forEach((peer, playerId) => {
      if (!currentIds.has(playerId)) {
        peer.close();
        peersRef.current.delete(playerId);
        setRemoteStreams(prev => {
          const next = { ...prev };
          delete next[playerId];
          return next;
        });
      }
    });
  }, [activePlayersIds]);

  return { remoteStreams, handleSignal };
}
