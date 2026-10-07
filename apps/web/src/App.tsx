import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { connectToRoom, type RoomEvent } from "./services/socket";
import "./App.css";

const API_URL = "http://localhost:5000";

type Participant = {
  id: string;
  name: string;
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

function App() {
  const [roomCode, setRoomCode] = useState("");
  const [name, setName] = useState("");
  const [activeRoom, setActiveRoom] = useState<string | null>(null);
  const [isHost, setIsHost] = useState(false);
  const [currentParticipant, setCurrentParticipant] = useState<Participant | null>(null);
  const [participants, setParticipants] = useState<Participant[]>([]);
  const [selectedVideo, setSelectedVideo] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const socketRef = useRef<WebSocket | null>(null);
  const videoUrlRef = useRef<string | null>(null);

  useEffect(() => () => {
    socketRef.current?.close();
    if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
  }, []);

  const enterRoom = (
    roomId: string,
    participantId: string,
    participantName: string,
    roster: Participant[],
  ) => {
    const self = { id: participantId, name: participantName };
    setActiveRoom(roomId);
    setIsHost(false);
    setCurrentParticipant(self);
    setParticipants(roster.some((participant) => participant.id === participantId)
      ? roster
      : [...roster, self]);
    setMessage("");
    setIsConnected(false);

    socketRef.current = connectToRoom(
      roomId,
      participantId,
      participantName,
      (event: RoomEvent) => {
        if (event.type === "connected") {
          setIsConnected(true);
          return;
        }

        if (event.type === "participant:joined" && typeof event.participantId === "string" && typeof event.name === "string") {
          const joined = { id: event.participantId, name: event.name };
          setParticipants((current) => current.some((participant) => participant.id === joined.id)
            ? current
            : [...current, joined]);
        }

        if (event.type === "participant:left" && typeof event.participantId === "string") {
          setParticipants((current) => current.filter((participant) => participant.id !== event.participantId));
        }
      },
    );
  };

  const createRoom = async () => {
    try {
      setIsLoading(true);
      setMessage("Creating your room...");

      const response = await fetch(`${API_URL}/api/rooms`, { method: "POST" });
      if (!response.ok) throw new Error("Failed to create room. Please try again.");

      const data = await response.json() as RoomResponse;
      const roomParticipants = Array.isArray(data.room.participants)
        ? data.room.participants.filter(isParticipant)
        : [];
      enterRoom(data.room.id, data.participantId, "Host", roomParticipants);
      setIsHost(data.room.hostId === data.participantId);
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

      const roomParticipants = Array.isArray(data.room.participants)
        ? data.room.participants.filter(isParticipant)
        : [];
      enterRoom(data.room.id, data.participantId, name.trim(), roomParticipants);
      setIsHost(data.room.hostId === data.participantId);
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
    socketRef.current?.close();
    socketRef.current = null;
    if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
    videoUrlRef.current = null;
    setVideoUrl(null);
    setSelectedVideo(null);
    setActiveRoom(null);
    setIsHost(false);
    setCurrentParticipant(null);
    setParticipants([]);
    setIsConnected(false);
    setMessage("");
  };

  const selectVideo = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;

    if (!/\.(mp4|webm|mov|mkv)$/i.test(file.name)) {
      setMessage("Choose an MP4, WebM, MOV, or MKV video.");
      return;
    }

    if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
    const url = URL.createObjectURL(file);
    videoUrlRef.current = url;
    setSelectedVideo(file);
    setVideoUrl(url);
    setMessage("");
  };

  const clearVideo = () => {
    if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
    videoUrlRef.current = null;
    setVideoUrl(null);
    setSelectedVideo(null);
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

          <div className="watch-layout">
            <section className="watch-column">
              <div className="player-frame">
                {videoUrl ? (
                  <>
                    <video
                      src={videoUrl}
                      controls
                      playsInline
                      preload="metadata"
                      aria-label={`Selected video: ${selectedVideo?.name ?? "local video"}`}
                      style={{ width: "100%", height: "100%", position: "absolute", inset: 0, objectFit: "contain", background: "#08080d" }}
                    />
                    {isHost && selectedVideo && (
                      <div style={{ position: "absolute", zIndex: 2, top: 16, right: 16, left: 16, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "8px 10px", border: "1px solid rgba(255,255,255,.12)", borderRadius: 8, background: "rgba(13,13,18,.82)" }}>
                        <span title={selectedVideo.name} style={{ minWidth: 0, overflow: "hidden", color: "#eeeaf5", fontSize: 11, textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selectedVideo.name}</span>
                        <button className="invite-button" style={{ width: "auto", flex: "0 0 auto", margin: 0, padding: "7px 10px" }} onClick={clearVideo}>Clear video</button>
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <div className="player-vignette" />
                    <div className="player-message">
                      <div className="player-icon"><BrandMark /></div>
                      <span className="player-kicker">YOUR PRIVATE WATCH ROOM</span>
                      <h2>Your room is ready<br />for its first movie night.</h2>
                      <p>Invite your friends with the room code and settle in together.</p>
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
          <footer className="room-footer"><span><BrandMark /> syncroom</span><span>Made for being together, wherever.</span></footer>
        </section>
      )}
    </main>
  );
}

export default App;
