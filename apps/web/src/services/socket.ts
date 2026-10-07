export type RoomEvent = {
  type: string;
  [key: string]: unknown;
};

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