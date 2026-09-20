const adminBtn=document.querySelector("#adminBtn");
if(adminBtn){
  const tokenForAdmin=localStorage.getItem("chatArabToken");
  fetch("/api/me",{headers:{Authorization:`Bearer ${tokenForAdmin}`}})
    .then(r=>r.ok?r.json():null).then(u=>{
      if(u?.role==="admin") adminBtn.hidden=false;
    }).catch(()=>{});
  adminBtn.onclick=()=>location.href="/admin.html";
}
