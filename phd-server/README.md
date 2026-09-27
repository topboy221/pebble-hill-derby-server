# Pebble Hill Derby: multiplayer server

A single Node.js program that:

- serves the game at `/` (the file in `public/index.html`)
- signs players in as **guests** (random name like `ZippyOtter42`) or with a **registered account** (username and password, kept signed in for 30 days)
- runs **lobbies of up to 12 racers**:
  - **Quick join**: drops you in the fullest open lobby that hasn't started racing (or makes a new one). The race starts 20 s after a second racer arrives, or 5 s after the lobby fills up.
  - **Private servers**: password protected. Friends pick it from the list and type the password. The host presses Start.
- relays every car's position about 15 times a second during the race
- shows results, then a **15-second vote between 2 random tracks**. The track with the most votes is raced next (a tie is a coin flip).

## Run it on your computer

Needs Node.js 18 or newer.

```
npm install
npm start
```

Open http://localhost:8080 and choose **Multiplayer**. Other devices on the same Wi-Fi can join at `http://<your computer's IP>:8080`.

## Put it online

Any host that runs Node and allows WebSockets works (for example Render, Railway, Fly.io, or a small VPS).

- Start command: `npm start`. The port comes from the `PORT` environment variable.
- Accounts are saved in the `data/` folder (`users.json` and `sessions.json`). Give that folder a **persistent disk or volume**, or set `DATA_DIR` to one. Otherwise accounts are wiped on every redeploy.
- Use HTTPS. Players then connect over `wss://` automatically.

When the game is opened from the server's own address, it finds the server by itself. From anywhere else (for example the phone app later on), type the server address under **Multiplayer → Server**.

## Updating the game

Replace `public/index.html` with the new game file and restart the server. `TRACK_IDS` at the top of `server.js` must list the same track ids as the game (`pebble`, `city`).

## Security notes

- Passwords (for accounts and private servers) are stored only as salted scrypt hashes.
- Repeated wrong passwords from one IP are slowed down (12 tries per 5 minutes).
- Each player sends their own car's position. The server checks finish times against its own clock, but the game has no anti-cheat beyond that.
