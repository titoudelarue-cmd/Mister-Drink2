import express from "express";
import http from "http";
import { Server } from "socket.io";
import crypto from "crypto";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const PORT = process.env.PORT || 3000;
const games = new Map();

const WORD_PAIRS = [
  ["Pizza", "Burger"],
  ["Chat", "Chien"],
  ["Plage", "Piscine"],
  ["Avion", "Train"],
  ["Café", "Thé"],
  ["Cinéma", "Série"],
  ["Guitare", "Piano"],
  ["Neige", "Pluie"]
];

function randCode(len = 6) {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
function uid() { return crypto.randomBytes(8).toString("hex"); }
function pickWordPair() { return WORD_PAIRS[Math.floor(Math.random() * WORD_PAIRS.length)]; }

function computeRoles(n) {
  const undercovers = n >= 8 ? 2 : (n >= 4 ? 1 : 0);
  const roles = ["mrwhite", ...Array(undercovers).fill("undercover")];
  while (roles.length < n) roles.push("civil");
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }
  return roles;
}

function publicState(game) {
  return {
    code: game.code,
    hostId: game.hostId,
    phase: game.phase,
    round: game.round,
    players: game.players.map(p => ({ id: p.id, name: p.name, alive: p.alive, isHost: p.id === game.hostId })),
    clues: game.clues.map(c => ({ name: c.name, text: c.text })),
    lastElim: game.lastElim || null
  };
}

io.on("connection", (socket) => {
  socket.on("create_game", ({ name }) => {
    const code = randCode();
    const hostId = uid();
    const [w1, w2] = pickWordPair();

    const game = {
      code,
      hostId,
      phase: "lobby",
      round: 0,
      wordCivil: w1,
      wordUnder: w2,
      players: [{ id: hostId, name: (name || "Host").slice(0,18), socketId: socket.id, alive: true, role: null }],
      votes: new Map(),
      clues: [],
      lastElim: null
    };

    games.set(code, game);
    socket.join(code);
    socket.emit("created", { code, playerId: hostId });
    io.to(code).emit("state", publicState(game));
  });

  socket.on("join_game", ({ code, name }) => {
    const game = games.get(code);
    if (!game) return socket.emit("error_msg", "Partie introuvable.");
    if (game.phase !== "lobby") return socket.emit("error_msg", "Partie déjà lancée.");

    const playerId = uid();
    game.players.push({ id: playerId, name: (name || "Joueur").slice(0,18), socketId: socket.id, alive: true, role: null });
    socket.join(code);
    socket.emit("joined", { code, playerId });
    io.to(code).emit("state", publicState(game));
  });

  socket.on("start_game", ({ code, playerId }) => {
    const game = games.get(code);
    if (!game) return;
    if (game.hostId !== playerId) return;
    if (game.players.length < 3) return io.to(code).emit("error_msg", "Il faut au moins 3 joueurs.");

    const roles = computeRoles(game.players.length);
    game.players.forEach((p, i) => { p.role = roles[i]; p.alive = true; });

    for (const p of game.players) {
      const s = io.sockets.sockets.get(p.socketId);
      if (!s) continue;
      if (p.role === "civil") s.emit("private_role", { role: "civil", word: game.wordCivil });
      if (p.role === "undercover") s.emit("private_role", { role: "undercover", word: game.wordUnder });
      if (p.role === "mrwhite") s.emit("private_role", { role: "mrwhite", word: null });
    }

    game.phase = "clues";
    game.round = 1;
    game.clues = [];
    game.votes = new Map();
    io.to(code).emit("state", publicState(game));
  });

  socket.on("submit_clue", ({ code, playerId, text }) => {
    const game = games.get(code);
    if (!game || game.phase !== "clues") return;

    const p = game.players.find(x => x.id === playerId);
    if (!p?.alive) return;

    if (game.clues.some(c => c.playerId === playerId)) return; // 1 clue/joueur
    const clean = (text || "").trim().slice(0, 40);
    if (!clean) return;

    game.clues.push({ playerId, name: p.name, text: clean });
    io.to(code).emit("state", publicState(game));
  });

  socket.on("cast_vote", ({ code, playerId, targetId }) => {
    const game = games.get(code);
    if (!game) return;
    game.votes.set(playerId, targetId);
    socket.emit("voted_ok");
  });

  socket.on("resolve_vote", ({ code, playerId }) => {
    const game = games.get(code);
    if (!game) return;
    if (game.hostId !== playerId) return;

    // tally
    const tally = new Map();
    for (const [voter, target] of game.votes.entries()) {
      tally.set(target, (tally.get(target) || 0) + 1);
    }
    let max = -1, top = [];
    for (const [t, c] of tally.entries()) {
      if (c > max) { max = c; top = [t]; }
      else if (c === max) top.push(t);
    }
    const alive = game.players.filter(p => p.alive);
    const elimId = (top.length === 1 ? top[0] : alive[Math.floor(Math.random()*alive.length)]?.id);
    const elim = game.players.find(p => p.id === elimId);
    if (!elim) return;

    elim.alive = false;
    game.lastElim = { name: elim.name, role: elim.role };
    game.phase = "vote"; // simple: on reste vote/discussion à gérer côté UI (MVP)

    io.to(code).emit("state", publicState(game));
    io.to(code).emit("reveal_elimination", game.lastElim);
  });
});

server.listen(PORT, () => console.log("✅ Running on port", PORT));
