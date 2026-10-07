import { randomBytes } from "node:crypto";

export interface Participant {
  id: string;
  name: string;
}

export interface Room {
  id: string;
  hostId: string;
  participants: Participant[];
}

const rooms = new Map<string, Room>();

function generateRoomId(): string {
  return randomBytes(3).toString("hex").toUpperCase();
}

function generateParticipantId(): string {
  return randomBytes(8).toString("hex");
}

export function createRoom() {
  const roomId = generateRoomId();
  const hostId = generateParticipantId();

  const host: Participant = {
    id: hostId,
    name: "Host",
  };

  const room: Room = {
    id: roomId,
    hostId,
    participants: [host],
  };

  rooms.set(roomId, room);

  return {
    room,
    participantId: hostId,
  };
}

export function getRoom(roomId: string) {
  return rooms.get(roomId);
}

export function joinRoom(roomId: string, name: string) {
  const room = rooms.get(roomId);

  if (!room) {
    return null;
  }

  const participant: Participant = {
    id: generateParticipantId(),
    name,
  };

  room.participants.push(participant);

  return {
    room,
    participantId: participant.id,
  };
}