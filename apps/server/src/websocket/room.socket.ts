import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { getRoom } from "../modules/rooms/room.service.js";

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
            const room = getRoom(roomId);
            const returningParticipant = room?.participants.find(
              (candidate) => candidate.id === data.participantId,
            );
            if (
              !returningParticipant ||
              typeof data.participantId !== "string" ||
              typeof data.name !== "string"
            ) {
              socket.send(JSON.stringify({
                type: "room:error",
                message: "This participant is not registered in the room.",
              }));
              socket.close(1008, "Unknown room participant");
              return;
            }

            const existingConnection = [...connections].find(
              (client) => client.participantId === returningParticipant.id,
            );
            if (existingConnection?.socket === socket) {
              participant = existingConnection;
              return;
            }
            const previousConnection = existingConnection;
            if (previousConnection) {
              connections.delete(previousConnection);
              for (const client of connections) {
                if (client.socket.readyState === 1) {
                  client.socket.send(JSON.stringify({
                    type: "participant:left",
                    participantId: previousConnection.participantId,
                    name: previousConnection.name,
                  }));
                }
              }
            }

            participant = {
              socket,
              participantId: returningParticipant.id,
              name: returningParticipant.name,
            };

            connections.add(participant);
            previousConnection?.socket.close(4001, "Participant reconnected");

            console.log(`${participant.name} ${previousConnection ? "reconnected to" : "joined"} room ${roomId}`);

            for (const client of connections) {
              if (client.socket !== socket && client.socket.readyState === 1) {
                client.socket.send(
                  JSON.stringify({
                    type: "participant:joined",
                    participantId: participant.participantId,
                    name: participant.name,
                  })
                );
                if (!previousConnection) {
                  client.socket.send(
                    JSON.stringify({
                      type: "system:message",
                      message: `${participant.name} joined the room`,
                      timestamp: Date.now(),
                    })
                  );
                }
              }
            }
            for (const client of connections) {
              if (client.socket !== socket && client.socket.readyState === 1) {
                socket.send(JSON.stringify({
                  type: "participant:joined",
                  participantId: client.participantId,
                  name: client.name,
                }));
              }
            }
            if (!previousConnection && socket.readyState === 1) {
              socket.send(
                JSON.stringify({
                  type: "system:message",
                  message: `${participant.name} joined the room`,
                  timestamp: Date.now(),
                })
              );
            }
          } else if (
            participant &&
            (data.type === "webrtc:offer" ||
              data.type === "webrtc:answer" ||
              data.type === "webrtc:ice-candidate" ||
              data.type === "voice:offer" ||
              data.type === "voice:answer" ||
              data.type === "voice:ice-candidate") &&
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
          } else if (
            participant &&
            (data.type === "chat:message" || data.type === "system:message") &&
            typeof data.message === "string" &&
            data.message.trim().length > 0
          ) {
            const payload = JSON.stringify(
              data.type === "chat:message"
                ? {
                    type: "chat:message",
                    senderId: participant.participantId,
                    senderName: participant.name,
                    message: data.message.trim().slice(0, 1000),
                    timestamp: Date.now(),
                  }
                : {
                    type: "system:message",
                    message: data.message.trim().slice(0, 500),
                    timestamp: Date.now(),
                  }
            );

            for (const client of connections) {
              if (client.socket.readyState === 1) client.socket.send(payload);
            }
          }
        } catch {
          console.error("Invalid WebSocket message");
        }
      });

      socket.on("close", () => {
        if (participant && connections.delete(participant)) {

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
              client.socket.send(
                JSON.stringify({
                  type: "system:message",
                  message: `${participant.name} left the room`,
                  timestamp: Date.now(),
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