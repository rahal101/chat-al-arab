const express = require("express");
const http = require("http");
const path = require("path");
const fs = require("fs");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { Pool } = require("pg");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_ME_IN_PRODUCTION";
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_URL.includes("sslmode=require") ? { rejectUnauthorized: false } : false })
  : null;

app.use(helmet({ crossOriginEmbedderPolicy: false }));
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "..", "public")));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 60, standardHeaders: true, legacyHeaders: false });
const messageLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });

function cleanUsername(v) {
  return String(v || "").trim().replace(/[^\u0600-\u06FFa-zA-Z0-9 _-]/g, "").slice(0, 30);
}
function cleanText(v, max=500) {
  return String(v || "").trim().slice(0, max);
}
function signUser(user) {
  return jwt.sign({ id: user.id, username: user.username, role: user.role }, JWT_SECRET, { expiresIn: "7d" });
}
async function auth(req, res, next) {
  try {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) return res.status(401).json({ error: "غير مسجل الدخول" });
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: "جلسة غير صالحة" });
  }
}

app.get("/api/health", async (req, res) => {
  let db = "disabled";
  if (pool) {
    try { await pool.query("SELECT 1"); db = "ok"; } catch { db = "error"; }
  }
  res.json({ ok: true, database: db });
});

app.post("/api/register", authLimiter, async (req, res) => {
  if (!pool) return res.status(503).json({ error: "قاعدة البيانات غير مفعلة. أضف DATABASE_URL." });
  const username = cleanUsername(req.body.username);
  const email = String(req.body.email || "").trim().toLowerCase().slice(0, 255);
  const password = String(req.body.password || "");
  if (username.length < 3) return res.status(400).json({ error: "اسم المستخدم يجب أن يكون 3 أحرف على الأقل" });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "البريد الإلكتروني غير صحيح" });
  if (password.length < 8) return res.status(400).json({ error: "كلمة المرور يجب أن تكون 8 أحرف على الأقل" });
  try {
    const hash = await bcrypt.hash(password, 12);
    const r = await pool.query(
      "INSERT INTO users(username,email,password_hash) VALUES($1,$2,$3) RETURNING id,username,email,bio,role",
      [username,email,hash]
    );
    const user = r.rows[0];
    res.json({ token: signUser(user), user });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "اسم المستخدم أو البريد مستخدم بالفعل" });
    console.error(e);
    res.status(500).json({ error: "تعذر إنشاء الحساب" });
  }
});

app.post("/api/login", authLimiter, async (req, res) => {
  if (!pool) return res.status(503).json({ error: "قاعدة البيانات غير مفعلة. أضف DATABASE_URL." });
  const login = String(req.body.login || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  try {
    const r = await pool.query("SELECT id,username,email,password_hash,bio,role,is_banned FROM users WHERE lower(email)=lower($1) OR lower(username)=lower($1) LIMIT 1", [login]);
    const user = r.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: "بيانات الدخول غير صحيحة" });
    if (user.is_banned) return res.status(403).json({ error: "هذا الحساب محظور" });
    delete user.password_hash;
    res.json({ token: signUser(user), user });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "تعذر تسجيل الدخول" });
  }
});

app.get("/api/me", auth, async (req, res) => {
  if (!pool) return res.status(503).json({ error: "قاعدة البيانات غير مفعلة" });
  const r = await pool.query("SELECT id,username,email,bio,role,is_banned,created_at FROM users WHERE id=$1", [req.user.id]);
  if (!r.rows[0]) return res.status(404).json({ error: "المستخدم غير موجود" });
  res.json(r.rows[0]);
});


app.post("/api/avatar", auth, async (req,res)=>{
  if(!pool) return res.status(503).json({error:"قاعدة البيانات غير مفعلة"});
  const data=String(req.body.data||"");
  if(!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(data)) return res.status(400).json({error:"الصورة غير صالحة"});
  if(data.length>900000) return res.status(413).json({error:"الصورة كبيرة جداً"});
  await pool.query("UPDATE users SET avatar=$1 WHERE id=$2",[data,req.user.id]);
  res.json({ok:true,avatar:data});
});

app.patch("/api/me", auth, async (req, res) => {
  if (!pool) return res.status(503).json({ error: "قاعدة البيانات غير مفعلة" });
  const username = cleanUsername(req.body.username);
  const bio = cleanText(req.body.bio, 300);
  if (username.length < 3) return res.status(400).json({ error: "اسم المستخدم قصير" });
  try {
    const r = await pool.query("UPDATE users SET username=$1,bio=$2 WHERE id=$3 RETURNING id,username,email,bio,role", [username,bio,req.user.id]);
    res.json(r.rows[0]);
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ error: "اسم المستخدم مستخدم بالفعل" });
    res.status(500).json({ error: "تعذر حفظ الملف الشخصي" });
  }
});

app.post("/api/block", auth, async (req, res) => {
  if (!pool) return res.status(503).json({ error: "قاعدة البيانات غير مفعلة" });
  const blockedId = Number(req.body.userId);
  if (!Number.isInteger(blockedId) || blockedId === req.user.id) return res.status(400).json({ error: "مستخدم غير صالح" });
  await pool.query("INSERT INTO blocks(blocker_id,blocked_id) VALUES($1,$2) ON CONFLICT DO NOTHING", [req.user.id, blockedId]);
  res.json({ ok: true });
});

app.post("/api/report", auth, async (req, res) => {
  if (!pool) return res.status(503).json({ error: "قاعدة البيانات غير مفعلة" });
  const reportedId = Number(req.body.userId);
  const reason = cleanText(req.body.reason, 500);
  if (!Number.isInteger(reportedId) || reportedId === req.user.id || reason.length < 3) return res.status(400).json({ error: "بيانات البلاغ غير صحيحة" });
  await pool.query("INSERT INTO reports(reporter_id,reported_id,reason) VALUES($1,$2,$3)", [req.user.id,reportedId,reason]);
  res.json({ ok: true });
});


app.get("/api/admin/reports", auth, async (req, res) => {
  if (!pool) return res.status(503).json({ error: "قاعدة البيانات غير مفعلة" });
  if (req.user.role !== "admin") return res.status(403).json({ error: "غير مصرح" });
  const r = await pool.query(`
    SELECT r.id, r.reason, r.status, r.created_at,
           u1.username AS reporter, u2.username AS reported
    FROM reports r
    JOIN users u1 ON u1.id=r.reporter_id
    JOIN users u2 ON u2.id=r.reported_id
    ORDER BY r.created_at DESC LIMIT 200
  `);
  res.json(r.rows);
});

app.patch("/api/admin/reports/:id", auth, async (req, res) => {
  if (!pool) return res.status(503).json({ error: "قاعدة البيانات غير مفعلة" });
  if (req.user.role !== "admin") return res.status(403).json({ error: "غير مصرح" });
  const status = ["open","reviewed","closed"].includes(req.body.status) ? req.body.status : "reviewed";
  await pool.query("UPDATE reports SET status=$1 WHERE id=$2", [status, Number(req.params.id)]);
  res.json({ ok: true });
});

app.get("/api/admin/users", auth, async (req, res) => {
  if (!pool) return res.status(503).json({ error: "قاعدة البيانات غير مفعلة" });
  if (req.user.role !== "admin") return res.status(403).json({ error: "غير مصرح" });
  const r = await pool.query("SELECT id,username,email,role,is_banned,created_at FROM users ORDER BY created_at DESC LIMIT 500");
  res.json(r.rows);
});

app.patch("/api/admin/users/:id/ban", auth, async (req, res) => {
  if (!pool) return res.status(503).json({ error: "قاعدة البيانات غير مفعلة" });
  if (req.user.role !== "admin") return res.status(403).json({ error: "غير مصرح" });
  const banned = Boolean(req.body.banned);
  await pool.query("UPDATE users SET is_banned=$1 WHERE id=$2", [banned, Number(req.params.id)]);
  res.json({ ok: true });
});



app.post("/api/media", auth, async (req,res)=>{
  if(!pool) return res.status(503).json({error:"قاعدة البيانات غير مفعلة"});
  const kind=String(req.body.kind||"");
  const data=String(req.body.data||"");
  const allowed=["image"];
  if(!allowed.includes(kind)) return res.status(400).json({error:"نوع الملف غير مدعوم"});
  if(!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(data)) return res.status(400).json({error:"الصورة غير صالحة"});
  if(data.length>1500000) return res.status(413).json({error:"الصورة كبيرة جداً"});
  const r=await pool.query("INSERT INTO media(user_id,kind,data) VALUES($1,$2,$3) RETURNING id,kind,data,created_at",[req.user.id,kind,data]);
  res.json(r.rows[0]);
});

app.get("/api/friends", auth, async (req,res)=>{
  if(!pool) return res.status(503).json({error:"قاعدة البيانات غير مفعلة"});
  const r=await pool.query(`
    SELECT u.id,u.username,u.bio
    FROM friends f JOIN users u ON u.id=f.friend_id
    WHERE f.user_id=$1 ORDER BY u.username`,[req.user.id]);
  res.json(r.rows);
});

app.post("/api/friends/:id", auth, async (req,res)=>{
  if(!pool) return res.status(503).json({error:"قاعدة البيانات غير مفعلة"});
  const id=Number(req.params.id);
  if(!Number.isInteger(id)||id===req.user.id) return res.status(400).json({error:"مستخدم غير صالح"});
  await pool.query("INSERT INTO friends(user_id,friend_id) VALUES($1,$2),($2,$1) ON CONFLICT DO NOTHING",[req.user.id,id]);
  res.json({ok:true});
});

app.delete("/api/friends/:id", auth, async (req,res)=>{
  if(!pool) return res.status(503).json({error:"قاعدة البيانات غير مفعلة"});
  const id=Number(req.params.id);
  await pool.query("DELETE FROM friends WHERE (user_id=$1 AND friend_id=$2) OR (user_id=$2 AND friend_id=$1)",[req.user.id,id]);
  res.json({ok:true});
});

app.get("/api/conversations/:id", auth, async (req,res)=>{
  if(!pool) return res.status(503).json({error:"قاعدة البيانات غير مفعلة"});
  const id=Number(req.params.id);
  const r=await pool.query(`
    SELECT sender_id,receiver_id,text,created_at FROM private_messages
    WHERE (sender_id=$1 AND receiver_id=$2) OR (sender_id=$2 AND receiver_id=$1)
    ORDER BY created_at DESC LIMIT 100`,[req.user.id,id]);
  res.json(r.rows.reverse());
});

const online = new Map(); // socketId -> user
const waiting = [];
const matches = new Map();

io.use((socket, next) => {
  try {
    const token = socket.handshake.auth?.token;
    if (!token) return next(new Error("auth_required"));
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch { next(new Error("auth_invalid")); }
});

io.on("connection", (socket) => {
  online.set(socket.id, { id: socket.user.id, username: socket.user.username, status: "online", lastSeen: Date.now() });

  socket.on("join", ({ room }) => {
    const safeRoom = cleanText(room, 30) || "العامة";
    for (const r of socket.rooms) if (r !== socket.id) socket.leave(r);
    socket.join(safeRoom);
    socket.emit("roomJoined", safeRoom);
    io.emit("onlineUsers", [...online.values()]);
  });

  socket.on("message", ({ room, text }) => {
    const body = cleanText(text, 500);
    const safeRoom = cleanText(room, 30) || "العامة";
    if (!body) return;
    socket.to(safeRoom).emit("message", { userId: socket.user.id, user: socket.user.username, text: body, at: Date.now() });
  });

  socket.on("randomStart", () => {
    if (matches.has(socket.id) || waiting.includes(socket.id)) return;
    const other = waiting.shift();
    if (!other || !online.has(other)) { waiting.push(socket.id); socket.emit("randomWaiting"); return; }
    matches.set(socket.id, other); matches.set(other, socket.id);
    socket.emit("randomMatched", { user: online.get(other) });
    io.to(other).emit("randomMatched", { user: online.get(socket.id) });
  });

  socket.on("randomNext", () => {
    const other = matches.get(socket.id);
    if (other) {
      matches.delete(socket.id); matches.delete(other);
      io.to(other).emit("randomEnded");
    }
    socket.emit("randomWaiting");
    waiting.push(socket.id);
    const idx = waiting.indexOf(socket.id);
    if (idx === -1) waiting.push(socket.id);
    const candidate = waiting.shift();
    if (candidate && candidate !== socket.id && online.has(candidate)) {
      matches.set(socket.id, candidate); matches.set(candidate, socket.id);
      socket.emit("randomMatched", { user: online.get(candidate) });
      io.to(candidate).emit("randomMatched", { user: online.get(socket.id) });
    } else if (candidate && candidate !== socket.id) waiting.push(candidate);
  });

  socket.on("randomStop", () => {
    const i = waiting.indexOf(socket.id); if (i >= 0) waiting.splice(i, 1);
    const other = matches.get(socket.id);
    if (other) {
      matches.delete(socket.id); matches.delete(other);
      io.to(other).emit("randomEnded");
    }
  });

  socket.on("randomMessage", (text) => {
    const body = cleanText(text, 500);
    const other = matches.get(socket.id);
    if (body && other) io.to(other).emit("randomMessage", { user: socket.user.username, text: body, at: Date.now() });
  });

  // WebRTC signaling
  socket.on("voiceOffer", ({ to, offer }) => io.to(to).emit("voiceOffer", { from: socket.id, offer, user: online.get(socket.id) }));
  socket.on("voiceAnswer", ({ to, answer }) => io.to(to).emit("voiceAnswer", { from: socket.id, answer }));
  socket.on("voiceIceCandidate", ({ to, candidate }) => io.to(to).emit("voiceIceCandidate", { from: socket.id, candidate }));
  socket.on("voiceEnd", ({ to }) => io.to(to).emit("voiceEnd"));

  socket.on("videoRequest", ({userId}) => {
    const target=Number(userId);
    for(const [sid,u] of online.entries()) if(u.id===target){ io.to(sid).emit("videoIncoming",{from:socket.id,user:online.get(socket.id)}); socket.emit("videoRequestAck",{to:sid}); return; }
    socket.emit("videoEnd");
  });

  socket.on("videoOffer", ({ to, offer }) => io.to(to).emit("videoOffer", { from: socket.id, offer, user: online.get(socket.id) }));
  socket.on("videoAnswer", ({ to, answer }) => io.to(to).emit("videoAnswer", { from: socket.id, answer }));
  socket.on("videoIceCandidate", ({ to, candidate }) => io.to(to).emit("videoIceCandidate", { from: socket.id, candidate }));
  socket.on("videoEnd", ({ to }) => io.to(to).emit("videoEnd"));



  socket.on("privateMedia", async ({to,mediaId,kind})=>{
    const target=Number(to);
    if(!pool || !Number.isInteger(target) || !Number.isInteger(Number(mediaId))) return;
    try{
      const r=await pool.query("SELECT id,kind,data FROM media WHERE id=$1 AND user_id=$2",[Number(mediaId),socket.user.id]);
      if(!r.rows[0]) return;
      const payload={sender_id:socket.user.id,receiver_id:target,media_id:r.rows[0].id,kind:r.rows[0].kind,data:r.rows[0].data,created_at:Date.now()};
      for(const [sid,u] of online.entries()) if(u.id===target) io.to(sid).emit("privateMedia",payload);
      socket.emit("privateMedia",payload);
    }catch(e){console.error(e)}
  });

  socket.on("privateMessage", async ({to,text})=>{
    const body=cleanText(text,500);
    const target=Number(to);
    if(!body || !Number.isInteger(target) || !pool) return;
    try{
      const blocked=await pool.query("SELECT 1 FROM blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1) LIMIT 1",[socket.user.id,target]);
      if(blocked.rowCount) return;
      const r=await pool.query("INSERT INTO private_messages(sender_id,receiver_id,text) VALUES($1,$2,$3) RETURNING sender_id,receiver_id,text,created_at",[socket.user.id,target,body]);
      const payload=r.rows[0];
      for(const [sid,u] of online.entries()) if(u.id===target) io.to(sid).emit("privateMessage",payload);
      socket.emit("privateMessage",payload);
    }catch(e){ console.error(e); }
  });


  socket.on("presence", (status) => {
    const u=online.get(socket.id);
    if(!u) return;
    u.status=["online","away","busy"].includes(status)?status:"online";
    u.lastSeen=Date.now();
    online.set(socket.id,u);
    io.emit("onlineUsers",[...online.values()]);
  });

  socket.on("disconnect", () => {
    const i = waiting.indexOf(socket.id); if (i >= 0) waiting.splice(i, 1);
    const other = matches.get(socket.id);
    if (other) {
      matches.delete(socket.id); matches.delete(other);
      io.to(other).emit("randomEnded");
    }
    online.delete(socket.id);
    io.emit("onlineUsers", [...online.values()]);
  });
});

app.get("*", (req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));

server.listen(PORT, () => console.log(`شات العرب يعمل على http://localhost:${PORT}`));
