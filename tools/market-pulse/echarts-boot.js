(function(){
  var sources = [
    'https://fastly.jsdelivr.net/npm/echarts@5.5.1/dist/echarts.min.js',
    '/tools/market-pulse/vendor/echarts.min.js'
  ];
  var i = 0;
  function ready(){
    if (window.__pulseOnReady) { window.__pulseOnReady(); return; }
    setTimeout(ready, 100);
  }
  function next(){
    if (window.echarts && !window.echarts.__shim) { ready(); return; }
    if (i >= sources.length) return;
    var src = sources[i++], done = false;
    var s = document.createElement('script');
    s.src = src; s.async = true;
    s.onload = function(){ if (!done) { done = true; setTimeout(next, 0); } };
    s.onerror = function(){ if (!done) { done = true; setTimeout(next, 0); } };
    document.head.appendChild(s);
    setTimeout(function(){ if (!done) { done = true; setTimeout(next, 0); } }, 10000);
  }
  next();
})();
