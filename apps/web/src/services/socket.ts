export type RoomEvent = {
  type: string;
  fromParticipantId?: string;
  offer?: RTCSessionDescriptionInit;
  answer?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  [key: string]: unknown;
};

export type WebRTCSignalMessage =
  | { type: "webrtc:offer"; offer: RTCSessionDescriptionInit }
  | { type: "webrtc:answer"; answer: RTCSessionDescriptionInit }
  | { type: "webrtc:ice-candidate"; candidate: RTCIceCandidateInit };

export function connectToRoom(
  roomId: string,
  participantId: string,
  name: string,
  onMessage: (event: RoomEvent) => void
) {
  const socket = new WebSocket(
    `ws://localhost:5000/ws/rooms/${roomId}`
  );

  socket.onopen = () => {
    console.log(`Connected to room ${roomId}`);

    socket.send(
      JSON.stringify({
        type: "participant:join",
        participantId,
        name,
      })
    );
  };

  socket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      onMessage(data);
    } catch {
      console.error("Invalid WebSocket message");
    }
  };

  socket.onclose = () => {
    console.log(`Disconnected from room ${roomId}`);
  };

  socket.onerror = (error) => {
    console.error("WebSocket error:", error);
  };

  return socket;
}

export function sendWebRTCSignal(
  socket: WebSocket,
  message: WebRTCSignalMessage,
) {
  if (socket.readyState !== WebSocket.OPEN) {
    throw new Error("Cannot send WebRTC signal: room connection is not open.");
  }

  socket.send(JSON.stringify(message));
}
