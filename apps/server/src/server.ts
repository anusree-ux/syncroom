import Fastify from "fastify";
import cors from "@fastify/cors";
import "dotenv/config";

import { roomRoutes } from "./modules/rooms/room.routes.js";

const app = Fastify({
  logger: true,
});

await app.register(cors, {
  origin: true,
});

await app.register(roomRoutes);

app.get("/health", async () => {
  return {
    status: "ok",
    service: "syncroom-server",
  };
});

const port = Number(process.env.PORT) || 5000;

try {
  await app.listen({
    port,
    host: "0.0.0.0",
  });

  console.log(`SyncRoom server running on http://localhost:${port}`);
} catch (error) {
  app.log.error(error);
  process.exit(1);
}