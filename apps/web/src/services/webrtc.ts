export type WebRTCCallbacks = {
  onIceCandidate: (candidate: RTCIceCandidateInit) => void;
  onTrack: (stream: MediaStream) => void;
};

export type PeerConnections = Map<string, RTCPeerConnection>;

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
