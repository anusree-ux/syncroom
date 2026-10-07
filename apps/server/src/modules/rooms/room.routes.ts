import type { FastifyInstance } from "fastify";
import {
  createRoom,
  getRoom,
  joinRoom,
} from "./room.service.js";

export async function roomRoutes(app: FastifyInstance) {
  app.post("/api/rooms", async () => {
    return createRoom();
  });

  app.get("/api/rooms/:roomId", async (request, reply) => {
    const { roomId } = request.params as { roomId: string };

    const room = getRoom(roomId);

    if (!room) {
      return reply.status(404).send({
        message: "Room not found",
      });
    }

    return room;
  });

  app.post("/api/rooms/:roomId/join", async (request, reply) => {
    const { roomId } = request.params as { roomId: string };

    const body = request.body as {
      name?: string;
    };

    const name = body.name?.trim();

    if (!name) {
      return reply.status(400).send({
        message: "Name is required",
      });
    }

    const result = joinRoom(roomId, name);

    if (!result) {
      return reply.status(404).send({
        message: "Room not found",
      });
    }

    return result;
  });
}