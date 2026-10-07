import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import {
  connectToRoom,
  sendChatMessage,
  sendSystemMessage,
  sendVoiceSignal,
  sendWebRTCSignal,
  type RoomEvent,
  type WebRTCSignalPayload,
} from "./services/socket";
import {
  acceptAnswer,
  acceptOffer,
  addIceCandidate,
  closeAllPeerConnections,
  closePeerConnection as removePeerConnection,
  createAnswer,
  createOffer,
  createPeerConnection,
  type PeerConnections,
  VoicePeerManager,
  type VoicePeerStatus,
  type VoiceSignalPayload as WebRTCVoiceSignalPayload,
} from "./services/webrtc";
import { analyzeMedia, type MediaInfo } from "./services/media";
import "./App.css";

const API_URL = "http://localhost:5000";

type Participant = {
  id: string;
  name: string;
};

type RoomSession = {
  roomId: string;
  participantId: string;
  name: string;
  role: "host" | "viewer";
  voiceMuted?: boolean;
};

const ROOM_SESSION_KEY = "syncroom_session";

function readRoomSession(): RoomSession | null {
  try {
    const raw = sessionStorage.getItem(ROOM_SESSION_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const session = value as Record<string, unknown>;
    if (
      typeof session.roomId !== "string" ||
      typeof session.participantId !== "string" ||
      typeof session.name !== "string" ||
      (session.role !== "host" && session.role !== "viewer")
    ) return null;

    return {
      roomId: session.roomId,
      participantId: session.participantId,
      name: session.name,
      role: session.role,
      voiceMuted: typeof session.voiceMuted === "boolean" ? session.voiceMuted : false,
    };
  } catch (error) {
    console.error("Could not read the saved room session:", error);
    return null;
  }
}

function saveRoomSession(session: RoomSession): boolean {
  try {
    sessionStorage.setItem(ROOM_SESSION_KEY, JSON.stringify(session));
    return true;
  } catch (error) {
    console.error("Could not save the room session:", error);
    return false;
  }
}

function saveVoiceMuted(voiceMuted: boolean): void {
  const session = readRoomSession();
  if (session) saveRoomSession({ ...session, voiceMuted });
}

function clearRoomSession(): void {
  try {
    sessionStorage.removeItem(ROOM_SESSION_KEY);
  } catch (error) {
    console.error("Could not clear the saved room session:", error);
  }
}

type PendingPlaybackState = {
  isPlaying?: boolean;
  currentTime?: number;
};

type ChatItem =
  | {
      type: "chat:message";
      senderId: string;
      senderName: string;
      message: string;
      timestamp: number;
    }
  | {
      type: "system:message";
      message: string;
      timestamp: number;
    };

type VideoElementWithCaptureStream = HTMLVideoElement & {
  captureStream?: () => MediaStream;
};

type RoomResponse = {
  room: {
    id: string;
    hostId?: string;
    participants?: Array<{ id: string; name: string }>;
  };
  participantId: string;
};

function isParticipant(value: unknown): value is Participant {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.id === "string" && typeof candidate.name === "string";
}

function BrandMark() {
  return (
    <span className="brand-mark" aria-hidden="true">
      <svg viewBox="0 0 32 32" fill="none">
        <rect x="2" y="5" width="20" height="22" rx="7" fill="currentColor" />
        <path d="m22 12 8-5v18l-8-5V12Z" fill="currentColor" />
        <path d="M10 12.5v7l6-3.5-6-3.5Z" fill="#101018" />
      </svg>
    </span>
  );
}

function RemoteAudio({ stream, participantName }: { stream: MediaStream; participantName: string }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    audio.srcObject = stream;
    void audio.play().catch((error: unknown) => {
      console.error(`Could not play ${participantName}'s voice stream:`, error);
    });
    return () => {
      audio.srcObject = null;
    };
  }, [participantName, stream]);

  return <audio ref={audioRef} autoPlay aria-label={`${participantName}'s voice`} />;
}

function formatMediaDuration(duration: number): string {
  const totalMinutes = Math.floor(duration / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (totalMinutes > 0) return `${totalMinutes}m`;
  return `${Math.floor(duration)}s`;
}

function getQualityOptions(mediaInfo: MediaInfo): string[] {
  const lowerResolutions = [4320, 2160, 1440, 1080, 720, 480, 360]
    .filter((height) => height < mediaInfo.height)
    .map((height) => `${height}p`);
  return ["Auto", mediaInfo.resolution, ...lowerResolutions.filter((quality) => quality !== mediaInfo.resolution)];
}

function App() {
  const [initialSession] = useState(readRoomSession);
  const [roomCode, setRoomCode] = useState("");
  const [name, setName] = useState(initialSession?.name ?? "");
  const [activeRoom, setActiveRoom] = useState<string | null>(initialSession?.roomId ?? null);
  const [isHost, setIsHost] = useState(initialSession?.role === "host");
  const [currentParticipant, setCurrentParticipant] = useState<Participant | null>(
    initialSession ? { id: initialSession.participantId, name: initialSession.name } : null,
  );
  const [participants, setParticipants] = useState<Participant[]>(
    initialSession ? [{ id: initialSession.participantId, name: initialSession.name }] : [],
  );
  const [selectedVideo, setSelectedVideo] = useState<File | null>(null);
  const [mediaInfo, setMediaInfo] = useState<MediaInfo | null>(null);
  const [isAnalyzingMedia, setIsAnalyzingMedia] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<"quality" | "audio" | "subtitles" | null>(null);
  const [selectedQuality, setSelectedQuality] = useState("Auto");
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [voiceStatus, setVoiceStatus] = useState<"idle" | "requesting" | "ready" | "denied">("idle");
  const [isVoiceMuted, setIsVoiceMuted] = useState(initialSession?.voiceMuted ?? false);
  const [voicePeerStatuses, setVoicePeerStatuses] = useState<Record<string, VoicePeerStatus>>({});
  const [remoteAudioStreams, setRemoteAudioStreams] = useState<Record<string, MediaStream>>({});
  const [chatMessages, setChatMessages] = useState<ChatItem[]>([]);
  const [chatDraft, setChatDraft] = useState("");
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [message, setMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const videoUrlRef = useRef<string | null>(null);
  const mediaAnalysisIdRef = useRef(0);
  const isHostRef = useRef(false);
  const peerConnectionsRef = useRef<PeerConnections>(new Map());
  const pendingIceCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const capturedStreamRef = useRef<MediaStream | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const watchStageRef = useRef<HTMLDivElement | null>(null);
  const chatMessagesEndRef = useRef<HTMLDivElement | null>(null);
  const pendingPlaybackRef = useRef<PendingPlaybackState>({});
  const voiceManagerRef = useRef<VoicePeerManager | null>(null);
  const voiceParticipantIdsRef = useRef<Set<string>>(new Set());
  const startVoiceRef = useRef<(() => Promise<void>) | null>(null);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === watchStageRef.current);
    };
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", handleFullscreenChange);
  }, []);

  const applyRemotePlayback = () => {
    const video = remoteVideoRef.current;
    if (!video) return;

    const playback = pendingPlaybackRef.current;
    if (
      typeof playback.currentTime === "number" &&
      video.readyState >= HTMLMediaElement.HAVE_METADATA
    ) {
      video.currentTime = playback.currentTime;
      delete playback.currentTime;
    }

    if (playback.isPlaying === true) {
      void video.play().catch((error: unknown) => {
        console.error("Could not play the synchronized video:", error);
        setMessage("Press play on the video to allow synchronized playback.");
      });
    } else if (playback.isPlaying === false) {
      video.pause();
    } else {
      void video.play().catch((error: unknown) => {
        console.error("Could not autoplay the remote video stream:", error);
      });
    }
  };

  const sendHostPlaybackEvent = (
    type: "playback:play" | "playback:pause" | "playback:seek",
    currentTime?: number,
  ) => {
    if (!isHostRef.current) return;
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      console.error(`Could not send ${type}: room connection is not open.`);
      setMessage("Playback could not sync because the room connection is unavailable.");
      return;
    }

    const event = type === "playback:seek"
      ? { type, currentTime }
      : { type };
    try {
      socket.send(JSON.stringify(event));
      const systemMessage = type === "playback:play"
        ? "Host played the video"
        : type === "playback:pause"
          ? "Host paused the video"
          : `Host skipped to ${formatPlaybackTime(currentTime ?? 0)}`;
      sendSystemMessage(socket, systemMessage);
    } catch (error) {
      console.error(`Could not send ${type}:`, error);
      setMessage("Playback could not sync because the room connection failed.");
    }
  };

  const formatPlaybackTime = (time: number): string => {
    const seconds = Math.max(0, Math.floor(time));
    const minutes = Math.floor(seconds / 60);
    return `${String(minutes).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  };

  const cleanupPeerConnection = (participantId: string, clearRemoteStream = false) => {
    removePeerConnection(peerConnectionsRef.current, participantId);
    pendingIceCandidatesRef.current.delete(participantId);
    if (clearRemoteStream) {
      pendingPlaybackRef.current = {};
      setRemoteStream(null);
    }
  };

  const cleanupAllPeerConnections = () => {
    closeAllPeerConnections(peerConnectionsRef.current);
    pendingIceCandidatesRef.current.clear();
    pendingPlaybackRef.current = {};
    setRemoteStream(null);
  };

  useEffect(() => () => {
    socketRef.current?.close();
    closeAllPeerConnections(peerConnectionsRef.current);
    voiceManagerRef.current?.cleanup();
    capturedStreamRef.current?.getTracks().forEach((track) => track.stop());
    if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
  }, []);

  useEffect(() => {
    const video = remoteVideoRef.current;
    if (!video) return;

    video.srcObject = remoteStream;
    video.addEventListener("loadedmetadata", applyRemotePlayback);
    applyRemotePlayback();

    return () => {
      video.removeEventListener("loadedmetadata", applyRemotePlayback);
      video.srcObject = null;
    };
  }, [remoteStream]);

  useEffect(() => {
    chatMessagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [chatMessages]);

  const enterRoom = (
    roomId: string,
    participantId: string,
    participantName: string,
    host: boolean,
  ) => {
    const self = { id: participantId, name: participantName };
    const existingSession = readRoomSession();
    const initialMuted = existingSession?.roomId === roomId &&
      existingSession.participantId === participantId
      ? existingSession.voiceMuted ?? false
      : false;
    const saved = saveRoomSession({
      roomId,
      participantId,
      name: participantName,
      role: host ? "host" : "viewer",
      voiceMuted: initialMuted,
    });
    setActiveRoom(roomId);
    setName(participantName);
    setIsHost(host);
    isHostRef.current = host;
    setCurrentParticipant(self);
    setParticipants([self]);
    voiceParticipantIdsRef.current.clear();
    voiceManagerRef.current?.cleanup();
    voiceManagerRef.current = null;
    setVoiceStatus("idle");
    setIsVoiceMuted(initialMuted);
    setVoicePeerStatuses({});
    setRemoteAudioStreams({});
    setMessage(saved ? "" : "Room is open, but this tab couldn't save your session.");
    setIsConnected(false);

    const initializeVoice = async () => {
      if (voiceManagerRef.current) return;
      const roomSocket = socketRef.current;
      if (!roomSocket) return;
      setVoiceStatus("requesting");
      const manager = new VoicePeerManager({
        onSignal: (remoteParticipantId, signal) => {
          const socket = socketRef.current;
          if (!socket || socket !== roomSocket) {
            console.error("Cannot send voice signal: room connection is unavailable.");
            return;
          }
          try {
            sendVoiceSignal(socket, { ...signal, from: participantId, to: remoteParticipantId });
          } catch (error) {
            console.error("Could not send voice signal:", error);
            setVoiceStatus("denied");
          }
        },
        onRemoteStream: (remoteParticipantId, stream) => {
          setRemoteAudioStreams((current) => {
            if (!stream) {
              const next = { ...current };
              delete next[remoteParticipantId];
              return next;
            }
            return { ...current, [remoteParticipantId]: stream };
          });
        },
        onStatusChange: (remoteParticipantId, status) => {
          setVoicePeerStatuses((current) => ({ ...current, [remoteParticipantId]: status }));
        },
      });
      manager.setMuted(initialMuted);
      voiceManagerRef.current = manager;

      try {
        await manager.initialize();
        if (
          socketRef.current !== roomSocket ||
          roomSocket.readyState !== WebSocket.OPEN ||
          voiceManagerRef.current !== manager
        ) {
          manager.cleanup();
          if (voiceManagerRef.current === manager) voiceManagerRef.current = null;
          if (socketRef.current === roomSocket) setVoiceStatus("idle");
          return;
        }
        setVoiceStatus("ready");
        for (const remoteParticipantId of voiceParticipantIdsRef.current) {
          await manager.addParticipant(remoteParticipantId, participantId < remoteParticipantId);
        }
      } catch (error) {
        console.error("Could not initialize room voice:", error);
        manager.cleanup();
        if (voiceManagerRef.current === manager) {
          voiceManagerRef.current = null;
          setVoiceStatus("denied");
          setVoicePeerStatuses({});
          setRemoteAudioStreams({});
        }
      }
    };
    startVoiceRef.current = initializeVoice;

    const sendSignal = (to: string, signal: WebRTCSignalPayload) => {
      const socket = socketRef.current;
      if (!socket) throw new Error("Room connection is not available.");
      sendWebRTCSignal(socket, { ...signal, from: participantId, to });
    };

    const createPeer = (remoteParticipantId: string) => {
      const peerConnection = createPeerConnection(remoteParticipantId, {
        onIceCandidate: (candidate) => {
          try {
            sendSignal(remoteParticipantId, { type: "webrtc:ice-candidate", candidate });
          } catch (error) {
            console.error("Could not send WebRTC ICE candidate:", error);
            setMessage("Couldn't send a video connection candidate.");
          }
        },
        onTrack: (stream) => {
          if (!isHostRef.current) setRemoteStream(stream);
        },
      }, peerConnectionsRef.current);
      if (!pendingIceCandidatesRef.current.has(remoteParticipantId)) {
        pendingIceCandidatesRef.current.set(remoteParticipantId, []);
      }
      return peerConnection;
    };

    const addPendingIceCandidates = async (
      remoteParticipantId: string,
      peerConnection: RTCPeerConnection,
    ) => {
      const candidates = pendingIceCandidatesRef.current.get(remoteParticipantId) ?? [];
      pendingIceCandidatesRef.current.delete(remoteParticipantId);
      for (const candidate of candidates) {
        await addIceCandidate(peerConnection, candidate);
      }
    };

    const startHostOffer = async (remoteParticipantId: string) => {
      if (peerConnectionsRef.current.has(remoteParticipantId)) return;
      const peerConnection = createPeer(remoteParticipantId);
      peerConnection.addTransceiver("video", { direction: "sendonly" });
      peerConnection.addTransceiver("audio", { direction: "sendonly" });

      const capturedStream = capturedStreamRef.current;
      if (capturedStream) {
        for (const track of capturedStream.getTracks()) {
          const transceiver = peerConnection.getTransceivers().find(
            (candidate) => candidate.receiver.track.kind === track.kind,
          );
          if (transceiver) await transceiver.sender.replaceTrack(track);
        }
      }

      const offer = await createOffer(peerConnection);
      sendSignal(remoteParticipantId, { type: "webrtc:offer", offer });
    };

    const handleWebRTCEvent = async (event: RoomEvent) => {
      if (!event.from || event.to !== participantId) return;
      const remoteParticipantId = event.from;

      if (event.type === "webrtc:offer" && !isHostRef.current && event.offer) {
        if (peerConnectionsRef.current.has(remoteParticipantId)) return;
        if (!remoteParticipantId) throw new Error("WebRTC offer has no sender ID.");
        const peerConnection = createPeer(remoteParticipantId);
        await acceptOffer(peerConnection, event.offer);
        await addPendingIceCandidates(remoteParticipantId, peerConnection);
        const answer = await createAnswer(peerConnection);
        sendSignal(remoteParticipantId, { type: "webrtc:answer", answer });
      } else if (event.type === "webrtc:answer" && isHostRef.current && event.answer) {
        const peerConnection = peerConnectionsRef.current.get(remoteParticipantId);
        if (!peerConnection) return;
        await acceptAnswer(peerConnection, event.answer);
        await addPendingIceCandidates(remoteParticipantId, peerConnection);
      } else if (event.type === "webrtc:ice-candidate" && event.candidate) {
        const peerConnection = peerConnectionsRef.current.get(remoteParticipantId);
        if (!peerConnection?.remoteDescription) {
          const pending = pendingIceCandidatesRef.current.get(remoteParticipantId) ?? [];
          pending.push(event.candidate);
          pendingIceCandidatesRef.current.set(remoteParticipantId, pending);
        } else {
          await addIceCandidate(peerConnection, event.candidate);
        }
      }
    };

    socketRef.current = connectToRoom(
      roomId,
      participantId,
      participantName,
      (event: RoomEvent) => {
        if (event.type === "connected") {
          setIsConnected(true);
          return;
        }

        if (event.type === "room:error") {
          clearRoomSession();
          socketRef.current?.close();
          socketRef.current = null;
          cleanupAllPeerConnections();
          voiceManagerRef.current?.cleanup();
          voiceManagerRef.current = null;
          setActiveRoom(null);
          setIsHost(false);
          isHostRef.current = false;
          setCurrentParticipant(null);
          setParticipants([]);
          setVoiceStatus("idle");
          setVoicePeerStatuses({});
          setRemoteAudioStreams({});
          setMessage(typeof event.message === "string" ? event.message : "Could not reconnect to this room.");
          return;
        }

        if (event.type === "participant:joined" && typeof event.participantId === "string" && typeof event.name === "string") {
          const joined = { id: event.participantId, name: event.name };
          voiceParticipantIdsRef.current.add(joined.id);
          setParticipants((current) => current.some((participant) => participant.id === joined.id)
            ? current
            : [...current, joined]);
          const voiceManager = voiceManagerRef.current;
          if (voiceManager) {
            void voiceManager.addParticipant(joined.id, participantId < joined.id).catch((error: unknown) => {
              console.error("Could not add voice participant:", error);
            });
          }
          if (isHostRef.current && !peerConnectionsRef.current.has(joined.id)) {
            void startHostOffer(joined.id).catch((error: unknown) => {
              console.error("Could not start WebRTC offer:", error);
              setMessage(error instanceof Error ? error.message : "Couldn't start the video connection.");
            });
          }
        }

        if (event.type === "participant:left" && typeof event.participantId === "string") {
          const leftParticipantId = event.participantId;
          voiceParticipantIdsRef.current.delete(leftParticipantId);
          voiceManagerRef.current?.removeParticipant(leftParticipantId);
          setRemoteAudioStreams((current) => {
            const next = { ...current };
            delete next[leftParticipantId];
            return next;
          });
          setParticipants((current) => current.filter((participant) => participant.id !== leftParticipantId));
          if (peerConnectionsRef.current.has(leftParticipantId)) {
            cleanupPeerConnection(leftParticipantId, !isHostRef.current);
          }
        }

        if (
          event.type === "chat:message" &&
          typeof event.senderId === "string" &&
          typeof event.senderName === "string" &&
          typeof event.message === "string"
        ) {
          const senderId = event.senderId;
          const senderName = event.senderName;
          const chatMessage = event.message;
          setChatMessages((current) => [...current, {
            type: "chat:message",
            senderId,
            senderName,
            message: chatMessage,
            timestamp: typeof event.timestamp === "number" ? event.timestamp : Date.now(),
          }]);
        }

        if (event.type === "system:message" && typeof event.message === "string") {
          const systemMessage = event.message;
          setChatMessages((current) => [...current, {
            type: "system:message",
            message: systemMessage,
            timestamp: typeof event.timestamp === "number" ? event.timestamp : Date.now(),
          }]);
        }

        if (!isHostRef.current) {
          if (event.type === "playback:play") {
            pendingPlaybackRef.current = { ...pendingPlaybackRef.current, isPlaying: true };
            applyRemotePlayback();
          } else if (event.type === "playback:pause") {
            pendingPlaybackRef.current = { ...pendingPlaybackRef.current, isPlaying: false };
            applyRemotePlayback();
          } else if (
            event.type === "playback:seek" &&
            typeof event.currentTime === "number" &&
            Number.isFinite(event.currentTime)
          ) {
            pendingPlaybackRef.current = {
              ...pendingPlaybackRef.current,
              currentTime: event.currentTime,
            };
            applyRemotePlayback();
          }
        }

        if (event.type.startsWith("webrtc:")) {
          void handleWebRTCEvent(event).catch((error: unknown) => {
            console.error("WebRTC signaling failed:", error);
            setMessage(error instanceof Error ? error.message : "The video connection failed.");
          });
        }

        if (
          event.type.startsWith("voice:") &&
          event.to === participantId &&
          typeof event.from === "string"
        ) {
          const remoteParticipantId = event.from;
          const voiceManager = voiceManagerRef.current;
          if (!voiceManager) return;
          let signal: WebRTCVoiceSignalPayload | null = null;
          if (event.type === "voice:offer" && event.offer) {
            signal = { type: "voice:offer", offer: event.offer };
          } else if (event.type === "voice:answer" && event.answer) {
            signal = { type: "voice:answer", answer: event.answer };
          } else if (event.type === "voice:ice-candidate" && event.candidate) {
            signal = { type: "voice:ice-candidate", candidate: event.candidate };
          }
          if (signal) {
            void voiceManager.handleSignal(remoteParticipantId, signal).catch((error: unknown) => {
              console.error("Voice signaling failed:", error);
              setVoicePeerStatuses((current) => ({ ...current, [remoteParticipantId]: "failed" }));
            });
          }
        }
      },
      () => { void initializeVoice(); },
    );
  };

  useEffect(() => {
    if (!initialSession) return;

    let cancelled = false;
    const restoreSession = async () => {
      try {
        const response = await fetch(
          `${API_URL}/api/rooms/${encodeURIComponent(initialSession.roomId)}`,
        );

        if (!response.ok) {
          if (response.status === 404) {
            clearRoomSession();
            if (!cancelled) {
              setActiveRoom(null);
              setCurrentParticipant(null);
              setParticipants([]);
              setIsHost(false);
              isHostRef.current = false;
              setMessage("That room is no longer available. Create or join another room.");
            }
            return;
          }
          throw new Error("Could not restore the saved room.");
        }

        const room = await response.json() as RoomResponse["room"];
        if (room.id !== initialSession.roomId) {
          throw new Error("The saved room response did not match the requested room.");
        }
        const roomParticipants = Array.isArray(room.participants)
          ? room.participants.filter(isParticipant)
          : [];
        const participant = roomParticipants.find((item) => item.id === initialSession.participantId);

        if (!participant) {
          clearRoomSession();
          if (!cancelled) {
            setActiveRoom(null);
            setCurrentParticipant(null);
            setParticipants([]);
            setIsHost(false);
            isHostRef.current = false;
            setMessage("Your saved participant is no longer in this room. Join again to continue.");
          }
          return;
        }

        if (!cancelled) {
          const host = room.hostId === initialSession.participantId;
          enterRoom(
            room.id,
            initialSession.participantId,
            participant.name || initialSession.name,
            host,
          );
        }
      } catch (error) {
        console.error("Could not restore the saved room:", error);
        if (!cancelled) {
          enterRoom(
            initialSession.roomId,
            initialSession.participantId,
            initialSession.name,
            initialSession.role === "host",
          );
          setMessage("Couldn't refresh the room roster. Reconnecting with your saved identity.");
        }
      }
    };

    void restoreSession();
    return () => {
      cancelled = true;
    };
  }, [initialSession]);

  const createRoom = async () => {
    try {
      setIsLoading(true);
      setMessage("Creating your room...");

      const response = await fetch(`${API_URL}/api/rooms`, { method: "POST" });
      if (!response.ok) throw new Error("Failed to create room. Please try again.");

      const data = await response.json() as RoomResponse;
      enterRoom(data.room.id, data.participantId, "Host", true);
    } catch (error) {
      console.error(error);
      setMessage(error instanceof Error ? error.message : "Could not create room.");
    } finally {
      setIsLoading(false);
    }
  };

  const joinRoom = async () => {
    if (!roomCode.trim()) {
      setMessage("Enter a room code to join.");
      return;
    }
    if (!name.trim()) {
      setMessage("Add your name so everyone knows it's you.");
      return;
    }

    try {
      setIsLoading(true);
      setMessage("Finding your room...");
      const code = roomCode.trim().toUpperCase();
      const response = await fetch(`${API_URL}/api/rooms/${code}/join`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      const data = await response.json() as RoomResponse & { message?: string };
      if (!response.ok) throw new Error(data.message || "Failed to join room.");

      enterRoom(data.room.id, data.participantId, name.trim(), false);
    } catch (error) {
      console.error(error);
      setMessage(error instanceof Error ? error.message : "Could not join room.");
    } finally {
      setIsLoading(false);
    }
  };

  const copyRoomCode = async () => {
    if (!activeRoom) return;
    try {
      await navigator.clipboard.writeText(activeRoom);
      setMessage("Room code copied. Send it to your friends!");
    } catch (error) {
      console.error(error);
      setMessage("Couldn't copy the room code. You can select and copy it instead.");
    }
  };

  const leaveRoom = () => {
    clearRoomSession();
    mediaAnalysisIdRef.current++;
    if (document.fullscreenElement === watchStageRef.current) {
      void document.exitFullscreen().catch((error: unknown) => {
        console.error("Could not exit fullscreen while leaving the room:", error);
      });
    }
    socketRef.current?.close();
    socketRef.current = null;
    cleanupAllPeerConnections();
    voiceManagerRef.current?.cleanup();
    voiceManagerRef.current = null;
    voiceParticipantIdsRef.current.clear();
    startVoiceRef.current = null;
    capturedStreamRef.current?.getTracks().forEach((track) => track.stop());
    capturedStreamRef.current = null;
    if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
    videoUrlRef.current = null;
    setVideoUrl(null);
    setSelectedVideo(null);
    setMediaInfo(null);
    setIsAnalyzingMedia(false);
    setIsSettingsOpen(false);
    setSettingsSection(null);
    setSelectedQuality("Auto");
    setActiveRoom(null);
    setIsHost(false);
    isHostRef.current = false;
    setCurrentParticipant(null);
    setParticipants([]);
    setVoiceStatus("idle");
    setIsVoiceMuted(false);
    setVoicePeerStatuses({});
    setRemoteAudioStreams({});
    setChatMessages([]);
    setChatDraft("");
    setIsConnected(false);
    setMessage("");
  };

  const toggleVoiceMute = async () => {
    let manager = voiceManagerRef.current;
    if (!manager) {
      await startVoiceRef.current?.();
      manager = voiceManagerRef.current;
      if (manager) {
        setIsVoiceMuted(manager.isMuted());
      }
      return;
    }

    const muted = !manager.isMuted();
    manager.setMuted(muted);
    setIsVoiceMuted(muted);
    saveVoiceMuted(muted);
  };

  const toggleFullscreen = async () => {
    const container = watchStageRef.current;
    if (!container) return;
    try {
      if (document.fullscreenElement === container) {
        await document.exitFullscreen();
      } else {
        await container.requestFullscreen();
      }
    } catch (error) {
      console.error("Could not toggle fullscreen:", error);
      setMessage("Fullscreen isn't available in this browser.");
    }
  };

  const submitChatMessage = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const content = chatDraft.trim();
    const socket = socketRef.current;
    if (!content || !socket) return;

    try {
      sendChatMessage(socket, content);
      setChatDraft("");
    } catch (error) {
      console.error("Could not send chat message:", error);
      setMessage(error instanceof Error ? error.message : "Could not send chat message.");
    }
  };

  const selectVideo = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;

    if (!/\.(mp4|webm|mov|mkv)$/i.test(file.name)) {
      setMessage("Choose an MP4, WebM, MOV, or MKV video.");
      return;
    }

    const analysisId = ++mediaAnalysisIdRef.current;
    setMediaInfo(null);
    setIsAnalyzingMedia(true);
    setIsSettingsOpen(false);
    setSettingsSection(null);
    setSelectedQuality("Auto");
    for (const peerConnection of peerConnectionsRef.current.values()) {
      for (const transceiver of peerConnection.getTransceivers()) {
        if (transceiver.sender.track) {
          void transceiver.sender.replaceTrack(null).catch((error: unknown) => {
            console.error("Could not replace the shared video track:", error);
          });
        }
      }
    }
    capturedStreamRef.current?.getTracks().forEach((track) => track.stop());
    capturedStreamRef.current = null;
    if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
    const url = URL.createObjectURL(file);
    videoUrlRef.current = url;
    setSelectedVideo(file);
    setVideoUrl(url);
    setMessage("");
    void analyzeMedia(file)
      .then((info) => {
        if (mediaAnalysisIdRef.current === analysisId) setMediaInfo(info);
      })
      .catch((error: unknown) => {
        console.error("Could not analyze selected video:", error);
        if (mediaAnalysisIdRef.current === analysisId) {
          setMessage(error instanceof Error ? error.message : "Could not read the selected video's metadata.");
        }
      })
      .finally(() => {
        if (mediaAnalysisIdRef.current === analysisId) setIsAnalyzingMedia(false);
      });
  };

  const clearVideo = () => {
    mediaAnalysisIdRef.current++;
    setMediaInfo(null);
    setIsAnalyzingMedia(false);
    setIsSettingsOpen(false);
    setSettingsSection(null);
    setSelectedQuality("Auto");
    for (const peerConnection of peerConnectionsRef.current.values()) {
      for (const transceiver of peerConnection.getTransceivers()) {
        if (transceiver.sender.track) {
          void transceiver.sender.replaceTrack(null).catch((error: unknown) => {
            console.error("Could not stop sharing the video track:", error);
          });
        }
      }
    }
    capturedStreamRef.current?.getTracks().forEach((track) => track.stop());
    capturedStreamRef.current = null;
    if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
    videoUrlRef.current = null;
    setVideoUrl(null);
    setSelectedVideo(null);
  };

  const captureHostVideo = async () => {
    const video = localVideoRef.current;
    if (!video || !isHostRef.current) return;
    const capturableVideo = video as VideoElementWithCaptureStream;
    if (!capturableVideo.captureStream) {
      setMessage("Your browser doesn't support sharing video playback.");
      return;
    }

    try {
      const stream = capturableVideo.captureStream();
      capturedStreamRef.current = stream;
      for (const peerConnection of peerConnectionsRef.current.values()) {
        for (const track of stream.getTracks()) {
          const transceiver = peerConnection.getTransceivers().find(
            (candidate) => candidate.receiver.track.kind === track.kind,
          );
          if (transceiver) await transceiver.sender.replaceTrack(track);
        }
      }
    } catch (error) {
      console.error("Could not capture the selected video stream:", error);
      setMessage("This browser couldn't share the selected video's playback.");
    }
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#" onClick={(event) => {
          event.preventDefault();
          if (activeRoom) leaveRoom();
        }}>
          <BrandMark />
          <span>syncroom</span>
        </a>
        <div className="topbar-note"><span className="status-dot" /> Made for your next movie night</div>
      </header>

      {!activeRoom ? (
        <section className="landing">
          <div className="landing-copy">
            <div className="eyebrow"><span className="eyebrow-spark">✦</span> YOUR PEOPLE. YOUR PLAYLIST. YOUR PLACE.</div>
            <h1>Watch together.<br /><span>From anywhere.</span></h1>
            <p className="hero-description">Bring everyone a little closer with a room of your own. Pick a video, gather your people, and make a night of it.</p>
            <div className="feature-list">
              <span><span className="feature-check">✓</span> No downloads, just good company</span>
              <span><span className="feature-check">✓</span> Private rooms made for your group</span>
            </div>
            <div className="landing-art" aria-hidden="true">
              <div className="orbit orbit-one" />
              <div className="orbit orbit-two" />
              <div className="art-glow" />
              <div className="art-screen">
                <div className="art-screen-top"><span /><span /><span /></div>
                <div className="art-screen-content"><span className="art-play">▶</span></div>
                <div className="art-screen-bottom"><span /><span /></div>
              </div>
              <span className="float-star star-one">✦</span>
              <span className="float-star star-two">✧</span>
              <div className="art-avatar avatar-one">J</div>
              <div className="art-avatar avatar-two">M</div>
              <div className="art-avatar avatar-three">A</div>
              </div>
          </div>

          <section className="entry-card" aria-label="Create or join a room">
            <div className="card-heading">
              <span className="card-icon"><BrandMark /></span>
              <div>
                <h2>Your room is waiting</h2>
                <p>Start a watch party in seconds.</p>
              </div>
            </div>

            <button className="button button-primary create-button" onClick={createRoom} disabled={isLoading}>
              <span>{isLoading ? "Creating room..." : "Create a room"}</span>
              {!isLoading && <span className="button-arrow">↗</span>}
            </button>
            <div className="form-divider"><span>OR JOIN A FRIEND</span></div>

            <div className="join-form">
              <label htmlFor="display-name">Your name</label>
              <input
                id="display-name"
                type="text"
                placeholder="How should we call you?"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={32}
                autoComplete="name"
              />
              <label htmlFor="room-code">Room code</label>
              <input
                id="room-code"
                className="room-code-input"
                type="text"
                placeholder="e.g. 960FB1"
                value={roomCode}
                onChange={(event) => setRoomCode(event.target.value.toUpperCase())}
                onKeyDown={(event) => {
                  if (event.key === "Enter") void joinRoom();
                }}
                maxLength={6}
                autoCapitalize="characters"
                spellCheck={false}
              />
              <button className="button button-secondary" onClick={joinRoom} disabled={isLoading}>
                Join room <span aria-hidden="true">→</span>
              </button>
            </div>
            {message && <p className="form-message" role="status">{message}</p>}
            <p className="privacy-note"><span aria-hidden="true">♢</span> Your room is private, shared only by invite.</p>
          </section>
        </section>
      ) : (
        <section className="room-page">
          <div className="room-heading">
            <div>
              <button className="back-link" onClick={leaveRoom}>← <span>Leave room</span></button>
              <h1>It’s movie night<span className="heading-period">.</span></h1>
              <p className="room-subtitle">Get comfy, invite your friends, and enjoy the show.</p>
            </div>
            <div className="room-code-card">
              <div><span className="room-code-label">ROOM CODE</span><strong>{activeRoom}</strong></div>
              <button className="copy-button" onClick={copyRoomCode} aria-label="Copy room code" title="Copy room code">
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><rect x="7" y="6" width="9" height="11" rx="2" stroke="currentColor" strokeWidth="1.5" /><path d="M13 6V4.8A1.8 1.8 0 0 0 11.2 3H5.8A1.8 1.8 0 0 0 4 4.8v7.4A1.8 1.8 0 0 0 5.8 14H7" stroke="currentColor" strokeWidth="1.5" /></svg>
              </button>
            </div>
          </div>

          <div ref={watchStageRef} className={`watch-stage${isFullscreen ? " is-fullscreen" : ""}`}>
            <div className="watch-layout">
            <section className="watch-column">
              <div className="player-frame">
                {isHost && videoUrl ? (
                  <>
                    <video
                      ref={localVideoRef}
                      src={videoUrl}
                      controls
                      playsInline
                      preload="metadata"
                      onPlay={() => {
                        sendHostPlaybackEvent("playback:play");
                        void captureHostVideo();
                      }}
                      onPause={() => sendHostPlaybackEvent("playback:pause")}
                      onSeeked={(event) => sendHostPlaybackEvent("playback:seek", event.currentTarget.currentTime)}
                      aria-label={`Selected video: ${selectedVideo?.name ?? "local video"}`}
                      style={{ width: "100%", height: "100%", position: "absolute", inset: 0, objectFit: "contain", background: "#08080d" }}
                    />
                    {selectedVideo && (
                      <div className="selected-video-info">
                        <div className="selected-video-copy">
                          <span className="selected-video-name" title={selectedVideo.name}>{selectedVideo.name}</span>
                          <span className="selected-video-metadata">
                            {isAnalyzingMedia
                              ? "Analyzing media…"
                              : mediaInfo
                                ? `${mediaInfo.resolution} • ${formatMediaDuration(mediaInfo.duration)}`
                                : "Media details unavailable"}
                          </span>
                        </div>
                        <button className="invite-button" style={{ width: "auto", flex: "0 0 auto", margin: 0, padding: "7px 10px" }} onClick={clearVideo}>Clear video</button>
                      </div>
                    )}
                  </>
                ) : !isHost && remoteStream ? (
                  <video
                    ref={remoteVideoRef}
                    autoPlay
                    controls
                    playsInline
                    aria-label="Video shared by the host"
                    style={{ width: "100%", height: "100%", position: "absolute", inset: 0, objectFit: "contain", background: "#08080d" }}
                  />
                ) : (
                  <>
                    <div className="player-vignette" />
                    <div className="player-message">
                      <div className="player-icon"><BrandMark /></div>
                      <span className="player-kicker">YOUR PRIVATE WATCH ROOM</span>
                      <h2>Your room is ready<br />for its first movie night.</h2>
                      <p>{isHost
                        ? "Your selected video isn't available after a refresh. Select it again to resume sharing."
                        : "Invite your friends with the room code and settle in together."}</p>
                      {isHost ? (
                        <label className="button button-player" style={{ cursor: "pointer" }}>
                          <span>↑</span> Select video
                          <input
                            type="file"
                            accept="video/mp4,video/webm,video/quicktime,video/x-matroska,.mp4,.webm,.mov,.mkv"
                            onChange={selectVideo}
                            aria-label="Select a video file"
                            style={{ display: "none" }}
                          />
                        </label>
                      ) : (
                        <button className="button button-player" onClick={copyRoomCode}>
                          <span>↗</span> Copy room code
                        </button>
                      )}
                    </div>
                    <span className="player-live"><span /> ROOM READY</span>
                  </>
                )}
                <div className="player-toolbar">
                  <span className="stage-people-count" aria-label={`${participants.length} people in room`} title={`${participants.length} people in room`}>
                    <span aria-hidden="true">👤</span><span>{participants.length}</span>
                  </span>
                  <button
                    className={`stage-control-button voice-icon-button${isVoiceMuted ? " is-muted" : ""}${voiceStatus === "denied" ? " is-unavailable" : ""}`}
                    onClick={() => void toggleVoiceMute()}
                    aria-label={isVoiceMuted ? "Unmute microphone" : "Mute microphone"}
                    title={voiceStatus === "denied" ? "Retry microphone access" : isVoiceMuted ? "Unmute microphone" : "Mute microphone"}
                  >
                    {isVoiceMuted ? "🔇" : "🎤"}
                  </button>
                  <button
                    className="stage-control-button chat-toggle"
                    onClick={() => {
                      setIsChatOpen((open) => !open);
                      setIsSettingsOpen(false);
                    }}
                    aria-expanded={isChatOpen}
                    aria-label={isChatOpen ? "Close chat" : "Open chat"}
                  >
                    💬{chatMessages.length > 0 && <span className="chat-unread-dot" />}
                  </button>
                  {isHost && videoUrl && (
                    <button
                      className={`stage-control-button settings-toggle${isSettingsOpen ? " is-active" : ""}`}
                      onClick={() => {
                        setIsSettingsOpen((open) => !open);
                        setIsChatOpen(false);
                        setSettingsSection(null);
                      }}
                      aria-label="Video settings"
                      aria-expanded={isSettingsOpen}
                      title="Video settings"
                    >
                      ⚙
                    </button>
                  )}
                  <button className="stage-control-button fullscreen-toggle" onClick={() => void toggleFullscreen()}>
                    {isFullscreen ? "Exit" : "⛶ Fullscreen"}
                  </button>
                </div>
                {isSettingsOpen && isHost && videoUrl && (
                  <section className="settings-menu" aria-label="Video settings">
                    {settingsSection === null ? (
                      <>
                        <h2>Settings</h2>
                        <button className="settings-menu-item" onClick={() => setSettingsSection("quality")}>
                          <span>Quality</span><span aria-hidden="true">›</span>
                        </button>
                        <button className="settings-menu-item" onClick={() => setSettingsSection("audio")}>
                          <span>Audio</span><span aria-hidden="true">›</span>
                        </button>
                        <button className="settings-menu-item" onClick={() => setSettingsSection("subtitles")}>
                          <span>Subtitles</span><span aria-hidden="true">›</span>
                        </button>
                      </>
                    ) : (
                      <>
                        <button className="settings-menu-back" onClick={() => setSettingsSection(null)}>
                          <span aria-hidden="true">‹</span> Settings
                        </button>
                        <h2>{settingsSection === "quality" ? "Quality" : settingsSection === "audio" ? "Audio" : "Subtitles"}</h2>
                        {settingsSection === "quality" ? (
                          mediaInfo ? getQualityOptions(mediaInfo).map((quality) => (
                            <button
                              className="settings-menu-item settings-quality-item"
                              key={quality}
                              onClick={() => setSelectedQuality(quality)}
                            >
                              <span className="settings-quality-check">{selectedQuality === quality ? "✓" : ""}</span>
                              <span>{quality}</span>
                            </button>
                          )) : (
                            <p className="settings-unavailable">{isAnalyzingMedia ? "Analyzing video…" : "Video quality is unavailable."}</p>
                          )
                        ) : (
                          <p className="settings-unavailable">Coming soon</p>
                        )}
                      </>
                    )}
                  </section>
                )}
                <section className={`chat-panel${isChatOpen ? " chat-panel-open" : ""}`} aria-label="Room chat" aria-hidden={!isChatOpen}>
                  <div className="chat-heading">
                    <div><h2>Chat</h2></div>
                    <button className="chat-close" onClick={() => setIsChatOpen(false)} aria-label="Close chat" tabIndex={isChatOpen ? 0 : -1}>×</button>
                  </div>
                  <div className="chat-messages" aria-live="polite" aria-relevant="additions">
                    {chatMessages.length === 0 ? (
                      <p className="chat-empty">No messages yet. Start the conversation!</p>
                    ) : chatMessages.map((item, index) => item.type === "system:message" ? (
                      <div className="chat-system-message" key={`${item.timestamp}-${index}`}>
                        <span className="chat-system-sender">System</span>
                        <p>{item.message}</p>
                      </div>
                    ) : (
                      <div
                        className={`chat-message${item.senderId === currentParticipant?.id ? " chat-message-own" : ""}`}
                        key={`${item.timestamp}-${index}`}
                      >
                        <span className="chat-sender">{item.senderName}</span>
                        <p>{item.message}</p>
                        <time dateTime={new Date(item.timestamp).toISOString()}>
                          {new Date(item.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
                        </time>
                      </div>
                    ))}
                    <div ref={chatMessagesEndRef} />
                  </div>
                  <form className="chat-form" onSubmit={submitChatMessage}>
                    <input
                      type="text"
                      aria-label="Chat message"
                      placeholder="Write a message..."
                      value={chatDraft}
                      onChange={(event) => setChatDraft(event.target.value)}
                      maxLength={1000}
                      autoComplete="off"
                      tabIndex={isChatOpen ? 0 : -1}
                    />
                    <button type="submit" disabled={!chatDraft.trim()} aria-label="Send message" tabIndex={isChatOpen ? 0 : -1}>
                      <span>Send</span><span aria-hidden="true">↑</span>
                    </button>
                  </form>
                </section>
                <div className="remote-audio-streams" aria-hidden="true">
                  {Object.entries(remoteAudioStreams).map(([participantId, stream]) => (
                    <RemoteAudio
                      key={participantId}
                      stream={stream}
                      participantName={participants.find((participant) => participant.id === participantId)?.name ?? "Participant"}
                    />
                  ))}
                </div>
              </div>
              {message && <p className="room-message" role="status">{message}</p>}
              <div className="watch-caption">
                <div><span className="caption-icon">✦</span><div><strong>Good times are better together</strong><p>Everyone in the room can hang out while you watch.</p></div></div>
                <span className="connection-state"><span className={isConnected ? "status-dot" : "status-dot status-dot-muted"} />{isConnected ? "Connected" : "Connecting"}</span>
              </div>
            </section>

            <aside className="people-card">
              <div className="people-card-heading">
                <div><h2>People here</h2><p>Your watch party crew</p></div>
                <span className="people-count">{participants.length}</span>
              </div>
              <div className="participant-list">
                {participants.map((participant, index) => (
                  <div className="participant-row" key={participant.id}>
                    <span className={`participant-avatar avatar-color-${index % 5}`}>{participant.name.trim().charAt(0).toUpperCase() || "?"}</span>
                    <span className="participant-name">{participant.name}{participant.id === currentParticipant?.id && <span className="you-label">YOU</span>}</span>
                    <span
                      className={`voice-indicator${participant.id === currentParticipant?.id
                        ? isVoiceMuted ? " voice-muted" : voiceStatus === "ready" ? " voice-connected" : ""
                        : voicePeerStatuses[participant.id] === "connected" ? " voice-connected" : ""}`}
                      title={participant.id === currentParticipant?.id
                        ? isVoiceMuted ? "Microphone muted" : voiceStatus === "ready" ? "Microphone on" : "Microphone unavailable"
                        : voicePeerStatuses[participant.id] === "connected" ? "Voice connected" : "Voice connecting"}
                      aria-label={participant.id === currentParticipant?.id && isVoiceMuted ? "Microphone muted" : "Voice status"}
                    >
                      {participant.id === currentParticipant?.id && isVoiceMuted ? "×" : "🎤"}
                    </span>
                    <span className="participant-online" aria-label="In room" />
                  </div>
                ))}
                {participants.length === 0 && <p className="empty-people">Waiting for your crew to join…</p>}
              </div>
              <div className="invite-panel">
                <span className="invite-icon">↗</span>
                <strong>More the merrier</strong>
                <p>Share your room code and save them a seat.</p>
                <button className="invite-button" onClick={copyRoomCode}>Copy invite code <span>→</span></button>
              </div>
              <div className="room-security"><span>♢</span> Only people with your code can join.</div>
            </aside>
          </div>
          </div>
          <footer className="room-footer"><span><BrandMark /> syncroom</span><span>Made for being together, wherever.</span></footer>
        </section>
      )}
    </main>
  );
}

export default App;
