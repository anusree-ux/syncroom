import { useState } from "react";
import { connectToRoom } from "./services/socket";
import "./App.css";

const API_URL = "http://localhost:5000";

function App() {
  const [roomCode, setRoomCode] = useState("");
  const [name, setName] = useState("");
  const [createdRoom, setCreatedRoom] = useState<string | null>(null);
  const [message, setMessage] = useState("");

  const createRoom = async () => {
    try {
      setMessage("Creating room...");

      const response = await fetch(`${API_URL}/api/rooms`, {
        method: "POST",
      });

      if (!response.ok) {
        throw new Error("Failed to create room");
      }

      const data = await response.json();

      setCreatedRoom(data.room.id);
      setMessage("Room created successfully!");

      connectToRoom(
        data.room.id,
        data.participantId,
        "Host",
        (event) => {     
          console.log("Room event:", event);
        }
      );
    } catch (error) {
      console.error(error);
      setMessage("Could not create room.");
    }
  };

  const joinRoom = async () => {
    if (!roomCode.trim()) {
      setMessage("Enter a room code.");
      return;
    }

    if (!name.trim()) {
      setMessage("Enter your name.");
      return;
    }

    try {
      setMessage("Joining room...");

      const code = roomCode.trim().toUpperCase();

      const response = await fetch(
        `${API_URL}/api/rooms/${code}/join`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: name.trim(),
          }),
        }
      );

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Failed to join room");
      }

      setMessage(`Joined room ${data.room.id} successfully!`);

      connectToRoom(
        data.room.id,
        data.participantId,
        name.trim(),
        (event) => {
          console.log("Room event:", event);
        }
      );
    } catch (error) {
      console.error(error);

      setMessage(
        error instanceof Error
          ? error.message
          : "Could not join room."
      );
    }
  };

  return (
    <main className="app">
      <section className="hero">
        <h1>SyncRoom</h1>
        <p>Watch together, from anywhere.</p>
      </section>

      <section className="room-card">
        <button className="primary-button" onClick={createRoom}>
          Create Room
        </button>

        {createdRoom && (
          <div className="created-room">
            <p>Your room code</p>
            <strong>{createdRoom}</strong>
            <p>Share this code with your friends.</p>
          </div>
        )}

        <div className="divider">
          <span>OR</span>
        </div>

        <div className="join-section">
          <label>Your name</label>
          <input
            type="text"
            placeholder="Enter your name"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />

          <label>Room code</label>
          <input
            type="text"
            placeholder="e.g. 960FB1"
            value={roomCode}
            onChange={(event) => setRoomCode(event.target.value)}
          />

          <button className="secondary-button" onClick={joinRoom}>
            Join Room
          </button>
        </div>

        {message && <p className="message">{message}</p>}
      </section>
    </main>
  );
}

export default App;