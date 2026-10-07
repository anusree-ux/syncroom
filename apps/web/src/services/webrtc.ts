export type WebRTCCallbacks = {
  onIceCandidate: (candidate: RTCIceCandidateInit) => void;
  onTrack: (stream: MediaStream) => void;
};

export type PeerConnections = Map<string, RTCPeerConnection>;

export type VoiceSignalPayload =
  | { type: "voice:offer"; offer: RTCSessionDescriptionInit }
  | { type: "voice:answer"; answer: RTCSessionDescriptionInit }
  | { type: "voice:ice-candidate"; candidate: RTCIceCandidateInit };

export type VoicePeerStatus = "connecting" | "connected" | "disconnected" | "failed";

export type VoicePeerCallbacks = {
  onSignal: (participantId: string, signal: VoiceSignalPayload) => void;
  onRemoteStream: (participantId: string, stream: MediaStream | null) => void;
  onStatusChange: (participantId: string, status: VoicePeerStatus) => void;
};

export class VoicePeerManager {
  private readonly peerConnections: PeerConnections = new Map();
  private readonly pendingCandidates = new Map<string, RTCIceCandidateInit[]>();
  private localStream: MediaStream | null = null;
  private initialization: Promise<MediaStream> | null = null;
  private muted = false;
  private readonly callbacks: VoicePeerCallbacks;

  constructor(callbacks: VoicePeerCallbacks) {
    this.callbacks = callbacks;
  }

  async initialize(): Promise<MediaStream> {
    if (this.localStream) return this.localStream;
    if (!this.initialization) {
      this.initialization = navigator.mediaDevices.getUserMedia({ audio: true })
        .then((stream) => {
          this.localStream = stream;
          for (const track of stream.getAudioTracks()) track.enabled = !this.muted;
          return stream;
        })
        .catch((error: unknown) => {
          this.initialization = null;
          throw error;
        });
    }
    return this.initialization;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    for (const track of this.localStream?.getAudioTracks() ?? []) {
      track.enabled = !muted;
    }
  }

  isMuted(): boolean {
    return this.muted;
  }

  async addParticipant(participantId: string, initiateOffer: boolean): Promise<void> {
    if (!this.localStream) throw new Error("Initialize the microphone before adding voice participants.");
    if (this.peerConnections.has(participantId)) return;

    const peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    this.peerConnections.set(participantId, peerConnection);
    this.pendingCandidates.set(participantId, []);
    this.callbacks.onStatusChange(participantId, "connecting");

    for (const track of this.localStream.getAudioTracks()) {
      peerConnection.addTrack(track, this.localStream);
    }

    const receivedStream = new MediaStream();
    peerConnection.onicecandidate = (event) => {
      if (!event.candidate) return;
      this.callbacks.onSignal(participantId, {
        type: "voice:ice-candidate",
        candidate: event.candidate.toJSON(),
      });
    };

    peerConnection.ontrack = (event) => {
      if (event.streams[0]) {
        this.callbacks.onRemoteStream(participantId, event.streams[0]);
        return;
      }
      if (!receivedStream.getTracks().some((track) => track.id === event.track.id)) {
        receivedStream.addTrack(event.track);
      }
      this.callbacks.onRemoteStream(participantId, receivedStream);
    };

    peerConnection.onconnectionstatechange = () => {
      const state = peerConnection.connectionState;
      if (state === "connected" || state === "disconnected" || state === "failed") {
        this.callbacks.onStatusChange(participantId, state);
      }
    };

    if (initiateOffer) {
      try {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        if (!peerConnection.localDescription) {
          throw new Error("Failed to create the local voice offer.");
        }
        this.callbacks.onSignal(participantId, {
          type: "voice:offer",
          offer: peerConnection.localDescription.toJSON(),
        });
      } catch (error) {
        this.removeParticipant(participantId);
        this.callbacks.onStatusChange(participantId, "failed");
        throw error;
      }
    }
  }

  async handleSignal(participantId: string, signal: VoiceSignalPayload): Promise<void> {
    if (!this.localStream) await this.initialize();

    if (signal.type === "voice:offer") {
      if (!this.peerConnections.has(participantId)) {
        await this.addParticipant(participantId, false);
      }
      const peerConnection = this.peerConnections.get(participantId);
      if (!peerConnection) return;
      await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.offer));
      await this.applyPendingCandidates(participantId, peerConnection);
      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      if (!peerConnection.localDescription) {
        throw new Error("Failed to create the local voice answer.");
      }
      this.callbacks.onSignal(participantId, {
        type: "voice:answer",
        answer: peerConnection.localDescription.toJSON(),
      });
      return;
    }

    if (signal.type === "voice:answer") {
      const peerConnection = this.peerConnections.get(participantId);
      if (!peerConnection) return;
      await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.answer));
      await this.applyPendingCandidates(participantId, peerConnection);
      return;
    }

    let peerConnection = this.peerConnections.get(participantId);
    if (!peerConnection) {
      await this.addParticipant(participantId, false);
      peerConnection = this.peerConnections.get(participantId);
    }
    if (!peerConnection) return;

    if (!peerConnection.remoteDescription) {
      const candidates = this.pendingCandidates.get(participantId) ?? [];
      candidates.push(signal.candidate);
      this.pendingCandidates.set(participantId, candidates);
    } else {
      await peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate));
    }
  }

  removeParticipant(participantId: string): void {
    closePeerConnection(this.peerConnections, participantId);
    this.pendingCandidates.delete(participantId);
    this.callbacks.onRemoteStream(participantId, null);
    this.callbacks.onStatusChange(participantId, "disconnected");
  }

  cleanup(): void {
    closeAllPeerConnections(this.peerConnections);
    this.pendingCandidates.clear();
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.localStream = null;
    this.initialization = null;
  }

  private async applyPendingCandidates(
    participantId: string,
    peerConnection: RTCPeerConnection,
  ): Promise<void> {
    const candidates = this.pendingCandidates.get(participantId) ?? [];
    this.pendingCandidates.delete(participantId);
    for (const candidate of candidates) {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }
}

const ICE_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
];

export function createPeerConnection(
  participantId: string,
  callbacks: WebRTCCallbacks,
  peerConnections: PeerConnections,
): RTCPeerConnection {
  closePeerConnection(peerConnections, participantId);
  const peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const receivedStream = new MediaStream();

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) callbacks.onIceCandidate(event.candidate.toJSON());
  };

  peerConnection.ontrack = (event) => {
    const stream = event.streams[0];
    if (stream) {
      callbacks.onTrack(stream);
      return;
    }

    if (!receivedStream.getTracks().some((track) => track.id === event.track.id)) {
      receivedStream.addTrack(event.track);
    }
    callbacks.onTrack(receivedStream);
  };

  peerConnections.set(participantId, peerConnection);
  return peerConnection;
}

export function closePeerConnection(
  peerConnections: PeerConnections,
  participantId: string,
): void {
  const peerConnection = peerConnections.get(participantId);
  if (!peerConnection) return;

  peerConnection.onicecandidate = null;
  peerConnection.ontrack = null;
  peerConnection.close();
  peerConnections.delete(participantId);
}

export function closeAllPeerConnections(peerConnections: PeerConnections): void {
  for (const participantId of peerConnections.keys()) {
    closePeerConnection(peerConnections, participantId);
  }
}

export async function createOffer(
  peerConnection: RTCPeerConnection,
): Promise<RTCSessionDescriptionInit> {
  const offer = await peerConnection.createOffer();
  await peerConnection.setLocalDescription(offer);
  if (!peerConnection.localDescription) {
    throw new Error("Failed to create the local WebRTC offer.");
  }
  return peerConnection.localDescription.toJSON();
}

export async function acceptOffer(
  peerConnection: RTCPeerConnection,
  offer: RTCSessionDescriptionInit,
): Promise<void> {
  await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
}

export async function createAnswer(
  peerConnection: RTCPeerConnection,
): Promise<RTCSessionDescriptionInit> {
  const answer = await peerConnection.createAnswer();
  await peerConnection.setLocalDescription(answer);
  if (!peerConnection.localDescription) {
    throw new Error("Failed to create the local WebRTC answer.");
  }
  return peerConnection.localDescription.toJSON();
}

export async function acceptAnswer(
  peerConnection: RTCPeerConnection,
  answer: RTCSessionDescriptionInit,
): Promise<void> {
  await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
}

export async function addIceCandidate(
  peerConnection: RTCPeerConnection,
  candidate: RTCIceCandidateInit,
): Promise<void> {
  await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
}
