import { useEffect, useRef } from 'react';

interface AudioStreamProps {
  stream: MediaStream;
  isMuted: boolean; // Remote player's mute status to stop playing if they are muted
}

export function AudioStream({ stream, isMuted }: AudioStreamProps) {
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (audioRef.current && stream) {
      audioRef.current.srcObject = stream;
      // We must explicitly call play in modern browsers, but some require user interaction first
      audioRef.current.play().catch(err => console.log('Audio autoplay prevented', err));
    }
  }, [stream]);

  useEffect(() => {
    if (audioRef.current) {
      audioRef.current.muted = isMuted;
    }
  }, [isMuted]);

  return <audio ref={audioRef} autoPlay playsInline className="hidden" />;
}
