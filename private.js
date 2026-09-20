let privateTarget=null;
let videoPC=null, videoStream=null, videoMuted=false, cameraOff=false, videoPeerSocket=null;

async function loadFriends(){
  try{
    const list=await api("/api/friends");
    $("#friends").innerHTML="";
    $("#friendsList").innerHTML="";
    if(!list.length){$("#friends").textContent="لا يوجد أصدقاء بعد";$("#friendsList").textContent="لا يوجد أصدقاء بعد";return;}
    list.forEach(u=>{
      const d=document.createElement("div");d.className="user";d.textContent=u.username;
      const b=document.createElement("button");b.textContent="💬";b.onclick=()=>openPrivate(u);d.append(b);$("#friends").append(d);
      const x=document.createElement("div");x.className="user";x.textContent=u.username;
      const xb=document.createElement("button");xb.textContent="💬";xb.onclick=()=>openPrivate(u);x.append(xb);$("#friendsList").append(x);
    });
  }catch(e){}
}
function openPrivate(u){
  privateTarget=u; $("#privateTitle").textContent="💬 "+u.username; $("#privateMessages").innerHTML="";
  api("/api/conversations/"+u.id).then(rows=>rows.forEach(m=>bubble($("#privateMessages"),m.sender_id===me.id?"أنت":u.username,m.text))).catch(()=>{});
  $("#privateDialog").showModal();
}
function appendMedia(m){
  const d=document.createElement("div");d.className="bubble";
  const b=document.createElement("b");b.textContent=m.sender_id===me.id?"أنت":(privateTarget?.username||"مستخدم");
  const img=document.createElement("img");img.src=m.data;img.className="chat-image";img.alt="صورة";
  d.append(b,img);$("#privateMessages").append(d);$("#privateMessages").scrollTop=$("#privateMessages").scrollHeight;
}
$("#friendsBtn").onclick=()=>{$("#friendsDialog").showModal();loadFriends()};
$("#friendsClose").onclick=()=>$("#friendsDialog").close();
$("#privateClose").onclick=()=>$("#privateDialog").close();

$("#privateForm").onsubmit=e=>{
  e.preventDefault(); const t=$("#privateText").value.trim();
  if(t&&privateTarget){socket.emit("privateMessage",{to:privateTarget.id,text:t});$("#privateText").value=""}
};


$("#privateImage").onchange=async()=>{
  const f=$("#privateImage").files[0];
  if(!f||!privateTarget)return;
  if(f.size>1000000){alert("الصورة أكبر من الحد المسموح");return}
  const reader=new FileReader();
  reader.onload=async()=>{
    try{
      const m=await api("/api/media",{method:"POST",body:JSON.stringify({kind:"image",data:reader.result})});
      socket.emit("privateMedia",{to:privateTarget.id,mediaId:m.id,kind:"image"});
      $("#privateImage").value="";
    }catch(e){alert(e.message)}
  };
  reader.readAsDataURL(f);
};

$("#videoCall").onclick=()=>startVideoCall();
$("#videoEnd").onclick=()=>endVideo();
$("#videoMute").onclick=()=>{videoMuted=!videoMuted;if(videoStream)videoStream.getAudioTracks().forEach(t=>t.enabled=!videoMuted);$("#videoMute").textContent=videoMuted?"🔊 تشغيل الصوت":"🔇 كتم"};
$("#videoCamera").onclick=()=>{cameraOff=!cameraOff;if(videoStream)videoStream.getVideoTracks().forEach(t=>t.enabled=!cameraOff);$("#videoCamera").textContent=cameraOff?"📷 تشغيل الكاميرا":"📷 إيقاف الكاميرا"};

async function createVideoPC(targetSocket){
  videoPeerSocket=targetSocket;
  videoPC=new RTCPeerConnection({iceServers:[
    {urls:"stun:stun.l.google.com:19302"},
    ...(window.CHAT_TURN_URL?[{urls:window.CHAT_TURN_URL,username:window.CHAT_TURN_USERNAME,credential:window.CHAT_TURN_CREDENTIAL}]:[])
  ]});
  videoPC.onicecandidate=e=>{if(e.candidate)socket.emit("videoIceCandidate",{to:videoPeerSocket,candidate:e.candidate})};
  videoPC.ontrack=e=>{$("#remoteVideo").srcObject=e.streams[0]};
  videoStream=await navigator.mediaDevices.getUserMedia({video:true,audio:true});
  $("#localVideo").srcObject=videoStream;
  videoStream.getTracks().forEach(t=>videoPC.addTrack(t,videoStream));
  return videoPC;
}
async function startVideoCall(){
  if(!privateTarget) return;
  const onlineUser=[...document.querySelectorAll("#users .user")].find(x=>x.textContent.includes(privateTarget.username));
  if(!onlineUser){alert("المستخدم غير متصل حالياً");return}
  // Find socket id is not exposed in the UI, so use a server-side presence lookup via a signaling request.
  socket.emit("videoRequest",{userId:privateTarget.id});
  $("#videoDialog").showModal();
}
if(typeof socket!=="undefined"){
  socket.on("privateMessage",m=>{
    if(privateTarget && (m.sender_id===privateTarget.id || m.receiver_id===privateTarget.id)){
      bubble($("#privateMessages"),m.sender_id===me.id?"أنت":privateTarget.username,m.text);
      if(m.sender_id!==me.id && document.hidden && "Notification" in window && Notification.permission==="granted") new Notification("رسالة جديدة",{body:m.text});
    }
  });
  socket.on("privateMedia",m=>{if(privateTarget && (m.sender_id===privateTarget.id || m.receiver_id===privateTarget.id)) appendMedia(m);});
  socket.on("videoIncoming",async ({from,user})=>{
    videoPeerSocket=from; $("#videoTitle").textContent="📹 مكالمة من "+(user?.username||"مستخدم");
    $("#videoDialog").showModal();
    if(confirm("قبول مكالمة الفيديو؟")){
      try{
        await createVideoPC(from);
        const answer=await videoPC.createAnswer(); await videoPC.setLocalDescription(answer);
        socket.emit("videoAnswer",{to:from,answer});
      }catch(e){alert("تعذر تشغيل الكاميرا أو الميكروفون");endVideo()}
    } else socket.emit("videoEnd",{to:from});
  });
  socket.on("videoRequestAck",async ({to})=>{
    try{
      await createVideoPC(to);
      const offer=await videoPC.createOffer(); await videoPC.setLocalDescription(offer);
      socket.emit("videoOffer",{to,offer});
    }catch(e){alert("اسمح للمتصفح باستخدام الكاميرا والميكروفون");endVideo()}
  });
  socket.on("videoOffer",async ({from,offer,user})=>{
    try{
      videoPeerSocket=from;$("#videoTitle").textContent="📹 مكالمة من "+(user?.username||"مستخدم");$("#videoDialog").showModal();
      if(!videoPC) await createVideoPC(from);
      await videoPC.setRemoteDescription(offer);
      const answer=await videoPC.createAnswer();await videoPC.setLocalDescription(answer);
      socket.emit("videoAnswer",{to:from,answer});
    }catch(e){endVideo()}
  });
  socket.on("videoAnswer",async ({answer})=>{if(videoPC)await videoPC.setRemoteDescription(answer)});
  socket.on("videoIceCandidate",async ({candidate})=>{try{if(videoPC)await videoPC.addIceCandidate(candidate)}catch{}});
  socket.on("videoEnd",()=>endVideo(false));
}
function endVideo(send=true){
  if(send&&videoPeerSocket)socket.emit("videoEnd",{to:videoPeerSocket});
  if(videoPC)videoPC.close(); videoPC=null;
  if(videoStream)videoStream.getTracks().forEach(t=>t.stop()); videoStream=null;
  $("#localVideo").srcObject=null;$("#remoteVideo").srcObject=null;$("#videoDialog").close();videoPeerSocket=null;
}

$("#privateDialog").addEventListener("close",()=>{});
