const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const rooms = new Map();
const questions = JSON.parse(fs.readFileSync(path.join(__dirname,"questions.json"),"utf8"));

function roomCode(){ return crypto.randomBytes(2).toString("hex").toUpperCase(); }
function send(ws, msg){ if(ws && ws.readyState===1) ws.send(JSON.stringify(msg)); }
function broadcast(room,msg){ for(const p of room.players.values()) send(p.ws,msg); if(room.host) send(room.host,msg); }
function publicState(room){
  const players=[...room.players.values()].map(p=>({id:p.id,name:p.name,score:p.score}));
  if(room.hostPlayer) players.unshift({id:"host",name:room.hostPlayer.name,score:room.hostPlayer.score});
  return { code:room.code, phase:room.phase, qIndex:room.qIndex,
    players,
    answered:Object.keys(room.answers).length,
    total:players.length };
}
function uniqueCode(){ let c; do c=roomCode(); while(rooms.has(c)); return c; }

const server=http.createServer((req,res)=>{
  let url=req.url.split("?")[0];
  if(url==="/") url="/index.html";
  const file=path.join(__dirname,"public",url);
  if(!file.startsWith(path.join(__dirname,"public"))) return res.writeHead(403).end();
  fs.readFile(file,(err,data)=>{
    if(err) return res.writeHead(404).end("Not found");
    const ext=path.extname(file);
    const types={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8"};
    res.writeHead(200,{"Content-Type":types[ext]||"application/octet-stream"});
    res.end(data);
  });
});

const wss=new WebSocketServer({server});
wss.on("connection",ws=>{
  let role=null, room=null, playerId=null;

  ws.on("message",raw=>{
    let m; try{m=JSON.parse(raw)}catch{return}
    if(m.type==="create"){
      const code=uniqueCode();
      room={code,host:ws,hostPlayer:{id:"host",name:String(m.name||"Host").slice(0,18),score:0,ws},
            players:new Map(),phase:"lobby",qIndex:-1,answers:{},start:0};
      rooms.set(code,room); role="host"; playerId="host";
      send(ws,{type:"created",state:publicState(room)});
      return;
    }
    if(m.type==="join"){
      room=rooms.get(String(m.code||"").toUpperCase());
      if(!room) return send(ws,{type:"error",message:"Raum nicht gefunden."});
      if(room.players.size+1>=4) return send(ws,{type:"error",message:"Der Raum ist voll (maximal 4 Personen inklusive Host)."});
      playerId=crypto.randomUUID(); role="player";
      room.players.set(playerId,{id:playerId,name:String(m.name||"Spieler").slice(0,18),score:0,ws});
      send(ws,{type:"joined",id:playerId,state:publicState(room)});
      broadcast(room,{type:"lobby",state:publicState(room)});
      return;
    }
    if(!room) return;
    if(role==="host" && m.type==="start"){
      room.qIndex++;
      if(room.qIndex>=questions.length){ room.phase="final"; broadcast(room,{type:"final",state:publicState(room)}); return; }
      room.phase="question"; room.answers={}; room.start=Date.now();
      broadcast(room,{type:"question",question:questions[room.qIndex],state:publicState(room)});
      return;
    }
    if(role==="host" && m.type==="answer"){
      if(room.phase!=="question" || room.answers.host) return;
      const choice=Number(m.choice);
      const elapsed=Math.min(20,Math.max(0,(Date.now()-room.start)/1000));
      room.answers.host={choice,elapsed};
      if(choice===questions[room.qIndex].a) room.hostPlayer.score += 1000+Math.round((20-elapsed)*50);
      send(ws,{type:"answerSaved"});
      broadcast(room,{type:"progress",state:publicState(room)});
      if(Object.keys(room.answers).length>=room.players.size+1){
        room.phase="results";
        broadcast(room,{type:"results",correct:questions[room.qIndex].a,state:publicState(room)});
      }
      return;
    }
    if(role==="host" && m.type==="next"){
      room.qIndex++;
      if(room.qIndex>=questions.length){room.phase="final";broadcast(room,{type:"final",state:publicState(room)});return;}
      room.phase="question";room.answers={};room.start=Date.now();
      broadcast(room,{type:"question",question:questions[room.qIndex],state:publicState(room)});
      return;
    }
    if(role==="host" && m.type==="end"){
      if(room.phase!=="question") return;
      room.phase="results"; broadcast(room,{type:"results",correct:questions[room.qIndex].a,state:publicState(room)}); return;
    }
    if(role==="player" && m.type==="answer"){
      if(room.phase!=="question" || room.answers[playerId]) return;
      const choice=Number(m.choice);
      const elapsed=Math.min(20,Math.max(0,(Date.now()-room.start)/1000));
      const p=room.players.get(playerId);
      room.answers[playerId]={choice,elapsed};
      if(choice===questions[room.qIndex].a) p.score += 1000+Math.round((20-elapsed)*50);
      send(ws,{type:"answerSaved"});
      broadcast(room,{type:"progress",state:publicState(room)});
      if(Object.keys(room.answers).length>=room.players.size) {
        room.phase="results";
        broadcast(room,{type:"results",correct:questions[room.qIndex].a,state:publicState(room)});
      }
    }
  });

  ws.on("close",()=>{
    if(role==="player" && room && room.players.has(playerId)){
      room.players.delete(playerId); broadcast(room,{type:"lobby",state:publicState(room)});
    }
    if(role==="host" && room){ broadcast(room,{type:"closed"}); rooms.delete(room.code); }
  });
});

server.listen(PORT,()=>console.log(`IHK Quiz läuft auf Port ${PORT}`));
