import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";

type ParticipantConnection = {
  socket: WebSocket;
  participantId: string;
  name: string;
};

const roomConnections = new Map<
  string,
  Set<ParticipantConnection>
>();

export async function roomSocket(app: FastifyInstance) {
  app.get(
    "/ws/rooms/:roomId",
    { websocket: true },
    (socket, request) => {
      const { roomId } = request.params as { roomId: string };

      if (!roomConnections.has(roomId)) {
        roomConnections.set(roomId, new Set());
      }

      const connections = roomConnections.get(roomId)!;

      let participant: ParticipantConnection | null = null;

      console.log(`WebSocket connected to room ${roomId}`);

      socket.send(
        JSON.stringify({
          type: "connected",
          roomId,
        })
      );

      socket.on("message", (message) => {
        try {
          const data = JSON.parse(message.toString());

          if (data.type === "participant:join") {
            participant = {
              socket,
              participantId: data.participantId,
              name: data.name,
            };

            connections.add(participant);

            console.log(
              `${data.name} joined room ${roomId}`
            );

            for (const client of connections) {
              if (client.socket !== socket && client.socket.readyState === 1) {
                client.socket.send(
                  JSON.stringify({
                    type: "participant:joined",
                    participantId: data.participantId,
                    name: data.name,
                  })
                );
              }
            }
          } else if (
            participant &&
            (data.type === "webrtc:offer" ||
              data.type === "webrtc:answer" ||
              data.type === "webrtc:ice-candidate") &&
            typeof data.to === "string"
          ) {
            const target = [...connections].find(
              (client) => client.participantId === data.to,
            );
            if (target && target.socket !== socket && target.socket.readyState === 1) {
              target.socket.send(
                JSON.stringify({
                  ...data,
                  from: participant.participantId,
                })
              );
            }
          }
        } catch {
          console.error("Invalid WebSocket message");
        }
      });

      socket.on("close", () => {
        if (participant) {
          connections.delete(participant);

          console.log(
            `${participant.name} left room ${roomId}`
          );

          for (const client of connections) {
            if (client.socket.readyState === 1) {
              client.socket.send(
                JSON.stringify({
                  type: "participant:left",
                  participantId: participant.participantId,
                  name: participant.name,
                })
              );
            }
          }
        }

        console.log(
          `WebSocket disconnected from room ${roomId}`
        );

        if (connections.size === 0) {
          roomConnections.delete(roomId);
        }
      });
    }
  );
}