export type RoomEvent = {
  type: string;
  from?: string;
  to?: string;
  senderId?: string;
  senderName?: string;
  message?: string;
  timestamp?: number;
  currentTime?: number;
  offer?: RTCSessionDescriptionInit;
  answer?: RTCSessionDescriptionInit;
  candidate?: RTCIceCandidateInit;
  voice?: boolean;
  [key: string]: unknown;
};

export type WebRTCSignalPayload =
  | { type: "webrtc:offer"; offer: RTCSessionDescriptionInit }
  | { type: "webrtc:answer"; answer: RTCSessionDescriptionInit }
  | { type: "webrtc:ice-candidate"; candidate: RTCIceCandidateInit };

export type WebRTCSignalMessage = WebRTCSignalPayload & {
  from: string;
  to: string;
};

export type VoiceSignalMessage = VoiceSignalPayload & {
  from: string;
  to: string;
};

export type VoiceSignalPayload =
  | { type: "voice:offer"; offer: RTCSessionDescriptionInit }
  | { type: "voice:answer"; answer: RTCSessionDescriptionInit }
  | { type: "voice:ice-candidate"; candidate: RTCIceCandidateInit };

export type ChatMessagePayload = {
  type: "chat:message";
  message: string;
};

export type SystemMessagePayload = {
  type: "system:message";
  message: string;
};

export function connectToRoom(
  roomId: string,
  participantId: string,
  name: string,
  onMessage: (event: RoomEvent) => void,
  onOpen?: () => void,
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
    onOpen?.();
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

export function sendVoiceSignal(
  socket: WebSocket,
  message: VoiceSignalMessage,
): void {
  if (socket.readyState !== WebSocket.OPEN) {
    throw new Error("Cannot send voice signal: room connection is not open.");
  }

  socket.send(JSON.stringify(message));
}

export function sendChatMessage(
  socket: WebSocket,
  message: string,
): void {
  if (socket.readyState !== WebSocket.OPEN) {
    throw new Error("Cannot send chat message: room connection is not open.");
  }

  const payload: ChatMessagePayload = { type: "chat:message", message };
  socket.send(JSON.stringify(payload));
}

export function sendSystemMessage(
  socket: WebSocket,
  message: string,
): void {
  if (socket.readyState !== WebSocket.OPEN) {
    throw new Error("Cannot send system message: room connection is not open.");
  }

  const payload: SystemMessagePayload = { type: "system:message", message };
  socket.send(JSON.stringify(payload));
}
