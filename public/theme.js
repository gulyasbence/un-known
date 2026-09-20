(function(){
  var s=localStorage.getItem('theme');
  if(s)document.documentElement.setAttribute('data-theme',s);
})();
function toggleTheme(){
  var r=document.documentElement;
  var cur=r.getAttribute('data-theme');
  var next=cur==='dark'?'light':cur==='light'?'dark':
    (matchMedia('(prefers-color-scheme:dark)').matches?'light':'dark');
  r.setAttribute('data-theme',next);
  localStorage.setItem('theme',next);
}
