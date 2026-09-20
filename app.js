let token = localStorage.getItem("chatArabToken");
let me = null, socket = null, currentRoom = "العامة";

const $ = s => document.querySelector(s);
const auth = $("#auth"), app = $("#app"), authMsg = $("#authMsg");

function showAuthMsg(t){ authMsg.textContent=t; }
function api(path, options={}) {
  options.headers = {...options.headers, "Content-Type":"application/json"};
  if(token) options.headers.Authorization = `Bearer ${token}`;
  return fetch(path, options).then(async r => {
    const data = await r.json().catch(()=>({}));
    if(!r.ok) throw new Error(data.error || "حدث خطأ");
    return data;
  });
}
function bubble(container, user, text){
  const d=document.createElement("div"); d.className="bubble";
  const b=document.createElement("b"); b.textContent=user;
  const s=document.createElement("span"); s.textContent=text;
  d.append(b,s); container.append(d); container.scrollTop=container.scrollHeight;
}
async function enter(){
  try{
    me=await api("/api/me");
    auth.hidden=true; app.hidden=false; $("#meName").textContent=`مرحباً ${me.username}`; if(me.avatar) $("#profileAvatar").src=me.avatar;
    connect();
  }catch(e){ token=null; localStorage.removeItem("chatArabToken"); auth.hidden=false; app.hidden=true; }
}
function connect(){
  socket=io({auth:{token}});
  socket.on("connect",()=>socket.emit("join",{room:currentRoom}));
  socket.on("onlineUsers", users=>{
    $("#onlineCount").textContent=users.length;
    $("#users").innerHTML="";
    users.forEach(u=>{
      const d=document.createElement("div"); d.className="user";
      d.textContent=(u.status==="away"?"🟡 ":u.status==="busy"?"🔴 ":"🟢 ")+u.username + (u.id===me.id ? " (أنت)" : "");
      $("#users").append(d);
    });
  });
  socket.on("message",m=>bubble($("#messages"),m.user,m.text));
  socket.on("randomWaiting",()=>$("#randomStatus").textContent="⏳ جاري البحث عن شخص...");
  socket.on("randomMatched",({user})=>{
    $("#randomStatus").textContent=`✅ اتصلت مع ${user.username}`;
    $("#randomMessages").innerHTML="";
  });
  socket.on("randomMessage",m=>bubble($("#randomMessages"),m.user,m.text));
  socket.on("randomEnded",()=>$("#randomStatus").textContent="انتهت المحادثة.");
}
document.querySelectorAll(".tabs button").forEach(b=>b.onclick=()=>{
  document.querySelectorAll(".tabs button").forEach(x=>x.classList.remove("active")); b.classList.add("active");
  const reg=b.dataset.tab==="register"; $("#loginForm").hidden=reg; $("#registerForm").hidden=!reg; showAuthMsg("");
});
$("#loginForm").onsubmit=async e=>{
  e.preventDefault();
  try{const d=await api("/api/login",{method:"POST",body:JSON.stringify({login:$("#login").value,password:$("#loginPassword").value})}); token=d.token; localStorage.setItem("chatArabToken",token); await enter();}
  catch(x){showAuthMsg(x.message)}
};
$("#registerForm").onsubmit=async e=>{
  e.preventDefault();
  try{const d=await api("/api/register",{method:"POST",body:JSON.stringify({username:$("#regUsername").value,email:$("#regEmail").value,password:$("#regPassword").value})}); token=d.token; localStorage.setItem("chatArabToken",token); await enter();}
  catch(x){showAuthMsg(x.message)}
};
document.querySelectorAll(".room").forEach(b=>b.onclick=()=>{
  document.querySelectorAll(".room").forEach(x=>x.classList.remove("active")); b.classList.add("active");
  currentRoom=b.dataset.room; $("#messages").innerHTML=""; socket?.emit("join",{room:currentRoom});
});
$("#sendForm").onsubmit=e=>{e.preventDefault(); const t=$("#text").value.trim(); if(t){bubble($("#messages"),"أنت",t);socket.emit("message",{room:currentRoom,text:t});$("#text").value=""}};
$("#randomBtn").onclick=()=>{$("#randomDialog").showModal();};
$("#randomStart").onclick=()=>socket?.emit("randomStart");
$("#randomNext").onclick=()=>socket?.emit("randomNext");
$("#randomStop").onclick=()=>socket?.emit("randomStop");
$("#randomClose").onclick=()=>$("#randomDialog").close();
$("#randomForm").onsubmit=e=>{e.preventDefault();const t=$("#randomText").value.trim();if(t){bubble($("#randomMessages"),"أنت",t);socket.emit("randomMessage",t);$("#randomText").value=""}};
$("#profileBtn").onclick=async()=>{const u=await api("/api/me");$("#profileName").value=u.username;$("#profileBio").value=u.bio||"";$("#profileAvatar").src=u.avatar||"";$("#profileDialog").showModal()};
$("#saveProfile").onclick=async e=>{e.preventDefault();try{const u=await api("/api/me",{method:"PATCH",body:JSON.stringify({username:$("#profileName").value,bio:$("#profileBio").value})});me=u;$("#meName").textContent=`مرحباً ${u.username}`;const file=$("#avatarFile").files[0]; if(file){const reader=new FileReader();reader.onload=async()=>{try{await api("/api/avatar",{method:"POST",body:JSON.stringify({data:reader.result})});}catch(x){alert(x.message)}};reader.readAsDataURL(file);} $("#profileDialog").close();}catch(x){alert(x.message)}};
$("#logout").onclick=()=>{localStorage.removeItem("chatArabToken");location.reload()};
if(token) enter(); else {auth.hidden=false;app.hidden=true;}

$("#presence").onchange=()=>socket?.emit("presence",$("#presence").value);
