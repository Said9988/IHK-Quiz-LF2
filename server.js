const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const questions = JSON.parse(fs.readFileSync(path.join(__dirname, "questions.json"), "utf8"));

const rooms = new Map();

function send(ws, data) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
}
function broadcast(room, data) {
  for (const p of room.players.values()) send(p.ws, data);
}
function roomState(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    players: [...room.players.values()].map(p => ({id:p.id, name:p.name, score:p.score, answered:p.answered}))
  };
}
function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  do {
    code = "";
    for (let i=0;i<4;i++) code += chars[Math.floor(Math.random()*chars.length)];
  } while (rooms.has(code));
  return code;
}
function endQuestion(room) {
  if (!room || room.phase !== "question") return;
  room.phase = "results";
  const q = questions[room.questionIndex];
  const results = [...room.players.values()].map(p => ({
    id:p.id, name:p.name, score:p.score,
    answer:p.answer, correct:p.answer === q.correct,
    answerTime:p.answerTime
  })).sort((a,b)=>b.score-a.score);
  room.lastResults = results;
  broadcast(room, {type:"results", questionIndex:room.questionIndex, results, correct:q.correct});
}

const server = http.createServer((req,res)=>{
  let reqPath = decodeURIComponent(req.url.split("?")[0]);
  if (reqPath === "/") reqPath = "/index.html";
  const file = path.normalize(path.join(PUBLIC, reqPath));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end("Forbidden"); }
  fs.readFile(file, (err,data)=>{
    if (err) { res.writeHead(404, {"Content-Type":"text/plain; charset=utf-8"}); return res.end("Not found"); }
    const ext = path.extname(file);
    const types = {".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".json":"application/json; charset=utf-8"};
    res.writeHead(200, {"Content-Type":types[ext] || "application/octet-stream"});
    res.end(data);
  });
});

const wss = new WebSocketServer({server});

wss.on("connection", ws=>{
  const id = crypto.randomUUID();
  let room = null;
  send(ws,{type:"connected",id});

  ws.on("message", raw=>{
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "create") {
      if (room) return;
      const code = makeCode();
      room = {code, hostId:id, players:new Map(), phase:"lobby", questionIndex:-1, timer:null};
      room.players.set(id,{id,name:String(msg.name||"Host").slice(0,24),score:0,answered:false,answer:null,answerTime:null,ws});
      rooms.set(code,room);
      send(ws,{type:"created",code,hostId:id,state:roomState(room)});
      return;
    }

    if (msg.type === "join") {
      if (room) return;
      const code = String(msg.code||"").toUpperCase();
      const r = rooms.get(code);
      if (!r) return send(ws,{type:"error",message:"Raum nicht gefunden."});
      if (r.phase !== "lobby") return send(ws,{type:"error",message:"Das Spiel läuft bereits."});
      if (r.players.size >= 4) return send(ws,{type:"error",message:"Der Raum ist voll (maximal 4 Spieler inklusive Host)."});
      const name = String(msg.name||"Spieler").slice(0,24);
      r.players.set(id,{id,name,score:0,answered:false,answer:null,answerTime:null,ws});
      room = r;
      send(ws,{type:"joined",code:r.code,hostId:r.hostId,state:roomState(r)});
      broadcast(r,{type:"lobby",state:roomState(r)});
      return;
    }

    if (!room) return;
    const player = room.players.get(id);
    if (!player) return;

    if (msg.type === "start" && id === room.hostId) {
      if (room.players.size < 1) return;
      room.questionIndex = 0;
      room.phase = "question";
      room.players.forEach(p=>{p.answered=false;p.answer=null;p.answerTime=null;});
      broadcast(room,{type:"question",questionIndex:0,total:questions.length,question:questions[0].question,options:questions[0].options,duration:60,startedAt:Date.now()});
      clearTimeout(room.timer);
      room.timer = setTimeout(()=>endQuestion(room),60000);
      return;
    }

    if (msg.type === "answer" && room.phase === "question") {
      if (player.answered) return;
      const now = Date.now();
      player.answered = true;
      player.answer = Number(msg.answer);
      player.answerTime = now;
      const q = questions[room.questionIndex];
      if (player.answer === q.correct) {
        const elapsed = Math.max(0, Math.min(60000, now - room.startedAt));
        const speedPoints = Math.round(1000 * (1 - elapsed/60000));
        player.score += 1000 + speedPoints;
      }
      send(ws,{type:"answerAccepted"});
      if ([...room.players.values()].every(p=>p.answered)) endQuestion(room);
      return;
    }

    if (msg.type === "next" && id === room.hostId && room.phase === "results") {
      room.questionIndex++;
      if (room.questionIndex >= questions.length) {
        room.phase = "finished";
        const leaderboard=[...room.players.values()].sort((a,b)=>b.score-a.score).map((p,i)=>({rank:i+1,name:p.name,score:p.score}));
        broadcast(room,{type:"finished",leaderboard});
        return;
      }
      room.phase="question";
      room.players.forEach(p=>{p.answered=false;p.answer=null;p.answerTime=null;});
      room.startedAt=Date.now();
      broadcast(room,{type:"question",questionIndex:room.questionIndex,total:questions.length,question:questions[room.questionIndex].question,options:questions[room.questionIndex].options,duration:60,startedAt:room.startedAt});
      clearTimeout(room.timer);
      room.timer=setTimeout(()=>endQuestion(room),60000);
      return;
    }

    if (msg.type === "state") send(ws,{type:"state",state:roomState(room)});
  });

  ws.on("close",()=>{
    if (!room) return;
    room.players.delete(id);
    if (id === room.hostId) {
      clearTimeout(room.timer);
      broadcast(room,{type:"error",message:"Der Host hat das Spiel verlassen."});
      rooms.delete(room.code);
    } else {
      broadcast(room,{type:"lobby",state:roomState(room)});
    }
  });
});

server.listen(PORT, ()=>console.log(`IHK Quiz läuft auf Port ${PORT}`));
